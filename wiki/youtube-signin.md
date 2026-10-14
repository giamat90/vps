# YouTube sign-in (in-app cookies)

Fixes YouTube import failing with "Sign in to confirm you're not a bot" without asking the user to export a `cookies.txt` by hand. Settings → **YouTube account** → *Sign in to YouTube*.

Status (2026-10-14): implemented on `feat/youtube-signin`. **Hand-tested on the author's machine (Windows 11, WebView2, Ecosia default browser):** Google accepted the embedded window, 52 cookies were saved, and a full YouTube import (download, Demucs, analysis) succeeded with `trying cookies file: ...youtube_cookies.txt`. Not yet exercised: 2FA/passkey screens, expiry, a non-Italian locale.

## Why not read the browser's cookies

yt-dlp's `cookiesfrombrowser` cannot decrypt Chrome/Edge 127+ (app-bound encryption, `Failed to decrypt with DPAPI`), nor forks such as Ecosia that are not in its list. Firefox works but is rarely installed. So the app gets its own session instead.

## Flow

1. UI calls `sign_in_youtube` (`src-tauri/src/youtube_signin.rs`).
2. Rust opens a webview window labelled `youtube-signin`, **private mode** (`incognito(true)`), on `accounts.google.com/ServiceLogin?service=youtube&continue=https://www.youtube.com/`.
3. A blocking task polls `window.cookies()` once a second. Signed in = `LOGIN_INFO` plus one of `SAPISID`/`__Secure-3PAPISID`/`__Secure-3PSID`/`SID`, **on youtube.com** (a Google session that has not reached YouTube yet does not count).
4. After a 2 s settle, only `google.com`/`youtube.com` cookies are written to `~/.vps/youtube_cookies.txt` (Netscape format, atomic write) and the window is destroyed.
5. The command returns the path; the UI stores it as `youtubeCookiesPath`, so `import_youtube` and the sidecar are unchanged (`cookiefile` is tried first, as before).

Closing the window cancels (`"Sign-in cancelled."`); 15 min timeout. *Sign out* calls `sign_out_youtube`, which deletes only the managed file, never one the user chose.

The window is private and destroyed right after export on purpose: yt-dlp's guidance is that cookies from a browser session you keep using get rotated by YouTube and stop working.

## Security

The window shows a remote page, which this app has not done before.

- **No app commands.** VPS defines no per-command ACL (`build.rs` is plain `tauri_build::build()`), so Tauri lets *any* webview call app commands. `lib.rs` therefore wraps the invoke handler and rejects every call from the `youtube-signin` webview (`youtube_signin::may_invoke`). Plugin commands (dialog, updater, core) are already ACL-checked and no capability names this window.
- **Navigation allowlist.** `on_navigation` allows only `https` on google.com, youtube.com, gstatic.com, googleusercontent.com, googleapis.com, ggpht.com, ytimg.com. Google's country domains are accepted by shape (`accounts.google.it`, `google.co.uk`, `google.com.br`, same for youtube) because it redirects sign-in there; found on the first real run, when `accounts.google.it` was refused. A refused navigation is logged (host only). If a real sign-in path (country domain, SSO) turns out to be blocked, add the suffix in `NAVIGATION_SUFFIXES` and a test.
- **Cookie minimisation.** Only google.com/youtube.com cookies are kept. A cookie with a tab/newline in any field is dropped instead of written (file-format injection).
- The file holds a live Google session: it sits in the user's profile like the rest of `~/.vps`, the header says not to share it, values are never logged.

## Hand test checklist

1. Settings → YouTube account → Sign in to YouTube: window opens on Google's page.
2. Does Google accept the embedded WebView2 (no "This browser or app may not be secure")? If it refuses, nothing regresses: the *Use a cookies.txt file instead…* link remains.
3. After signing in the window closes by itself and the row says "Signed in to YouTube"; `~/.vps/youtube_cookies.txt` exists.
4. Import a YouTube URL; the sidecar log shows `trying cookies file: ...youtube_cookies.txt`.
5. 2FA / passkey / "verify it's you" screens complete inside the window.
6. Close the window mid-way: the button recovers with an error message, no leftover window.
7. Sign out removes the file and clears the setting.

## Not done

- Not ported to SPS yet (wait for the hand test); not extracted to `core/` (Rust side has no shared crate yet).
- No automatic re-prompt when the session expires: the import error text points at Settings → YouTube.

## yt-dlp needs a JS runtime (fixed in `feat/ytdlp-js-runtime`)

Found on the first real run (2026-10-14). With the sign-in cookies, yt-dlp failed with `The page needs to be reloaded` while the same video worked without cookies. Verbose output: `JS runtimes: none`, `Signature solving failed`, `n challenge solving failed`. yt-dlp needs a JavaScript runtime plus the `yt-dlp-ejs` solver scripts to extract with a logged-in session. The cookies were fine.

Fix: Deno bundled with the sidecar (`yt-dlp[default,deno]`, `build.py`, `yt_importer._js_runtime_opts`); details in `python-sidecar.md`. Verified with the dev venv (`JS runtimes: deno-2.9.7`) and with a throwaway PyInstaller onefile build using the same flags, run against the real sign-in cookies. The full sidecar build in CI was not run locally.
