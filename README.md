# P2P 安全通信 · 房间直连

基于 [PeerJS](https://peerjs.com/) 的纯静态 P2P 聊天 PWA，无需注册账号，约定房间号即可直连。

**地址**：https://unplage.github.io/p2p-chat/

## 功能

| 功能 | 说明 |
|---|---|
| 文字 / 图片 / 语音消息 | 图片自动压缩至 800px JPEG 0.6，语音限 60s |
| 视频 / 语音通话 | 自适应码率、ICE 重启恢复、Opus FEC/DTX |
| 文件传输 | CRC32 校验 + ACK/NACK 滑动窗口 + 缺口补发 + 断点续传 |
| 流式磁盘写入 | 支持 FileSystem Access API 直接保存大文件 |
| 语音优先自适应 | 音频高优先级，视频按丢包/RTT/带宽平滑降档但不中断 |
| 网络质量监控 | 标题栏徽标 + 面板：连接路径、RTT、丢包、抖动、码率、当前档位 |
| 服务器自定义 | 信令服务器、TURN/STUN、ICE 策略、码率上限、省流量模式 |

## 架构

单页 PWA，无构建工具、无 npm 依赖（PeerJS 已随仓库本地托管）。

| 文件 | 作用 |
|---|---|
| `index.html` | UI + 业务逻辑（消息、通话、文件传输） |
| `net.js` | 网络模块：统计采集、语音优先 ABR、网络切换恢复、服务器设置、状态面板 |
| `peerjs.min.js` | PeerJS 1.5.2（本地副本，离线可用） |
| `sw.js` | Service Worker，网络优先 HTML，缓存优先静态资源 |
| `manifest.json` | PWA 配置，standalone 模式 |
| `icons/` | PWA 图标（192/512 any + maskable、apple-touch-icon、favicon） |
| `tools/make_icons.py` | 图标生成脚本（`python3 tools/make_icons.py`，需 cairosvg + Pillow） |
| `tools/test_net.mjs` | 离线自检（`node tools/test_net.mjs`）：ABR 决策 + 二进制帧协议 |
| `clear.html` | 一键清除 PWA 缓存 / IndexedDB |
| `android/` | Android WebView 包装层（Gradle 工程，音频路由/网络回调/大文件落盘） |

## 快速开始

```bash
python3 -m http.server 8080
# 浏览器打开 http://localhost:8080
```

无需构建步骤。**开发时注意硬刷新**（Ctrl+F5）清除 SW 缓存。

## 技术细节

### 通话弱网优化（`net.js`）
- 9 档视频码率（60kbps–2Mbps）按分辨率/帧率联动，最低档保留画面不自动关视频
- 语音优先：音频 `priority=high` + 48kbps 上限；视频 `priority=low` 让路
- 音频丢包 >2% 立即降档，RTT >400ms / 带宽受限 / 实测码率不足同样降档
- 升档需连续 2 次采样达标且距上次调整 ≥6s，避免抖动
- Opus FEC/DTX；ICE 重启 + 指数退避（1s→2s→4s→8s→16s，5 次）
- 网络类型变化 / 8s 无收发（黑洞）自动 ICE 重启（15s 冷却）
- 设置面板可切换信令服务器、TURN、`iceTransportPolicy=relay` 强制中继

### 文件传输可靠性
- 二进制帧协议：`[magic 'P2PF'][type][flags][reserved][seq][crc32][payload]`，兼容旧 8 字节头
- 16KB 分片（低于 PeerJS 16300 的 chunk MTU），通话中降为 8KB 给语音让路
- 滑动窗口按实测吞吐×RTT 自适应（8–64，通话中 ≤8），累计 ACK 每 10 片批量确认
- 缺口检测主动 NACK 补发（1 次/秒），重传分片去重不重复写盘
- 背压保护：PeerJS 缓冲 >64 条或 DataChannel 积压 >4MB 时暂停发送
- 断点续传：`fileId`（文件名+大小+修改时间）匹配后从断点续传
- 停滞保护（60s 无进展失败），连接关闭自动清理

### 语音消息
- 二进制帧直传（不再 base64，省 33% 流量），头部保留位携带时长
- 接收端 `Blob` + `URL.createObjectURL` 播放；跨版本兼容旧 base64 消息

### 安全
- 所有用户输入经过 `escapeHTML` 防 XSS
- 图片 URL 仅允许 `http://` / `https://` 协议
- 多 TURN 中继服务器，SRTP 加密

### 缓存隔离（GitHub Pages 多 PWA 共存）
- 缓存名格式 `pwa-cache-<项目>--v<版本>`，项目名取自 `sw.js` 自身路径
- `activate` 只删除本项目前缀的旧缓存，其它 PWA 的缓存一律不动
- 所有缓存查找都限定在本项目缓存内，只拦截本项目作用域的同源 GET 请求

## 部署

```bash
git push origin main
```

GitHub Pages 自动从 `main` 分支部署。
