// tools/test_net.mjs - 离线自检脚本（零依赖，node tools/test_net.mjs）
// 覆盖：语音优先 ABR 决策、码率档位上限、二进制帧协议往返与旧格式兼容

import assert from 'node:assert';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// ---------- 1. net.js：ABR 决策 ----------
const netCode = fs.readFileSync(path.join(ROOT, 'net.js'), 'utf8');
const netSandbox = { console, module: { exports: {} } };
netSandbox.globalThis = netSandbox;
vm.createContext(netSandbox);
vm.runInContext(netCode, netSandbox);
const { decideTier, tierCapByBandwidth, VIDEO_TIERS, AUDIO_TIERS } = netSandbox.module.exports;

const baseInput = {
    now: 10000, audioLoss: 0, totalLoss: 0, rtt: 0.05,
    bandwidthLimited: false, actualRatio: 1, maxTier: 8
};

// 音频丢包 → 立即降档
let s = { tier: 4, upStreak: 0, lastChangeTs: 0 };
let r = decideTier({ ...baseInput, audioLoss: 0.05, totalLoss: 0.05 }, s);
assert.strictEqual(r.dir, 'down');
assert.strictEqual(r.tier, 3);
assert.ok(r.reason.includes('音频丢包'));

// RTT 过高 → 降档
s = { tier: 5, upStreak: 0, lastChangeTs: 0 };
r = decideTier({ ...baseInput, rtt: 0.6 }, s);
assert.strictEqual(r.dir, 'down');
assert.strictEqual(r.tier, 4);

// 带宽受限 → 降档
s = { tier: 2, upStreak: 0, lastChangeTs: 0 };
r = decideTier({ ...baseInput, bandwidthLimited: true }, s);
assert.strictEqual(r.dir, 'down');
assert.strictEqual(r.tier, 1);

// 实际码率低于目标 → 降档
s = { tier: 3, upStreak: 0, lastChangeTs: 0 };
r = decideTier({ ...baseInput, actualRatio: 0.5 }, s);
assert.strictEqual(r.dir, 'down');

// 3 秒冷却期内不重复降档
s = { tier: 4, upStreak: 0, lastChangeTs: 9000 };
r = decideTier({ ...baseInput, audioLoss: 0.2, totalLoss: 0.2 }, s);
assert.strictEqual(r.dir, 'hold');
assert.strictEqual(r.tier, 4);

// 升档需连续两次达标
s = { tier: 2, upStreak: 0, lastChangeTs: 0 };
r = decideTier({ ...baseInput, now: 20000 }, s);
assert.strictEqual(r.dir, 'hold');
r = decideTier({ ...baseInput, now: 22000 }, s);
assert.strictEqual(r.dir, 'up');
assert.strictEqual(r.tier, 3);

// 升档受 maxTier 约束
s = { tier: 7, upStreak: 0, lastChangeTs: 0 };
decideTier({ ...baseInput, now: 20000, maxTier: 7 }, s);
decideTier({ ...baseInput, now: 22000, maxTier: 7 }, s);
assert.strictEqual(s.tier, 7);

// 最低档不再下降（保留画面，不自动关闭视频）
s = { tier: 0, upStreak: 0, lastChangeTs: 0 };
r = decideTier({ ...baseInput, audioLoss: 0.5, totalLoss: 0.5, rtt: 1, bandwidthLimited: true, actualRatio: 0.1 }, s);
assert.strictEqual(r.tier, 0);

// 档位上限计算
assert.strictEqual(tierCapByBandwidth(null, 2000000), VIDEO_TIERS.length - 1);
assert.ok(tierCapByBandwidth(300000, 2500000) <= 3);
assert.strictEqual(VIDEO_TIERS[0].bitrate, 60000);
assert.ok(VIDEO_TIERS.every(t => t.scale >= 1 && t.fps >= 10));
assert.ok(AUDIO_TIERS.includes(48000));
console.log('✓ ABR 决策与档位上限');

// ---------- 2. index.html：二进制帧协议 ----------
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

function grab(name) {
    const start = html.indexOf(`function ${name}(`);
    if (start < 0) throw new Error('未找到函数: ' + name);
    let i = html.indexOf('{', start), depth = 0;
    for (; i < html.length; i++) {
        if (html[i] === '{') depth++;
        else if (html[i] === '}') { depth--; if (depth === 0) { i++; break; } }
    }
    return html.slice(start, i);
}

const crcTableSrc = html.slice(
    html.indexOf('const crc32Table = new Uint32Array(256);'),
    html.indexOf('function crc32(buf)')
);
const harness = [
    crcTableSrc,
    grab('crc32'),
    'const FRAME_MAGIC = 0x50325046;',
    'const FRAME_TYPE_FILE = 1;',
    'const FRAME_TYPE_VOICE = 2;',
    'const FRAME_HEADER = 16;',
    grab('buildFrame'),
    grab('buildChunkPacket'),
    grab('buildVoiceFrame'),
    grab('parseFrame'),
    grab('toArrayBuffer'),
    'globalThis.__t = { buildFrame, buildChunkPacket, buildVoiceFrame, parseFrame, toArrayBuffer, crc32 };'
].join('\n');
const frameSandbox = { console, Uint8Array, ArrayBuffer, DataView, Math, JSON };
frameSandbox.globalThis = frameSandbox;
vm.createContext(frameSandbox);
vm.runInContext(harness, frameSandbox);
const T = frameSandbox.__t;

const payload = new Uint8Array([1, 2, 3, 4, 5, 250, 251]);
const parsed = T.parseFrame(T.buildChunkPacket(42, payload));
assert.strictEqual(parsed.type, 1);
assert.strictEqual(parsed.seq, 42);
assert.strictEqual(parsed.crc, T.crc32(payload));
assert.deepStrictEqual([...parsed.data], [...payload]);
assert.strictEqual(parsed.legacy, false);

const voice = T.parseFrame(T.buildVoiceFrame(7.6, payload));
assert.strictEqual(voice.type, 2);
assert.strictEqual(voice.duration, 8);
assert.deepStrictEqual([...voice.data], [...payload]);

// 旧协议 [4B seq][4B crc][data] 兼容
const legacyBuf = new ArrayBuffer(8 + payload.length);
const lv = new DataView(legacyBuf);
lv.setUint32(0, 7, false);
lv.setUint32(4, T.crc32(payload), false);
new Uint8Array(legacyBuf, 8).set(payload);
const legacy = T.parseFrame(legacyBuf);
assert.strictEqual(legacy.type, 1);
assert.strictEqual(legacy.seq, 7);
assert.strictEqual(legacy.legacy, true);
assert.deepStrictEqual([...legacy.data], [...payload]);

// 视图裁剪
const view = new Uint8Array([9, 8, 7, 6, 5]).subarray(1, 4);
assert.deepStrictEqual([...new Uint8Array(T.toArrayBuffer(view))], [8, 7, 6]);
console.log('✓ 二进制帧协议往返 / 旧格式兼容');

console.log('\n全部自检通过 ✅');
