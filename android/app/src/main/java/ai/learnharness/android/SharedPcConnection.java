package ai.learnharness.android;

import android.content.Context;
import android.net.Uri;

import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.security.cert.CertificateFactory;
import java.util.UUID;

final class SharedPcConnection {
    private static final int MAX_SIZE = 64 * 1024;
    private static final String PAIRING_FILE = "shared-pairing-[0-9a-f-]{36}\\.json";

    static File file(Context context) {
        return new File(context.getFilesDir(), "shared-pc.lhconnect");
    }

    static void importFile(Context context, Uri uri) throws Exception {
        if (uri == null || !"content".equals(uri.getScheme())) throw new IOException("Choose a connection file.");
        byte[] bytes;
        try (var input = context.getContentResolver().openInputStream(uri);
             var buffer = new ByteArrayOutputStream()) {
            if (input == null) throw new IOException("Cannot read connection file.");
            byte[] chunk = new byte[4096];
            int size;
            while ((size = input.read(chunk)) != -1) {
                if (buffer.size() + size > MAX_SIZE) throw new IOException("Connection file is too large.");
                buffer.write(chunk, 0, size);
            }
            bytes = buffer.toByteArray();
        }
        var config = new JSONObject(new String(bytes, StandardCharsets.UTF_8));
        var origin = new URI(config.getString("origin"));
        String publicCertificate = config.getString("certificate");
        int version = config.getInt("version");
        if ((version != 1 && version != 2) || !"https".equals(origin.getScheme()) || origin.getHost() == null ||
                origin.getUserInfo() != null || origin.getQuery() != null || origin.getFragment() != null ||
                (!origin.getPath().isEmpty() && !"/".equals(origin.getPath())) ||
                !publicCertificate.startsWith("-----BEGIN CERTIFICATE-----")) {
            throw new IOException("Invalid LearnHarness connection file.");
        }
        CertificateFactory.getInstance("X.509").generateCertificate(
                new ByteArrayInputStream(publicCertificate.getBytes(StandardCharsets.US_ASCII)));
        File destination = file(context);
        var saved = new JSONObject().put("version", version)
                .put("origin", origin.toString()).put("certificate", publicCertificate);
        File pending = null;
        String pairingCode = null;
        if (version == 2) {
            pairingCode = config.getString("pairingCode");
            if (!pairingCode.matches("[A-Za-z0-9_-]{24}") || config.getLong("expiresAt") <= 0) {
                throw new IOException("Invalid LearnHarness pairing authorization.");
            }
            // A separate, unique file lets an older engine clear its own
            // authorization without modifying a just-imported connection.
            String pairingId = UUID.randomUUID().toString();
            saved.put("pairingId", pairingId);
            pending = new File(destination.getParentFile(), "shared-pairing-" + pairingId + ".json");
        }
        File staging = File.createTempFile("shared-pc-", ".tmp", destination.getParentFile());
        boolean installed = false;
        try {
            if (pending != null) {
                Files.write(pending.toPath(), new JSONObject().put("code", pairingCode)
                        .toString().getBytes(StandardCharsets.UTF_8));
            }
            Files.write(staging.toPath(), saved.toString().getBytes(StandardCharsets.UTF_8));
            Files.move(staging.toPath(), destination.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
            installed = true;
        } finally {
            Files.deleteIfExists(staging.toPath());
            if (!installed && pending != null) Files.deleteIfExists(pending.toPath());
        }
        File[] previous = destination.getParentFile().listFiles((parent, name) -> name.matches(PAIRING_FILE));
        if (previous != null) for (File file : previous) {
            if (file.equals(pending)) continue;
            try { Files.deleteIfExists(file.toPath()); }
            catch (IOException ignored) { /* Any old authorization expires on the host. */ }
        }
    }

    static void disconnect(Context context) throws IOException {
        File config = file(context);
        Files.deleteIfExists(config.toPath());
        File[] sessions = config.getParentFile().listFiles((parent, name) ->
                name.matches("shared-session-[0-9a-f]{64}(\\.tmp)?") || name.matches(PAIRING_FILE));
        if (sessions != null) for (File session : sessions) Files.deleteIfExists(session.toPath());
    }
}
