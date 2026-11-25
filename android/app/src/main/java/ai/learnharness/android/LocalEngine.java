package ai.learnharness.android;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.system.Os;
import android.util.Log;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Map;
import java.util.Properties;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

final class LocalEngine {
    private static final String TAG = "LearnHarnessEngine";
    private static final String READY = "LH_ANDROID_READY ";
    private static final LocalEngine INSTANCE = new LocalEngine();
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ScheduledExecutorService workers = Executors.newScheduledThreadPool(2);
    private final ArrayList<Listener> listeners = new ArrayList<>();
    private final Object processLock = new Object();
    private Connection connection;
    private Process activeProcess;
    private volatile long generation;
    private boolean starting;
    private boolean failed;

    record Connection(int port, String token, boolean shared) {
        String origin() { return "http://127.0.0.1:" + port; }
    }

    interface Listener {
        void changed(Connection connection, boolean failed);
    }

    static LocalEngine get() { return INSTANCE; }

    void observe(Listener listener) {
        listeners.add(listener);
        listener.changed(connection, failed);
    }

    void remove(Listener listener) { listeners.remove(listener); }

    void start(Context context) {
        if (starting || connection != null) return;
        starting = true;
        failed = false;
        publish();
        long attempt = ++generation;
        workers.execute(() -> run(context.getApplicationContext(), attempt));
    }

    void restart(Context context) {
        synchronized (processLock) {
            generation++;
            if (activeProcess != null) activeProcess.destroy();
            activeProcess = null;
        }
        connection = null;
        starting = false;
        start(context);
    }

    private void publish() {
        for (Listener listener : new ArrayList<>(listeners)) listener.changed(connection, failed);
    }

    private void run(Context context, long attempt) {
        Process process = null;
        try {
            File runtime = unpack(context);
            File profile = directory(new File(context.getFilesDir(), "profile"));
            File data = directory(new File(profile, "data"));
            File temp = directory(new File(context.getCacheDir(), "node"));
            File libraries = new File(context.getApplicationInfo().nativeLibraryDir);
            String token = randomToken();
            File sharedConnection = SharedPcConnection.file(context);
            boolean shared = sharedConnection.isFile();
            var preferences = context.getSharedPreferences("engine", Context.MODE_PRIVATE);
            ProcessBuilder builder = new ProcessBuilder(
                    new File(libraries, "liblh-node.so").getAbsolutePath(),
                    "--max-old-space-size=384", "--preserve-symlinks",
                    new File(runtime, "engine.cjs").getAbsolutePath());
            builder.directory(runtime).redirectErrorStream(true);
            Map<String, String> env = builder.environment();
            env.put("LD_LIBRARY_PATH", libraries.getAbsolutePath());
            // Android's linker exposes N-API symbols to addons through its
            // global group, which includes libraries loaded by LD_PRELOAD.
            env.put("LD_PRELOAD", new File(libraries, "libnode.so").getAbsolutePath());
            env.put("LH_ANDROID_PARENT_PID", Integer.toString(android.os.Process.myPid()));
            env.put("LH_ANDROID_TOKEN", token);
            env.put("LH_ANDROID_PORT", Integer.toString(preferences.getInt("port", 0)));
            if (shared) env.put("LH_SHARED_CONNECTION_FILE", sharedConnection.getAbsolutePath());
            env.put("LH_DATA_DIR", data.getAbsolutePath());
            env.put("LH_AUTH_FILE", new File(profile, "auth.json").getAbsolutePath());
            env.put("LH_ANDROID_ATTACHMENTS", directory(new File(profile, "attachments")).getAbsolutePath());
            env.put("HOME", profile.getAbsolutePath());
            env.put("TMPDIR", temp.getAbsolutePath());
            env.put("NEXT_TELEMETRY_DISABLED", "1");
            synchronized (processLock) {
                if (generation != attempt) return;
                process = builder.start();
                activeProcess = process;
            }
            var watchdog = workers.schedule(process::destroyForcibly, 45, TimeUnit.SECONDS);
            Process child = process;
            try (var lines = new BufferedReader(new InputStreamReader(child.getInputStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = lines.readLine()) != null) {
                    if (line.startsWith(READY)) {
                        int port = Integer.parseInt(line.substring(READY.length()));
                        watchdog.cancel(false);
                        Log.i(TAG, "Local engine ready");
                        preferences.edit().putInt("port", port).apply();
                        main.post(() -> {
                            if (generation != attempt) return;
                            connection = new Connection(port, token, shared);
                            starting = false;
                            publish();
                        });
                    } else if (BuildConfig.DEBUG) {
                        Log.d(TAG, line);
                    }
                }
            } finally {
                watchdog.cancel(false);
            }
            Log.w(TAG, "The local engine exited with status " + child.waitFor());
        } catch (Exception error) {
            Log.e(TAG, "Could not run the local engine", error);
        } finally {
            if (process != null && process.isAlive()) process.destroyForcibly();
            synchronized (processLock) {
                if (activeProcess == process) activeProcess = null;
            }
            main.post(() -> {
                if (generation != attempt) return;
                connection = null;
                starting = false;
                failed = true;
                publish();
            });
        }
    }

    private static String randomToken() {
        var bytes = new byte[32];
        new SecureRandom().nextBytes(bytes);
        var token = new StringBuilder();
        for (byte value : bytes) {
            token.append(Character.forDigit((value & 255) >> 4, 16));
            token.append(Character.forDigit(value & 15, 16));
        }
        return token.toString();
    }

    private static File directory(File path) throws IOException {
        if (!path.isDirectory() && !path.mkdirs()) throw new IOException("Cannot create " + path.getName());
        return path;
    }

    private static synchronized File unpack(Context context) throws Exception {
        File parent = context.getNoBackupFilesDir();
        String id;
        try (var reader = new BufferedReader(new InputStreamReader(
                context.getAssets().open("runtime.id"), StandardCharsets.US_ASCII))) {
            id = reader.readLine();
        }
        if (id == null || !id.matches("[a-f0-9]{64}")) throw new IOException("Invalid runtime identifier");
        File libraries = new File(context.getApplicationInfo().nativeLibraryDir);
        // Android can relocate the extracted native libraries after each APK update.
        String installation = id + "\n" + libraries.getAbsolutePath();
        File runtime = new File(parent, "runtime");
        File installed = new File(runtime, ".installed");
        if (installed.isFile() && installation.equals(new String(
                Files.readAllBytes(installed.toPath()), StandardCharsets.UTF_8))) return runtime;
        File staging = new File(parent, "runtime-staging");
        deleteTree(staging);
        directory(staging);
        String prefix = staging.getCanonicalPath() + File.separator;
        try (var zip = new ZipInputStream(context.getAssets().open("runtime.zip"))) {
            byte[] buffer = new byte[64 * 1024];
            ZipEntry entry;
            while ((entry = zip.getNextEntry()) != null) {
                File target = new File(staging, entry.getName());
                if (!target.getCanonicalPath().startsWith(prefix)) throw new IOException("Invalid runtime entry");
                if (entry.isDirectory()) {
                    directory(target);
                } else {
                    directory(target.getParentFile());
                    try (var output = new FileOutputStream(target)) {
                        int count;
                        while ((count = zip.read(buffer)) != -1) output.write(buffer, 0, count);
                    }
                }
            }
        }
        var links = new Properties();
        try (var input = Files.newInputStream(new File(staging, "native.properties").toPath())) {
            links.load(input);
        }
        for (String relative : links.stringPropertyNames()) {
            File target = new File(staging, relative);
            if (!target.getCanonicalPath().startsWith(prefix)) throw new IOException("Invalid native entry");
            File nativeFile = new File(libraries, links.getProperty(relative));
            if (nativeFile.isFile()) {
                directory(target.getParentFile());
                Os.symlink(nativeFile.getAbsolutePath(), target.getAbsolutePath());
            }
        }
        Files.write(new File(staging, ".installed").toPath(), installation.getBytes(StandardCharsets.UTF_8));
        deleteTree(runtime);
        if (!staging.renameTo(runtime)) throw new IOException("Cannot install the local engine");
        return runtime;
    }

    private static void deleteTree(File path) throws IOException {
        if (!Files.isSymbolicLink(path.toPath())) {
            File[] entries = path.listFiles();
            if (entries != null) for (File entry : entries) deleteTree(entry);
        }
        Files.deleteIfExists(path.toPath());
    }
}
