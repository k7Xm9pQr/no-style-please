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

// 状态转移表：next 是下一个状态的权重，dur 是持续 tick 数的范围
const STATES = {
    walk:  { next: { walk: 2, sit: 3, lick: 1, alert: 1 }, dur: [20, 60] },
    sit:   { next: { lick: 3, walk: 2, sleep: 2, sit: 1 }, dur: [30, 80] },
    lick:  { next: { sit: 3, walk: 1, sleep: 0.5 },         dur: [16, 40] },
    sleep: { next: { sit: 1 },                              dur: [200, 600] }, // 睡醒先坐起来
    alert: { next: { walk: 2, sit: 1 },                     dur: [12, 24] },
    chase: { next: { sit: 1 },                              dur: [30, 30] }, // 扑完坐下喘口气
};

const rand = (lo, hi) => lo + Math.random() * (hi - lo);

function pick(weights) {
    const entries = Object.entries(weights).filter(([, w]) => w > 0);
    let r = Math.random() * entries.reduce((s, [, w]) => s + w, 0);
    for (const [k, w] of entries) {
        if ((r -= w) < 0) return k;
    }
    return entries[0][0];
}

const mouse = { x: 0, y: 0, inside: false, movedAt: 0, visitedAt: -1 };
window.addEventListener('pointermove', (e) => {
    mouse.x = e.clientX;
    mouse.y = e.clientY;
    mouse.inside = true;
    mouse.movedAt = performance.now();
});
document.addEventListener('pointerleave', () => { mouse.inside = false; });

class Cat {
    constructor() {
        this.x = rand(0, window.innerWidth - SIZE);
        this.y = rand(0, window.innerHeight - SIZE);
        this.energy = rand(50, 100);
        this.frame = new Frame();
        this.flip = false;
        this.forcedNext = null;
        this.calmUntil = 0;
        this.enter(reducedMotion ? 'sleep' : 'walk');
    }

    cx() { return this.x + SIZE / 2; }
    cy() { return this.y + SIZE / 2; }

    clamp() {
        this.x = Math.min(Math.max(this.x, 0), window.innerWidth - SIZE);
        this.y = Math.min(Math.max(this.y, 0), window.innerHeight - SIZE);
    }

    enter(state, opts = {}) {
        this.state = state;
        const [lo, hi] = STATES[state]?.dur ?? [60, 120];
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

    next() {
        if (this.forcedNext) {
            const s = this.forcedNext;
            this.forcedNext = null;
            return this.enter(s);
        }
        const from = this.state === 'approach' ? 'walk' : this.state;
        const weights = { ...STATES[from].next };
        if (this.energy < 30) {
            if (weights.sleep) weights.sleep *= 5;
            if (weights.sit) weights.sit *= 2;
            if (weights.walk) weights.walk *= 0.3;
        } else if (this.energy > 80) {
            if (weights.sleep) weights.sleep *= 0.1;
            if (weights.walk) weights.walk *= 2;
        }
        this.enter(pick(weights));
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
        const dist = Math.hypot(mouse.x - this.cx(), mouse.y - this.cy());
        const moving = now - mouse.movedAt < 400;
        const idle = now - mouse.movedAt > 3000;

        if (this.state === 'sleep') {
            if (moving && dist < 80 && Math.random() < 0.08) {
                this.forcedNext = 'lick'; // 被吵醒：先坐起来，再舔爪
                this.enter('sit');
                return true;
            }
            return false;
        }
        if (moving && dist < 160 && now > this.calmUntil
            && ['walk', 'sit', 'lick', 'approach'].includes(this.state)) {
            this.enter('alert');
            return true;
        }
        if (idle && dist > 90 && mouse.visitedAt !== mouse.movedAt
            && ['walk', 'sit', 'lick'].includes(this.state) && Math.random() < 0.02) {
            mouse.visitedAt = mouse.movedAt; // 同一个停留位置只去一次
            const side = mouse.x > window.innerWidth / 2 ? -1 : 1;
            this.enter('approach', {
                target: {
                    x: Math.min(Math.max(mouse.x + side * 24 - SIZE / 2, 0), window.innerWidth - SIZE),
                    y: Math.min(Math.max(mouse.y - SIZE / 2, 0), window.innerHeight - SIZE),
                },
            });
            return true;
        }
        return false;
    }

    tick(now) {
        const cost = { walk: -0.15, approach: -0.15, chase: -0.5, sleep: 0.3 }[this.state] ?? 0.03;
        this.energy = Math.min(Math.max(this.energy + cost, 0), 100);

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
                    else this.next();
                    break;
                }
                if (this.timer <= 0) this.next();
                break;
            case 'alert': {
                this.frame.change(ROW.wag);
                this.flip = mouse.x < this.cx(); // 摇尾巴那一行只朝右，朝左时镜像
                const near = mouse.inside && Math.hypot(mouse.x - this.cx(), mouse.y - this.cy()) < 200;
                if (this.timer <= 0) {
                    if (near && now - mouse.movedAt < 800) {
                        this.enter('chase');
                    } else {
                        this.next();
                    }
                }
                break;
            }
            case 'chase': {
                const tx = Math.min(Math.max(mouse.x - SIZE / 2, 0), window.innerWidth - SIZE);
                const ty = Math.min(Math.max(mouse.y - SIZE / 2, 0), window.innerHeight - SIZE);
                if (this.stepTowards(tx, ty, 8) || this.timer <= 0) {
                    this.calmUntil = now + 5000; // 扑完歇一会儿，不会被鼠标立刻再勾起来
                    this.enter('sit');
                }
                break;
            }
            default:
                if (this.timer <= 0 && !reducedMotion) this.next();
        }
        this.clamp();
        this.frame.tick();
    }

    draw() {
        ctx.save();
        if (this.flip) {
            ctx.translate(this.x + SIZE, this.y);
            ctx.scale(-1, 1);
            ctx.drawImage(img, this.frame.dx(), this.frame.dy(), 32, 32, 0, 0, SIZE, SIZE);
        } else {
            ctx.drawImage(img, this.frame.dx(), this.frame.dy(), 32, 32, Math.round(this.x), Math.round(this.y), SIZE, SIZE);
        }
        ctx.restore();
    }
}

const cat = new Cat();

let last = 0;
function animate(now) {
    if (now - last >= TICK_MS) {
        // 切回标签页时不要一次补很多帧
        last = now - last > TICK_MS * 5 ? now : last + TICK_MS;
        cat.tick(now);
        ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
        cat.draw();
    }
    requestAnimationFrame(animate);
}

img.onload = () => {
    requestAnimationFrame(animate);
};
