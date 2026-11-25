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

final class SharedPcConnection {
    private static final int MAX_SIZE = 64 * 1024;

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
        if (config.getInt("version") != 1 || !"https".equals(origin.getScheme()) || origin.getHost() == null ||
                origin.getUserInfo() != null || origin.getQuery() != null || origin.getFragment() != null ||
                (!origin.getPath().isEmpty() && !"/".equals(origin.getPath())) ||
                !publicCertificate.startsWith("-----BEGIN CERTIFICATE-----")) {
            throw new IOException("Invalid LearnHarness connection file.");
        }
        CertificateFactory.getInstance("X.509").generateCertificate(
                new ByteArrayInputStream(publicCertificate.getBytes(StandardCharsets.US_ASCII)));
        File destination = file(context);
        File staging = File.createTempFile("shared-pc-", ".tmp", destination.getParentFile());
        try {
            Files.write(staging.toPath(), new JSONObject()
                    .put("version", 1).put("origin", origin.toString()).put("certificate", publicCertificate)
                    .toString().getBytes(StandardCharsets.UTF_8));
            Files.move(staging.toPath(), destination.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
        } finally { Files.deleteIfExists(staging.toPath()); }
    }

    static void disconnect(Context context) throws IOException {
        File config = file(context);
        Files.deleteIfExists(config.toPath());
        File[] sessions = config.getParentFile().listFiles((parent, name) -> name.matches("shared-session-[0-9a-f]{64}(\\.tmp)?"));
        if (sessions != null) for (File session : sessions) Files.deleteIfExists(session.toPath());
    }
}
