# p2p-chat

Pure static PWA — no build tools, no `package.json`, no lockfile, no `.gitignore`, no tests, no CI.

## Quick start

```bash
python3 -m http.server 8080
```

No build step. During dev **Hard Refresh** (Ctrl+F5) to bypass SW cache. Open `clear.html` to purge caches/IndexedDB/localStorage.

## Architecture

| File | Role |
|---|---|
| `index.html` (1800 lines) | SPA — all UI + logic in one file |
| `sw.js` | SW: network-first HTML, cache-first static assets; dynamic BASE_PATH from URL |
| `clear.html` | PWA cleanup — auto-detects path, cleans related caches/IndexedDB/localStorage |
| `manifest.json` | PWA manifest (scope `/p2p-chat/`, standalone) |
| `android/` | Android WebView wrapper (Gradle project) — for review, not actively maintained |

- **Only dependency**: `peerjs@1.5.2` from `https://unpkg.com/peerjs@1.5.2/dist/peerjs.min.js`
- **Signaling**: `0.peerjs.com`, Google STUN + Metered Relay TURN
- **Room model**: shared room ID → creator gets fixed peer ID, joiner gets ephemeral ID and calls `peer.connect(roomId)`

## Implementation details

- **Connection**: creator = `new Peer(roomId, peerOptions)`, joiner = `new Peer(peerOptions)` then `peer.connect(roomId)`. Auto-reconnect on disconnect with `_reconnectAttempts`.
- **File transfer**: CRC32 per-chunk, sliding window (16 wide), dynamic chunk size (4KB–256KB by throughput), 5 retries, max 10GB. ACK every 10 chunks.
- **Heartbeat**: 60s interval, 2h timeout, 6 max failures — relaxed to not interrupt large transfers
- **Adaptive bitrate**: WebRTC stats-based, updates every 6s (100kbps–2.5Mbps via RTT+loss)
- **Image compression**: auto-resize 800px, JPEG quality 0.6
- **Voice messages**: max 60s, `audio/webm;codecs=opus`, sent as base64 data URL
- **Calls**: ICE restart + exponential backoff (1s→2s→4s→8s→16s, 5x), Opus FEC/DTX, screen wake lock
- **Security**: `escapeHTML` on all user input (line 1189), image URLs restricted to `http://`/`https://`
- **UI**: Chinese labels, English identifiers

## Release checklist

1. Bump SW cache version in `sw.js` and `android/app/src/main/assets/sw.js` (e.g. `v8` → `v9`)
2. Update `versionCode` + `versionName` in `android/app/build.gradle.kts`
3. Build APK: `./gradlew assembleDebug` (from `android/`)
4. `git tag -a v<version> -m "<message>"` and push

## Pitfalls

- SW scope is `/p2p-chat/`. If deploying elsewhere, `sw.js` auto-detects `BASE_PATH` from its own URL — no manual change needed.
- The code comment `// 10秒发送一次ping` on line 329 is stale; the actual interval is 60000ms (60s).
- `clear.html` uses keyword matching to find related cache/DB entries — if custom IndexedDB names are added, add them to `CUSTOM_KEYWORDS` in `clear.html:144`.
