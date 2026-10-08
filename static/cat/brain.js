// 猫的小脑：16 → 16(tanh) → 6 的 MLP，只决定「下一步做什么」，走路和动画还是 ai.js 的规则。
// 初始权重由 tools/distill.mjs 从旧版状态转移表蒸馏出来；之后用访客的互动做 REINFORCE，
// 权重存在 localStorage，每个浏览器里的猫各长各的。
(function () {
    const ACTIONS = ['walk', 'sit', 'lick', 'sleep', 'alert', 'approach'];
    const STATES = ['walk', 'sit', 'lick', 'sleep', 'alert', 'chase', 'approach'];
    const N_IN = 16, N_HID = 16, N_OUT = ACTIONS.length;
    const STORAGE_KEY = 'cat-brain-v1';

    const LR = 0.03;
    const DISCOUNT = 0.85;   // 每过 1 秒，奖励对之前决策的功劳打一次折
    const HORIZON_MS = 20000; // 超过 20 秒的决策不再分功劳
    const EXPLORE = 0.05;    // 5% 概率在可选动作里均匀乱选
    const ANCHOR = 0.005;    // 每次更新往初始权重拉回一点，防止被几次偶然奖励带偏

    // BEGIN WEIGHTS（tools/distill.mjs 生成，别手改）
    const INIT = {"W1":[0.1107,-2.7176,0.7718,1.1217,-0.1324,0.6575,-0.0671,-3.3113,0.0844,0.3779,0.577,0.2712,0.9761,0.0475,0.0102,-0.0118,0.8222,-0.912,1.4029,-1.2502,-0.2555,-0.5673,0.1228,-0.9195,-0.0007,0.0231,-0.0166,0.039,-0.0257,-0.0169,0.0029,0.0022,2.6953,-1.3255,-1.1618,-1.1851,0.1247,2.3906,0.2317,-1.2991,-0.0172,-0.1141,-0.0881,-0.1488,-0.1384,0.003,-0.0093,-0.0052,0.1234,-1.0749,-0.0807,0.628,-0.0644,0.1287,-0.2683,-0.5764,0.1066,-0.0111,0.088,0.1079,-0.1901,0.0434,-0.0015,0.0239,2.4687,-0.4305,-0.6071,-0.734,0.4341,-0.3577,0.2269,-0.4122,-0.1011,-0.3718,-0.3399,-0.262,-0.3755,-0.028,-0.0022,0.0149,0.3218,-0.1976,0.3342,0.0025,0.0688,-0.3378,0.1758,0.0658,-0.1503,-0.0915,0.206,-0.7957,-0.3325,-0.0296,-0.0155,0.0038,11.0464,-0.7596,-0.8052,-0.7588,-0.108,-0.8692,-0.1501,-0.7822,-0.0892,-0.3589,-0.2618,-0.143,-0.294,-0.07,-0.0196,-0.0066,0.4736,-0.584,-0.3488,0.3088,0.0369,0.4102,-0.269,-0.737,-0.0072,0.2138,-0.0123,-0.191,-0.1545,-0.0185,0.0042,-0.0045,-1.8759,-0.0573,0.0053,0.0464,0.2216,-0.1524,0.0653,-0.0535,0.0211,0.2713,0.1201,-0.1484,0.1489,-0.0144,-0.0052,-0.0028,0.1263,-0.0711,-0.2976,-0.3931,0.0977,-0.1937,-0.1803,-0.1568,-0.0044,-0.0199,-0.5482,-3.0563,-0.2952,-0.0387,0.0019,0.0068,-0.0235,0.4909,0.3742,-1.251,0.0319,0.017,0.2619,0.3457,0.1257,0.516,0.2549,-0.3771,0.2551,0.0686,0.0011,-0.0065,1.0309,-0.2224,-0.2635,0.5003,0.2034,0.326,-0.3742,-0.3919,-0.07,-0.1685,-0.2465,-0.1951,-0.0139,-0.0079,0.0084,0.0013,0.2015,-0.5211,-0.2971,0.032,0.0988,0.1395,0.4321,-0.2299,-0.059,0.0418,-0.9695,-2.8178,-0.7404,0.0379,0.0152,-0.0077,-0.2919,0.5702,-0.5262,0.0302,-0.0886,0.3238,-0.1306,0.3373,-0.0734,0.2553,0.3496,-0.7381,0.514,-0.0058,-0.0298,-0.0382,-0.012,-0.3937,0.8868,0.6567,-0.0893,0.729,0.283,-1.1313,-0.0017,0.4864,-5.6101,0.0956,-9.7587,0.0151,-0.0371,-0.0188,0.0972,2.2132,0.5519,-0.4446,-0.5663,-0.6841,0.0074,-0.64,-0.0207,-0.0523,3.152,-0.082,4.2352,-0.0377,0.0236,0.0377],"b1":[0.1977,-0.7527,-1.1525,0.0899,-0.9729,-0.3026,-1.6911,0.0524,0.2292,-0.4322,-0.3335,0.1366,-0.4851,0.0735,0.3448,0.0154],"W2":[0.6383,-0.1599,0.719,0.0683,0.6104,-0.2078,0.9038,-0.0102,0.5252,-0.3062,-0.0069,-0.2484,-0.1076,0.1293,-0.7125,0.1754,0.4579,-0.791,0.0034,0.0961,-0.2655,0.0776,-0.3637,0.2698,-0.3036,-0.2389,-0.235,0.3009,0.1777,0.0629,-0.7599,0.1483,0.144,1.1823,-0.3198,-0.5326,0.2417,0.2125,0.1265,-0.4488,-0.1171,-0.0046,0.477,-0.297,-0.1778,-0.2258,-0.6405,0.0176,-0.2723,0.2246,-1.953,-0.2707,-0.8342,0.24,-0.9161,0.0809,-1.1733,0.1966,-0.0733,0.0122,0.4294,-0.0187,-0.6704,0.2078,-0.4967,-0.4414,-0.0821,-0.373,0.2563,-0.0881,0.1271,-0.0081,0.0144,-0.6195,0.3201,-0.0018,-0.7524,0.2677,1.8941,-0.8851,0.583,-0.2786,0.392,0.2559,-0.291,0.1395,0.2247,0.3394,0.3832,0.1907,0.1024,0.2015,1.0569,0.3344,0.2121,2.5671],"b2":[0.1813,0.2145,-0.4101,-0.315,0.1088,-0.2421]};
    // END WEIGHTS

    // c: { energy, state, stateTicks, mouseInside, mouseDist, mouseSpeed, mouseIdle, scrollSpeed, hour }
    function features(c) {
        const x = new Float64Array(N_IN);
        x[0] = c.energy / 100;
        x[1 + STATES.indexOf(c.state)] = 1;
        x[8] = Math.min(c.stateTicks / 300, 1);
        x[9] = c.mouseInside ? 1 : 0;
        x[10] = c.mouseInside ? Math.min(c.mouseDist / 800, 1) : 1;
        x[11] = Math.min(c.mouseSpeed / 2000, 1);
        x[12] = c.mouseInside ? Math.min(c.mouseIdle / 10000, 1) : 1;
        x[13] = Math.min(c.scrollSpeed / 3000, 1);
        x[14] = Math.sin(2 * Math.PI * c.hour / 24);
        x[15] = Math.cos(2 * Math.PI * c.hour / 24);
        return x;
    }

    function toTyped(w) {
        return {
            W1: Float64Array.from(w.W1), b1: Float64Array.from(w.b1),
            W2: Float64Array.from(w.W2), b2: Float64Array.from(w.b2),
        };
    }

    function randomWeights() {
        const g = (n, s) => Float64Array.from({ length: n }, () => (Math.random() * 2 - 1) * s);
        return { W1: g(N_HID * N_IN, 0.4), b1: g(N_HID, 0), W2: g(N_OUT * N_HID, 0.4), b2: g(N_OUT, 0) };
    }

    function forward(w, x) {
        const h = new Float64Array(N_HID);
        for (let j = 0; j < N_HID; j++) {
            let s = w.b1[j];
            for (let k = 0; k < N_IN; k++) s += w.W1[j * N_IN + k] * x[k];
            h[j] = Math.tanh(s);
        }
        const z = new Float64Array(N_OUT);
        for (let i = 0; i < N_OUT; i++) {
            let s = w.b2[i];
            for (let j = 0; j < N_HID; j++) s += w.W2[i * N_HID + j] * h[j];
            z[i] = s;
        }
        return { h, z };
    }

    // 只在 mask 为 true 的动作上做 softmax，其余概率为 0
    function maskedSoftmax(z, mask) {
        let max = -Infinity;
        for (let i = 0; i < z.length; i++) if (mask[i]) max = Math.max(max, z[i]);
        const p = new Float64Array(z.length);
        let sum = 0;
        for (let i = 0; i < z.length; i++) if (mask[i]) sum += (p[i] = Math.exp(z[i] - max));
        for (let i = 0; i < z.length; i++) p[i] /= sum;
        return p;
    }

    class Brain {
        constructor() {
            this.init = INIT ? toTyped(INIT) : randomWeights();
            this.reset(false);
            this.load();
        }

        reset(persist = true) {
            this.w = toTyped(this.init);
            this.history = [];
            this.stats = { reward: 0, updates: 0, pet: 0, treat: 0, play: 0, flee: 0 };
            this.last = null;
            if (persist) {
                try { localStorage.removeItem(STORAGE_KEY); } catch (e) { /* 隐私模式等 */ }
            }
        }

        probs(ctx, mask) {
            return maskedSoftmax(forward(this.w, features(ctx)).z, mask);
        }

        decide(ctx, mask, now) {
            const x = features(ctx);
            const p = maskedSoftmax(forward(this.w, x).z, mask);
            const n = mask.filter(Boolean).length;
            let r = Math.random(), a = mask.indexOf(true);
            for (let i = 0; i < N_OUT; i++) {
                if (!mask[i]) continue;
                if ((r -= (1 - EXPLORE) * p[i] + EXPLORE / n) < 0) { a = i; break; }
            }
            this.history.push({ x, mask, a, t: now });
            this.history = this.history.filter((d) => now - d.t < HORIZON_MS).slice(-16);
            return ACTIONS[a];
        }

        // 奖励按时间折扣分给最近的决策，逐个做一步策略梯度
        reward(r, why, now) {
            this.stats.reward += r;
            this.stats[why] = (this.stats[why] || 0) + 1;
            this.last = { r, why, at: now };
            this.history = this.history.filter((d) => now - d.t < HORIZON_MS);
            for (const d of this.history) {
                this.step(d, r * Math.pow(DISCOUNT, (now - d.t) / 1000));
            }
            const w = this.w.W2, w0 = this.init.W2;
            for (let i = 0; i < w.length; i++) w[i] += ANCHOR * (w0[i] - w[i]);
            this.stats.updates++;
            this.save();
        }

        // ∇ log π(a|x) · adv，对 logits 的梯度是 onehot(a) - p（只在 mask 内）。
        // 只更新 W2：隐层特征保持蒸馏出来的样子，改动只作用在隐层激活相似的场景上。
        // 连 b2 / W1 一起更新的话，奖励「坐着不理鼠标」会让猫在所有场景下都更爱坐。
        step(d, adv) {
            const w = this.w;
            const { h, z } = forward(w, d.x);
            const p = maskedSoftmax(z, d.mask);
            const gz = new Float64Array(N_OUT);
            let norm = 0;
            for (let i = 0; i < N_OUT; i++) {
                if (d.mask[i]) gz[i] = adv * ((i === d.a ? 1 : 0) - p[i]);
                norm += gz[i] * gz[i];
            }
            const scale = norm > 1 ? 1 / Math.sqrt(norm) : 1; // 梯度裁剪
            for (let i = 0; i < N_OUT; i++) {
                for (let j = 0; j < N_HID; j++) w.W2[i * N_HID + j] += LR * scale * gz[i] * h[j];
            }
        }

        save() {
            try {
                const w = {};
                for (const k of ['W1', 'b1', 'W2', 'b2']) w[k] = Array.from(this.w[k]);
                localStorage.setItem(STORAGE_KEY, JSON.stringify({ w, stats: this.stats }));
            } catch (e) { /* 存不了就只活在这一页 */ }
        }

        load() {
            try {
                const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
                if (!saved || saved.w.W1.length !== N_HID * N_IN || saved.w.W2.length !== N_OUT * N_HID) return;
                this.w = toTyped(saved.w);
                Object.assign(this.stats, saved.stats);
            } catch (e) { /* 没存过或者坏了，用初始权重 */ }
        }
    }

    globalThis.CatBrain = { ACTIONS, STATES, N_IN, N_HID, N_OUT, features, Brain };
})();
