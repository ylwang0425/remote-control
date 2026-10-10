package com.airemote.app;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.view.View;
import android.webkit.CookieManager;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.TextView;

/**
 * The whole app: one Activity holding one WebView pointed at the same-origin UI.
 *
 * Design rules this class keeps (see docs/tasks/T-mobile.md):
 * <ul>
 *   <li>No native bridge. The page is untrusted-by-default remote content, so it
 *       gets no handle on Java objects at all.</li>
 *   <li>No custom TLS handling. Certificate failures are left to the platform,
 *       which cancels the load -- a self-signed or wrong-host certificate is a
 *       hard stop, never a prompt and never a bypass.</li>
 *   <li>Foreign origins never load in-app; they are handed to the system browser.</li>
 *   <li>The cookie store is flushed on pause so a restart is still signed in.</li>
 * </ul>
 */
public class MainActivity extends Activity {

    /** Same-origin entry point. HTTPS only; cleartext is refused by the manifest. */
    private static final String ENTRY_URL = "https://101.43.98.18/";

    /** The only host allowed to render inside this WebView. */
    private static final String TRUSTED_HOST = "101.43.98.18";

    private WebView webView;
    private View errorView;
    private TextView errorText;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        webView = findViewById(R.id.webview);
        errorView = findViewById(R.id.error_view);
        errorText = findViewById(R.id.error_text);
        Button retryButton = findViewById(R.id.retry_button);

        configureWebView();

        retryButton.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View view) {
                errorView.setVisibility(View.GONE);
                webView.reload();
            }
        });

        CookieManager cookies = CookieManager.getInstance();
        cookies.setAcceptCookie(true);
        cookies.setAcceptThirdPartyCookies(webView, false);

        if (savedInstanceState != null) {
            webView.restoreState(savedInstanceState);
        } else {
            webView.loadUrl(ENTRY_URL);
        }
    }

    @SuppressWarnings("deprecation")
    private void configureWebView() {
        WebSettings settings = webView.getSettings();

        // Needed: the UI is a JavaScript app and it stores the session cookie
        // through DOM storage.
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);

        // Not needed, so switched off: this page is remote content and has no
        // business reading the device's filesystem or content providers.
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setAllowFileAccessFromFileURLs(false);
        settings.setAllowUniversalAccessFromFileURLs(false);

        settings.setGeolocationEnabled(false);
        // An https page must never pull in an http subresource.
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return handleNavigation(request == null ? null : request.getUrl());
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                // Write the cookie jar to disk straight after the page settles.
                CookieManager.getInstance().flush();
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request != null && request.isForMainFrame()) {
                    showOffline();
                }
            }
        });
    }

    /**
     * Decide where a navigation goes.
     *
     * @return true when the WebView must NOT load the URL itself.
     */
    private boolean handleNavigation(Uri uri) {
        if (uri == null) {
            return true;
        }
        String scheme = uri.getScheme();
        String host = uri.getHost();
        if ("https".equals(scheme) && TRUSTED_HOST.equals(host)) {
            return false; // our own UI stays inside the shell
        }
        if ("http".equals(scheme) || "https".equals(scheme)) {
            return openInSystemBrowser(uri);
        }
        return true; // file:, content:, intent:, ... are all refused outright
    }

    private boolean openInSystemBrowser(Uri uri) {
        Intent intent = new Intent(Intent.ACTION_VIEW, uri);
        intent.addCategory(Intent.CATEGORY_BROWSABLE);
        try {
            startActivity(intent);
        } catch (ActivityNotFoundException noBrowser) {
            // Consumed either way: a foreign origin must never fall back into
            // this WebView.
            return true;
        }
        return true;
    }

    private void showOffline() {
        if (errorText != null) {
            errorText.setText(R.string.offline_message);
        }
        if (errorView != null) {
            errorView.setVisibility(View.VISIBLE);
        }
    }

    @Override
    public void onBackPressed() {
        // Prefer walking the page's own history, and only leave the app when
        // there is nowhere left to go back to.
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
            return;
        }
        super.onBackPressed();
    }

    @Override
    protected void onPause() {
        super.onPause();
        // A restart must not sign the user out.
        CookieManager.getInstance().flush();
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        if (webView != null) {
            webView.saveState(outState);
        }
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }
}
