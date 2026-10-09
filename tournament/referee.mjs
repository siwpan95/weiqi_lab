// referee.mjs — 独立裁决层（authoritative arbiter）
//
// 设计取向：**刻意与五个引擎的实现机制不同**，以构成真正的第三方仲裁：
//   - 不用 Zobrist：超级劫用「盘面字符串」判重（引擎侧用 splitmix64 键）
//   - 不用 stamp 数组：棋块扫描用显式队列 + Set
//   - 只实现仲裁所需子集（play/legal/legalMoves/score/undo），不含 AI
// 行为契约与 docs/RULES_SPEC.md 完全一致；由 harness 的随机局面交叉校验守护。

export const COLS = "ABCDEFGHJKLMNOPQRST";

// 死子判定（纯函数，依赖 tools/scoring.mjs；与引擎侧 ai.mjs 共用同一算法，行为逐位一致）。
// referee 作为语言无关的权威仲裁层，自动死子修正由此统一出口，避免各引擎各自实现导致跨语言不一致。
import { deadStones, buildNeigh } from "../tools/scoring.mjs";

export const PROFILES = {
  cn: { ko: "positional", suicide: "forbid", scoring: "area", komi: 7.5 },
  tt: { ko: "positional", suicide: "allow", scoring: "area", komi: 7.5 },
  jp: { ko: "simple", suicide: "forbid", scoring: "territory", komi: 6.5 },
};

export function normalizeRules(r) {
  if (r === undefined || r === null) r = "cn";
  if (typeof r === "string") {
    const p = PROFILES[String(r).trim().toLowerCase()];
    if (!p) throw new Error("unknown rules profile: '" + r + "'");
    return { ...p };
  }
  const out = { ...PROFILES.cn };
  for (const k of ["ko", "suicide", "scoring"]) {
    if (r[k] !== undefined && r[k] !== null) out[k] = String(r[k]).trim().toLowerCase();
  }
  if (r.komi !== undefined && r.komi !== null) out.komi = Number(r.komi);
  if (!["simple", "positional", "situational"].includes(out.ko)) throw new Error("bad ko");
  if (!["forbid", "allow"].includes(out.suicide)) throw new Error("bad suicide");
  if (!["area", "territory"].includes(out.scoring)) throw new Error("bad scoring");
  return out;
}

export function parseVertex(s, size) {
  if (s === undefined || s === null) throw new Error("range");
  const t = String(s).trim().toUpperCase();
  if (t === "PASS") return -1;
  if (t.length < 2) throw new Error("range");
  const col = COLS.indexOf(t[0]);
  if (col < 0 || col >= size) throw new Error("range");
  const row = Number(t.slice(1));
  if (!Number.isInteger(row) || row < 1 || row > size) throw new Error("range");
  return (row - 1) * size + col;
}

export function formatVertex(i, size) {
  if (i < 0) return "pass";
  return COLS[i % size] + String(Math.floor(i / size) + 1);
}

export function parseColor(c) {
  const t = String(c).trim().toUpperCase();
  if (t === "B" || t === "BLACK" || t === "1") return 1;
  if (t === "W" || t === "WHITE" || t === "2") return 2;
  throw new Error("bad color: '" + c + "'");
}

function neighbors(size, i) {
  const x = i % size;
  const y = (i - x) / size;
  const out = [];
  if (x > 0) out.push(i - 1);
  if (x < size - 1) out.push(i + 1);
  if (y > 0) out.push(i - size);
  if (y < size - 1) out.push(i + size);
  return out;
}

const fmtNum = (v) => {
  const q = Math.round(v * 4);
  const whole = Math.floor(Math.abs(q) / 4);
  const rem = Math.abs(q) % 4;
  return String(whole) + ["", ".25", ".5", ".75"][rem];
};

export class Ref {
  constructor(size = 9, komi = null, rules = undefined) {
    this.size = Number(size);
    this.n2 = this.size * this.size;
    this.rules = normalizeRules(rules);
    this.komi = komi === null || komi === undefined ? this.rules.komi : Number(komi);
    this.reset();
  }

  reset() {
    this.cells = new Array(this.n2).fill(0);
    this.side = 1;
    this.koPoint = -1;
    this.passes = 0;
    this.over = false;
    this.captures = [0, 0, 0];
    this.boardKeys = [this.boardKey()];
    this.sitKeys = [this.side + ":" + this.boardKey()];
    this.stack = [];
    return this;
  }

  boardKey() {
    return this.cells.join("");
  }

  setStones(stones, side = 1) {
    this.reset();
    for (const [c, v] of stones) {
      const ci = typeof c === "string" ? parseColor(c) : c;
      const vi = typeof v === "string" ? parseVertex(v, this.size) : v;
      if (vi >= 0 && vi < this.n2) this.cells[vi] = ci;
    }
    this.side = side;
    this.boardKeys = [this.boardKey()];
    this.sitKeys = [this.side + ":" + this.boardKey()];
    return this;
  }

  group(idx, cells) {
    const c = cells[idx];
    const seen = new Set([idx]);
    const stack = [idx];
    const members = [idx];
    const libs = new Set();
    while (stack.length) {
      const cur = stack.pop();
      for (const nb of neighbors(this.size, cur)) {
        const v = cells[nb];
        if (v === 0) libs.add(nb);
        else if (v === c && !seen.has(nb)) {
          seen.add(nb);
          stack.push(nb);
          members.push(nb);
        }
      }
    }
    return { members, libs };
  }

  // 在 cells 副本上推演一次；返回 {ok, reason, cells, captures, selfCaptured, koPoint}
  simulate(color, vertex) {
    if (this.over) return { ok: false, reason: "over" };
    if (color !== this.side) return { ok: false, reason: "turn" };
    if (vertex === -1) {
      return { ok: true, pass: true, cells: this.cells, captures: 0, selfCaptured: 0, koPoint: -1 };
    }
    if (vertex < 0 || vertex >= this.n2) return { ok: false, reason: "range" };
    if (vertex === this.koPoint) return { ok: false, reason: "ko" };
    if (this.cells[vertex] !== 0) return { ok: false, reason: "occupied" };
    const opp = 3 - color;
    const cells = this.cells.slice();
    cells[vertex] = color;
    const captured = [];
    const seen = new Set();
    for (const nb of neighbors(this.size, vertex)) {
      if (cells[nb] === opp && !seen.has(nb)) {
        const g = this.group(nb, cells);
        for (const m of g.members) seen.add(m);
        if (g.libs.size === 0) captured.push(...g.members);
      }
    }
    for (const m of captured) cells[m] = 0;
    let selfCaptured = 0;
    const own = this.group(vertex, cells);
    if (own.libs.size === 0) {
      if (this.rules.suicide === "forbid") return { ok: false, reason: "suicide" };
      selfCaptured = own.members.length;
      for (const m of own.members) cells[m] = 0;
    }
    // 禁全同
    const key = cells.join("");
    const newSide = 3 - color;
    if (this.rules.ko === "positional" && this.boardKeys.includes(key)) {
      return { ok: false, reason: "superko" };
    }
    if (this.rules.ko === "situational" && this.sitKeys.includes(newSide + ":" + key)) {
      return { ok: false, reason: "superko" };
    }
    // koPoint
    let koNew = -1;
    if (captured.length === 1) {
      const g2 = this.group(vertex, cells);
      if (g2.members.length === 1 && g2.libs.size === 1) koNew = captured[0];
    }
    return { ok: true, vertex, cells, captures: captured.length, selfCaptured, koPoint: koNew };
  }

  play(color, vertex) {
    const r = this.simulate(color, vertex);
    if (!r.ok) return r;
    if (r.pass) {
      const key = this.boardKey();
      const newSide = 3 - color;
      const rec = { pass: true, prevSide: this.side, prevKo: this.koPoint, prevPasses: this.passes };
      this.side = newSide;
      this.sitKeys.push(newSide + ":" + key);
      this.koPoint = -1;
      this.passes += 1;
      this.stack.push(rec);
      if (this.passes >= 2) this.over = true;
      return { ok: true, captures: 0, selfCaptured: 0 };
    }
    const prev = {
      cells: this.cells,
      side: this.side,
      koPoint: this.koPoint,
      passes: this.passes,
      cap: this.captures[color],
    };
    this.cells = r.cells;
    this.captures[color] += r.captures;
    this.koPoint = r.koPoint;
    this.passes = 0;
    this.side = 3 - color;
    const key = this.boardKey();
    this.boardKeys.push(key);
    this.sitKeys.push(this.side + ":" + key);
    this.stack.push(prev);
    return { ok: true, captures: r.captures, selfCaptured: r.selfCaptured };
  }

  undo() {
    const prev = this.stack.pop();
    if (!prev) return false;
    if (prev.pass) {
      this.sitKeys.pop();
      this.side = prev.prevSide;
      this.passes = prev.prevPasses;
      this.koPoint = prev.prevKo;
    } else {
      this.sitKeys.pop();
      this.boardKeys.pop();
      this.cells = prev.cells;
      this.captures[prev.side] = prev.cap;
      this.side = prev.side;
      this.koPoint = prev.koPoint;
      this.passes = prev.passes;
    }
    this.over = false;
    return true;
  }

  legal(color, vertex) {
    const r = this.simulate(color, vertex);
    return r.ok ? { legal: true } : { legal: false, reason: r.reason };
  }

  legalMoves() {
    const out = [];
    for (let p = 0; p < this.n2; p++) {
      if (this.cells[p] !== 0) continue;
      if (this.legal(this.side, p).legal) out.push(p);
    }
    return out;
  }

  score(dead = null) {
    const cells = this.cells.slice();
    const prisoners = [0, this.captures[1], this.captures[2]];
    if (dead) {
      for (const [c, v] of dead) {
        const ci = typeof c === "string" ? parseColor(c) : c;
        const vi = typeof v === "string" ? parseVertex(v, this.size) : v;
        if (cells[vi] === ci) {
          cells[vi] = 0;
          prisoners[3 - ci] += 1;
        }
      }
    }
    const seen = new Array(this.n2).fill(false);
    let bt = 0;
    let wt = 0;
    let dame = 0;
    for (let s = 0; s < this.n2; s++) {
      if (cells[s] !== 0 || seen[s]) continue;
      const stack = [s];
      seen[s] = true;
      let size = 1;
      const borders = new Set();
      while (stack.length) {
        const cur = stack.pop();
        for (const nb of neighbors(this.size, cur)) {
          const v = cells[nb];
          if (v === 0) {
            if (!seen[nb]) {
              seen[nb] = true;
              stack.push(nb);
              size += 1;
            }
          } else borders.add(v);
        }
      }
      if (borders.size === 1 && borders.has(1)) bt += size;
      else if (borders.size === 1 && borders.has(2)) wt += size;
      else dame += size;
    }
    let bs = 0;
    let ws = 0;
    for (const v of cells) {
      if (v === 1) bs += 1;
      else if (v === 2) ws += 1;
    }
    let black;
    let white;
    if (this.rules.scoring === "area") {
      black = bs + bt;
      white = ws + wt;
    } else {
      black = bt + prisoners[1];
      white = wt + prisoners[2];
    }
    const diff = black - (white + this.komi);
    const result = diff === 0 ? "0" : (diff > 0 ? "B+" + fmtNum(diff) : "W+" + fmtNum(-diff));
    return { black, white, komi: this.komi, dame, result };
  }

  /** 自动死子判定后的终局计分（面积法）。推翻 docs/RESEARCH.md §8.4「死子自动判定：不实现」：
   * 终局（两 pass）后自动识别死子并移除，修正「盘上皆活」给错的分差。
   * 与引擎侧 ai.mjs 的 dead_stones 叶子估值共用 tools/scoring.mjs 的同一算法，语义一致。 */
  scoreAuto() {
    const neigh = buildNeigh(this.size);
    const dead = deadStones(this.cells, this.size, neigh);
    const pairs = [];
    for (const m of dead) pairs.push([this.cells[m], formatVertex(m, this.size)]);
    return this.score(pairs);
  }

  /** 复演一手序列：任一手非法即返回 {ok:false, ply, reason}（裁决用） */
  replay(colors, vertices) {
    for (let i = 0; i < colors.length; i++) {
      const c = typeof colors[i] === "string" ? parseColor(colors[i]) : colors[i];
      const v = typeof vertices[i] === "string" ? parseVertex(vertices[i], this.size) : vertices[i];
      const r = this.play(c, v);
      if (!r.ok) return { ok: false, ply: i, reason: r.reason };
    }
    return { ok: true, score: this.score() };
  }
}
