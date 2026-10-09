// tools/markov.mjs — 马尔可夫链工具箱（围棋落子模型）
//
// 借鉴记账：核心 DTMC 结构（states / matrix / step / simulate / steadyState(幂迭代) / isAbsorbing）
// 借鉴自本机项目 `G:\repos\zhuangtaiji` 的 `core/markov_chain.py`（作者同为 siwpan，
// 公开仓 https://gitee.com/siwpan/zhuangtaiji ，MIT）。借用范围：**接口形态与幂迭代求解思路**；
// 本文本为 JS 重写（weiqi_lab 共享 I/O 层无 Python 依赖），并叠加围棋专用层（§2、§3）。
//
// 三层：
//   §1 MarkovChain   通用离散时间马尔可夫链（DTMC）
//   §2 MoveChain     全局落子转移模型（状态 = 落子点 + pass）→ 落子热点稳态分布
//   §3 PatternPolicy 局部棋形条件转移模型（3×3 主上下文 + 十字邻域退避）→ 预测下一手
//
// 零第三方依赖；RNG 为 splitmix64 流（与引擎同族，可复现）。

const MASK = (1n << 64n) - 1n;
export function makeRng(seed) {
  let s = BigInt(seed >>> 0) & MASK;
  return () => {
    s = (s + 0x9e3779b97f4a7c15n) & MASK;
    let z = s;
    z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK;
    z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK;
    z = (z ^ (z >> 31n)) & MASK;
    return Number(z % 1000000n) / 1000000;
  };
}

// ---------------------------------------------------------------- §1 DTMC
export class MarkovChain {
  constructor(states, matrix = {}, initial = null) {
    this.states = Array.from(states);
    this.index = new Map(this.states.map((s, i) => [s, i]));
    this.initial = initial ?? this.states[0];
    this.current = this.initial;
    this.matrix = this.states.map((s) => {
      const row = matrix[s] || {};
      const dist = this.states.map((t) => Number(row[t] || 0));
      const total = dist.reduce((a, b) => a + b, 0);
      if (total <= 0) return this.states.map((t) => (t === s ? 1 : 0)); // 退化：吸收在自身
      return dist.map((d) => d / total);
    });
  }

  step(state = null) {
    const s = state ?? this.current;
    const i = this.index.get(s);
    if (i === undefined) return this.current;
    const r = Math.random();
    let acc = 0;
    for (let j = 0; j < this.states.length; j++) {
      acc += this.matrix[i][j];
      if (r <= acc) {
        this.current = this.states[j];
        return this.current;
      }
    }
    this.current = this.states[this.states.length - 1];
    return this.current;
  }

  simulate(steps = 20, start = null) {
    let cur = start ?? this.current;
    const seq = [cur];
    for (let i = 0; i < steps; i++) {
      cur = this.step(cur);
      seq.push(cur);
    }
    return seq;
  }

  /** 稳态分布 π（幂迭代 π←πP）；返回 {pi, iters} */
  steadyState(maxIter = 2000, tol = 1e-10) {
    const n = this.states.length;
    let pi = new Array(n).fill(1 / n);
    let iters = 0;
    for (; iters < maxIter; iters++) {
      const next = new Array(n).fill(0);
      for (let j = 0; j < n; j++) {
        let sum = 0;
        for (let i = 0; i < n; i++) sum += pi[i] * this.matrix[i][j];
        next[j] = sum;
      }
      let diff = 0;
      for (let k = 0; k < n; k++) diff += Math.abs(next[k] - pi[k]);
      pi = next;
      if (diff < tol) {
        iters++;
        break;
      }
    }
    const out = {};
    this.states.forEach((s, i) => (out[s] = pi[i]));
    return { pi: out, iters };
  }

  isAbsorbing(state) {
    const i = this.index.get(state);
    return i !== undefined && this.matrix[i][i] >= 1 - 1e-9;
  }
}

// ------------------------------------------------- §2 全局落子转移模型
/** 状态 = 落子点索引（含 -1 表示 pass）；由棋谱序列统计转移。 */
export class MoveChain {
  constructor(size) {
    this.size = size;
    this.counts = new Map();
    this.stateCount = new Map();
  }

  observeMoveList(vertices) {
    let prev = "start";
    for (const v of vertices) {
      const to = String(v);
      if (!this.counts.has(prev)) this.counts.set(prev, new Map());
      const row = this.counts.get(prev);
      row.set(to, (row.get(to) || 0) + 1);
      this.stateCount.set(prev, (this.stateCount.get(prev) || 0) + 1);
      prev = to;
    }
  }

  toChain() {
    const states = new Set(["start", "-1"]);
    for (const [from, row] of this.counts) {
      states.add(from);
      for (const to of row.keys()) states.add(to);
    }
    const matrix = {};
    for (const [from, row] of this.counts) {
      matrix[from] = {};
      for (const [to, c] of row) matrix[from][to] = c;
    }
    return new MarkovChain(Array.from(states), matrix, "start");
  }

  /** 落子线位分布（到最近边的距离：1–2 线 / 3 线 / ≥4 线；均匀随机的 9 路各占 ≈69%/20%/11%） */
  regionHistogram() {
    const size = this.size;
    const buckets = { line12: 0, line3: 0, center: 0, pass: 0 };
    for (const [from, cnt] of this.stateCount) {
      if (from === "start") continue;
      const v = Number(from);
      if (v < 0) {
        buckets.pass += cnt;
        continue;
      }
      const x = v % size;
      const y = Math.floor(v / size);
      const line = Math.min(x, y, size - 1 - x, size - 1 - y) + 1;
      if (line <= 2) buckets.line12 += cnt;
      else if (line === 3) buckets.line3 += cnt;
      else buckets.center += cnt;
    }
    return buckets;
  }
}

// --------------------------------------------- §3 局部棋形条件转移模型
// sample = { cells: 盘面数组, toMove: 应手方(1/2), last: 最后一手点索引(-1=无) }
// 编码相对应手方：0 空 / 1 应手方子 / 2 对方子 / 3 盘外

const SYM8 = [
  (x, y) => [x, y], (x, y) => [-y, x], (x, y) => [-x, -y], (x, y) => [y, -x],
  (x, y) => [-x, y], (x, y) => [x, -y], (x, y) => [y, x], (x, y) => [-y, -x],
];
const SYM_INV = [0, 3, 2, 1, 4, 5, 6, 7]; // SYM8 各元素的逆（该集合构成群，逆仍在集合内）

// ---- 对称帧（canonical frames）----
// 问题：签名把 8 个对称的棋形归一到同一个键，但**应手偏移**若按盘面原始帧记录，
// 同一键下会混入 8 个不同朝向的偏移 → 分布被"抹平"（实测 top-1 仅 6.8%，
// 修正帧后 22.0%）。修正：记录时把偏移转进**规范帧**，查询时再转回**盘面帧**。
// 语义：signature 的编码位置 (dx,dy) 读取盘面位置 f_s(dx,dy)
//   ⇒ 规范帧 → 盘面帧：board = SYM8[s](canonical)
//   ⇒ 盘面帧 → 规范帧：canonical = SYM8[SYM_INV[s]](board)
/** 主表（8 对称）偏移变换：s = signatureEx 的 argmin 下标；inv=true 时取逆 */
export function symOffset(s, dx, dy, inv = false) {
  return SYM8[inv ? SYM_INV[s] : s](dx, dy);
}

// 十字签名的方向表（与 signatureCross 内一致）：N,E,S,W
const DIRS = [[0, 1], [1, 0], [0, -1], [-1, 0]];
/** 十字表旋转映射：规范帧 → 盘面帧（r = 旋转数，与 signatureCrossEx 的 rot 对应）；inv=true 取逆 */
export function crossOffset(r, dx, dy, inv = false) {
  let k = r % 4;
  if (inv) k = (4 - k) % 4;
  for (let i = 0; i < k; i++) {
    const nx = dy;
    const ny = -dx;
    dx = nx;
    dy = ny;
  }
  return [dx, dy];
}

function encode(cells, size, x, y, toMove) {
  if (x < 0 || y < 0 || x >= size || y >= size) return "3";
  const v = cells[y * size + x];
  if (v === 0) return "0";
  return v === toMove ? "1" : "2";
}

/** 主上下文：以最后一手为中心的 (2r+1)² 邻域，8 对称取字典序最小。r=1 → 3×3。 */
export function signatureEx(sample, size, radius = 1) {
  const { cells, toMove, last } = sample;
  if (last < 0) return { key: "PASSCTX", sym: 0 };
  const lx = last % size;
  const ly = Math.floor(last / size);
  let best = null;
  let bestS = 0;
  for (let s = 0; s < 8; s++) {
    const f = SYM8[s];
    let enc = "";
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (dx === 0 && dy === 0) {
          enc += "2"; // 中心 = 最后一手（对方刚落，从应手方视角记为"对方"）
          continue;
        }
        const [nx, ny] = f(dx, dy);
        enc += encode(cells, size, lx + nx, ly + ny, toMove);
      }
    }
    if (best === null || enc < best) { best = enc; bestS = s; }
  }
  return { key: best, sym: bestS };
}

export function signature(sample, size, radius = 1) {
  return signatureEx(sample, size, radius).key;
}

/** 退避上下文：4 正交邻域（N,E,S,W），4 旋转取字典序最小。状态空间 4⁴=256。 */
export function signatureCrossEx(sample, size) {
  const { cells, toMove, last } = sample;
  if (last < 0) return { key: "PCROSS", rot: 0 };
  const lx = last % size;
  const ly = Math.floor(last / size);
  let best = null;
  let bestR = 0;
  for (let r = 0; r < 4; r++) {
    let enc = "";
    for (let k = 0; k < 4; k++) {
      const [dx, dy] = DIRS[(k + r) % 4];
      enc += encode(cells, size, lx + dx, ly + dy, toMove);
    }
    if (best === null || enc < best) { best = enc; bestR = r; }
  }
  return { key: best, rot: bestR };
}

export function signatureCross(sample, size) {
  return signatureCrossEx(sample, size).key;
}

const offKey = (dx, dy) => `${dx},${dy}`;
const parseOff = (k) => k.split(",").map(Number);

// xf（可选）：把行内偏移从**规范帧**转回**盘面帧**（canonicalFrames 模式用）
function normalize(row, xf = null) {
  const total = Array.from(row.values()).reduce((a, b) => a + b, 0);
  return Array.from(row.entries())
    .map(([k, c]) => {
      let off = parseOff(k);
      if (xf) off = xf(off);
      return { off, p: c / total, n: c };
    })
    .sort((a, b) => b.p - a.p || a.off[0] - b.off[0] || a.off[1] - b.off[1]);
}

export class PatternPolicy {
  constructor(radius = 1, moveRadius = 3, backoffMin = 1, backoffRadius = 0, canonicalFrames = false) {
    this.radius = radius;
    this.moveRadius = moveRadius;
    this.backoffMin = backoffMin; // 主表该上下文样本数 < backoffMin 时退避
    // 退避上下文半径：0 = 用十字邻域（signatureCross，零依赖默认）；
    // ≥1 = 用同族的 radius 棋形签名（如 主=5×5 / 退避=3×3 的层次化回退）
    this.backoffRadius = backoffRadius;
    // 对称帧（推荐 true；旧模型为 false = 偏移按盘面原始帧记录，分布被朝向抹平）
    this.canonicalFrames = canonicalFrames;
    this.table = new Map(); // 主上下文 -> Map(offset -> count/weight)
    this.cross = new Map(); // 退避上下文 -> Map(offset -> count/weight)
    this.seen = 0;
  }

  backoffKey(sample, size) {
    return this.backoffKeyEx(sample, size).key;
  }

  /** 退避上下文键 + 该表对应的对称信息（kind: "main"(8 对称) | "cross"(4 旋转)） */
  backoffKeyEx(sample, size) {
    if (this.backoffRadius >= 1) {
      return { kind: "main", ...signatureEx(sample, size, this.backoffRadius) };
    }
    return { kind: "cross", ...signatureCrossEx(sample, size) };
  }

  /** 盘面帧偏移 → 表内帧（记录用） */
  _toTableFrame(kind, sym, dx, dy) {
    if (!this.canonicalFrames) return [dx, dy];
    return kind === "cross" ? crossOffset(sym, dx, dy, true) : symOffset(sym, dx, dy, true);
  }

  /** 表内帧偏移 → 盘面帧偏移（查询用） */
  _toBoardFrame(kind, sym, off) {
    if (!this.canonicalFrames) return off;
    return kind === "cross" ? crossOffset(sym, off[0], off[1], false) : symOffset(sym, off[0], off[1], false);
  }

  observe(sample, size, next) {
    if (sample.last < 0 || next < 0) return false;
    const dx = (next % size) - (sample.last % size);
    const dy = Math.floor(next / size) - Math.floor(sample.last / size);
    if (Math.abs(dx) > this.moveRadius || Math.abs(dy) > this.moveRadius) return false;
    const add = (map, key, k) => {
      if (!map.has(key)) map.set(key, new Map());
      const row = map.get(key);
      row.set(k, (row.get(k) || 0) + 1);
    };
    const me = signatureEx(sample, size, this.radius);
    const be = this.backoffKeyEx(sample, size);
    const [mx, my] = this._toTableFrame("main", me.sym, dx, dy);
    const [bx, by] = this._toTableFrame(be.kind, be.kind === "cross" ? be.rot : be.sym, dx, dy);
    add(this.table, me.key, offKey(mx, my));
    add(this.cross, be.key, offKey(bx, by));
    this.seen += 1;
    return true;
  }

  /** → {dist, source: "main"|"cross"}；两者皆无 → null（dist 的 off 一律为**盘面帧**偏移） */
  distribution(sample, size) {
    const me = signatureEx(sample, size, this.radius);
    const main = this.table.get(me.key);
    if (main) {
      const n = Array.from(main.values()).reduce((a, b) => a + b, 0);
      if (n >= this.backoffMin) {
        const xf = this.canonicalFrames ? (off) => this._toBoardFrame("main", me.sym, off) : null;
        return { dist: normalize(main, xf), source: "main" };
      }
    }
    const be = this.backoffKeyEx(sample, size);
    const cross = this.cross.get(be.key);
    if (cross) {
      const sym = be.kind === "cross" ? be.rot : be.sym;
      const xf = this.canonicalFrames ? (off) => this._toBoardFrame(be.kind, sym, off) : null;
      return { dist: normalize(cross, xf), source: "cross" };
    }
    return null;
  }

  /** 预测 top-k 绝对点（不做合法性过滤） */
  topK(sample, size, k = 3) {
    const d = this.distribution(sample, size);
    if (!d) return { top: [], source: null };
    const lx = sample.last % size;
    const ly = Math.floor(sample.last / size);
    const out = [];
    for (const item of d.dist) {
      const x = lx + item.off[0];
      const y = ly + item.off[1];
      if (x < 0 || y < 0 || x >= size || y >= size) continue;
      out.push({ vertex: y * size + x, p: item.p, n: item.n });
      if (out.length >= k) break;
    }
    return { top: out, source: d.source };
  }

  size() {
    let entries = 0;
    for (const row of this.table.values()) entries += row.size;
    let crossEntries = 0;
    for (const row of this.cross.values()) crossEntries += row.size;
    return { contexts: this.table.size, entries, crossContexts: this.cross.size, crossEntries };
  }

  toJSON() {
    const t = {};
    for (const [k, row] of this.table) t[k] = Object.fromEntries(row);
    const c = {};
    for (const [k, row] of this.cross) c[k] = Object.fromEntries(row);
    return { radius: this.radius, moveRadius: this.moveRadius, backoffMin: this.backoffMin,
      backoffRadius: this.backoffRadius, frames: this.canonicalFrames ? "canonical" : "raw",
      samples: this.seen, table: t, cross: c };
  }

  static fromJSON(obj) {
    const p = new PatternPolicy(obj.radius, obj.moveRadius, obj.backoffMin, obj.backoffRadius || 0,
      obj.frames === "canonical");
    for (const [k, row] of Object.entries(obj.table || {})) p.table.set(k, new Map(Object.entries(row)));
    for (const [k, row] of Object.entries(obj.cross || {})) p.cross.set(k, new Map(Object.entries(row)));
    p.seen = obj.samples || 0;
    return p;
  }

  /** 生成着法：从分布采样一个偏移（不保证合法，调用方过滤）；无上下文返回 null */
  sampleMove(sample, size, rng) {
    const d = this.distribution(sample, size);
    if (!d) return null;
    const r = rng();
    let acc = 0;
    const lx = sample.last % size;
    const ly = Math.floor(sample.last / size);
    for (const item of d.dist) {
      acc += item.p;
      if (r <= acc) {
        const x = lx + item.off[0];
        const y = ly + item.off[1];
        if (x < 0 || y < 0 || x >= size || y >= size) break;
        return y * size + x;
      }
    }
    return null;
  }
}
