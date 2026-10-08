// 把旧版的状态转移表蒸馏进 static/cat/brain.js 的初始权重，让网络上线第一天的行为和规则版一致。
// 用法：node tools/distill.mjs
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const BRAIN = path.join(import.meta.dirname, '../static/cat/brain.js');
const src = fs.readFileSync(BRAIN, 'utf8');
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(src, sandbox);
const { ACTIONS, N_IN, N_HID, N_OUT, features } = sandbox.CatBrain;

// 可复现的随机数
let seed = 42;
const rnd = () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const rand = (lo, hi) => lo + rnd() * (hi - lo);
const choice = (xs) => xs[Math.floor(rnd() * xs.length)];
const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());

// ---- 老师：旧版 ai.js 的规则 ----
const TABLE = {
    walk:  { walk: 2, sit: 3, lick: 1, alert: 1 },
    sit:   { lick: 3, walk: 2, sleep: 2, sit: 1 },
    lick:  { sit: 3, walk: 1, sleep: 0.5 },
    alert: { walk: 2, sit: 1 },
};
TABLE.approach = TABLE.walk;

const nearMoving = (c) => c.mouseInside && c.mouseDist < 160 && c.mouseIdle < 400;
const idleAvail = (c) => c.mouseInside && c.mouseIdle > 3000 && c.mouseDist > 90;

function teacher(c) {
    const w = { ...TABLE[c.state] };
    if (c.energy < 30) {
        if (w.sleep) w.sleep *= 5;
        if (w.sit) w.sit *= 2;
        if (w.walk) w.walk *= 0.3;
    } else if (c.energy > 80) {
        if (w.sleep) w.sleep *= 0.1;
        if (w.walk) w.walk *= 2;
    }
    if (nearMoving(c)) w.alert = (w.alert || 0) + 8; // 旧版：鼠标在旁边晃，几乎一定警觉
    if (idleAvail(c)) w.approach = 2;                // 旧版：鼠标停住后迟早会走过去
    return ACTIONS.map((a) => w[a] || 0);
}

// 和 ai.js 里的三种决策点一致
function masks(c) {
    const timed = ['walk', 'sit', 'lick', 'alert'];
    if (c.state === 'sit' || c.state === 'lick') timed.push('sleep');
    if (idleAvail(c)) timed.push('approach');
    const out = [timed];
    if (nearMoving(c) && c.state !== 'alert') out.push([c.state, 'alert']);
    if (idleAvail(c) && ['walk', 'sit', 'lick'].includes(c.state)) out.push([c.state, 'approach']);
    return out.map((names) => ACTIONS.map((a) => names.includes(a)));
}

function sampleCtx() {
    const inside = rnd() < 0.6;
    const moving = inside && rnd() < 0.5;
    return {
        energy: rand(0, 100),
        state: choice(['walk', 'sit', 'lick', 'alert', 'approach']),
        stateTicks: rand(0, 400),
        mouseInside: inside,
        mouseDist: rnd() < 0.4 ? rand(0, 200) : rand(0, 1000),
        mouseSpeed: moving ? rand(50, 2500) : 0,
        mouseIdle: moving ? rand(0, 400) : rand(0, 15000),
        scrollSpeed: rnd() < 0.7 ? 0 : rand(0, 4000),
        hour: rand(0, 24),
    };
}

function sample() {
    const c = sampleCtx();
    const mask = choice(masks(c));
    const t = teacher(c).map((v, i) => (mask[i] ? v : 0));
    const n = mask.filter(Boolean).length;
    const sum = t.reduce((a, b) => a + b, 0);
    // 标签平滑：老师给 0 的动作也留一点点概率，猫不会彻底学死
    const target = t.map((v, i) => (mask[i] ? 0.97 * (sum > 0 ? v / sum : 1 / n) + 0.03 / n : 0));
    return { x: features(c), mask, target, c };
}

// ---- 网络 + Adam ----
const P = {
    W1: Float64Array.from({ length: N_HID * N_IN }, () => gauss() / Math.sqrt(N_IN)),
    b1: new Float64Array(N_HID),
    W2: Float64Array.from({ length: N_OUT * N_HID }, () => gauss() / Math.sqrt(N_HID)),
    b2: new Float64Array(N_OUT),
};
const M = Object.fromEntries(Object.entries(P).map(([k, v]) => [k, new Float64Array(v.length)]));
const V = Object.fromEntries(Object.entries(P).map(([k, v]) => [k, new Float64Array(v.length)]));

function forward(x) {
    const h = new Float64Array(N_HID);
    for (let j = 0; j < N_HID; j++) {
        let s = P.b1[j];
        for (let k = 0; k < N_IN; k++) s += P.W1[j * N_IN + k] * x[k];
        h[j] = Math.tanh(s);
    }
    const z = new Float64Array(N_OUT);
    for (let i = 0; i < N_OUT; i++) {
        let s = P.b2[i];
        for (let j = 0; j < N_HID; j++) s += P.W2[i * N_HID + j] * h[j];
        z[i] = s;
    }
    return { h, z };
}

function softmax(z, mask) {
    const max = Math.max(...z.filter((_, i) => mask[i]));
    const e = Array.from(z, (v, i) => (mask[i] ? Math.exp(v - max) : 0));
    const s = e.reduce((a, b) => a + b, 0);
    return e.map((v) => v / s);
}

function kl(target, p) {
    let s = 0;
    for (let i = 0; i < target.length; i++) if (target[i] > 0) s += target[i] * Math.log(target[i] / p[i]);
    return s;
}

const STEPS = 6000, BATCH = 128, LR = 0.01, B1 = 0.9, B2 = 0.999;
for (let step = 1; step <= STEPS; step++) {
    const G = Object.fromEntries(Object.entries(P).map(([k, v]) => [k, new Float64Array(v.length)]));
    for (let b = 0; b < BATCH; b++) {
        const { x, mask, target } = sample();
        const { h, z } = forward(x);
        const p = softmax(z, mask);
        const gz = p.map((v, i) => (mask[i] ? (v - target[i]) / BATCH : 0));
        for (let i = 0; i < N_OUT; i++) {
            G.b2[i] += gz[i];
            for (let j = 0; j < N_HID; j++) G.W2[i * N_HID + j] += gz[i] * h[j];
        }
        for (let j = 0; j < N_HID; j++) {
            let s = 0;
            for (let i = 0; i < N_OUT; i++) s += gz[i] * P.W2[i * N_HID + j];
            const gh = s * (1 - h[j] * h[j]);
            G.b1[j] += gh;
            for (let k = 0; k < N_IN; k++) G.W1[j * N_IN + k] += gh * x[k];
        }
    }
    const lr = LR * (step > STEPS * 0.7 ? 0.3 : 1);
    for (const k of Object.keys(P)) {
        for (let i = 0; i < P[k].length; i++) {
            M[k][i] = B1 * M[k][i] + (1 - B1) * G[k][i];
            V[k][i] = B2 * V[k][i] + (1 - B2) * G[k][i] ** 2;
            const mh = M[k][i] / (1 - B1 ** step), vh = V[k][i] / (1 - B2 ** step);
            P[k][i] -= lr * mh / (Math.sqrt(vh) + 1e-8);
        }
    }
    if (step % 1000 === 0) {
        let loss = 0;
        for (let n = 0; n < 2000; n++) {
            const s = sample();
            loss += kl(s.target, softmax(forward(s.x).z, s.mask));
        }
        console.log(`step ${step}  KL(老师‖网络) = ${(loss / 2000).toFixed(4)}`);
    }
}

// ---- 抽几个场景对比一下 ----
const fmt = (p, mask) => ACTIONS.map((a, i) => (mask[i] ? `${a} ${(p[i] * 100).toFixed(0).padStart(3)}%` : '')).filter(Boolean).join('  ');
const cases = [
    ['坐着、精力足、没鼠标', { state: 'sit', energy: 90, mouseInside: false }],
    ['坐着、很累、没鼠标', { state: 'sit', energy: 15, mouseInside: false }],
    ['走路、精力中等、没鼠标', { state: 'walk', energy: 50, mouseInside: false }],
    ['坐着、鼠标在旁边晃（只选 继续坐/警觉）', { state: 'sit', energy: 50, mouseInside: true, mouseDist: 100, mouseIdle: 100, mouseSpeed: 800 }, ['sit', 'alert']],
    ['舔爪、鼠标停在远处 5 秒（只选 继续舔/走过去）', { state: 'lick', energy: 50, mouseInside: true, mouseDist: 400, mouseIdle: 5000 }, ['lick', 'approach']],
];
for (const [name, partial, only] of cases) {
    const c = { stateTicks: 50, mouseDist: 1000, mouseSpeed: 0, mouseIdle: 20000, scrollSpeed: 0, hour: 14, ...partial };
    const mask = only ? ACTIONS.map((a) => only.includes(a)) : masks(c)[0];
    const t = teacher(c).map((v, i) => (mask[i] ? v : 0));
    const s = t.reduce((a, b) => a + b, 0);
    console.log(`\n${name}\n  老师  ${fmt(t.map((v) => v / s), mask)}\n  网络  ${fmt(softmax(forward(features(c)).z, mask), mask)}`);
}

// ---- 写回 brain.js ----
const round = (a) => Array.from(a, (v) => Math.round(v * 1e4) / 1e4);
const weights = JSON.stringify({ W1: round(P.W1), b1: round(P.b1), W2: round(P.W2), b2: round(P.b2) });
const out = src.replace(
    /\/\/ BEGIN WEIGHTS[^\n]*\n[\s\S]*?\/\/ END WEIGHTS/,
    `// BEGIN WEIGHTS（tools/distill.mjs 生成，别手改）\n    const INIT = ${weights};\n    // END WEIGHTS`,
);
fs.writeFileSync(BRAIN, out);
console.log(`\n已写入 ${path.relative(process.cwd(), BRAIN)}`);
