// net.js - 网络自适应模块（独立于 index.html，便于维护与离线测试）
// 职责：网络探测 / WebRTC 统计采集 / 语音优先自适应码率 / 网络切换恢复 / 服务器设置 / 状态面板

(function (global) {
    'use strict';

    const SETTINGS_KEY = 'p2p.net.settings.v1';
    const STATS_INTERVAL = 1000;       // 统计采样周期（ms）
    const BLACKHOLE_MS = 8000;         // 无收发判定黑洞的阈值（ms）
    const ICE_RESTART_COOLDOWN = 15000;// ICE 重启最小间隔（ms）

    // ---------------- 默认配置 ----------------
    const DEFAULTS = {
        signaling: {
            host: '0.peerjs.com',
            port: 443,
            path: '/',
            secure: true,
            key: 'peerjs'
        },
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
            { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
            { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
            { urls: 'turn:openrelay.metered.ca:5349', username: 'openrelayproject', credential: 'openrelayproject' },
            { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
            { urls: 'turns:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' }
        ],
        iceTransportPolicy: 'all',      // all | relay
        videoMaxBitrate: 2500000,       // 视频码率上限（bps）
        dataSaver: false,               // 省流量模式
        showStats: false                // 常驻显示网络面板
    };

    // 视频码率档位（从低到高），最低档仍保留画面，不自动关闭视频
    const VIDEO_TIERS = [
        { bitrate: 60000, scale: 6, fps: 10, label: '160p@10' },
        { bitrate: 100000, scale: 4, fps: 15, label: '240p@15' },
        { bitrate: 160000, scale: 3, fps: 15, label: '320p@15' },
        { bitrate: 250000, scale: 2, fps: 20, label: '480p@20' },
        { bitrate: 400000, scale: 1.5, fps: 24, label: '540p@24' },
        { bitrate: 600000, scale: 1.25, fps: 24, label: '720p@24' },
        { bitrate: 900000, scale: 1, fps: 30, label: '720p@30' },
        { bitrate: 1400000, scale: 1, fps: 30, label: '1080p@30' },
        { bitrate: 2000000, scale: 1, fps: 30, label: '1080p@30' }
    ];

    // 纯语音通话时的音频码率档位（bps）
    const AUDIO_TIERS = [32000, 48000, 64000, 96000];

    // ---------------- 设置读写 ----------------
    function clone(obj) {
        return JSON.parse(JSON.stringify(obj));
    }

    let settings = clone(DEFAULTS);
    let _loaded = false;

    function loadSettings() {
        try {
            const raw = global.localStorage && global.localStorage.getItem(SETTINGS_KEY);
            if (!raw) return clone(settings);
            const parsed = JSON.parse(raw);
            settings = {
                ...clone(DEFAULTS),
                ...parsed,
                signaling: { ...clone(DEFAULTS.signaling), ...(parsed.signaling || {}) },
                iceServers: Array.isArray(parsed.iceServers) && parsed.iceServers.length
                    ? parsed.iceServers
                    : clone(DEFAULTS.iceServers)
            };
        } catch (e) {
            console.warn('[Net] 设置读取失败，使用默认值', e);
            settings = clone(DEFAULTS);
        }
        _loaded = true;
        return clone(settings);
    }

    function saveSettings(next) {
        settings = {
            ...clone(DEFAULTS),
            ...next,
            signaling: { ...clone(DEFAULTS.signaling), ...(next.signaling || {}) }
        };
        try {
            if (global.localStorage) global.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
        } catch (e) {
            console.warn('[Net] 设置保存失败', e);
        }
        return clone(settings);
    }

    function resetSettings() {
        try {
            if (global.localStorage) global.localStorage.removeItem(SETTINGS_KEY);
        } catch (e) { /* ignore */ }
        settings = clone(DEFAULTS);
        return clone(settings);
    }

    // 生成 PeerJS 选项（信令 + ICE 配置）
    function peerOptions() {
        if (!_loaded) loadSettings();
        const s = settings;
        return {
            host: s.signaling.host || DEFAULTS.signaling.host,
            port: Number(s.signaling.port) || DEFAULTS.signaling.port,
            path: s.signaling.path || '/',
            secure: s.signaling.secure !== false,
            key: s.signaling.key || 'peerjs',
            config: {
                iceServers: s.iceServers,
                iceTransportPolicy: s.iceTransportPolicy === 'relay' ? 'relay' : 'all',
                iceCandidatePoolSize: 10,
                sdpSemantics: 'unified-plan',
                bundlePolicy: 'max-bundle',
                rtcpMuxPolicy: 'require'
            }
        };
    }

    // ---------------- 网络探测 ----------------
    function connectionApi() {
        if (!global.navigator) return null;
        return global.navigator.connection || global.navigator.mozConnection || global.navigator.webkitConnection || null;
    }

    function networkInfo() {
        const conn = connectionApi();
        let type = 'unknown';
        // Android 包装层可通过 JS 桥拿到真实网络类型（Chrome 不暴露 connection.type）
        try {
            if (typeof global.Android !== 'undefined' && global.Android && typeof global.Android.getNetworkType === 'function') {
                type = global.Android.getNetworkType() || 'unknown';
            }
        } catch (e) { /* ignore */ }
        if (type === 'unknown' && conn && conn.type && conn.type !== 'unknown') {
            type = conn.type;
        }
        const effectiveType = conn ? conn.effectiveType : null;
        const downlink = conn ? conn.downlink : null;
        const rtt = conn ? conn.rtt : null;
        const saveData = conn ? !!conn.saveData : false;
        const cellular = type === 'cellular' || (type === 'unknown' && !!effectiveType && effectiveType !== '4g');
        const label = type !== 'unknown' ? type : (effectiveType ? effectiveType.toUpperCase() : '未知');
        return { type, label, effectiveType, downlink, rtt, saveData, cellular };
    }

    const networkListeners = [];
    function onNetworkChange(fn) {
        networkListeners.push(fn);
        return () => {
            const i = networkListeners.indexOf(fn);
            if (i >= 0) networkListeners.splice(i, 1);
        };
    }

    function emitNetworkChange(reason) {
        const info = networkInfo();
        networkListeners.forEach(fn => {
            try { fn(info, reason); } catch (e) { console.warn('[Net] 网络监听回调异常', e); }
        });
    }

    function bindNetworkEvents() {
        const conn = connectionApi();
        if (conn && typeof conn.addEventListener === 'function') {
            conn.addEventListener('change', () => emitNetworkChange('网络类型变化'));
        }
        if (global.addEventListener) {
            global.addEventListener('online', () => emitNetworkChange('网络恢复'));
            global.addEventListener('offline', () => emitNetworkChange('网络断开'));
        }
    }

    // ---------------- WebRTC 统计采集 ----------------
    function emptyMediaStats() {
        return { bitrate: 0, loss: null, jitter: null, rtt: null, targetBitrate: null, qualityLimited: null, framesPerSecond: null, width: null, height: null };
    }

    const Stats = {
        pc: null,
        timer: null,
        snapshot: null,
        prevOutbound: {},
        prevLost: {},
        lastBytesSent: 0,
        lastBytesRecv: 0,
        lastProgressTs: 0,

        start(pc) {
            this.stop();
            this.pc = pc;
            this.prevOutbound = {};
            this.prevLost = {};
            this.lastProgressTs = Date.now();
            this.timer = setInterval(() => this.sample(), STATS_INTERVAL);
        },

        stop() {
            if (this.timer) clearInterval(this.timer);
            this.timer = null;
            this.pc = null;
            this.snapshot = null;
        },

        async sample() {
            const pc = this.pc;
            if (!pc) return;
            try {
                const report = await pc.getStats();
                const now = Date.now();
                const snap = {
                    ts: now,
                    rtt: null,
                    bandwidth: null,
                    path: '未知',
                    audio: emptyMediaStats(),
                    video: emptyMediaStats(),
                    totalSent: 0,
                    totalRecv: 0
                };
                const candidates = {};
                const outbound = {};
                const remoteInbound = [];
                let selectedPair = null;

                // 第一遍：收集原始数据
                report.forEach(r => {
                    if (r.type === 'candidate-pair' && (r.nominated || r.selected)) {
                        if (!selectedPair || (r.state === 'succeeded' && !selectedPair.state)) selectedPair = r;
                    }
                    if (r.type === 'local-candidate' || r.type === 'remote-candidate') {
                        candidates[r.id] = r;
                    }
                    if (r.type === 'outbound-rtp') {
                        outbound[r.id] = r;
                    }
                    if (r.type === 'remote-inbound-rtp') {
                        remoteInbound.push(r);
                    }
                    if (r.type === 'inbound-rtp') {
                        snap.totalRecv += r.bytesReceived || 0;
                        const kind = r.kind === 'audio' ? 'audio' : 'video';
                        if (snap[kind].loss == null && r.packetsLost != null && r.packetsReceived) {
                            snap[kind].loss = r.packetsLost / (r.packetsLost + r.packetsReceived);
                        }
                        if (r.jitter != null && snap[kind].jitter == null) snap[kind].jitter = r.jitter;
                    }
                    if (r.type === 'transport' && r.selectedCandidatePairId) {
                        selectedPair = report.get(r.selectedCandidatePairId) || selectedPair;
                    }
                });

                // 第二遍：计算码率增量
                for (const id in outbound) {
                    const r = outbound[id];
                    const kind = r.kind === 'audio' ? 'audio' : 'video';
                    const prev = this.prevOutbound[id] || { bytes: 0, packets: 0, ts: now - STATS_INTERVAL };
                    const dt = Math.max(0.001, (now - prev.ts) / 1000);
                    const bytes = r.bytesSent || 0;
                    const packets = r.packetsSent || 0;
                    const target = snap[kind];
                    target.bitrate += Math.max(0, (bytes - prev.bytes) * 8 / dt);
                    snap.totalSent += bytes;
                    this.prevOutbound[id] = { bytes, packets, ts: now };
                    if (r.targetBitrate) target.targetBitrate = r.targetBitrate;
                    if (r.qualityLimitationReason) target.qualityLimited = r.qualityLimitationReason;
                    if (kind === 'video') {
                        if (r.framesPerSecond != null) target.framesPerSecond = r.framesPerSecond;
                        if (r.frameWidth != null) target.width = r.frameWidth;
                        if (r.frameHeight != null) target.height = r.frameHeight;
                    }
                }

                // 第三遍：接收端视角的真实丢包 / 抖动 / RTT
                remoteInbound.forEach(r => {
                    const kind = r.kind === 'audio' ? 'audio' : 'video';
                    const lost = r.packetsLost || 0;
                    const prevLost = this.prevLost[r.id] || 0;
                    const out = r.localId ? outbound[r.localId] : null;
                    const sentNow = out ? (out.packetsSent || 0) : 0;
                    const prevSent = this.prevLost['l:' + r.id] || 0;
                    const deltaLost = Math.max(0, lost - prevLost);
                    const deltaSent = Math.max(0, sentNow - prevSent);
                    this.prevLost[r.id] = lost;
                    this.prevLost['l:' + r.id] = sentNow;
                    if (r.roundTripTime != null) snap[kind].rtt = r.roundTripTime;
                    if (r.jitter != null) snap[kind].jitter = r.jitter;
                    if (r.fractionLost != null) {
                        snap[kind].loss = r.fractionLost;
                    } else if (deltaSent + deltaLost > 0) {
                        snap[kind].loss = deltaLost / (deltaSent + deltaLost);
                    }
                });

                if (selectedPair) {
                    if (selectedPair.currentRoundTripTime != null) snap.rtt = selectedPair.currentRoundTripTime;
                    if (selectedPair.availableOutgoingBitrate) snap.bandwidth = selectedPair.availableOutgoingBitrate;
                    const local = candidates[selectedPair.localCandidateId];
                    const remote = candidates[selectedPair.remoteCandidateId];
                    const types = [local && local.candidateType, remote && remote.candidateType].filter(Boolean);
                    if (types.includes('relay')) snap.path = 'TURN 中继';
                    else if (types.every(t => t === 'host')) snap.path = '直连(局域网/公网)';
                    else snap.path = 'NAT 穿透';
                }

                // 无收发检测（网络切换黑洞）
                const moved = snap.totalSent !== this.lastBytesSent || snap.totalRecv !== this.lastBytesRecv;
                if (moved) {
                    this.lastBytesSent = snap.totalSent;
                    this.lastBytesRecv = snap.totalRecv;
                    this.lastProgressTs = now;
                }

                this.snapshot = snap;
                if (ABR.active) ABR.onStats(snap);
                NetworkWatch.onStats(snap, moved);
                UI.render(snap);
            } catch (e) {
                console.warn('[Net] 统计采集失败', e);
            }
        }
    };

    // ---------------- 自适应码率（语音优先） ----------------
    // 纯函数：给定网络指标与当前状态，决定下一档位。供离线单测使用。
    function decideTier(input, state) {
        const now = input.now || 0;
        const maxTier = input.maxTier != null ? input.maxTier : state.tier;
        const reasons = [];

        if (input.audioLoss != null && input.audioLoss > 0.02) {
            reasons.push('音频丢包 ' + (input.audioLoss * 100).toFixed(1) + '%');
        }
        if (input.totalLoss != null && input.totalLoss > 0.05) {
            reasons.push('总丢包 ' + (input.totalLoss * 100).toFixed(1) + '%');
        }
        if (input.rtt != null && input.rtt > 0.4) {
            reasons.push('RTT ' + Math.round(input.rtt * 1000) + 'ms');
        }
        if (input.bandwidthLimited) {
            reasons.push('发送带宽受限');
        }
        if (input.actualRatio != null && input.actualRatio < 0.8 && state.tier > 0) {
            reasons.push('实际码率低于目标');
        }

        if (reasons.length) {
            state.upStreak = 0;
            if (now - state.lastChangeTs < 3000) {
                return { tier: state.tier, reason: '冷却中', dir: 'hold' };
            }
            state.lastChangeTs = now;
            state.tier = Math.max(0, state.tier - 1);
            return { tier: state.tier, reason: reasons.join(' / '), dir: 'down' };
        }

        const canUp = (input.totalLoss == null || input.totalLoss < 0.01)
            && (input.rtt == null || input.rtt < 0.2)
            && !input.bandwidthLimited;
        if (!canUp) {
            state.upStreak = 0;
            return { tier: state.tier, reason: '维持', dir: 'hold' };
        }
        state.upStreak += 1;
        if (state.upStreak >= 2 && now - state.lastChangeTs >= 6000 && state.tier < maxTier) {
            state.upStreak = 0;
            state.lastChangeTs = now;
            state.tier += 1;
            return { tier: state.tier, reason: '网络良好', dir: 'up' };
        }
        return { tier: state.tier, reason: '维持', dir: 'hold' };
    }

    // 依据可用带宽计算允许的最高档位
    function tierCapByBandwidth(bandwidth, ceilingBitrate) {
        let cap = 0;
        for (let i = 0; i < VIDEO_TIERS.length; i++) {
            if (bandwidth && VIDEO_TIERS[i].bitrate > bandwidth * 0.7) break;
            cap = i;
        }
        if (ceilingBitrate) {
            let limited = 0;
            for (let i = 0; i < VIDEO_TIERS.length; i++) {
                if (VIDEO_TIERS[i].bitrate > ceilingBitrate) break;
                limited = i;
            }
            cap = Math.min(cap, limited);
        }
        return cap;
    }

    function initialTier() {
        const info = networkInfo();
        const ceiling = settings.videoMaxBitrate;
        let cap = tierCapByBandwidth(null, ceiling);
        if (info.cellular || settings.dataSaver || info.saveData) {
            cap = Math.min(cap, 3);
        }
        return cap;
    }

    const ABR = {
        active: false,
        pc: null,
        videoSender: null,
        audioSender: null,
        appliedTier: -1,
        state: { tier: 0, upStreak: 0, lastChangeTs: 0 },
        audioState: { tier: 2, upStreak: 0, lastChangeTs: 0 },
        lastReason: '未启动',

        async start(pc) {
            this.pc = pc;
            this.active = true;
            this.videoSender = pc.getSenders().find(s => s.track && s.track.kind === 'video') || null;
            this.audioSender = pc.getSenders().find(s => s.track && s.track.kind === 'audio') || null;
            this.state = { tier: initialTier(), upStreak: 0, lastChangeTs: Date.now() };
            this.audioState = { tier: 2, upStreak: 0, lastChangeTs: Date.now() };
            this.appliedTier = -1;
            await applySenderPriority(pc);
            await this.apply();
        },

        stop() {
            this.active = false;
            this.pc = null;
            this.videoSender = null;
            this.audioSender = null;
            this.appliedTier = -1;
        },

        currentTier() {
            return VIDEO_TIERS[Math.min(Math.max(0, this.state.tier), VIDEO_TIERS.length - 1)];
        },

        async apply() {
            if (!this.active) return;
            const tier = this.currentTier();
            try {
                if (this.videoSender) {
                    const params = this.videoSender.getParameters();
                    if (!params.encodings || !params.encodings.length) params.encodings = [{}];
                    const enc = params.encodings[0];
                    enc.maxBitrate = Math.min(tier.bitrate, settings.videoMaxBitrate);
                    enc.scaleResolutionDownBy = tier.scale;
                    enc.maxFramerate = tier.fps;
                    if ('degradationPreference' in params) params.degradationPreference = 'balanced';
                    await this.videoSender.setParameters(params);
                } else if (this.audioSender) {
                    // 纯语音通话：按网络状况调整音频码率
                    const bitrate = AUDIO_TIERS[Math.min(Math.max(0, this.audioState.tier), AUDIO_TIERS.length - 1)];
                    const params = this.audioSender.getParameters();
                    if (!params.encodings || !params.encodings.length) params.encodings = [{}];
                    params.encodings[0].maxBitrate = bitrate;
                    await this.audioSender.setParameters(params);
                }
                this.appliedTier = this.state.tier;
            } catch (e) {
                console.warn('[Net] 应用码率参数失败', e);
            }
        },

        onStats(snap) {
            if (!this.active) return;
            const now = snap.ts;
            const tier = this.currentTier();
            const target = snap.video.targetBitrate || tier.bitrate;
            const actualRatio = target > 0 && snap.video.bitrate > 0 ? snap.video.bitrate / target : null;
            const bandwidthLimited = snap.video.qualityLimited === 'bandwidth' || snap.audio.qualityLimited === 'bandwidth';

            if (!this.videoSender) {
                // 纯语音：仅调音频码率
                const res = decideTier({
                    now,
                    audioLoss: snap.audio.loss,
                    totalLoss: snap.audio.loss,
                    rtt: snap.rtt != null ? snap.rtt : snap.audio.rtt,
                    bandwidthLimited,
                    actualRatio: null,
                    maxTier: AUDIO_TIERS.length - 1
                }, this.audioState);
                this.lastReason = '音频 ' + (AUDIO_TIERS[this.audioState.tier] / 1000) + 'kbps · ' + res.reason;
                if (res.dir !== 'hold') {
                    this.apply().then(() => logTier('音频', res));
                }
                return;
            }

            const cap = tierCapByBandwidth(snap.bandwidth, settings.videoMaxBitrate);
            const res = decideTier({
                now,
                audioLoss: snap.audio.loss,
                totalLoss: snap.video.loss != null ? snap.video.loss : snap.audio.loss,
                rtt: snap.rtt != null ? snap.rtt : snap.video.rtt,
                bandwidthLimited,
                actualRatio,
                maxTier: cap
            }, this.state);

            this.lastReason = res.reason;
            if (res.dir !== 'hold' || this.appliedTier !== this.state.tier) {
                this.apply().then(() => {
                    if (res.dir !== 'hold') logTier('视频', res);
                });
            }
        }
    };

    function logTier(kind, res) {
        const tier = currentTierSafe();
        const msg = `📊 ${kind}码率调整(${res.dir === 'down' ? '↓降' : res.dir === 'up' ? '↑升' : '·'}): ${tier.label} ${Math.round(tier.bitrate / 1000)}kbps — ${res.reason}`;
        if (typeof global.addLog === 'function') global.addLog(msg, res.dir === 'down' ? 'warning' : 'system');
        else console.log(msg);
    }

    function currentTierSafe() {
        return ABR.currentTier();
    }

    // 设置发送端优先级：语音优先，视频让路
    async function applySenderPriority(pc) {
        const senders = pc.getSenders();
        for (const sender of senders) {
            const kind = sender.track && sender.track.kind;
            if (!kind) continue;
            try {
                const params = sender.getParameters();
                if (!params.encodings || !params.encodings.length) params.encodings = [{}];
                const enc = params.encodings[0];
                if (kind === 'audio') {
                    enc.maxBitrate = 48000;
                    enc.priority = 'high';
                    if ('networkPriority' in enc) enc.networkPriority = 'high';
                } else {
                    enc.priority = 'low';
                    if ('networkPriority' in enc) enc.networkPriority = 'low';
                }
                await sender.setParameters(params);
            } catch (e) {
                console.warn('[Net] 设置发送端优先级失败(' + kind + ')', e);
            }
            // FEC / DTX 单独设置，避免部分浏览器因类型不支持导致整次调用失败
            if (kind === 'audio') {
                try {
                    const params = sender.getParameters();
                    if (!params.encodings || !params.encodings.length) params.encodings = [{}];
                    params.encodings[0].fec = { googFecEnabled: true };
                    await sender.setParameters(params);
                } catch (e) { /* 浏览器不支持则忽略 */ }
                try {
                    const params = sender.getParameters();
                    if (!params.encodings || !params.encodings.length) params.encodings = [{}];
                    params.encodings[0].dtx = 'enabled';
                    await sender.setParameters(params);
                } catch (e) { /* 浏览器不支持则忽略 */ }
            }
        }
    }

    // ---------------- 网络切换 / 黑洞恢复 ----------------
    const NetworkWatch = {
        pc: null,
        lastRestart: 0,
        pendingReason: null,
        timer: null,

        attach(pc) {
            this.pc = pc;
        },

        detach() {
            this.pc = null;
        },

        onStats(snap, moved) {
            if (!this.pc) return;
            if (moved) return;
            // 采样期间没有任何收发 → 疑似黑洞
            const idle = Date.now() - Stats.lastProgressTs;
            if (idle > BLACKHOLE_MS && snap.totalSent > 0) {
                this.restart('连续 ' + Math.round(idle / 1000) + 's 无数据收发');
            }
        },

        restart(reason) {
            if (!this.pc) return;
            const now = Date.now();
            if (now - this.lastRestart < ICE_RESTART_COOLDOWN) return;
            this.lastRestart = now;
            const pc = this.pc;
            try {
                pc.restartIce();
                const msg = '🔄 网络异常（' + reason + '），已触发 ICE 重启';
                if (typeof global.addLog === 'function') global.addLog(msg, 'warning');
                else console.log(msg);
            } catch (e) {
                console.warn('[Net] ICE 重启失败', e);
            }
        }
    };

    // ---------------- UI ----------------
    const UI = {
        modal: null,
        badge: null,
        statusBox: null,
        enabled: false,

        init() {
            this.modal = document.getElementById('netModal');
            this.badge = document.getElementById('netBadge');
            this.statusBox = document.getElementById('netStatusBox');
            this.enabled = !!settings.showStats;
            this.bindSettingsForm();
            this.updateBadge(null);
        },

        bindSettingsForm() {
            const s = settings;
            const set = (id, value) => { const el = document.getElementById(id); if (el) el.value = value; };
            const check = (id, value) => { const el = document.getElementById(id); if (el) el.checked = !!value; };
            set('netSigHost', s.signaling.host);
            set('netSigPort', s.signaling.port);
            set('netSigPath', s.signaling.path);
            set('netSigKey', s.signaling.key);
            check('netSigSecure', s.signaling.secure);
            set('netIceServers', JSON.stringify(s.iceServers, null, 2));
            set('netIcePolicy', s.iceTransportPolicy);
            set('netMaxBitrate', Math.round(s.videoMaxBitrate / 1000));
            check('netDataSaver', s.dataSaver);
            check('netShowStats', s.showStats);
        },

        collectSettings() {
            const val = id => { const el = document.getElementById(id); return el ? el.value.trim() : ''; };
            const chk = id => { const el = document.getElementById(id); return el ? el.checked : false; };
            let iceServers = settings.iceServers;
            const raw = val('netIceServers');
            if (raw) {
                try {
                    const parsed = JSON.parse(raw);
                    if (Array.isArray(parsed) && parsed.length) iceServers = parsed;
                    else throw new Error('TURN 配置需为非空数组');
                } catch (e) {
                    alert('TURN 配置格式错误：' + e.message);
                    return null;
                }
            }
            return {
                signaling: {
                    host: val('netSigHost') || DEFAULTS.signaling.host,
                    port: Number(val('netSigPort')) || DEFAULTS.signaling.port,
                    path: val('netSigPath') || '/',
                    secure: chk('netSigSecure'),
                    key: val('netSigKey') || 'peerjs'
                },
                iceServers,
                iceTransportPolicy: val('netIcePolicy') === 'relay' ? 'relay' : 'all',
                videoMaxBitrate: Math.max(60000, (Number(val('netMaxBitrate')) || 2500) * 1000),
                dataSaver: chk('netDataSaver'),
                showStats: chk('netShowStats')
            };
        },

        open() {
            if (!this.modal) return;
            this.modal.classList.add('active');
            this.bindSettingsForm();
        },

        close() {
            if (!this.modal) return;
            this.modal.classList.remove('active');
        },

        toggle() {
            if (!this.modal) return;
            if (this.modal.classList.contains('active')) this.close();
            else this.open();
        },

        updateBadge(snap) {
            if (!this.badge) return;
            if (!settings.showStats) {
                this.badge.textContent = '📶 --';
                this.badge.title = '网络状态与服务器设置（点击打开）';
                return;
            }
            const info = networkInfo();
            const path = snap ? snap.path : '';
            const label = path ? info.label + '·' + path : info.label;
            this.badge.textContent = '📶 ' + label;
            this.badge.title = '网络状态与服务器设置（点击打开）';
        },

        render(snap) {
            this.updateBadge(snap);
            if (!this.modal || !this.modal.classList.contains('active')) return;
            if (!this.statusBox) return;
            const info = networkInfo();
            const lines = [];
            lines.push('网络：' + info.label + (info.effectiveType ? '（' + info.effectiveType + '）' : '')
                + (info.downlink ? ' 下行约 ' + info.downlink + 'Mbps' : '')
                + (info.saveData ? ' 省流量开启' : ''));
            if (snap) {
                const rtt = snap.rtt != null ? Math.round(snap.rtt * 1000) + 'ms' : '—';
                lines.push('连接路径：' + snap.path + '　RTT：' + rtt
                    + (snap.bandwidth ? '　可用带宽约 ' + Math.round(snap.bandwidth / 1000) + 'kbps' : ''));
                lines.push('音频：' + fmtBitrate(snap.audio.bitrate)
                    + '　丢包 ' + fmtPct(snap.audio.loss)
                    + '　抖动 ' + fmtMs(snap.audio.jitter)
                    + (snap.audio.qualityLimited ? '　受限:' + snap.audio.qualityLimited : ''));
                lines.push('视频：' + fmtBitrate(snap.video.bitrate)
                    + '　目标 ' + (snap.video.targetBitrate ? Math.round(snap.video.targetBitrate / 1000) + 'kbps' : '—')
                    + '　' + (snap.video.width ? snap.video.width + 'x' + snap.video.height : '—')
                    + '@' + (snap.video.framesPerSecond != null ? Math.round(snap.video.framesPerSecond) : '—')
                    + '　丢包 ' + fmtPct(snap.video.loss)
                    + (snap.video.qualityLimited ? '　受限:' + snap.video.qualityLimited : ''));
                lines.push('当前档位：' + (ABR.active ? ABR.currentTier().label : '—') + '　原因：' + ABR.lastReason);
            } else {
                lines.push('尚未建立媒体连接');
            }
            this.statusBox.innerHTML = lines.map(l => '<div class="net-line">' + escapeText(l) + '</div>').join('');
        }
    };

    function fmtBitrate(bps) {
        if (!bps) return '0kbps';
        return (bps / 1000).toFixed(0) + 'kbps';
    }
    function fmtPct(v) {
        return v == null ? '—' : (v * 100).toFixed(1) + '%';
    }
    function fmtMs(v) {
        return v == null ? '—' : Math.round(v * 1000) + 'ms';
    }
    function escapeText(s) {
        return String(s).replace(/[&<>]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[m]));
    }

    const NetUI = {
        open: () => UI.open(),
        close: () => UI.close(),
        toggle: () => UI.toggle(),
        save() {
            const next = UI.collectSettings();
            if (!next) return;
            saveSettings(next);
            UI.enabled = !!settings.showStats;
            alert('设置已保存，重新连接后生效。');
        },
        reset() {
            resetSettings();
            UI.bindSettingsForm();
            alert('已恢复默认设置，重新连接后生效。');
        }
    };

    // ---------------- 对外接口 ----------------
    const Net = {
        DEFAULTS,
        VIDEO_TIERS,
        AUDIO_TIERS,
        loadSettings,
        saveSettings,
        resetSettings,
        get settings() { return clone(settings); },
        peerOptions,
        networkInfo,
        onNetworkChange,
        notifyNetworkChanged(reason) {
            emitNetworkChange(reason || '外部通知');
        },
        Stats,
        ABR,
        NetworkWatch,
        decideTier,
        tierCapByBandwidth,
        applySenderPriority,
        init() {
            loadSettings();
            bindNetworkEvents();
            onNetworkChange((info, reason) => {
                const msg = '📶 网络变化：' + info.label + (reason ? '（' + reason + '）' : '');
                if (typeof global.addLog === 'function') global.addLog(msg, 'system');
                if (ABR.active && ABR.pc) NetworkWatch.restart(reason || '网络类型变化');
            });
            UI.init();
        }
    };

    global.Net = Net;
    global.NetUI = NetUI;

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = { Net, decideTier, VIDEO_TIERS, AUDIO_TIERS, tierCapByBandwidth };
    }
})(typeof window !== 'undefined' ? window : globalThis);
