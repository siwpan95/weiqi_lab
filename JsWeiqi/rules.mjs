// rules.mjs — 围棋规则核心（JsWeiqi）
//
// 规范来源：docs/RULES_SPEC.md（spec-v1）。
// 行为参照：PyWeiqi/weiqi_rules.py —— 规则操作必须与其逐位一致。
//
// 64 位键一律使用 BigInt；输出 "0x" + 16 位小写 hex。

export const MASK64 = (1n << 64n) - 1n;
export const MAX_POINTS = 361;
export const COLS = "ABCDEFGHJKLMNOPQRST";

export class WeiqiError extends Error {
  constructor(msg, reason = null) {
    super(msg);
    this.name = "WeiqiError";
    this.msg = msg;
    this.reason = reason;
  }
}

// 规则档（RULES_SPEC §10）
export const PROFILES = {
  cn: { ko: "positional", suicide: "forbid", scoring: "area", komi: 7.5 },
  tt: { ko: "positional", suicide: "allow", scoring: "area", komi: 7.5 },
  jp: { ko: "simple", suicide: "forbid", scoring: "territory", komi: 6.5 },
};

// ---------- Zobrist（RULES_SPEC §6，splitmix64 严格照抄）----------

export function splitmix64(x) {
  let z = (BigInt(x) + 0x9E3779B97F4A7C15n) & MASK64;
  z = ((z ^ (z >> 30n)) * 0xBF58476D1CE4E5B9n) & MASK64;
  z = ((z ^ (z >> 27n)) * 0x94D049BB133111EBn) & MASK64;
  return (z ^ (z >> 31n)) & MASK64;
}

export const ZB = [null, new Array(MAX_POINTS), new Array(MAX_POINTS)];
for (const c of [1, 2]) {
  for (let p = 0; p < MAX_POINTS; p++) {
    ZB[c][p] = splitmix64((c - 1) * 1024 + p);
  }
}
export const SIDEKEY_W = splitmix64(4096);

export function fmt_key(k) {
  return "0x" + k.toString(16).padStart(16, "0");
}

// Python round() 为 half-to-even；此处严格对齐以保持结果串逐字一致。
function py_round(x) {
  const f = Math.floor(x);
  const d = x - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

// 数值格式：整数不带小数点，否则按 0.25 步长（.25/.5/.75）。
export function fmt_num(v) {
  const q = py_round(v * 4);
  const whole = Math.floor(Math.abs(q) / 4);
  const rem = Math.abs(q) % 4;
  const s = "" + whole + { 0: "", 1: ".25", 2: ".5", 3: ".75" }[rem];
  return q < 0 ? "-" + s : s;
}

// ---------- 坐标 ----------

const _NEIGH_CACHE = new Map();

export function neighbors_of(size) {
  let n = _NEIGH_CACHE.get(size);
  if (n === undefined) {
    n = new Array(size * size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const lst = [];
        if (x > 0) lst.push(y * size + x - 1);
        if (x < size - 1) lst.push(y * size + x + 1);
        if (y > 0) lst.push((y - 1) * size + x);
        if (y < size - 1) lst.push((y + 1) * size + x);
        n[y * size + x] = lst;
      }
    }
    _NEIGH_CACHE.set(size, n);
  }
  return n;
}

function py_int(s) {
  // 对齐 Python int(str)：允许首尾空白与符号，拒绝小数/空串。
  const t = String(s).trim();
  if (!/^[+-]?[0-9]+$/.test(t)) throw new Error("bad int: " + s);
  return Number(t);
}

// 返回点索引；pass → -1；非法 → 抛 WeiqiError(reason="range")
export function parse_vertex(s, size) {
  if (s === null || s === undefined) throw new WeiqiError("range", "range");
  const t = String(s).trim().toUpperCase();
  if (t === "PASS") return -1;
  if (t.length < 2) throw new WeiqiError("range", "range");
  const col = COLS.indexOf(t[0]);
  if (col < 0 || col >= size) throw new WeiqiError("range", "range");
  let row;
  try {
    row = py_int(t.slice(1));
  } catch (e) {
    throw new WeiqiError("range", "range");
  }
  if (row < 1 || row > size) throw new WeiqiError("range", "range");
  return (row - 1) * size + col;
}

export function format_vertex(idx, size) {
  if (idx < 0) return "pass";
  return COLS[idx % size] + String(Math.floor(idx / size) + 1);
}

export function parse_color(c) {
  const t = String(c).trim().toUpperCase();
  if (t === "B" || t === "BLACK" || t === "1") return 1;
  if (t === "W" || t === "WHITE" || t === "2") return 2;
  throw new WeiqiError("bad color: " + JSON.stringify(c), "bad args");
}

export function color_name(c) {
  return c === 1 ? "B" : "W";
}

// ---------- 规则档归一化 ----------

export function normalize_rules(r = null) {
  if (r === null || r === undefined) r = "cn";
  if (typeof r === "string") {
    const p = PROFILES[r.trim().toLowerCase()];
    if (p === undefined) throw new WeiqiError("unknown rules profile: " + JSON.stringify(r));
    return Object.assign({}, p);
  }
  if (typeof r !== "object" || r === null) throw new WeiqiError("bad rules");
  const out = Object.assign({}, PROFILES.cn);
  for (const k of ["ko", "suicide", "scoring"]) {
    const v = r[k];
    if (v !== undefined && v !== null) out[k] = String(v).trim().toLowerCase();
  }
  if (r["komi"] !== undefined && r["komi"] !== null) out["komi"] = Number(r["komi"]);
  if (!["simple", "positional", "situational"].includes(out.ko)) {
    throw new WeiqiError("bad ko: " + JSON.stringify(out.ko));
  }
  if (!["forbid", "allow"].includes(out.suicide)) {
    throw new WeiqiError("bad suicide: " + JSON.stringify(out.suicide));
  }
  if (!["area", "territory"].includes(out.scoring)) {
    throw new WeiqiError("bad scoring: " + JSON.stringify(out.scoring));
  }
  return out;
}

function sit_of(posKey, side) {
  return posKey.toString() + ":" + side;
}

// ---------- Board ----------

export class Board {
  constructor(size = 9, komi = null, rules = null) {
    this.size = Math.trunc(Number(size));
    if (!(this.size >= 2 && this.size <= 19)) throw new WeiqiError("bad size");
    this.n2 = this.size * this.size;
    this.neigh = neighbors_of(this.size);
    this.rules = normalize_rules(rules);
    this.komi = Number(komi === null || komi === undefined ? this.rules["komi"] : komi);
    this.reset();
  }

  reset() {
    this.cells = new Array(this.n2).fill(0);
    this.side = 1;
    this.ko_point = -1;
    this.passes = 0;
    this.pos_key = 0n;
    this.captures = [0, 0, 0]; // captures[c] = 黑/白方提掉的对方子数
    this.over = false;
    this.stack = [];
    this.hist_pos = new Map([[0n, 1]]);          // multiset: posKey → count
    this.hist_sit = new Map([[sit_of(0n, 1), 1]]); // multiset: (posKey, side) → count
    return this;
  }

  clone() {
    const b = Object.create(Board.prototype);
    b.size = this.size;
    b.n2 = this.n2;
    b.neigh = this.neigh;
    b.rules = this.rules;
    b.komi = this.komi;
    b.cells = this.cells.slice();
    b.side = this.side;
    b.ko_point = this.ko_point;
    b.passes = this.passes;
    b.pos_key = this.pos_key;
    b.captures = this.captures.slice();
    b.over = this.over;
    b.stack = this.stack.slice();
    b.hist_pos = new Map(this.hist_pos);
    b.hist_sit = new Map(this.hist_sit);
    return b;
  }

  // 直接摆子（不校验合法性），历史重置为单条记录（RULES_SPEC §11）。
  set_stones(stones, side = 1) {
    this.reset();
    for (const item of stones) {
      let color = item[0];
      let vertex = item[1];
      if (typeof color === "string") color = parse_color(color);
      if (typeof vertex === "string") vertex = parse_vertex(vertex, this.size);
      color = Math.trunc(Number(color));
      vertex = Math.trunc(Number(vertex));
      if (vertex >= 0 && vertex < this.n2) {
        this.cells[vertex] = color;
        this.pos_key ^= ZB[color][vertex];
      }
    }
    this.side = side;
    this.hist_pos = new Map([[this.pos_key, 1]]);
    this.hist_sit = new Map([[sit_of(this.pos_key, side), 1]]);
    return this;
  }

  key() {
    const sit = this.pos_key ^ (this.side === 2 ? SIDEKEY_W : 0n);
    return [this.pos_key, sit];
  }

  is_over() {
    return this.over;
  }

  // ---------- 棋块 ----------

  group(idx) {
    const cells = this.cells;
    const color = cells[idx];
    const neigh = this.neigh;
    const stack = [idx];
    const seen = new Set([idx]);
    const members = [idx];
    const libs = new Set();
    while (stack.length) {
      const cur = stack.pop();
      for (const nb of neigh[cur]) {
        const v = cells[nb];
        if (v === 0) {
          libs.add(nb);
        } else if (v === color && !seen.has(nb)) {
          seen.add(nb);
          stack.push(nb);
          members.push(nb);
        }
      }
    }
    return [members, libs];
  }

  // ---------- 走子 ----------

  _err(reason) {
    return {
      ok: false, reason, captures: 0, self_captured: 0,
      key: fmt_key(this.pos_key),
    };
  }

  // color: 1/2；vertex: 点索引 或 -1(pass)。返回 dict。
  play(color, vertex) {
    if (this.over) return this._err("over");
    if (color !== this.side) return this._err("turn");
    if (vertex === -1) {
      const rec = {
        type: "pass", prev_key: this.pos_key, prev_side: this.side,
        prev_ko: this.ko_point, prev_passes: this.passes, sit_key: null,
      };
      this.side = 3 - color;
      const sk = sit_of(this.pos_key, this.side);
      this.hist_sit.set(sk, (this.hist_sit.get(sk) || 0) + 1);
      rec.sit_key = sk;
      this.ko_point = -1;
      this.passes += 1;
      this.stack.push(rec);
      if (this.passes >= 2) this.over = true;
      return { ok: true, captures: 0, self_captured: 0, key: fmt_key(this.pos_key) };
    }
    if (vertex < 0 || vertex >= this.n2) return this._err("range");
    if (vertex === this.ko_point) return this._err("ko");
    if (this.cells[vertex] !== 0) return this._err("occupied");

    const opp = 3 - color;
    const cells = this.cells;
    const prev_cells = cells.slice();
    const prev_key = this.pos_key;
    const prev_cap = this.captures[color];

    // 5) 落子
    cells[vertex] = color;
    this.pos_key ^= ZB[color][vertex];

    // 6) 提对方
    const captured = [];
    const seen_cap = new Set();
    for (const nb of this.neigh[vertex]) {
      if (cells[nb] === opp && !seen_cap.has(nb)) {
        const [members, libs] = this.group(nb);
        if (libs.size === 0) {
          for (const m of members) seen_cap.add(m);
          for (const m of members) captured.push(m);
        }
      }
    }
    for (const m of captured) {
      cells[m] = 0;
      this.pos_key ^= ZB[opp][m];
    }

    // 7) 自杀判定（提子后己方必有气，可跳过重扫）
    let self_captured = [];
    if (captured.length === 0) {
      const [members, libs] = this.group(vertex);
      if (libs.size === 0) {
        if (this.rules["suicide"] === "forbid") {
          this.cells = prev_cells;
          this.pos_key = prev_key;
          return this._err("suicide");
        }
        self_captured = members;
        for (const m of members) {
          cells[m] = 0;
          this.pos_key ^= ZB[color][m];
        }
      }
    }

    // 8) 禁全同
    const new_key = this.pos_key;
    const new_side = 3 - color;
    if (this.rules["ko"] === "positional" && this.hist_pos.has(new_key)) {
      this.cells = prev_cells;
      this.pos_key = prev_key;
      return this._err("superko");
    }
    if (this.rules["ko"] === "situational" && this.hist_sit.has(sit_of(new_key, new_side))) {
      this.cells = prev_cells;
      this.pos_key = prev_key;
      return this._err("superko");
    }

    // 9) 提交（先取快照，再改状态）
    let ko_new = -1;
    if (captured.length === 1) {
      const [members, libs] = this.group(vertex);
      if (members.length === 1 && libs.size === 1) ko_new = captured[0];
    }
    const rec = {
      type: "move", color, prev_cells, prev_key, prev_side: this.side,
      prev_ko: this.ko_point, prev_passes: this.passes, prev_cap,
      pos_key: new_key, sit_key: sit_of(new_key, new_side),
    };
    this.ko_point = ko_new;
    this.captures[color] += captured.length;
    this.side = new_side;
    this.passes = 0;
    this.hist_pos.set(new_key, (this.hist_pos.get(new_key) || 0) + 1);
    const sk2 = rec.sit_key;
    this.hist_sit.set(sk2, (this.hist_sit.get(sk2) || 0) + 1);
    this.stack.push(rec);
    return {
      ok: true, captures: captured.length, self_captured: self_captured.length,
      key: fmt_key(new_key),
    };
  }

  undo() {
    if (this.stack.length === 0) return false;
    const rec = this.stack.pop();
    if (rec.type === "pass") {
      const k = rec.sit_key;
      if (k !== null) {
        const n = (this.hist_sit.get(k) || 0) - 1;
        if (n <= 0) this.hist_sit.delete(k); else this.hist_sit.set(k, n);
      }
      this.pos_key = rec.prev_key;
      this.side = rec.prev_side;
      this.ko_point = rec.prev_ko;
      this.passes = rec.prev_passes;
    } else {
      const pk = rec.pos_key;
      const n = (this.hist_pos.get(pk) || 0) - 1;
      if (n <= 0) this.hist_pos.delete(pk); else this.hist_pos.set(pk, n);
      const k = rec.sit_key;
      const n2 = (this.hist_sit.get(k) || 0) - 1;
      if (n2 <= 0) this.hist_sit.delete(k); else this.hist_sit.set(k, n2);
      this.cells = rec.prev_cells;
      this.pos_key = rec.prev_key;
      this.captures[rec.color] = rec.prev_cap;
      this.side = rec.prev_side;
      this.ko_point = rec.prev_ko;
      this.passes = rec.prev_passes;
    }
    this.over = false;
    return true;
  }

  // ---------- 合法性与计分 ----------

  // → [bool, reason or null]
  legal(color, vertex) {
    if (this.over) return [false, "over"];
    if (color !== this.side) return [false, "turn"];
    if (vertex === -1) return [true, null];
    if (vertex < 0 || vertex >= this.n2) return [false, "range"];
    if (vertex === this.ko_point) return [false, "ko"];
    if (this.cells[vertex] !== 0) return [false, "occupied"];
    const b = this.clone();
    const r = b.play(color, vertex);
    if (r.ok) return [true, null];
    return [false, r.reason];
  }

  legal_moves() {
    const out = [];
    for (let p = 0; p < this.n2; p++) {
      if (this.cells[p] === 0) {
        const [ok] = this.legal(this.side, p);
        if (ok) out.push(p);
      }
    }
    return out;
  }

  prisoners() {
    return { black: this.captures[1], white: this.captures[2] };
  }

  score(dead = null) {
    const size = this.size;
    const n2 = this.n2;
    const neigh = this.neigh;
    let cells = this.cells;
    const prisoners = [0, this.captures[1], this.captures[2]];
    if (dead && dead.length) {
      cells = cells.slice();
      for (const item of dead) {
        let color = item[0];
        let vertex = item[1];
        if (typeof color === "string") color = parse_color(color);
        if (typeof vertex === "string") vertex = parse_vertex(vertex, size);
        color = Math.trunc(Number(color));
        vertex = Math.trunc(Number(vertex));
        if (vertex >= 0 && vertex < n2 && cells[vertex] === color) {
          cells[vertex] = 0;
          prisoners[3 - color] += 1;
        }
      }
    }
    const seen = new Uint8Array(n2);
    let black_t = 0;
    let white_t = 0;
    let dame = 0;
    for (let start = 0; start < n2; start++) {
      if (cells[start] !== 0 || seen[start]) continue;
      const stack = [start];
      seen[start] = 1;
      let size_region = 1;
      const borders = new Set();
      while (stack.length) {
        const cur = stack.pop();
        for (const nb of neigh[cur]) {
          const v = cells[nb];
          if (v === 0) {
            if (!seen[nb]) {
              seen[nb] = 1;
              stack.push(nb);
              size_region += 1;
            }
          } else {
            borders.add(v);
          }
        }
      }
      if (borders.size === 1 && borders.has(1)) black_t += size_region;
      else if (borders.size === 1 && borders.has(2)) white_t += size_region;
      else dame += size_region;
    }
    let black_stones = 0;
    let white_stones = 0;
    for (let i = 0; i < n2; i++) {
      const v = cells[i];
      if (v === 1) black_stones += 1;
      else if (v === 2) white_stones += 1;
    }
    let black;
    let white;
    if (this.rules["scoring"] === "area") {
      black = black_stones + black_t;
      white = white_stones + white_t;
    } else {
      black = black_t + prisoners[1];
      white = white_t + prisoners[2];
    }
    const diff = black - (white + this.komi);
    let result;
    if (diff === 0) result = "0";
    else if (diff > 0) result = "B+" + fmt_num(diff);
    else result = "W+" + fmt_num(-diff);
    return {
      black, white, komi: this.komi, dame,
      result,
      black_territory: black_t, white_territory: white_t,
      black_stones, white_stones,
      prisoners_black: prisoners[1], prisoners_white: prisoners[2],
    };
  }
}
