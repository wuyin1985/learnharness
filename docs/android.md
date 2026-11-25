# LearnHarness for Android

The Android app bundles the LearnHarness web UI, its Node.js learning engine, and the core plugins. It starts the engine on the device and opens the UI in Android System WebView. Sessions, knowledge graph, keys, and imported attachments are stored in the app's private storage. No LearnHarness server or separate runtime installation is required.

## Run on a phone or tablet

Use Android 9 or newer with Android System WebView 111 or newer. The APK supports arm64, 32-bit ARM, and x86-64. On a phone, use the sidebar button to open sessions over the current page. Use **+** for composer tools and **⋯** for graph or session actions. Settings opens a vertical list of sections. Android Back closes the current menu or returns from a settings section to the list. Windows with sufficient width and height can show sessions and learning content side by side.

Open **Set up models**, add a provider key or an OpenAI-compatible endpoint, and choose the Strong, Cheap, and Vision models. Model requests need network access when the selected provider is remote. Dictation and web research also use their respective services when configured.

Use [PC connection](shared-pc.md) from the session sidebar to continue a session hosted by a Windows PC over an approved network.

Use **Attach files** in the composer tools, or the paperclip in a wider window, to copy selected files into LearnHarness and insert their references in the session. A selection can contain up to 32 files and 25 MB in total. The original files remain in their provider. Android's clear-storage and uninstall commands remove the learning profile and those copies.

Use **Connect** next to ChatGPT in **Settings → Providers** to open sign-in in the system browser. Return to LearnHarness after the browser confirms sign-in.

Desktop-only features include the Claude Code CLI integration, the Electron browser used to verify interactive demos, and the in-app desktop updater. PDF page rasterization uses the ARM64 build of the canvas library.

## Build an APK

Install Node.js 26, Python 3.11+, JDK 17 or 21, Android SDK platform 35 and Build Tools 36.0.0, and Android NDK r27c. Set `ANDROID_HOME` to the Android SDK root and pass the path to the unpacked NDK. Run these commands from the repository root.

```sh
npm ci
npm run plugins:setup
npm run build
node scripts/build-server.mjs
python3 android/prepare-runtime.py --ndk /path/to/android-ndk-r27c
./android/gradlew -p android :app:assembleDebug
```

On Windows, use `python` and `android\gradlew.bat -p android :app:assembleDebug`. The build takes the standalone output from Next.js and the existing desktop payload assembly script. Runtime preparation downloads and verifies the pinned [Node.js Mobile SDK](https://github.com/fogtape/nodejs-mobile/releases/tag/v24.22.1-0) and the ARM64 canvas binary from the package lockfile. Use `--abi arm64-v8a` to build a smaller APK for an ARM64 device.

The APK is written to `android/app/build/outputs/apk/debug/app-debug.apk`. The [Android workflow](https://github.com/wuyin1985/learnharness/actions/workflows/android.yml) also publishes the debug APK as a build artifact. Install it with `adb install -r android/app/build/outputs/apk/debug/app-debug.apk`. Android updates require a matching signing key, so keep using the same local build key if you want to retain an installed profile across builds.

The Android source is available in the [project fork](https://github.com/wuyin1985/learnharness) under AGPL-3.0. The APK carries the Node.js and Android NDK notices.
