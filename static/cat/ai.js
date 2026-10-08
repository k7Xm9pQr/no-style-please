const canvas = document.getElementById('playground');
const ctx = canvas.getContext('2d');
const img = new Image();
img.src = '/cat/cat.png';

const SIZE = 64; // 32px 整数倍放大，避免像素图发糊
const TICK_MS = 100;
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function resizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = window.innerWidth * dpr;
    canvas.height = window.innerHeight * dpr;
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = false; // 改尺寸会重置 context 状态
}

resizeCanvas();
window.addEventListener('resize', () => {
    resizeCanvas();
    cat.clamp();
});

// 精灵图每一行对应的动画
const ROW = { down: 0, right: 1, up: 2, left: 3, sit: 4, lick: 5, sleep: 6, curl: 7, wag: 8 };

class Frame {
    constructor() {
        this.animateType = 0;
        this.animateFrame = 0;
        this.ticks = 0;
    }

    dy() {
        return this.animateType * 32;
    }

    dx() {
        return this.animateFrame * 32;
    }

    change(type) {
        if (type === this.animateType) return; // 同一行不重置，走路转弯时动画不断
        this.animateType = type;
        this.animateFrame = 0;
        this.ticks = 0;
    }

    tick() {
        switch (this.animateType) {
            case ROW.down:
            case ROW.right:
            case ROW.up:
            case ROW.left:
                this.animateFrame = [0, 1, 2, 3][this.ticks % 4];
                break;
            case ROW.sit:
                this.animateFrame = [0, 1, 2, 2, 2, 2, 3, 3, 3, 3][this.ticks < 10 ? this.ticks : (this.ticks - 10) % 8 + 2];
                break;
            case ROW.lick:
                this.animateFrame = [0, 0, 1, 1, 2, 2, 3, 3][this.ticks % 8];
                break;
            case ROW.sleep:
                this.animateFrame = [0, 1, 2, 3][this.ticks < 4 ? this.ticks : 3];
                break;
            case ROW.curl:
                this.animateFrame = [0, 0, 0, 1, 1, 1, 2, 2, 2, 3, 3, 3][this.ticks % 12];
                break;
            case ROW.wag: // 攻击姿态！
                this.animateFrame = [0, 0, 0, 1, 2, 3][this.ticks % 6];
                break;
        }
        this.ticks++;
    }
}

// 每个状态持续的 tick 数范围；下一步做什么由 brain.js 里的网络决定
const DURATION = {
    walk: [20, 60],
    sit: [30, 80],
    lick: [16, 40],
    sleep: [200, 600],
    alert: [12, 24],
    chase: [30, 30],
};

const rand = (lo, hi) => lo + Math.random() * (hi - lo);

const brain = new CatBrain.Brain();
const maskOf = (names) => CatBrain.ACTIONS.map((a) => names.includes(a));

const mouse = { x: 0, y: 0, inside: false, movedAt: 0, visitedAt: -1, speed: 0 };
window.addEventListener('pointermove', (e) => {
    const now = performance.now();
    const dt = now - mouse.movedAt;
    if (mouse.inside && dt > 0 && dt < 200) {
        const step = Math.hypot(e.clientX - mouse.x, e.clientY - mouse.y);
        const v = step / dt * 1000;
        mouse.speed = 0.7 * mouse.speed + 0.3 * v;
        cat.stroke(e.clientX, e.clientY, step, v, now);
    }
    mouse.x = e.clientX;
    mouse.y = e.clientY;
    mouse.inside = true;
    mouse.movedAt = now;
});
// document 上监听不到 pointerleave，用 relatedTarget 为空的 pointerout 判断光标离开了窗口
document.addEventListener('pointerout', (e) => { if (!e.relatedTarget) mouse.inside = false; });
window.addEventListener('pointerdown', (e) => cat.poke(e.clientX, e.clientY, performance.now()));

const scroll = { y: window.scrollY, at: 0, speed: 0 };
window.addEventListener('scroll', () => {
    const now = performance.now();
    const dt = Math.max(now - scroll.at, 16);
    scroll.speed = 0.7 * scroll.speed + 0.3 * Math.abs(window.scrollY - scroll.y) / dt * 1000;
    scroll.y = window.scrollY;
    scroll.at = now;
}, { passive: true });

class Cat {
    constructor() {
        this.x = rand(0, window.innerWidth - SIZE);
        this.y = rand(0, window.innerHeight - SIZE);
        this.energy = rand(50, 100);
        this.frame = new Frame();
        this.flip = false;
        this.forcedNext = null;
        this.calmUntil = 0;
        this.nearDecisionAt = 0;
        this.strokeDist = 0;
        this.strokeAt = 0;
        this.petCooldownUntil = 0;
        this.treatCooldownUntil = 0;
        this.playCheckAt = 0;
        this.fx = [];
        this.enter(reducedMotion ? 'sleep' : 'walk');
    }

    cx() { return this.x + SIZE / 2; }
    cy() { return this.y + SIZE / 2; }
    mouseDist() { return Math.hypot(mouse.x - this.cx(), mouse.y - this.cy()); }
    hit(px, py) {
        return px > this.x - 8 && px < this.x + SIZE + 8 && py > this.y - 8 && py < this.y + SIZE + 8;
    }

    clamp() {
        this.x = Math.min(Math.max(this.x, 0), window.innerWidth - SIZE);
        this.y = Math.min(Math.max(this.y, 0), window.innerHeight - SIZE);
    }

    enter(state, opts = {}) {
        this.state = state;
        this.stateTicks = 0;
        const [lo, hi] = DURATION[state] ?? [60, 120];
        this.timer = Math.floor(rand(lo, hi));
        this.flip = false;
        switch (state) {
            case 'walk':
            case 'approach':
                this.target = opts.target ?? this.pickTarget();
                this.axis = null;
                this.timer = 200; // 走太久还没到就放弃
                break;
            case 'sit':
                this.frame.change(ROW.sit);
                if (opts.long) this.timer *= 3;
                break;
            case 'lick':
                this.frame.change(ROW.lick);
                break;
            case 'sleep':
                this.frame.change(reducedMotion || Math.random() < 0.7 ? ROW.sleep : ROW.curl);
                if (this.energy < 30) this.timer *= 1.5; // 累了睡得更久
                break;
            case 'alert':
            case 'chase':
                break;
        }
    }

    // 目标点：一半概率是屏幕上随机一点，一半概率蹲到可见的标题/图片/代码块上面
    pickTarget() {
        const w = window.innerWidth, h = window.innerHeight;
        if (Math.random() < 0.5) {
            const perches = [...document.querySelectorAll('h1, h2, h3, img, pre, table')]
                .map((el) => el.getBoundingClientRect())
                .filter((r) => r.width > 0 && r.top > SIZE && r.top < h);
            if (perches.length) {
                const r = perches[Math.floor(Math.random() * perches.length)];
                return {
                    x: Math.min(Math.max(r.left + rand(0, r.width) - SIZE / 2, 0), w - SIZE),
                    y: r.top - SIZE + 6,
                };
            }
        }
        return { x: rand(0, w - SIZE), y: rand(0, h - SIZE) };
    }

    // 喂给网络的环境
    senses(now) {
        const d = new Date();
        return {
            energy: this.energy,
            state: this.state,
            stateTicks: this.stateTicks,
            mouseInside: mouse.inside,
            mouseDist: this.mouseDist(),
            mouseSpeed: mouse.speed,
            mouseIdle: now - mouse.movedAt,
            scrollSpeed: scroll.speed,
            hour: d.getHours() + d.getMinutes() / 60,
        };
    }

    canApproach(now) {
        return mouse.inside && now - mouse.movedAt > 3000 && this.mouseDist() > 90
            && mouse.visitedAt !== mouse.movedAt;
    }

    // 状态到时间了，下一步能选哪些动作
    timedMask(now) {
        if (this.state === 'sleep' || this.state === 'chase') return maskOf(['sit']); // 睡醒、扑完都先坐下
        const names = ['walk', 'sit', 'lick', 'alert'];
        if (this.state === 'sit' || this.state === 'lick') names.push('sleep'); // 坐下来才会躺
        if (this.canApproach(now)) names.push('approach');
        return maskOf(names);
    }

    act(action, now) {
        if (action === 'approach') {
            mouse.visitedAt = mouse.movedAt; // 同一个停留位置只去一次
            const side = mouse.x > window.innerWidth / 2 ? -1 : 1;
            this.enter('approach', {
                target: {
                    x: Math.min(Math.max(mouse.x + side * 24 - SIZE / 2, 0), window.innerWidth - SIZE),
                    y: Math.min(Math.max(mouse.y - SIZE / 2, 0), window.innerHeight - SIZE),
                },
            });
        } else {
            this.enter(action);
        }
    }

    next(now) {
        if (this.forcedNext) {
            const s = this.forcedNext;
            this.forcedNext = null;
            return this.enter(s);
        }
        if (this.state === 'sleep' || this.state === 'chase') return this.enter('sit');
        this.act(brain.decide(this.senses(now), this.timedMask(now), now), now);
    }

    // 朝目标走一步，到了返回 true。优先沿当前轴走，避免在斜线上左右抽搐
    stepTowards(tx, ty, speed) {
        const dx = tx - this.x, dy = ty - this.y;
        if (Math.abs(dx) <= speed && Math.abs(dy) <= speed) {
            this.x = tx;
            this.y = ty;
            return true;
        }
        const along = this.axis === 'x' ? dx : dy;
        if (this.axis === null || Math.abs(along) <= speed) {
            this.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
        }
        if (this.axis === 'x') {
            this.x += Math.sign(dx) * Math.min(speed, Math.abs(dx));
            this.frame.change(dx > 0 ? ROW.right : ROW.left);
        } else {
            this.y += Math.sign(dy) * Math.min(speed, Math.abs(dy));
            this.frame.change(dy > 0 ? ROW.down : ROW.up);
        }
        return false;
    }

    // 对鼠标的反应，返回 true 表示这一帧已经处理过状态切换
    react(now) {
        if (!mouse.inside || reducedMotion) return false;
        const dist = this.mouseDist();
        const moving = now - mouse.movedAt < 400;
        const awake = ['walk', 'sit', 'lick', 'approach'].includes(this.state);

        if (this.state === 'sleep') {
            if (moving && dist < 80 && Math.random() < 0.08) {
                this.forcedNext = 'lick'; // 被吵醒：先坐起来，再舔爪
                this.enter('sit');
                return true;
            }
            return false;
        }
        // 鼠标在旁边晃：让网络在「接着干自己的事」和「警觉」之间选，1.5 秒最多问一次
        if (moving && dist < 160 && awake && now > this.calmUntil && now > this.nearDecisionAt) {
            this.nearDecisionAt = now + 1500;
            if (brain.decide(this.senses(now), maskOf([this.state, 'alert']), now) === 'alert') {
                this.enter('alert');
                return true;
            }
            return false;
        }
        // 鼠标停住了：让网络在「接着干自己的事」和「走过去」之间选，同一个停留位置只问一次
        if (this.state !== 'approach' && awake && this.canApproach(now) && Math.random() < 0.02) {
            mouse.visitedAt = mouse.movedAt;
            if (brain.decide(this.senses(now), maskOf([this.state, 'approach']), now) === 'approach') {
                this.act('approach', now);
                return true;
            }
        }
        return false;
    }

    reward(r, why, now) {
        brain.reward(r, why, now);
        const icon = { pet: '♥', treat: '🐟', play: '♪', flee: '💨' }[why];
        this.fx.push({ icon, x: this.cx() + rand(-12, 12), y: this.y, born: now });
    }

    // 抚摸：光标在猫身上轻轻地来回移动。只是放着不动、或者一下划过去都不算，
    // 攒够 150px 的轻抚路程才算摸了一次；停下超过半秒就重新攒
    stroke(px, py, step, v, now) {
        if (!this.hit(px, py) || v < 20 || v > 800) return;
        if (now - this.strokeAt > 500) this.strokeDist = 0;
        this.strokeDist += step;
        this.strokeAt = now;
        if (this.strokeDist >= 150 && now > this.petCooldownUntil) {
            this.strokeDist = 0;
            this.petCooldownUntil = now + 3000;
            this.reward(1, 'pet', now);
        }
    }

    // 奖励：陪玩或躲开（扑完之后鼠标的反应）
    feel(now) {
        if (this.playCheckAt) {
            const elapsed = now - this.playCheckAt;
            if (elapsed < 1000 && this.mouseDist() > 300) {
                this.playCheckAt = 0;
                this.reward(-0.3, 'flee', now);
            } else if (elapsed >= 2000) {
                this.playCheckAt = 0;
                if (mouse.inside && now - mouse.movedAt < 500 && this.mouseDist() < 200) {
                    this.reward(0.5, 'play', now);
                }
            }
        }
    }

    // 点一下猫：喂零食
    poke(px, py, now) {
        if (!this.hit(px, py) || now < this.treatCooldownUntil) return;
        this.treatCooldownUntil = now + 1000;
        this.reward(2, 'treat', now);
    }

    tick(now) {
        const cost = { walk: -0.15, approach: -0.15, chase: -0.5, sleep: 0.3 }[this.state] ?? 0.03;
        this.energy = Math.min(Math.max(this.energy + cost, 0), 100);
        if (now - mouse.movedAt > 150) mouse.speed *= 0.5;
        if (now - scroll.at > 150) scroll.speed *= 0.5;
        this.stateTicks++;
        this.feel(now);

        if (this.react(now)) {
            this.frame.tick();
            return;
        }

        this.timer--;
        switch (this.state) {
            case 'walk':
            case 'approach':
                if (this.stepTowards(this.target.x, this.target.y, 4)) {
                    if (this.state === 'approach') this.enter('sit', { long: true });
                    else this.next(now);
                    break;
                }
                if (this.timer <= 0) this.next(now);
                break;
            case 'alert': {
                this.frame.change(ROW.wag);
                this.flip = mouse.x < this.cx(); // 摇尾巴那一行只朝右，朝左时镜像
                const near = mouse.inside && this.mouseDist() < 200;
                if (this.timer <= 0) {
                    if (near && now - mouse.movedAt < 800) {
                        this.enter('chase');
                    } else {
                        this.next(now);
                    }
                }
                break;
            }
            case 'chase': {
                const tx = Math.min(Math.max(mouse.x - SIZE / 2, 0), window.innerWidth - SIZE);
                const ty = Math.min(Math.max(mouse.y - SIZE / 2, 0), window.innerHeight - SIZE);
                if (this.stepTowards(tx, ty, 8) || this.timer <= 0) {
                    this.calmUntil = now + 5000; // 扑完歇一会儿，不会被鼠标立刻再勾起来
                    this.playCheckAt = now;      // 接下来看鼠标是陪它玩还是躲开
                    this.enter('sit');
                }
                break;
            }
            default:
                if (this.timer <= 0 && !reducedMotion) this.next(now);
        }
        this.clamp();
        this.frame.tick();
    }

    draw(now) {
        ctx.save();
        if (this.flip) {
            ctx.translate(this.x + SIZE, this.y);
            ctx.scale(-1, 1);
            ctx.drawImage(img, this.frame.dx(), this.frame.dy(), 32, 32, 0, 0, SIZE, SIZE);
        } else {
            ctx.drawImage(img, this.frame.dx(), this.frame.dy(), 32, 32, Math.round(this.x), Math.round(this.y), SIZE, SIZE);
        }
        ctx.restore();

        // 奖励飘字
        this.fx = this.fx.filter((f) => now - f.born < 1200);
        ctx.save();
        ctx.font = '18px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillStyle = '#e0245e';
        for (const f of this.fx) {
            const age = (now - f.born) / 1200;
            ctx.globalAlpha = 1 - age;
            ctx.fillText(f.icon, f.x, f.y - age * 30);
        }
        ctx.restore();
    }
}

const cat = new Cat();

// ---- 概率面板：在页面上敲 cat，或者网址带 #cat-brain 打开 ----
const panel = (() => {
    const PANEL_KEY = 'cat-brain-panel';
    const NAMES = { walk: '闲逛', sit: '坐下', lick: '舔爪', sleep: '睡觉', alert: '警觉', approach: '找你', chase: '扑！' };
    const WHY = { pet: '摸猫', treat: '零食', play: '陪玩', flee: '躲开' };
    let root = null, rows = {}, info, energyBar, stats, lastLine;

    const el = (tag, style, text) => {
        const e = document.createElement(tag);
        if (style) e.style.cssText = style;
        if (text) e.textContent = text;
        return e;
    };
    const bar = () => {
        const outer = el('div', 'flex:1;height:8px;border:1px solid currentColor;margin:0 6px');
        const inner = el('div', 'height:100%;background:currentColor;width:0');
        outer.append(inner);
        return { outer, inner };
    };

    function build() {
        root = el('div', 'position:fixed;right:12px;bottom:12px;z-index:10;width:250px;max-width:calc(100vw - 24px);'
            + 'box-sizing:border-box;padding:10px;background:#fff;color:#000;border:1px solid #000;'
            + 'font:12px/1.6 ui-monospace,Menlo,monospace');
        const head = el('div', 'display:flex;justify-content:space-between;font-weight:bold');
        head.append(el('span', null, 'cat brain · 16→16→6'));
        const close = el('span', 'cursor:pointer', '×');
        close.onclick = () => toggle(false);
        head.append(close);

        info = el('div');
        const energy = el('div', 'display:flex;align-items:center');
        energy.append(el('span', null, '精力'));
        energyBar = bar();
        energy.append(energyBar.outer);

        const list = el('div', 'margin:6px 0;padding-top:6px;border-top:1px dashed #000');
        list.append(el('div', 'opacity:.6', '现在让它决定，会选：'));
        for (const a of CatBrain.ACTIONS) {
            const row = el('div', 'display:flex;align-items:center');
            const name = el('span', 'width:3em', NAMES[a]);
            const b = bar();
            const pct = el('span', 'width:3.2em;text-align:right');
            row.append(name, b.outer, pct);
            list.append(row);
            rows[a] = { row, inner: b.inner, pct };
        }

        stats = el('div', 'padding-top:6px;border-top:1px dashed #000');
        lastLine = el('div', 'opacity:.6');
        const reset = el('button', 'margin-top:6px;font:inherit;cursor:pointer', '重置大脑');
        reset.onclick = () => {
            if (confirm('把猫的大脑恢复成出厂状态？学到的东西会清空。')) brain.reset();
        };
        const hint = el('div', 'opacity:.6;margin-top:4px', '在它身上轻轻来回划 +1 · 点它喂零食 +2 · 扑完陪它玩 +0.5');
        root.append(head, info, energy, list, stats, lastLine, reset, hint);
        document.body.append(root);
    }

    function toggle(open = !root || root.style.display === 'none') {
        if (open && !root) build();
        if (root) root.style.display = open ? '' : 'none';
        try { localStorage.setItem(PANEL_KEY, open ? '1' : ''); } catch (e) { /* 忽略 */ }
    }

    function update(now) {
        if (!root || root.style.display === 'none') return;
        info.textContent = `状态  ${NAMES[cat.state]}（${(cat.stateTicks / 10).toFixed(1)}s）`;
        energyBar.inner.style.width = cat.energy.toFixed(0) + '%';
        const mask = cat.timedMask(now);
        const p = brain.probs(cat.senses(now), mask);
        CatBrain.ACTIONS.forEach((a, i) => {
            const r = rows[a];
            r.row.style.opacity = mask[i] ? 1 : 0.3;
            r.inner.style.width = (p[i] * 100).toFixed(1) + '%';
            r.pct.textContent = mask[i] ? (p[i] * 100).toFixed(0) + '%' : '—';
        });
        const s = brain.stats;
        stats.textContent = `总奖励 ${s.reward.toFixed(1)} · 学习 ${s.updates} 次\n`
            + `摸 ${s.pet} · 零食 ${s.treat} · 陪玩 ${s.play} · 躲开 ${s.flee}`;
        stats.style.whiteSpace = 'pre-line';
        const l = brain.last;
        lastLine.textContent = l && now >= l.at
            ? `上次 ${l.r > 0 ? '+' : ''}${l.r} ${WHY[l.why]}（${((now - l.at) / 1000).toFixed(0)}s 前）`
            : '还没学到东西';
    }

    // 在页面上敲 c-a-t 开关面板（输入框里打字不算）
    let typed = '';
    window.addEventListener('keydown', (e) => {
        const t = e.target;
        if (e.metaKey || e.ctrlKey || e.altKey || t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
        typed = (typed + e.key.toLowerCase()).slice(-3);
        if (typed === 'cat') {
            typed = '';
            toggle();
        }
    });
    let saved = '';
    try { saved = localStorage.getItem(PANEL_KEY); } catch (e) { /* 忽略 */ }
    if (location.hash === '#cat-brain' || saved) toggle(true);

    return { update };
})();

let last = 0;
function animate(now) {
    if (now - last >= TICK_MS) {
        // 切回标签页时不要一次补很多帧
        last = now - last > TICK_MS * 5 ? now : last + TICK_MS;
        cat.tick(now);
        ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
        cat.draw(now);
        panel.update(now);
    }
    requestAnimationFrame(animate);
}

img.onload = () => {
    requestAnimationFrame(animate);
};
