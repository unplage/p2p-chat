package com.p2pchat.app;

import android.Manifest;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.NetworkRequest;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import androidx.appcompat.app.AppCompatActivity;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.List;

public class MainActivity extends AppCompatActivity {

    private WebView webView;
    private ValueCallback<Uri[]> uploadMessage;
    private PermissionRequest pendingPermissionRequest;
    private static final int FILE_CHOOSER_REQUEST_CODE = 100;
    private static final int PERMISSION_REQUEST_CODE = 200;
    private OutputStream currentOutStream;
    private String currentFilename;
    private Uri currentUri;
    private File currentFile;
    private boolean isInCall = false;
    private boolean enteringPip = false;
    private static final int NOTIFICATION_PERMISSION_REQUEST_CODE = 300;
    private AudioManager audioManager;
    private ConnectivityManager connectivityManager;
    private ConnectivityManager.NetworkCallback networkCallback;
    private String currentRoute = "speaker";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        webView = new WebView(this);
        setContentView(webView);

        audioManager = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
        connectivityManager = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(true);
        settings.setAllowContentAccess(true);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        settings.setLoadWithOverviewMode(true);
        settings.setUseWideViewPort(true);
        settings.setBuiltInZoomControls(false);
        settings.setMediaPlaybackRequiresUserGesture(false);

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                String url = request.getUrl().toString();
                if (url.startsWith("file://") || url.startsWith("data:")) {
                    return false;
                }
                try {
                    Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
                    startActivity(intent);
                } catch (Exception e) {
                    return false;
                }
                return true;
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView webView, ValueCallback<Uri[]> filePathCallback, FileChooserParams fileChooserParams) {
                if (uploadMessage != null) {
                    uploadMessage.onReceiveValue(null);
                    uploadMessage = null;
                }
                uploadMessage = filePathCallback;

                Intent intent = fileChooserParams.createIntent();
                try {
                    startActivityForResult(intent, FILE_CHOOSER_REQUEST_CODE);
                } catch (Exception e) {
                    uploadMessage = null;
                    return false;
                }
                return true;
            }

            @Override
            public void onPermissionRequest(PermissionRequest request) {
                String[] resources = request.getResources();
                List<String> needed = new ArrayList<>();
                for (String r : resources) {
                    if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(r)) {
                        if (ContextCompat.checkSelfPermission(MainActivity.this, Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
                            needed.add(Manifest.permission.CAMERA);
                        }
                    } else if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(r)) {
                        if (ContextCompat.checkSelfPermission(MainActivity.this, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
                            needed.add(Manifest.permission.RECORD_AUDIO);
                        }
                    }
                }
                if (needed.isEmpty()) {
                    request.grant(resources);
                } else {
                    pendingPermissionRequest = request;
                    ActivityCompat.requestPermissions(MainActivity.this, needed.toArray(new String[0]), PERMISSION_REQUEST_CODE);
                }
            }
        });

        webView.addJavascriptInterface(new FileSaver(), "Android");
        registerNetworkListener();

        webView.loadUrl("file:///android_asset/index.html");
    }

    @Override
    protected void onPause() {
        super.onPause();
        if (!enteringPip) {
            webView.evaluateJavascript("typeof onAppPause === 'function' && onAppPause()", null);
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        webView.evaluateJavascript("typeof onAppResume === 'function' && onAppResume()", null);
    }

    @Override
    public void onUserLeaveHint() {
        super.onUserLeaveHint();
        if (isInCall && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            enteringPip = true;
            enterPictureInPictureMode();
        }
    }

    @Override
    public void onPictureInPictureModeChanged(boolean isInPictureInPictureMode, Configuration newConfig) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            super.onPictureInPictureModeChanged(isInPictureInPictureMode, newConfig);
        }
        enteringPip = false;
        webView.post(() ->
            webView.evaluateJavascript(
                "typeof onPiPChanged === 'function' && onPiPChanged(" + isInPictureInPictureMode + ")",
                null
            )
        );
    }

    public class FileSaver {
        @JavascriptInterface
        public void startFileSave(String filename) {
            try {
                currentFilename = filename;
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    ContentValues values = new ContentValues();
                    values.put(MediaStore.Downloads.DISPLAY_NAME, filename);
                    values.put(MediaStore.Downloads.MIME_TYPE, getMimeType(filename));
                    values.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/P2PChat");
                    currentUri = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
                    if (currentUri != null) {
                        currentOutStream = getContentResolver().openOutputStream(currentUri);
                    }
                } else {
                    File dir = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), "P2PChat");
                    if (!dir.exists()) dir.mkdirs();
                    currentFile = new File(dir, filename);
                    currentOutStream = new FileOutputStream(currentFile);
                }
                if (currentOutStream == null) {
                    throw new RuntimeException("无法打开输出流");
                }
            } catch (Exception e) {
                currentOutStream = null;
                currentFilename = null;
                currentUri = null;
                currentFile = null;
                throw new RuntimeException(e.getMessage());
            }
        }

        @JavascriptInterface
        public void appendFileChunk(String base64Chunk) {
            if (currentOutStream == null) return;
            try {
                byte[] data = Base64.decode(base64Chunk, Base64.DEFAULT);
                currentOutStream.write(data);
            } catch (Exception e) {
                throw new RuntimeException(e.getMessage());
            }
        }

        @JavascriptInterface
        public void endFileSave() {
            try {
                if (currentOutStream != null) {
                    currentOutStream.close();
                    currentOutStream = null;
                }
                final String fname = currentFilename;
                runOnUiThread(() -> Toast.makeText(MainActivity.this, "✓ 已保存到 Downloads/P2PChat/" + fname, Toast.LENGTH_LONG).show());
            } catch (Exception e) {
                runOnUiThread(() -> Toast.makeText(MainActivity.this, "文件保存失败: " + e.getMessage(), Toast.LENGTH_LONG).show());
            }
            currentFilename = null;
            currentUri = null;
            currentFile = null;
        }

        @JavascriptInterface
        public void cancelFileSave() {
            try {
                if (currentOutStream != null) {
                    currentOutStream.close();
                    currentOutStream = null;
                }
                if (currentUri != null) {
                    getContentResolver().delete(currentUri, null, null);
                } else if (currentFile != null && currentFile.exists()) {
                    currentFile.delete();
                }
            } catch (Exception ignored) {}
            currentFilename = null;
            currentUri = null;
            currentFile = null;
        }

        /** 切换通话音频输出：speaker / earpiece / bluetooth */
        @JavascriptInterface
        public void setAudioRoute(String route) {
            applyAudioRoute(route);
        }

        @JavascriptInterface
        public String getAudioRoute() {
            return currentRoute;
        }

        /** 当前网络类型：wifi / cellular / ethernet / none / unknown */
        @JavascriptInterface
        public String getNetworkType() {
            return currentNetworkType();
        }

        /** 监听网络变化，回调 window.onNetworkTypeChanged(type) */
        @JavascriptInterface
        public void registerNetworkCallback() {
            registerNetworkListener();
        }

        @JavascriptInterface
        public void startCallService() {
            try {
                isInCall = true;
                enterCommunicationMode();
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                    if (ContextCompat.checkSelfPermission(MainActivity.this, Manifest.permission.POST_NOTIFICATIONS)
                            != PackageManager.PERMISSION_GRANTED) {
                        ActivityCompat.requestPermissions(MainActivity.this,
                                new String[]{Manifest.permission.POST_NOTIFICATIONS},
                                NOTIFICATION_PERMISSION_REQUEST_CODE);
                    }
                }
                Intent intent = new Intent(MainActivity.this, CallForegroundService.class);
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    startForegroundService(intent);
                } else {
                    startService(intent);
                }
            } catch (Exception ignored) {}
        }

        @JavascriptInterface
        public void stopCallService() {
            try {
                isInCall = false;
                exitCommunicationMode();
                stopService(new Intent(MainActivity.this, CallForegroundService.class));
            } catch (Exception ignored) {}
        }

        private String getMimeType(String filename) {
            String ext = filename.contains(".") ? filename.substring(filename.lastIndexOf('.') + 1).toLowerCase() : "";
            switch (ext) {
                case "jpg": case "jpeg": return "image/jpeg";
                case "png": return "image/png";
                case "gif": return "image/gif";
                case "mp4": return "video/mp4";
                case "mp3": case "opus": case "webm": return "audio/opus";
                case "pdf": return "application/pdf";
                case "zip": return "application/zip";
                default: return "application/octet-stream";
            }
        }
    }

    // ==================== 通话音频路由 ====================
    private void enterCommunicationMode() {
        if (audioManager == null) return;
        try {
            audioManager.setMode(AudioManager.MODE_IN_COMMUNICATION);
            applyAudioRoute(currentRoute);
        } catch (Exception ignored) {}
    }

    private void exitCommunicationMode() {
        if (audioManager == null) return;
        try {
            audioManager.setMode(AudioManager.MODE_NORMAL);
            audioManager.stopBluetoothSco();
            audioManager.setBluetoothScoOn(false);
        } catch (Exception ignored) {}
    }

    private void applyAudioRoute(String route) {
        if (audioManager == null) return;
        if (route == null || route.isEmpty()) route = "speaker";
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                AudioDeviceInfo target = findOutputDevice(route);
                if (target != null) {
                    audioManager.setCommunicationDevice(target);
                    currentRoute = route;
                    return;
                }
            }
            boolean speaker = "speaker".equals(route);
            audioManager.setSpeakerphoneOn(speaker);
            if ("bluetooth".equals(route)) {
                audioManager.startBluetoothSco();
                audioManager.setBluetoothScoOn(true);
            } else {
                audioManager.setBluetoothScoOn(false);
                audioManager.stopBluetoothSco();
            }
            currentRoute = route;
        } catch (Exception ignored) {}
    }

    @SuppressWarnings("deprecation")
    private AudioDeviceInfo findOutputDevice(String route) {
        if (audioManager == null) return null;
        int wanted;
        switch (route) {
            case "earpiece": wanted = AudioDeviceInfo.TYPE_BUILTIN_EARPIECE; break;
            case "bluetooth": wanted = AudioDeviceInfo.TYPE_BLUETOOTH_SCO; break;
            default: wanted = AudioDeviceInfo.TYPE_BUILTIN_SPEAKER; break;
        }
        AudioDeviceInfo fallback = null;
        for (AudioDeviceInfo device : audioManager.getDevices(AudioManager.GET_DEVICES_OUTPUTS)) {
            if (device.getType() == wanted) return device;
            if ("bluetooth".equals(route) && fallback == null
                    && device.getType() == AudioDeviceInfo.TYPE_BLUETOOTH_A2DP) {
                fallback = device;
            }
        }
        return fallback;
    }

    // ==================== 网络类型 ====================
    private String currentNetworkType() {
        if (connectivityManager == null) return "unknown";
        try {
            Network network = connectivityManager.getActiveNetwork();
            if (network == null) return "none";
            NetworkCapabilities caps = connectivityManager.getNetworkCapabilities(network);
            return typeFromCapabilities(caps);
        } catch (Exception e) {
            return "unknown";
        }
    }

    private String typeFromCapabilities(NetworkCapabilities caps) {
        if (caps == null) return "unknown";
        if (caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) return "wifi";
        if (caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR)) return "cellular";
        if (caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)) return "ethernet";
        return "unknown";
    }

    private void registerNetworkListener() {
        if (connectivityManager == null || networkCallback != null) return;
        networkCallback = new ConnectivityManager.NetworkCallback() {
            @Override
            public void onCapabilitiesChanged(Network network, NetworkCapabilities caps) {
                notifyNetworkType(typeFromCapabilities(caps));
            }

            @Override
            public void onLost(Network network) {
                notifyNetworkType(currentNetworkType());
            }
        };
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                connectivityManager.registerDefaultNetworkCallback(networkCallback);
            } else {
                NetworkRequest request = new NetworkRequest.Builder()
                        .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                        .build();
                connectivityManager.registerNetworkCallback(request, networkCallback);
            }
        } catch (Exception e) {
            networkCallback = null;
        }
    }

    private void notifyNetworkType(String type) {
        if (webView == null || type == null) return;
        try {
            webView.evaluateJavascript(
                    "typeof onNetworkTypeChanged === 'function' && onNetworkTypeChanged('" + type + "')",
                    null);
        } catch (Exception ignored) {}
    }

    @Override
    protected void onDestroy() {
        try {
            if (connectivityManager != null && networkCallback != null) {
                connectivityManager.unregisterNetworkCallback(networkCallback);
                networkCallback = null;
            }
        } catch (Exception ignored) {}
        exitCommunicationMode();
        super.onDestroy();
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == FILE_CHOOSER_REQUEST_CODE) {
            if (uploadMessage != null) {
                Uri[] results = null;
                if (resultCode == RESULT_OK) {
                    if (data != null) {
                        String dataString = data.getDataString();
                        if (dataString != null) {
                            results = new Uri[]{Uri.parse(dataString)};
                        }
                    }
                }
                uploadMessage.onReceiveValue(results);
                uploadMessage = null;
            }
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        if (requestCode == PERMISSION_REQUEST_CODE && pendingPermissionRequest != null) {
            boolean allGranted = true;
            for (int r : grantResults) {
                if (r != PackageManager.PERMISSION_GRANTED) {
                    allGranted = false;
                    break;
                }
            }
            if (allGranted) {
                pendingPermissionRequest.grant(pendingPermissionRequest.getResources());
            } else {
                pendingPermissionRequest.deny();
            }
            pendingPermissionRequest = null;
            return;
        }
        if (requestCode == NOTIFICATION_PERMISSION_REQUEST_CODE) {
            return;
        }
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
    }

    @Override
    public void onBackPressed() {
        if (webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
    }
}
