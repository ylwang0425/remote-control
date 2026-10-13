# Android 1.1.0 build and deployment

The local release build completed from the current checkout using the reviewed
mobile/android/build-apk.ps1 toolchain. The APK declares package
com.airemote.app, versionCode 2, versionName 1.1.0, minimum SDK 26, and
target SDK 35. apksigner verification succeeded with APK Signature Scheme v2
and v3; aapt reported the same package and version metadata.

Artifact: mobile/dist/AI-Remote-Android-1.1.0.apk
Canonical artifact: mobile/dist/AI-Remote-Android.apk
Size: 21,118 bytes
SHA-256: 41e9398fd60153b21014e8e7add5534f7409df7a2a3f192163c6ef53a6a5bc2d

The canonical and versioned HTTPS download links are deployed. Root verified
both downloads against this size and SHA-256. The server serves them from its
configured downloads directory, /opt/ai-remote/downloads; this is separate
from the static web root. The previous 1.0.0 APK remains in the ignored local
mobile/.private directory.

The Android shell loads the hosted web application at runtime. The 1.1.0 APK
and hosted web assets therefore have separate delivery paths. Root verified
that all five deployed public web assets match their source bytes and that the
public responses use no-store with valid TLS. Reload the web application to
receive the current hosted UI; rebuilding or reinstalling the shell is not
required for web-only changes.

The public service was validated with authenticated native business operations through the connected
Windows bridge. WorkBuddy creation, continuation, next-message model selection, single-question and
two-page answers, and Stop were confirmed in its local conversation archive. Its actual model list
contains 19 options. Desktop bridge 1.1.1 carries the current native helpers independently of this APK.
Codex history, native model/project catalogs and existing-chat sending use the desktop app connection.

Codex Stop, questions and approvals require the dedicated Start-FullControl launcher; the user deferred
that restart, so native Codex full-control acceptance remains outstanding. WorkBuddy workspace selection
is currently performed on its desktop. Its benign command tests did not raise a real approval card.

The Android package has not been installed or exercised on a physical device. Public API acceptance and
responsive browser inspection do not establish physical-device acceptance.
