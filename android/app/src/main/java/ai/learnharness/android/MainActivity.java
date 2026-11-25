package ai.learnharness.android;

import android.Manifest;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Message;
import android.view.Gravity;
import android.view.View;
import android.view.WindowInsets;
import android.webkit.CookieManager;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.window.OnBackInvokedDispatcher;

import java.io.ByteArrayInputStream;
import java.util.Collections;

public final class MainActivity extends Activity {
    private static final int FILE_PICKER = 10;
    private static final int MICROPHONE = 11;
    private static final int MIN_WEBVIEW = 111;
    private final LocalEngine.Listener engineListener = this::engineChanged;
    private FrameLayout root;
    private LinearLayout status;
    private TextView statusText;
    private ProgressBar progress;
    private Button retry;
    private WebView view;
    private LocalEngine.Connection connection;
    private String restoredPath = "/";
    private ValueCallback<Uri[]> fileSelection;
    private PermissionRequest microphone;

    @Override public void onCreate(Bundle savedState) {
        super.onCreate(savedState);
        if (savedState != null) restoredPath = savedState.getString("path", "/");
        root = new FrameLayout(this);
        root.setBackgroundColor(0xfffafafa);
        if (Build.VERSION.SDK_INT >= 30) {
            getWindow().setDecorFitsSystemWindows(false);
            root.setOnApplyWindowInsetsListener((frame, insets) -> {
                var bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                var keyboard = insets.getInsets(WindowInsets.Type.ime());
                frame.setPadding(bars.left, bars.top, bars.right, Math.max(bars.bottom, keyboard.bottom));
                return WindowInsets.CONSUMED;
            });
        } else {
            root.setFitsSystemWindows(true);
        }
        setContentView(root);
        if (Build.VERSION.SDK_INT >= 33) {
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(
                    OnBackInvokedDispatcher.PRIORITY_DEFAULT, this::goBack);
        }
        status = new LinearLayout(this);
        status.setOrientation(LinearLayout.VERTICAL);
        status.setGravity(Gravity.CENTER);
        int padding = Math.round(24 * getResources().getDisplayMetrics().density);
        status.setPadding(padding, padding, padding, padding);
        progress = new ProgressBar(this);
        status.addView(progress);
        statusText = new TextView(this);
        statusText.setTextSize(16);
        statusText.setGravity(Gravity.CENTER);
        statusText.setPadding(0, padding, 0, padding);
        status.addView(statusText);
        retry = new Button(this);
        status.addView(retry);
        root.addView(status, new FrameLayout.LayoutParams(-1, -1));
        LocalEngine.get().observe(engineListener);
        LocalEngine.get().start(this);
    }

    private void showStatus(int text, int action, Runnable onClick) {
        status.setVisibility(View.VISIBLE);
        statusText.setText(text);
        progress.setVisibility(action == 0 ? View.VISIBLE : View.GONE);
        retry.setVisibility(action == 0 ? View.GONE : View.VISIBLE);
        if (action != 0) {
            retry.setText(action);
            retry.setOnClickListener(ignored -> onClick.run());
        }
    }

    private void engineChanged(LocalEngine.Connection next, boolean failed) {
        if (next == null) {
            destroyWebView();
            connection = null;
            if (failed) showStatus(R.string.start_failed, R.string.retry, () -> LocalEngine.get().start(this));
            else showStatus(R.string.starting, 0, null);
            return;
        }
        connection = next;
        var provider = WebView.getCurrentWebViewPackage();
        if (provider == null || webViewMajor(provider.versionName) < MIN_WEBVIEW) {
            showStatus(R.string.old_webview, R.string.update_webview, () -> {
                String id = provider == null ? "com.google.android.webview" : provider.packageName;
                openExternal(Uri.parse("https://play.google.com/store/apps/details?id=" + id));
            });
            return;
        }
        launchWebView(next);
    }

    private static int webViewMajor(String version) {
        if (version == null) return 0;
        try { return Integer.parseInt(version.split("\\.", 2)[0]); }
        catch (NumberFormatException ignored) { return 0; }
    }

    private void launchWebView(LocalEngine.Connection next) {
        if (view != null) return;
        showStatus(R.string.starting, 0, null);
        WebView content = new WebView(this);
        view = content;
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);
        WebSettings settings = content.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setSupportMultipleWindows(true);
        settings.setUserAgentString(settings.getUserAgentString() + " LearnHarnessAndroid/" + BuildConfig.VERSION_NAME);
        CookieManager cookies = CookieManager.getInstance();
        cookies.setAcceptThirdPartyCookies(content, false);
        content.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView web, WebResourceRequest request) {
                if (isAppUrl(request.getUrl())) return false;
                if (request.isForMainFrame()) openExternal(request.getUrl());
                return true;
            }

            @Override public WebResourceResponse shouldInterceptRequest(WebView web, WebResourceRequest request) {
                Uri url = request.getUrl();
                if (isAppUrl(url) || "https".equals(url.getScheme())) return null;
                return new WebResourceResponse("text/plain", "utf-8", 403, "Forbidden",
                        Collections.emptyMap(), new ByteArrayInputStream(new byte[0]));
            }

            @Override public void onPageCommitVisible(WebView web, String url) {
                if (web == view) status.setVisibility(View.GONE);
            }

            @Override public void onReceivedError(WebView web, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame() && web == view) webError();
            }

            @Override public void onReceivedHttpError(WebView web, WebResourceRequest request, WebResourceResponse response) {
                if (request.isForMainFrame() && web == view && response.getStatusCode() >= 500) webError();
            }

            @Override public boolean onRenderProcessGone(WebView web, android.webkit.RenderProcessGoneDetail detail) {
                webError();
                return true;
            }
        });
        content.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onShowFileChooser(WebView web, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (fileSelection != null) fileSelection.onReceiveValue(null);
                fileSelection = callback;
                try { startActivityForResult(params.createIntent(), FILE_PICKER); }
                catch (ActivityNotFoundException ignored) { completeFileSelection(null); }
                return true;
            }

            @Override public boolean onCreateWindow(WebView web, boolean isDialog, boolean isUserGesture, Message result) {
                if (!isUserGesture) return false;
                WebView popup = new WebView(MainActivity.this);
                popup.setWebViewClient(new WebViewClient() {
                    @Override public boolean shouldOverrideUrlLoading(WebView window, WebResourceRequest request) {
                        Uri uri = request.getUrl();
                        if (isAppUrl(uri)) web.loadUrl(uri.toString());
                        else openExternal(uri);
                        window.post(window::destroy);
                        return true;
                    }
                });
                ((WebView.WebViewTransport) result.obj).setWebView(popup);
                result.sendToTarget();
                return true;
            }

            @Override public void onPermissionRequest(PermissionRequest request) {
                String[] resources = request.getResources();
                if (!isAppUrl(request.getOrigin()) || resources.length != 1 ||
                        !PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resources[0]) || microphone != null) {
                    request.deny();
                    return;
                }
                if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                    request.grant(resources);
                } else {
                    microphone = request;
                    requestPermissions(new String[] { Manifest.permission.RECORD_AUDIO }, MICROPHONE);
                }
            }

            @Override public void onPermissionRequestCanceled(PermissionRequest request) {
                if (microphone == request) microphone = null;
            }
        });
        root.addView(content, 0, new FrameLayout.LayoutParams(-1, -1));
        cookies.setCookie(next.origin(), "lh_android=" + next.token() + "; HttpOnly; SameSite=Strict; Path=/",
                success -> {
                    if (view != content || !next.equals(connection)) return;
                    if (!success) webError();
                    else content.loadUrl(next.origin() + restoredPath);
                });
    }

    private boolean isAppUrl(Uri url) {
        return connection != null && "http".equals(url.getScheme()) && "127.0.0.1".equals(url.getHost())
                && url.getUserInfo() == null && url.getPort() == connection.port();
    }

    private void webError() {
        destroyWebView();
        showStatus(R.string.web_failed, R.string.retry, () -> {
            if (connection != null) launchWebView(connection);
        });
    }

    private void destroyWebView() {
        if (view == null) return;
        rememberPath();
        WebView old = view;
        view = null;
        completeFileSelection(null);
        microphone = null;
        root.removeView(old);
        old.destroy();
    }

    private void rememberPath() {
        if (view == null || view.getUrl() == null) return;
        Uri url = Uri.parse(view.getUrl());
        if (!isAppUrl(url)) return;
        String path = url.getEncodedPath();
        if (path != null && path.startsWith("/") && !path.startsWith("//")) {
            restoredPath = path + (url.getEncodedQuery() == null ? "" : "?" + url.getEncodedQuery());
        }
    }

    private void openExternal(Uri uri) {
        if (!"https".equals(uri.getScheme()) || uri.getHost() == null || uri.getUserInfo() != null) return;
        try { startActivity(new Intent(Intent.ACTION_VIEW, uri)); }
        catch (ActivityNotFoundException ignored) { /* No browser installed. */ }
    }

    @Override protected void onActivityResult(int code, int result, Intent data) {
        super.onActivityResult(code, result, data);
        if (code != FILE_PICKER) return;
        Uri[] files = null;
        if (result == RESULT_OK && data != null) {
            var multiple = data.getClipData();
            if (multiple != null) {
                files = new Uri[multiple.getItemCount()];
                for (int index = 0; index < files.length; index++) files[index] = multiple.getItemAt(index).getUri();
            } else if (data.getData() != null) files = new Uri[] {data.getData()};
        }
        if (files != null) {
            for (Uri file : files) {
                if (file == null || !"content".equals(file.getScheme())) { files = null; break; }
            }
        }
        completeFileSelection(files);
    }

    private void completeFileSelection(Uri[] files) {
        if (fileSelection == null) return;
        var callback = fileSelection;
        fileSelection = null;
        callback.onReceiveValue(files);
    }

    @Override public void onRequestPermissionsResult(int code, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(code, permissions, results);
        if (code != MICROPHONE || microphone == null) return;
        var request = microphone;
        microphone = null;
        if (results.length == 1 && results[0] == PackageManager.PERMISSION_GRANTED
                && isAppUrl(request.getOrigin())) request.grant(request.getResources());
        else request.deny();
    }

    @Override public void onBackPressed() { goBack(); }

    private void goBack() {
        WebView content = view;
        if (content == null) { finish(); return; }
        content.evaluateJavascript("window.dispatchEvent(new Event('lh-android-back', { cancelable: true }))", result -> {
            if (content != view || "false".equals(result)) return;
            if (content.canGoBack()) content.goBack();
            else finish();
        });
    }

    @Override protected void onSaveInstanceState(Bundle state) {
        rememberPath();
        state.putString("path", restoredPath);
        super.onSaveInstanceState(state);
    }

    @Override protected void onDestroy() {
        LocalEngine.get().remove(engineListener);
        destroyWebView();
        super.onDestroy();
    }
}
