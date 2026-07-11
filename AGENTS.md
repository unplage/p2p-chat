# p2p-chat

Pure static PWA — no build tools, no package manager, no tests, no CI.

## Quick start

No build step needed. Open `index.html` in a browser or serve locally:

```bash
python3 -m http.server 8080
```

The app is hosted at `https://unplage.github.io/p2p-chat/`.

## Architecture

| File | Role |
|---|---|
| `index.html` | Single-page app (1350 lines) — all logic in one file |
| `sw.js` | Service Worker (network-first HTML, cache-first static assets) |
| `clear.html` | PWA cache/IndexedDB/localStorage cleanup utility |
| `manifest.json` | PWA manifest (scope `/p2p-chat/`, standalone mode) |

- **Only dependency**: `peerjs@1.5.2` loaded from `https://unpkg.com/peerjs@1.5.2/dist/peerjs.min.js`
- **Room model**: users agree on a room ID; that ID becomes the PeerJS peer ID
- **P2P signaling**: `0.peerjs.com` with Google STUN + Metered Relay TURN

## Notable implementation details

- **File transfer**: 16KB chunks, queue-based, 3 retries per chunk, max 10GB
- **Heartbeat**: 60s interval, **2-hour timeout**, 6 max failures — deliberately relaxed to avoid interrupting large file transfers
- **Adaptive bitrate**: WebRTC stats-based, updates every 6s (4 tiers: 150kbps–2Mbps)
- **Image compression**: auto-resize to 800px, JPEG quality 0.6
- **Voice messages**: max 60s, sent as base64 data URL
- **Calls**: ICE restart on failure, screen wake lock during calls
- UI in Chinese, code identifiers in English

## Common pitfalls

- Service Worker aggressively caches `index.html`. During development, use **Hard Refresh** (Ctrl+F5) or open `clear.html` to purge caches.
- `clear.html` auto-detects the PWA path from URL and cleans associated caches, IndexedDB, and localStorage.
- The SW scope is `/p2p-chat/` — adjust `BASE_PATH` in `sw.js` if deploying elsewhere.
- No `package.json`, no lockfile, no `.gitignore`.
