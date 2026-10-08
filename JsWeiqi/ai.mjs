// ai.mjs — MCTS(UCT+RAVE) 引擎（JsWeiqi）
//
// 参照：PyWeiqi/weiqi_ai.py。结构等价（详见 docs/PORTING.md §4）：
// - 树内与最终落子走【完整规则】（禁全同）；playout 用 simple-ko 近似。
// - 候选点裁剪：最近棋子切比雪夫半径 R 内（R=0 关）。
// - playout 局部候选：优先最后一手 1 邻域，无候选才全盘扫描。
// - 固定模拟次数预算（默认 500），RNG 为 splitmix64 流；同 (seed,playouts,profile) 可复现。
// - 性能：PBoard 用 stamp 数组（零 set 分配）+ 快路径（提子预检 / 气数下界 / 单子判定）。

import { splitmix64, MASK64 } from "./rules.mjs";

export const PASS = -1;
export const PASS_MOVE = -1;

const GOLD = 0x9E3779B97F4A7C15n;

// splitmix64 流式 RNG（纯整数，同语言内可复现）
export class Rng {
  constructor(seed = 0) {
    this.state = (BigInt(seed) + GOLD) & MASK64;
  }

  next_u64() {
    this.state = (this.state + GOLD) & MASK64;
    return splitmix64(this.state);
  }

  randint(n) {
    return n > 0 ? Number(this.next_u64() % BigInt(n)) : 0;
  }

  random() {
    return Number(this.next_u64() >> 11n) * (1.0 / 9007199254740992.0);
  }
}

// 轻量棋盘：仅 simple-ko + 自杀档，用于树与 playout 的高速推演。
export class PBoard {
  constructor(size, neigh, cells, side, ko, passes, suicide_allow) {
    this.size = size;
    this.n2 = size * size;
    this.neigh = neigh;
    this.cells = cells; // Uint8Array
    this.side = side;
    this.ko = ko;
    this.passes = passes;
    this.suicide_allow = suicide_allow;
    this.last = -1;
    this.stamp = new Int32Array(this.n2);
    this.libstamp = new Int32Array(this.n2);
    this._gen = 0;
  }

  clone() {
    const p = new PBoard(this.size, this.neigh, this.cells.slice(), this.side,
      this.ko, this.passes, this.suicide_allow);
    p.last = this.last;
    return p;
  }

  // 棋块扫描 → [members|None, n_libs, lib0]。want_members=False 时不建成员表（省分配）。
  _scan(idx, want_members) {
    const cells = this.cells;
    const stamp = this.stamp;
    const libstamp = this.libstamp;
    const gen = this._gen + 1;
    this._gen = gen;
    const color = cells[idx];
    const neigh = this.neigh;
    const stack = [idx];
    stamp[idx] = gen;
    const members = want_members ? [idx] : null;
    let nlibs = 0;
    let lib0 = -1;
    while (stack.length) {
      const cur = stack.pop();
      const nbs = neigh[cur];
      for (let i = 0; i < nbs.length; i++) {
        const nb = nbs[i];
        const v = cells[nb];
        if (v === 0) {
          if (libstamp[nb] !== gen) {
            libstamp[nb] = gen;
            nlibs += 1;
            if (lib0 < 0) lib0 = nb;
          }
        } else if (v === color && stamp[nb] !== gen) {
          stamp[nb] = gen;
          stack.push(nb);
          if (want_members) members.push(nb);
        }
      }
    }
    return [members, nlibs, lib0];
  }

  // 核心推演。→ [ok, captures, own_size, own_libs, ko_new]；mutate=True 保留变化。
  simulate(color, p, mutate) {
    const cells = this.cells;
    if (p < 0 || p >= this.n2 || cells[p] !== 0 || p === this.ko) {
      return [false, 0, 0, 0, -1];
    }
    const opp = 3 - color;
    const neigh = this.neigh;
    const save = [[p, 0]];
    cells[p] = color;
    const captured = [];
    const seen = new Set();
    // 6) 提对方（提子预检：仅当邻块除落点外无空邻点才整块扫描）
    for (const nb of neigh[p]) {
      if (cells[nb] === opp && !seen.has(nb)) {
        let other_empty = false;
        for (const q of neigh[nb]) {
          if (q !== p && cells[q] === 0) {
            other_empty = true;
            break;
          }
        }
        if (other_empty) {
          seen.add(nb);
          continue;
        }
        const [members, nlibs] = this._scan(nb, true);
        for (const m of members) seen.add(m);
        if (nlibs === 0) for (const m of members) captured.push(m);
      }
    }
    for (const m of captured) {
      save.push([m, opp]);
      cells[m] = 0;
    }
    let empties = 0;
    let same_color_nb = false;
    for (const q of neigh[p]) {
      const v = cells[q];
      if (v === 0) empties += 1;
      else if (v === color) same_color_nb = true;
    }
    let own_size;
    let nlibs;
    let ko_new;
    if (empties >= 2) {
      // 气数下界：落点空邻点 ≥2 → 己方气数必 ≥2，免扫描；ko_new 必为 -1。
      own_size = 1;
      nlibs = empties;
      ko_new = -1;
    } else {
      const [, nl2] = this._scan(p, false);
      nlibs = nl2;
      own_size = same_color_nb ? 2 : 1;
      ko_new = -1;
      if (nlibs === 0) {
        if (!this.suicide_allow) {
          for (let i = save.length - 1; i >= 0; i--) {
            const [idx, old] = save[i];
            cells[idx] = old;
          }
          return [false, 0, 0, 0, -1];
        }
        const [mem3] = this._scan(p, true);
        for (const m of mem3) {
          save.push([m, color]);
          cells[m] = 0;
        }
      } else if (captured.length === 1 && !same_color_nb && nlibs === 1) {
        ko_new = captured[0];
      }
    }
    if (!mutate) {
      for (let i = save.length - 1; i >= 0; i--) {
        const [idx, old] = save[i];
        cells[idx] = old;
      }
      return [true, captured.length, own_size, nlibs, ko_new];
    }
    this.ko = ko_new;
    this.last = p;
    this.passes = 0;
    this.side = opp;
    return [true, captured.length, own_size, nlibs, ko_new];
  }

  probe(color, p) {
    return this.simulate(color, p, false);
  }

  apply(color, p) {
    return this.simulate(color, p, true);
  }

  play_pass(color) {
    this.ko = -1;
    this.passes += 1;
    this.side = 3 - color;
    this.last = -1;
  }

  // 简单眼：全部正交邻点是本方棋子（盘外忽略）。
  is_eye(p, color) {
    const cells = this.cells;
    for (const nb of this.neigh[p]) if (cells[nb] !== color) return false;
    return true;
  }

  // p 的邻点中是否存在 color 方、仅剩 1 气的棋块（含空邻点预检）。
  adjacent_atari(p, color) {
    const cells = this.cells;
    const neigh = this.neigh;
    const seen = new Set();
    for (const nb of neigh[p]) {
      if (cells[nb] === color && !seen.has(nb)) {
        let empties = 0;
        for (const q of neigh[nb]) {
          if (cells[q] === 0) {
            empties += 1;
            if (empties >= 2) break;
          }
        }
        if (empties >= 2) continue;
        const [members, nlibs] = this._scan(nb, true);
        for (const m of members) seen.add(m);
        if (nlibs === 1) return true;
      }
    }
    return false;
  }

  // 最后一手附近的己方被打吃棋块的救手（其唯一气）。
  rescue_moves(color) {
    const out = [];
    const last = this.last;
    if (last < 0) return out;
    const cells = this.cells;
    const neigh = this.neigh;
    const seen = new Set();
    const pts = [last, ...neigh[last]];
    for (const nb of pts) {
      if (cells[nb] === color && !seen.has(nb)) {
        let empties = 0;
        for (const q of neigh[nb]) {
          if (cells[q] === 0) {
            empties += 1;
            if (empties >= 2) break;
          }
        }
        if (empties >= 2) continue;
        const [members, nlibs, lib0] = this._scan(nb, true);
        for (const m of members) seen.add(m);
        if (nlibs === 1 && lib0 >= 0) out.push(lib0);
      }
    }
    return out;
  }

  // 面积计分（盘上皆活）。→ [black_area, white_area]
  area() {
    const cells = this.cells;
    const n2 = this.n2;
    const neigh = this.neigh;
    const seen = new Uint8Array(n2);
    let bt = 0;
    let wt = 0;
    for (let start = 0; start < n2; start++) {
      if (cells[start] !== 0 || seen[start]) continue;
      const stack = [start];
      seen[start] = 1;
      let size_region = 1;
      const borders = new Set();
      while (stack.length) {
        const cur = stack.pop();
        const nbs = neigh[cur];
        for (let i = 0; i < nbs.length; i++) {
          const nb = nbs[i];
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
      if (borders.size === 1 && borders.has(1)) bt += size_region;
      else if (borders.size === 1 && borders.has(2)) wt += size_region;
    }
    let bs = 0;
    let ws = 0;
    for (let i = 0; i < n2; i++) {
      const v = cells[i];
      if (v === 1) bs += 1;
      else if (v === 2) ws += 1;
    }
    return [bs + bt, ws + wt];
  }
}

export const DEFAULT_PROFILE = {
  c: 0.7,
  rave: true,
  rave_k: 100.0,
  capture_bias: 0.5,
  pattern_bias: 0.5,
  prune_radius: 2,
  pass_bias: 0.0,
  resign_threshold: 0.0,
  resign_min_visits: 200,
  mercy: 0.0,
  pass_threshold: 0.5,
  score_scale: 0.0, // 0 → 自动 = n2/2（分差归一化尺度）
};

export class Node {
  constructor(move, to_move, prior = 0.5) {
    this.move = move;
    this.children = new Map(); // 保持插入顺序（等价 Python dict）
    this.to_move = to_move;
    this.N = 0;
    this.W = 0.0;
    this.amafN = 0;
    this.amafW = 0.0;
    this.expanded = false;
    this.prior = prior;
  }
}

// 树内先验（等效经验）：提子加分、自填气减分。
export function move_prior(caps, own_libs) {
  let q = 0.5;
  if (caps >= 2) q += 0.25;
  else if (caps === 1) q += 0.15;
  if (own_libs === 1) q -= 0.15;
  if (q < 0.05) q = 0.05;
  if (q > 0.9) q = 0.9;
  return q;
}

function chebyshev(a, b, size) {
  const ax = a % size;
  const ay = Math.floor(a / size);
  const bx = b % size;
  const by = Math.floor(b / size);
  let dx = ax - bx;
  if (dx < 0) dx = -dx;
  let dy = ay - by;
  if (dy < 0) dy = -dy;
  return dx > dy ? dx : dy;
}

// → [near, any_stone]：near[p] 表示 p 在任一棋子切比雪夫半径内。
function near_mask(pb, radius) {
  const n2 = pb.n2;
  const size = pb.size;
  const near = new Uint8Array(n2);
  const cells = pb.cells;
  let any_stone = false;
  for (let p = 0; p < n2; p++) {
    if (cells[p] === 0) continue;
    any_stone = true;
    const px = p % size;
    const py = Math.floor(p / size);
    const x0 = px - radius > 0 ? px - radius : 0;
    const x1 = px + radius < size - 1 ? px + radius : size - 1;
    const y0 = py - radius > 0 ? py - radius : 0;
    const y1 = py + radius < size - 1 ? py + radius : size - 1;
    for (let y = y0; y <= y1; y++) {
      const base = y * size;
      for (let x = x0; x <= x1; x++) near[base + x] = 1;
    }
  }
  return [near, any_stone];
}

// 空盘开局候选：中央三分之一见方（9 路 = 3x3 共 9 点）。
function center_zone(size) {
  const lo = Math.floor(size / 3);
  const hi = size - 1 - Math.floor(size / 3);
  const pts = [];
  for (let y = lo; y <= hi; y++) {
    for (let x = lo; x <= hi; x++) pts.push(y * size + x);
  }
  return pts;
}

// 裁剪后的候选点（无子取中央区；否则取 near 内的合法点）。
function candidates(pb, color, radius) {
  const cells = pb.cells;
  const n2 = pb.n2;
  const size = pb.size;
  const out = [];
  let pts;
  if (radius <= 0) {
    pts = [];
    for (let p = 0; p < n2; p++) pts.push(p);
  } else {
    const [near, any_stone] = near_mask(pb, radius);
    if (!any_stone) {
      pts = center_zone(size);
    } else {
      pts = [];
      for (let p = 0; p < n2; p++) if (near[p]) pts.push(p);
    }
  }
  for (const p of pts) {
    if (cells[p] !== 0) continue;
    if (pb.is_eye(p, color) && !pb.adjacent_atari(p, 3 - color)) continue; // 眼位过滤（打吃例外）
    const [ok, caps, , olibs] = pb.probe(color, p);
    if (ok) out.push([p, caps, olibs]);
  }
  return out;
}

// 轻量 playout：提子/救子优先 → 贴近最后一手 → 随机；避免自填气与填眼。
function playout(pb, rng, pr, max_moves) {
  const cap_bias = pr["capture_bias"];
  const pat_bias = pr["pattern_bias"];
  const large_margin = pr["mercy"] * pb.n2;
  let moves = 0;
  while (pb.passes < 2 && moves < max_moves) {
    const color = pb.side;
    const last = pb.last;
    // 不镜像过手（Fuego 范式）——仅在无着可走时 pass。
    const cands = [];
    const urgent = [];
    const probe_pts = last >= 0 ? [last, ...pb.neigh[last]] : null;
    const cells = pb.cells;
    if (probe_pts !== null) {
      for (const p of probe_pts) {
        if (cells[p] !== 0) continue;
        const [ok, cap, , olibs] = pb.probe(color, p);
        if (!ok) continue;
        if (cap === 0) {
          if (olibs === 1) continue;
          if (pb.is_eye(p, color) && !pb.adjacent_atari(p, 3 - color)) continue;
        }
        cands.push(p);
        if (cap > 0) urgent.push(p);
      }
    }
    if (cands.length === 0) {
      for (let p = 0; p < pb.n2; p++) {
        if (cells[p] !== 0) continue;
        const [ok, cap, , olibs] = pb.probe(color, p);
        if (!ok) continue;
        if (cap === 0) {
          if (olibs === 1) continue;
          if (pb.is_eye(p, color) && !pb.adjacent_atari(p, 3 - color)) continue;
        }
        cands.push(p);
        if (cap > 0) urgent.push(p);
      }
    }
    for (const m of pb.rescue_moves(color)) {
      if (cells[m] === 0 && urgent.indexOf(m) < 0) urgent.push(m);
    }
    if (cands.length === 0) {
      pb.play_pass(color);
      moves += 1;
      continue;
    }
    const r = rng.random();
    let m;
    if (urgent.length > 0 && r < cap_bias) {
      m = urgent[rng.randint(urgent.length)];
    } else if (last >= 0 && rng.random() < pat_bias) {
      const local = cands.filter((p) => chebyshev(p, last, pb.size) <= 1);
      m = local.length > 0 ? local[rng.randint(local.length)] : cands[rng.randint(cands.length)];
    } else {
      m = cands[rng.randint(cands.length)];
    }
    pb.apply(color, m);
    moves += 1;
    if (large_margin > 0) {
      const [bt, wt] = pb.area();
      if (bt - wt > large_margin || wt - bt > large_margin) break;
    }
  }
  return pb;
}

function select(node, c, rave_k, rave) {
  const logN = Math.log(node.N + 1);
  let best = null;
  let bestv = -1e18;
  for (const [m, ch] of node.children) {
    const n = ch.N;
    let q = n ? ch.W / n : ch.prior;
    if (rave && ch.amafN > 0) {
      const qa = ch.amafW / ch.amafN;
      const beta = n > 0 ? Math.sqrt(rave_k / (rave_k + 3.0 * n)) : 1.0;
      q = (1.0 - beta) * q + beta * qa;
    }
    const val = q + c * Math.sqrt(logN / (n + 1));
    if (val > bestv) {
      bestv = val;
      best = m;
    }
  }
  return best;
}

export function rng_shuffle(lst, rng) {
  for (let i = lst.length - 1; i > 0; i--) {
    const j = rng.randint(i + 1);
    const t = lst[i];
    lst[i] = lst[j];
    lst[j] = t;
  }
  return lst;
}

function lessKey(a, b) {
  if (a[0] !== b[0]) return a[0] < b[0];
  if (a[1] !== b[1]) return a[1] < b[1];
  return a[2] < b[2];
}

/**
 * 对 board（完整规则 Board）搜索并返回 [vertex, visits, winrate]。
 * 不落子 —— 落子由调用方（driver）执行，以便用完整规则复检。
 * vertex 可为点索引、PASS(=-1) 或字符串 "resign"。
 */
export function genmove(board, playouts = 500, seed = 0, profile = null) {
  const pr = Object.assign({}, DEFAULT_PROFILE);
  if (profile) {
    for (const k of Object.keys(profile)) {
      if (profile[k] !== null && profile[k] !== undefined) pr[k] = profile[k];
    }
  }
  const rng = new Rng(seed);
  const size = board.size;
  const n2 = board.n2;
  const neigh = board.neigh;
  const suicide_allow = board.rules["suicide"] === "allow";
  const full_legal = board.legal_moves();
  const full_set = new Set(full_legal);

  const pb0 = new PBoard(size, neigh, Uint8Array.from(board.cells), board.side,
    board.ko_point, board.passes, suicide_allow);
  const radius = Math.trunc(Number(pr["prune_radius"]));
  const root = new Node(PASS_MOVE, board.side);
  root.expanded = true;
  const moves = candidates(pb0, board.side, radius).filter(([p]) => full_set.has(p));
  rng_shuffle(moves, rng);
  for (const [m, c, ol] of moves) {
    root.children.set(m, new Node(m, 3 - board.side, move_prior(c, ol)));
  }
  if (root.children.size === 0) {
    return [PASS_MOVE, 0, 0.0]; // 无任何非填眼着法 → 过手（终局机制）
  }

  const max_moves = 3 * n2;
  const iters = Math.max(1, Math.trunc(Number(playouts)));
  for (let it = 0; it < iters; it++) {
    let pb = pb0.clone();
    let node = root;
    const chain = [root];
    const sim_moves = { 1: new Set(), 2: new Set() };
    while (node.expanded && node.children.size > 0) {
      const m = select(node, Number(pr["c"]), Number(pr["rave_k"]), Boolean(pr["rave"]));
      const color = node.to_move;
      if (m === PASS_MOVE) pb.play_pass(color);
      else {
        pb.apply(color, m);
        sim_moves[color].add(m);
      }
      node = node.children.get(m);
      chain.push(node);
    }
    if (!node.expanded) {
      const cl = candidates(pb, node.to_move, radius);
      rng_shuffle(cl, rng);
      for (const [m, c, ol] of cl) {
        node.children.set(m, new Node(m, 3 - node.to_move, move_prior(c, ol)));
      }
      node.expanded = true;
    }
    const leaf_to_move = node.to_move;
    pb = playout(pb, rng, pr, max_moves);
    const [bt, wt] = pb.area();
    // 终局估值：以"分差"归一化（而非纯胜负）。v ∈ [0,1]，0.5 为均势；scale = n2/2。
    const diff_black = bt - wt - board.komi;
    const scale = Number(pr["score_scale"]) > 0 ? Number(pr["score_scale"]) : n2 / 2.0;
    let sv = 0.5 + 0.5 * (diff_black / scale);
    if (sv < 0.0) sv = 0.0;
    else if (sv > 1.0) sv = 1.0;
    const res_leaf = leaf_to_move === 1 ? sv : 1.0 - sv;
    for (const nd of chain) {
      const v = nd.to_move === leaf_to_move ? res_leaf : 1.0 - res_leaf;
      nd.N += 1;
      nd.W += v;
      const mv = sim_moves[nd.to_move];
      const kids = nd.children;
      if (mv.size > 0 && kids.size > 0) {
        const cv = 1.0 - v;
        for (const [m, ch] of kids) {
          if (mv.has(m)) {
            ch.amafN += 1;
            ch.amafW += cv;
          }
        }
      }
    }
  }

  let best = null;
  let best_key = null;
  let best_wr = 0.0;
  let best_n = 0;
  let total_visits = 0;
  for (const [m, ch] of root.children) {
    total_visits += ch.N;
    const wr = ch.N ? ch.W / ch.N : 0.0;
    const key = [-ch.N, -wr, m === PASS_MOVE ? n2 : m];
    if (best_key === null || lessKey(key, best_key)) {
      best_key = key;
      best = m;
      best_wr = wr;
      best_n = ch.N;
    }
  }
  if (best !== null && !full_set.has(best)) {
    let alt = null;
    let alt_key = null;
    for (const [m, ch] of root.children) {
      if (full_set.has(m)) {
        const wr = ch.N ? ch.W / ch.N : 0.0;
        const key = [-ch.N, -wr, m];
        if (alt_key === null || lessKey(key, alt_key)) {
          alt_key = key;
          alt = m;
        }
      }
    }
    best = alt !== null ? alt : PASS_MOVE;
  }
  if (best === null) best = PASS_MOVE;
  // 显式过手规则：对手已过手，且本方胜率达标 → 过手终局（否则继续争胜）
  if (board.passes >= 1 && best !== PASS_MOVE && best_wr >= Number(pr["pass_threshold"])) {
    return [PASS_MOVE, best_n, best_wr];
  }
  if (Number(pr["resign_threshold"]) > 0
    && total_visits >= Math.trunc(Number(pr["resign_min_visits"]))
    && best_wr < Number(pr["resign_threshold"])) {
    return ["resign", best_n, best_wr];
  }
  return [best, best_n, best_wr];
}
