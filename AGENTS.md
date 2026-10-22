# p2p-chat

Pure static PWA — no build tools, no `package.json`, no lockfile, no CI. (A root `.gitignore` exists for Android build artifacts; `tools/test_net.mjs` is a zero-dep offline self-check, not a test framework.)

## Quick start

```bash
python3 -m http.server 8080
```

No build step. During dev **Hard Refresh** (Ctrl+F5) to bypass SW cache. Open `clear.html` to purge caches/IndexedDB/localStorage.

## Architecture

| File | Role |
|---|---|
| `index.html` | SPA — UI + messaging/calls/file-transfer logic |
| `net.js` | Network module: getStats sampling, voice-first ABR, ICE black-hole recovery, signaling/TURN settings, `NetUI` panel |
| `peerjs.min.js` | Local PeerJS 1.5.2 copy (no CDN dependency) |
| `sw.js` | SW: network-first HTML, cache-first static assets; dynamic BASE_PATH from URL |
| `clear.html` | PWA cleanup — auto-detects path, cleans related caches/IndexedDB/localStorage |
| `manifest.json` | PWA manifest (scope `/p2p-chat/`, standalone) |
| `tools/test_net.mjs` | `node tools/test_net.mjs` — ABR decision + binary frame protocol checks |
| `android/` | Android WebView wrapper (Gradle project): audio route, network callback, streaming file save |

- **Only dependency**: `peerjs@1.5.2` from `https://unpkg.com/peerjs@1.5.2/dist/peerjs.min.js`
- **Signaling**: `0.peerjs.com`, Google STUN + Metered Relay TURN — configurable at runtime via the `📶` badge (`net.js`, persisted in `localStorage` key `p2p.net.settings.v1`)
- **Room model**: shared room ID → creator gets fixed peer ID, joiner gets ephemeral ID and calls `peer.connect(roomId)`

## Implementation details

- **Connection**: creator = `new Peer(roomId, peerOptions)`, joiner = `new Peer(peerOptions)` then `peer.connect(roomId)`. Auto-reconnect on disconnect with `_reconnectAttempts`.
- **File transfer**: binary frame `[P2PF][type][flags][rsv][seq][crc32][payload]` (legacy 8-byte header still parsed), 16KB chunks (8KB during calls), ACK/NACK sliding window adaptive 8–64 via measured throughput×RTT, gap NACK, resume by `fileId`, backpressure guard, 5 retries, max 10GB. ACK every 10 chunks.
- **Heartbeat**: 60s interval, 2h timeout, 6 max failures — relaxed to not interrupt large transfers
- **Adaptive bitrate**: in `net.js`; 9 video tiers (60kbps–2Mbps) + voice-first priority (`audio=high/low`), sampled every 1s, down instantly on audio loss >2%, up after 2 consecutive good samples (≥6s apart)
- **Image compression**: auto-resize 800px, JPEG quality 0.6
- **Voice messages**: max 60s, `audio/webm;codecs=opus`, sent as a binary frame (`FRAME_TYPE_VOICE`), played via blob URL
- **Calls**: ICE restart + exponential backoff (1s→2s→4s→8s→16s, 5x), Opus FEC/DTX, screen wake lock; ICE black-hole detection (8s no traffic → restart, 15s cooldown); Android audio route toggle
- **Security**: `escapeHTML` on all user input, image URLs restricted to `http://`/`https://`
- **UI**: Chinese labels, English identifiers

## Release checklist

1. Bump SW cache version in `sw.js` and `android/app/src/main/assets/sw.js` (currently `v13`) and keep `net.js` + `assets/net.js` in sync
2. Update `versionCode` + `versionName` in `android/app/build.gradle.kts` (currently 9 / 1.3.0)
3. Build APK: `./gradlew assembleDebug` (from `android/`)
4. `git tag -a v<version> -m "<message>"` and push

## Pitfalls

- SW scope is `/p2p-chat/`. If deploying elsewhere, `sw.js` auto-detects `BASE_PATH` from its own URL — no manual change needed.
- The heartbeat comment on line ~329 is stale; the actual interval is 60000ms (60s).
- `android/app/src/main/assets/` is a copy of the web files — after editing `index.html`/`net.js`/`sw.js`, re-copy them, keeping `index.html` CRLF.
- `net.js` is loaded before the inline script; it must stay before it or `Net.peerOptions()` at `index.html` top level fails.
- Run `node tools/test_net.mjs` after touching ABR/frame code.
- `clear.html` uses keyword matching to find related cache/DB entries — if custom IndexedDB names are added, add them to `CUSTOM_KEYWORDS` in `clear.html:144`.
