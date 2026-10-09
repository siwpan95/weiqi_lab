// ai.mjs — MCTS(UCT+RAVE) 引擎（JsWeiqi）
//
// 参照：PyWeiqi/weiqi_ai.py。结构等价（详见 docs/PORTING.md §4）：
// - 树内与最终落子走【完整规则】（禁全同）；playout 用 simple-ko 近似。
// - 候选点裁剪：最近棋子切比雪夫半径 R 内（R=0 关）。
// - playout 局部候选：优先最后一手 1 邻域，无候选才全盘扫描。
// - 固定模拟次数预算（默认 500），RNG 为 splitmix64 流；同 (seed,playouts,profile) 可复现。
// - 性能：PBoard 用 stamp 数组（零 set 分配）+ 快路径（提子预检 / 气数下界 / 单子判定）。

import path from "node:path";
import { fileURLToPath } from "node:url";
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
    // ---- 零分配 scratch（热路径复用；19 路实测 probe/playout 达 3.6 万次，避免每次分配小数组）----
    this._scanStack = new Int32Array(this.n2);    // 棋块扫描的遍历栈
    this._scanMembers = new Int32Array(this.n2);  // 棋块成员（前 _sMLen 项有效）
    this._saveIdx = new Int32Array(this.n2 + 2);  // simulate 的回滚记录（点）
    this._saveVal = new Uint8Array(this.n2 + 2);  // simulate 的回滚记录（原值）
    this._capBuf = new Int32Array(this.n2);       // 本手提子点
    this._seenStamp = new Int32Array(this.n2);    // 棋块去重（代际标记，替代 Set）
    this._seenGen = 0;
    this._sNlibs = 0;
    this._sLib0 = -1;
    this._sMLen = 0;
  }

  clone() {
    const p = new PBoard(this.size, this.neigh, this.cells.slice(), this.side,
      this.ko, this.passes, this.suicide_allow);
    p.last = this.last;
    return p;
  }

  // 棋块扫描（**零分配**）：结果写入 this._sNlibs / this._sLib0 / this._scanMembers[0, _sMLen)。
  // ⚠️ _scanMembers 是共享缓冲：调用方必须在**下一次 _scan 之前**消费完成员（本文件内均如此）。
  _scan(idx, want_members) {
    const cells = this.cells;
    const stamp = this.stamp;
    const libstamp = this.libstamp;
    const gen = this._gen + 1;
    this._gen = gen;
    const color = cells[idx];
    const neigh = this.neigh;
    const stack = this._scanStack;
    const members = this._scanMembers;
    let sp = 0;
    let mlen = 0;
    stack[sp++] = idx;
    stamp[idx] = gen;
    if (want_members) members[mlen++] = idx;
    let nlibs = 0;
    let lib0 = -1;
    while (sp > 0) {
      const cur = stack[--sp];
      const nbs = neigh[cur];
      for (let i = 0, L = nbs.length; i < L; i++) {
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
          stack[sp++] = nb;
          if (want_members) members[mlen++] = nb;
        }
      }
    }
    this._sNlibs = nlibs;
    this._sLib0 = lib0;
    this._sMLen = mlen;
  }

  // 核心推演。→ [ok, captures, own_size, own_libs, ko_new]；mutate=True 保留变化。
  // **零分配**：所有临时状态走实例 scratch（见构造函数注释）。
  simulate(color, p, mutate) {
    const cells = this.cells;
    if (p < 0 || p >= this.n2 || cells[p] !== 0 || p === this.ko) {
      return [false, 0, 0, 0, -1];
    }
    const opp = 3 - color;
    const neigh = this.neigh;
    const saveIdx = this._saveIdx;
    const saveVal = this._saveVal;
    const capBuf = this._capBuf;
    const seenStamp = this._seenStamp;
    const sgen = this._seenGen + 1;
    this._seenGen = sgen;
    let slen = 0;
    let clen = 0;
    saveIdx[slen] = p;
    saveVal[slen] = 0;
    slen += 1;
    cells[p] = color;
    // 6) 提对方（提子预检：仅当邻块除落点外无空邻点才整块扫描）
    const nbsP = neigh[p];
    for (let ni = 0, NL = nbsP.length; ni < NL; ni++) {
      const nb = nbsP[ni];
      if (cells[nb] !== opp || seenStamp[nb] === sgen) continue;
      let other_empty = false;
      const nbs2 = neigh[nb];
      for (let qi = 0, QL = nbs2.length; qi < QL; qi++) {
        const q = nbs2[qi];
        if (q !== p && cells[q] === 0) {
          other_empty = true;
          break;
        }
      }
      if (other_empty) {
        seenStamp[nb] = sgen;
        continue;
      }
      this._scan(nb, true);
      const mlen = this._sMLen;
      const members = this._scanMembers;
      for (let i = 0; i < mlen; i++) seenStamp[members[i]] = sgen;
      if (this._sNlibs === 0) {
        for (let i = 0; i < mlen; i++) capBuf[clen++] = members[i];
      }
    }
    for (let i = 0; i < clen; i++) {
      const m = capBuf[i];
      saveIdx[slen] = m;
      saveVal[slen] = opp;
      slen += 1;
      cells[m] = 0;
    }
    let empties = 0;
    let same_color_nb = false;
    for (let i = 0, L = nbsP.length; i < L; i++) {
      const v = cells[nbsP[i]];
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
      this._scan(p, false);
      nlibs = this._sNlibs;
      own_size = same_color_nb ? 2 : 1;
      ko_new = -1;
      if (nlibs === 0) {
        if (!this.suicide_allow) {
          for (let i = slen - 1; i >= 0; i--) cells[saveIdx[i]] = saveVal[i];
          return [false, 0, 0, 0, -1];
        }
        this._scan(p, true);
        const mlen = this._sMLen;
        const members = this._scanMembers;
        for (let i = 0; i < mlen; i++) {
          const m = members[i];
          saveIdx[slen] = m;
          saveVal[slen] = color;
          slen += 1;
          cells[m] = 0;
        }
      } else if (clen === 1 && !same_color_nb && nlibs === 1) {
        ko_new = capBuf[0];
      }
    }
    if (!mutate) {
      for (let i = slen - 1; i >= 0; i--) cells[saveIdx[i]] = saveVal[i];
      return [true, clen, own_size, nlibs, ko_new];
    }
    this.ko = ko_new;
    this.last = p;
    this.passes = 0;
    this.side = opp;
    return [true, clen, own_size, nlibs, ko_new];
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

  // p 的邻点中是否存在 color 方、仅剩 1 气的棋块（含空邻点预检）。零分配（代际标记替代 Set）。
  adjacent_atari(p, color) {
    const cells = this.cells;
    const neigh = this.neigh;
    const seenStamp = this._seenStamp;
    const sgen = this._seenGen + 1;
    this._seenGen = sgen;
    const nbsP = neigh[p];
    for (let ni = 0, NL = nbsP.length; ni < NL; ni++) {
      const nb = nbsP[ni];
      if (cells[nb] !== color || seenStamp[nb] === sgen) continue;
      let empties = 0;
      const nbs2 = neigh[nb];
      for (let qi = 0, QL = nbs2.length; qi < QL; qi++) {
        if (cells[nbs2[qi]] === 0) {
          empties += 1;
          if (empties >= 2) break;
        }
      }
      if (empties >= 2) continue;
      this._scan(nb, true);
      const mlen = this._sMLen;
      const members = this._scanMembers;
      for (let i = 0; i < mlen; i++) seenStamp[members[i]] = sgen;
      if (this._sNlibs === 1) return true;
    }
    return false;
  }

  // 最后一手附近的己方被打吃棋块的救手（其唯一气）。零分配（除返回的 out 数组）。
  rescue_moves(color) {
    const out = [];
    const last = this.last;
    if (last < 0) return out;
    const cells = this.cells;
    const neigh = this.neigh;
    const seenStamp = this._seenStamp;
    const sgen = this._seenGen + 1;
    this._seenGen = sgen;
    const nbsL = neigh[last];
    for (let li = -1, LL = nbsL.length; li < LL; li++) {
      const nb = li < 0 ? last : nbsL[li];
      if (cells[nb] !== color || seenStamp[nb] === sgen) continue;
      let empties = 0;
      const nbs2 = neigh[nb];
      for (let qi = 0, QL = nbs2.length; qi < QL; qi++) {
        if (cells[nbs2[qi]] === 0) {
          empties += 1;
          if (empties >= 2) break;
        }
      }
      if (empties >= 2) continue;
      this._scan(nb, true);
      const mlen = this._sMLen;
      const nlibs = this._sNlibs;
      const lib0 = this._sLib0;
      const members = this._scanMembers;
      for (let i = 0; i < mlen; i++) seenStamp[members[i]] = sgen;
      if (nlibs === 1 && lib0 >= 0) out.push(lib0);
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
  // ---- CNN 先验（可选；默认 0 = 关闭，基线行为完全不变）----
  cnn_prior: 0.0,           // PUCT 先验项权重；0 = 关闭
  cnn_prior_max_nodes: 1,   // 每次 genmove 最多做几次 CNN 前向（1 = 仅根节点）
  cnn_prior_weights: null,  // 权重文件路径覆盖；null = spec/cnn_weights-<size>.json
  // ---- 惰性探测（可选；默认 0 = 探测全部候选，与原行为逐位一致）----
  probe_k: 0,               // >0：playout 每手最多探测 k 个普通候选（提子点必探，不受限）
  // ---- 渐进加宽（可选；默认 0 = 一次开放全部候选，与原行为逐位一致）----
  pw_c: 0,                  // >0：候选开放数 k = max(pw_min, ⌈c·√(N+1)⌉)，随节点访问数增长
  pw_min: 8,                // 初始最少开放候选数（防止根节点过早收窄）
};

// ---------------------------------------------------------------- CNN 先验
// 运行期零依赖：CnnPolicy 由 tools/cnn_forward.mjs（纯 JS 前向）提供；
// 该文件缺失时**自动禁用先验**（引擎仍可独立运行），并只在启用后首次调用时告警一次。
let CnnPolicy = null;
try {
  ({ CnnPolicy } = await import("../tools/cnn_forward.mjs"));
} catch (e) {
  CnnPolicy = null;
}

let _cnnNet = null;
let _cnnNetKey = null;
let _cnnFailReason = null;
let _cnnWarned = false;

function loadCnnNet(size, weightsPath) {
  const key = size + "|" + (weightsPath || "");
  if (_cnnNetKey === key) return _cnnNet;
  _cnnNetKey = key;
  _cnnNet = null;
  _cnnFailReason = null;
  if (!CnnPolicy) {
    _cnnFailReason = "tools/cnn_forward.mjs 不可用（引擎独立运行时属正常）";
    return null;
  }
  try {
    const p = weightsPath || _defaultWeightsPath(size);
    const net = CnnPolicy.load(p);
    if (net.size !== size) throw new Error(`权重尺寸 ${net.size} ≠ 棋盘 ${size}`);
    _cnnNet = net;
  } catch (e) {
    _cnnFailReason = e.message;
  }
  return _cnnNet;
}

function _defaultWeightsPath(size) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.join(here, "..", "spec", `cnn_weights-${size}.json`);
}

/** 从完整规则 Board 的栈记录推导"最后一手"点索引（-1 = 无/pass）：
 *  落子手的记录里 prev_cells 与 cells 相比，唯一"空→有子"的点即落点（提子只会是"有子→空"）。 */
export function lastMoveOf(board) {
  const st = board.stack;
  if (!st || st.length === 0) return -1;
  const rec = st[st.length - 1];
  if (rec.type !== "move" || !rec.prev_cells) return -1;
  const cells = board.cells;
  const prev = rec.prev_cells;
  for (let i = 0; i < cells.length; i++) {
    if (prev[i] === 0 && cells[i] !== 0) return i;
  }
  return -1;
}

/** 把 CNN 策略写进 node 的子节点（归一化到该节点的候选集），返回写入的节点数 */
function attachCnnPrior(net, pb, node) {
  if (!node.children || node.children.size === 0) return 0;
  const probs = net.policyFrom(pb.cells, node.to_move, pb.last);
  let sum = 0;
  for (const [m] of node.children) if (probs[m] > 0) sum += probs[m];
  if (sum <= 0) return 0;
  for (const [m, ch] of node.children) ch.cnnP = probs[m] > 0 ? probs[m] / sum : 0;
  return node.children.size;
}

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
    this.cnnP = 0.0; // CNN 先验（归一化到本节点候选集；未启用时恒为 0）
    this.candPool = null; // 渐进加宽：完整候选列表（按 prior 降序，同分保持随机序）
    this.candAdded = 0;   // 已开放到 children 的数量
  }
}

// 渐进加宽：按节点访问数决定"应开放多少候选"，把更多候选逐步加入 children。
// k = min(poolLen, max(minK, ⌈c·√(N+1)⌉))。新加入的候选因"未访问 + 最大探索项"会被优先采样。
function widenNode(node, c, minK) {
  const pool = node.candPool;
  if (!pool) return;
  const want = Math.min(pool.length, Math.max(minK, Math.ceil(c * Math.sqrt(node.N + 1))));
  while (node.candAdded < want) {
    const item = pool[node.candAdded];
    node.candAdded += 1;
    const m = item[0];
    if (node.children.has(m)) continue;
    node.children.set(m, new Node(m, 3 - node.to_move, move_prior(item[1], item[2])));
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

// ---------------------------------------------------------------- 惰性探测（probe_k > 0）
// p 落子是否**可能**提掉对方子。
// 判据（保守必要条件，**不漏真提子**、可能多报——多报的代价只是多一次 probe）：
//   p 的某个对方邻子 q 的"空邻点集"恰为 {p}。
// 证明：若 p 提 q 所在块，则块的气集 = {p}；而 q 的空邻 ⊆ 块的气集，故 q 的空邻 = {p}。∎
function _mayCapture(pb, p, color) {
  const cells = pb.cells;
  const neigh = pb.neigh;
  const opp = 3 - color;
  const nbs = neigh[p];
  for (let i = 0, L = nbs.length; i < L; i++) {
    const q = nbs[i];
    if (cells[q] !== opp) continue;
    const qn = neigh[q];
    let nEmpty = 0;
    let onlyP = true;
    for (let j = 0, QL = qn.length; j < QL; j++) {
      const r = qn[j];
      if (cells[r] === 0) {
        nEmpty += 1;
        if (r !== p) {
          onlyP = false;
          break;
        }
      }
    }
    if (nEmpty === 1 && onlyP) return true;
  }
  return false;
}

// 惰性候选收集：圈序 {last+正交邻} → 方形2 → 方形4 → 全盘；
// 每圈内先做提子预判（O(16)/点，不 probe）→ 疑似点 probe 确认；再按随机顺序探测普通候选，
// 最多 probeK 个（probeK=0 的语义由调用方保证不走本函数）。
function collectLazy(pb, rng, color, probeK, cands, urgent) {
  const size = pb.size;
  const cells = pb.cells;
  const neigh = pb.neigh;
  const last = pb.last;
  const n2 = pb.n2;
  let probed = 0;
  const nRings = last >= 0 ? 4 : 1;
  for (let ring = 0; ring < nRings; ring++) {
    const pool = [];
    let prevR = -1;
    let R = 0;
    if (last < 0) {
      for (let p = 0; p < n2; p++) if (cells[p] === 0) pool.push(p);
    } else if (ring === 0) {
      if (cells[last] === 0) pool.push(last);
      const nb = neigh[last];
      for (let i = 0, L = nb.length; i < L; i++) if (cells[nb[i]] === 0) pool.push(nb[i]);
    } else {
      R = ring === 1 ? 2 : ring === 2 ? 4 : 0; // 0 = 全盘
      prevR = ring === 1 ? 1 : ring === 2 ? 2 : 4;
      const lx = last % size;
      const ly = (last - lx) / size;
      if (R === 0) {
        for (let p = 0; p < n2; p++) {
          if (cells[p] !== 0) continue;
          const dx = Math.abs((p % size) - lx);
          const dy = Math.abs(Math.floor(p / size) - ly);
          if ((dx > dy ? dx : dy) <= prevR) continue;
          pool.push(p);
        }
      } else {
        for (let dy = -R; dy <= R; dy++) {
          const y = ly + dy;
          if (y < 0 || y >= size) continue;
          for (let dx = -R; dx <= R; dx++) {
            const x = lx + dx;
            if (x < 0 || x >= size) continue;
            const adx = dx < 0 ? -dx : dx;
            const ady = dy < 0 ? -dy : dy;
            if ((adx > ady ? adx : ady) <= prevR) continue;
            const p = y * size + x;
            if (cells[p] === 0) pool.push(p);
          }
        }
      }
    }
    if (!pool.length) continue;
    rng_shuffle(pool, rng);
    // 轮 1：提子（预判 → 确认）
    for (let i = 0, L = pool.length; i < L; i++) {
      const p = pool[i];
      if (!_mayCapture(pb, p, color)) continue;
      const r = pb.probe(color, p);
      probed += 1;
      if (!r[0]) continue;
      if (r[1] > 0) urgent.push(p);
      else if (r[3] > 1 && !(pb.is_eye(p, color) && !pb.adjacent_atari(p, 3 - color))) cands.push(p);
    }
    // 轮 2：普通候选（随机顺序，最多 probeK 个）
    for (let i = 0, L = pool.length; i < L && probed < probeK; i++) {
      const p = pool[i];
      if (urgent.indexOf(p) >= 0 || cands.indexOf(p) >= 0) continue;
      const r = pb.probe(color, p);
      probed += 1;
      if (!r[0]) continue;
      if (r[1] > 0) {
        urgent.push(p);
        continue;
      }
      if (r[3] === 1) continue;
      if (pb.is_eye(p, color) && !pb.adjacent_atari(p, 3 - color)) continue;
      cands.push(p);
    }
    if (cands.length > 0 || urgent.length > 0) return;
  }
}

// 轻量 playout：提子/救子优先 → 贴近最后一手 → 随机；避免自填气与填眼。
function playout(pb, rng, pr, max_moves) {
  const cap_bias = pr["capture_bias"];
  const pat_bias = pr["pattern_bias"];
  const large_margin = pr["mercy"] * pb.n2;
  const probeK = Math.trunc(Number(pr["probe_k"]) || 0);
  let moves = 0;
  while (pb.passes < 2 && moves < max_moves) {
    const color = pb.side;
    const last = pb.last;
    // 不镜像过手（Fuego 范式）——仅在无着可走时 pass。
    const cands = [];
    const urgent = [];
    const cells = pb.cells;
    if (probeK > 0) {
      // ---- 惰性路径（probe_k > 0）：提子优先 + 随机顺序早停 ----
      collectLazy(pb, rng, color, probeK, cands, urgent);
    } else {
      // ---- 原路径（默认）：探测全部局部候选，行为与历史版本逐位一致 ----
      const probe_pts = last >= 0 ? [last, ...pb.neigh[last]] : null;
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
        // 逐圈扩大（关键性能优化，19 路实测：全盘扫描会使 probe 次数 ×35）：
        // 半径 1 已在上方尝试过 → 依次试 2 / 4 / 全盘；每圈仅对盘内点调用 probe。
        const rings = last >= 0 ? [2, 4, 0] : [0]; // 0 = 全盘
        for (const R of rings) {
          for (let p = 0; p < pb.n2; p++) {
            if (cells[p] !== 0) continue;
            if (R > 0) {
              const dx = Math.abs((p % pb.size) - (last % pb.size));
              if (dx > R) continue;
              const dy = Math.abs(Math.floor(p / pb.size) - Math.floor(last / pb.size));
              if (dy > R) continue;
              if (dx <= 1 && dy <= 1) continue; // 半径 1 已试过
            }
            const [ok, cap, , olibs] = pb.probe(color, p);
            if (!ok) continue;
            if (cap === 0) {
              if (olibs === 1) continue;
              if (pb.is_eye(p, color) && !pb.adjacent_atari(p, 3 - color)) continue;
            }
            cands.push(p);
            if (cap > 0) urgent.push(p);
          }
          if (cands.length > 0) break;
        }
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

function select(node, c, rave_k, rave, cnnW = 0.0) {
  const logN = Math.log(node.N + 1);
  const sqrtN = Math.sqrt(node.N);
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
    let val = q + c * Math.sqrt(logN / (n + 1));
    // CNN 先验（PUCT 形式）：随访问数自然衰减；cnnW=0 时该项恒为 0（基线不变）
    if (cnnW > 0 && ch.cnnP > 0) val += cnnW * ch.cnnP * (sqrtN / (1 + n));
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
 * 对 board（完整规则 Board）搜索并返回 [vertex, visits, winrate, bestChild]。
 * 不落子 —— 落子由调用方（driver）执行，以便用完整规则复检。
 * vertex 可为点索引、PASS(=-1) 或字符串 "resign"。
 *
 * `reuse`（可选）：`{ node, oppMove }` —— 上次 genmove 返回的 bestChild（我方那手之后的节点）
 *   与本次"对手实际下的那一手"。若该手在 node 的子节点中，则把它提升为新根，
 *   直接继承其访问统计（等效算力 +20~50%）。局面不符时安全回退为全新搜索。
 *   返回值第 4 项 `bestChild` 供下次调用复用（null 表示不可复用：pass/resign/无子节点）。
 */
export function genmove(board, playouts = 500, seed = 0, profile = null, reuse = null) {
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
  // 渐进加宽参数（pw_c=0 → 保持"一次开放全部候选"的原行为）
  const pwC = Number(pr["pw_c"]) || 0;
  const pwMin = Math.max(1, Math.trunc(Number(pr["pw_min"]) || 8));
  const radius = Math.trunc(Number(pr["prune_radius"]));
  let root = new Node(PASS_MOVE, board.side);
  root.expanded = true;
  // ---- 树重用（可选）：把"对手实际下的那手"对应的子树提升为新根，继承其访问统计 ----
  let reused = false;
  if (reuse && reuse.node && reuse.node.children && reuse.node.children.size > 0) {
    const child = reuse.node.children.get(reuse.oppMove);
    if (child && child.to_move === board.side) {
      root = child;
      root.move = PASS_MOVE; // 根节点的 move 字段不参与搜索逻辑
      reused = true;
    }
  }
  if (!reused) {
    const moves = candidates(pb0, board.side, radius).filter(([p]) => full_set.has(p));
    rng_shuffle(moves, rng);
    if (pwC > 0) {
      // 渐进加宽：按 prior 降序（稳定排序保留同分的随机序），先开放前 k 个
      moves.sort((a, b) => move_prior(b[1], b[2]) - move_prior(a[1], a[2]));
      root.candPool = moves;
      root.candAdded = 0;
      widenNode(root, pwC, pwMin);
    } else {
      for (const [m, c, ol] of moves) {
        root.children.set(m, new Node(m, 3 - board.side, move_prior(c, ol)));
      }
    }
  }
  if (!reused && root.children.size === 0) {
    return [PASS_MOVE, 0, 0.0, null]; // 无任何非填眼着法 → 过手（终局机制）
  }

  // ---- CNN 先验（可选）：根节点一定尝试；深层节点受 cnn_prior_max_nodes 预算限制 ----
  const cnnW = Number(pr["cnn_prior"]) || 0;
  let cnnBudget = 0;
  let cnnNet = null;
  if (cnnW > 0) {
    cnnNet = loadCnnNet(size, pr["cnn_prior_weights"] || null);
    if (cnnNet) {
      pb0.last = lastMoveOf(board); // 根局面的"最后一手"来自完整规则栈
      cnnBudget = Math.max(1, Math.trunc(Number(pr["cnn_prior_max_nodes"]))) - 1; // 根用掉 1 次
      if (!reused) attachCnnPrior(cnnNet, pb0, root); // 复用节点的 cnnP 已在旧搜索中归一化
    } else if (!_cnnWarned) {
      _cnnWarned = true;
      console.warn(`[ai] cnn_prior=${cnnW} 但先验不可用 → 已按纯 UCT 运行：${_cnnFailReason}`);
    }
  }
  const cnnActive = cnnNet !== null && cnnW > 0;

  const max_moves = 3 * n2;
  const iters = Math.max(1, Math.trunc(Number(playouts)));
  // RAVE 的"本次迭代下过哪些手"用代际标记数组（零分配；替代每迭代 new Set()×2）
  const simStamp1 = new Int32Array(n2);
  const simStamp2 = new Int32Array(n2);
  for (let it = 0; it < iters; it++) {
    let pb = pb0.clone();
    let node = root;
    const chain = [root];
    const itMark = it + 1; // 每次迭代唯一
    let cnt1 = 0;
    let cnt2 = 0;
    while (node.expanded && node.children.size > 0) {
      if (pwC > 0) widenNode(node, pwC, pwMin); // 渐进加宽：访问前按 N 增长开放更多候选
      const m = select(node, Number(pr["c"]), Number(pr["rave_k"]), Boolean(pr["rave"]),
        cnnActive ? cnnW : 0.0);
      const color = node.to_move;
      if (m === PASS_MOVE) pb.play_pass(color);
      else {
        pb.apply(color, m);
        if (color === 1) {
          simStamp1[m] = itMark;
          cnt1 += 1;
        } else {
          simStamp2[m] = itMark;
          cnt2 += 1;
        }
      }
      node = node.children.get(m);
      chain.push(node);
    }
    if (!node.expanded) {
      const cl = candidates(pb, node.to_move, radius);
      rng_shuffle(cl, rng);
      node.expanded = true;
      if (pwC > 0) {
        cl.sort((a, b) => move_prior(b[1], b[2]) - move_prior(a[1], a[2]));
        node.candPool = cl;
        node.candAdded = 0;
        widenNode(node, pwC, pwMin);
      } else {
        for (const [m, c, ol] of cl) {
          node.children.set(m, new Node(m, 3 - node.to_move, move_prior(c, ol)));
        }
      }
      // CNN 先验：深层节点受预算限制（默认仅根节点，cnn_prior_max_nodes 可放大）
      if (cnnActive && cnnBudget > 0) {
        attachCnnPrior(cnnNet, pb, node);
        cnnBudget -= 1;
      }
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
      const tm = nd.to_move;
      const stampArr = tm === 1 ? simStamp1 : simStamp2;
      const cnt = tm === 1 ? cnt1 : cnt2;
      const kids = nd.children;
      if (cnt > 0 && kids.size > 0) {
        const cv = 1.0 - v;
        for (const [m, ch] of kids) {
          if (stampArr[m] === itMark) {
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
  // 供下次调用的树重用句柄：选中着法对应的子节点（pass/resign 不可复用）
  const bestChild = best !== PASS_MOVE && root.children.has(best) ? root.children.get(best) : null;
  // 显式过手规则：对手已过手，且本方胜率达标 → 过手终局（否则继续争胜）
  if (board.passes >= 1 && best !== PASS_MOVE && best_wr >= Number(pr["pass_threshold"])) {
    return [PASS_MOVE, best_n, best_wr, null];
  }
  if (Number(pr["resign_threshold"]) > 0
    && total_visits >= Math.trunc(Number(pr["resign_min_visits"]))
    && best_wr < Number(pr["resign_threshold"])) {
    return ["resign", best_n, best_wr, null];
  }
  return [best, best_n, best_wr, bestChild];
}
