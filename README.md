# P2P 安全通信 · 房间直连

基于 [PeerJS](https://peerjs.com/) 的纯静态 P2P 聊天 PWA，无需注册账号，约定房间号即可直连。

**地址**：https://unplage.github.io/p2p-chat/

## 功能

| 功能 | 说明 |
|---|---|
| 文字 / 图片 / 语音消息 | 图片自动压缩至 800px JPEG 0.6，语音限 60s |
| 视频 / 语音通话 | 自适应码率、ICE 重启恢复、Opus FEC/DTX |
| 文件传输 | CRC32 校验 + ACK/NACK 滑动窗口 + 断线恢复 |
| 流式磁盘写入 | 支持 FileSystem Access API 直接保存大文件 |
| 网络质量监控 | 实时显示连接类型、RTT、丢包率、码率 |

## 架构

单页 PWA，无构建工具、无依赖（仅 PeerJS CDN）。

| 文件 | 作用 |
|---|---|
| `index.html` | 全部 UI 与逻辑（~1350 行） |
| `sw.js` | Service Worker，网络优先 HTML，缓存优先静态资源 |
| `manifest.json` | PWA 配置，standalone 模式 |
| `clear.html` | 一键清除 PWA 缓存 / IndexedDB |

## 快速开始

```bash
python3 -m http.server 8080
# 浏览器打开 http://localhost:8080
```

无需构建步骤。**开发时注意硬刷新**（Ctrl+F5）清除 SW 缓存。

## 技术细节

### 通话弱网优化
- ICE 重启 + 指数退避（1s→2s→4s→8s→16s，5 次）
- 自适应码率（100kbps–2.5Mbps，结合丢包率+RTT）
- Opus FEC/DTX，移动端 640×480/30fps + 800kbps 起始约束

### 文件传输可靠性
- 4B CRC32 校验，16 宽的滑动窗口，累计 ACK 每 10 片批量确认
- 动态分片大小（4KB–256KB 基于吞吐量）
- 断线重传（最多 5 次），连接关闭自动清理

### 安全
- 所有用户输入经过 `escapeHTML` 防 XSS
- 图片 URL 仅允许 `http://` / `https://` 协议
- 多 TURN 中继服务器，SRTP 加密

## 部署

```bash
git push origin main
```

GitHub Pages 自动从 `main` 分支部署。
