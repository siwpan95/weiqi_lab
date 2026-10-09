// tournament/openings.mjs — 开局库（Tier 1 对应物）
//
// 两种模式（由环境变量 OPENINGS 选择；默认 random，行为与原实现完全一致）：
//   - random（默认）：在中央 5×5 区（C3..G7）内随机取点，避开已有的 2 邻域，生成多样化开局线。
//   - markov（OPENINGS=markov）：以已冻结的马尔可夫落子模型（spec/markov_model.json）逐手采样，
//     每手都用裁判 Ref 校验合法性；采样失败回退到 random 逻辑。
//
// 可复现：两种模式都只使用由 seed 派生的 splitmix64 流，不触碰 Math.random。
// 零第三方依赖。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Ref } from "./referee.mjs";
import { PatternPolicy } from "../tools/markov.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODEL_PATH = path.resolve(__dirname, "..", "spec", "markov_model.json");

const COLS = "ABCDEFGHJKLMNOPQRST";

export function makeRng(seed) {
  let s = BigInt(seed) & ((1n << 64n) - 1n);
  const MASK = (1n << 64n) - 1n;
  return () => {
    s = (s + 0x9e3779b97f4a7c15n) & MASK;
    let z = s;
    z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK;
    z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK;
    z = (z ^ (z >> 31n)) & MASK;
    return Number(z % BigInt(1 << 30)) / (1 << 30);
  };
}

export function vertexOf(idx, size) {
  return COLS[idx % size] + String(Math.floor(idx / size) + 1);
}

/** 中央 5×5 区（与 random 模式一致）：C3..G7（9 路） */
function centralZone(size) {
  const lo = Math.max(0, Math.floor(size / 2) - 2);
  const hi = Math.min(size - 1, Math.floor(size / 2) + 2);
  const zone = [];
  for (let y = lo; y <= hi; y++) {
    for (let x = lo; x <= hi; x++) zone.push({ x, y, idx: y * size + x });
  }
  return zone;
}

/** 现有随机开局（保持原行为不变） */
export function randomOpeningLine(size, plies, seed) {
  const rnd = makeRng(seed);
  if (plies <= 0) return [];
  const zone = centralZone(size);
  const picked = [];
  const line = [];
  let color = 1;
  for (let p = 0; p < plies; p++) {
    const cands = zone.filter(({ x, y }) =>
      picked.every((q) => Math.max(Math.abs(q.x - x), Math.abs(q.y - y)) >= 2));
    if (!cands.length) break;
    const c = cands[Math.floor(rnd() * cands.length) % cands.length];
    picked.push(c);
    line.push({ color: color === 1 ? "B" : "W", vertex: vertexOf(c.idx, size) });
    color = 3 - color;
  }
  return line;
}

// ------------------------------------------------------------------ 模型装载
// 惰性 + 缓存：成功缓存 policy，失败缓存错误（避免每手重复读盘/重复报错）。
let _policy = null;
let _modelSize = null;
let _modelError = null;

function loadPolicy() {
  if (_policy) return _policy;
  if (_modelError) throw _modelError;
  try {
    const raw = fs.readFileSync(MODEL_PATH, "utf8");
    const obj = JSON.parse(raw);
    if (!obj || !obj.policy) throw new Error("缺少 policy 字段");
    _policy = PatternPolicy.fromJSON(obj.policy);
    _modelSize = Number(obj.size) || null;
    return _policy;
  } catch (e) {
    _modelError = new Error(`模型 ${MODEL_PATH} 不可用: ${e.message}`);
    throw _modelError;
  }
}

// 每手最多重采样次数；超过则回退到随机逻辑
const MARKOV_MAX_TRIES = Number(process.env.MARKOV_OPENING_TRIES || 40);

/** 诊断计数（供 A/B 汇总；进程内累计） */
export const markovStats = { calls: 0, pliesPlaced: 0, sampled: 0, fallbackPly: 0, nullSamples: 0 };

/** 回退：按现随机逻辑（中央区 + 避开 2 邻域）取一个合法点；无候选则全盘合法点；仍无则 -1（pass） */
function randomFallbackLegal(size, ref, placedPts, rnd) {
  const zone = centralZone(size);
  const cands = [];
  for (const c of zone) {
    if (ref.cells[c.idx] !== 0) continue;
    if (placedPts.some((q) => Math.max(Math.abs(q.x - c.x), Math.abs(q.y - c.y)) < 2)) continue;
    if (!ref.legal(ref.side, c.idx).legal) continue;
    cands.push(c.idx);
  }
  if (cands.length) return cands[Math.floor(rnd() * cands.length) % cands.length];
  const all = ref.legalMoves();
  if (!all.length) return -1;
  return all[Math.floor(rnd() * all.length) % all.length];
}

/**
 * Markov 开局线：中央区随机首手 → 之后逐手用 policy.sampleMove 采样，Ref 校验合法性。
 * 返回 [{color:"B",vertex:"E5"}, ...]；模型不可用/尺寸不符时抛错（由 openingLine 捕获回退）。
 */
export function markovOpeningLine(size, plies, seed) {
  const policy = loadPolicy();
  if (_modelSize && _modelSize !== size) {
    throw new Error(`模型尺寸 ${_modelSize} ≠ 棋盘 ${size}`);
  }
  const rnd = makeRng(seed);
  if (plies <= 0) return [];

  markovStats.calls += 1;
  const ref = new Ref(size, null, "cn"); // komi 与合法性无关；cn = 位置禁全同 + 禁自杀
  const line = [];
  const placedPts = [];

  // 首手：中央区随机（空盘必然合法）
  const zone = centralZone(size);
  const first = zone[Math.floor(rnd() * zone.length) % zone.length];
  if (!ref.legal(1, first.idx).legal) return randomOpeningLine(size, plies, seed);
  ref.play(1, first.idx);
  placedPts.push({ x: first.x, y: first.y });
  line.push({ color: "B", vertex: vertexOf(first.idx, size) });

  let last = first.idx;
  for (let p = 1; p < plies; p++) {
    const side = ref.side; // 1=B / 2=W
    // 采样的前提是"棋局到该手之前的真实盘面"：sample.cells = 落子前的盘面
    const sample = { cells: ref.cells, toMove: side, last };
    let chosen = -1;
    for (let t = 0; t < MARKOV_MAX_TRIES; t++) {
      const cand = policy.sampleMove(sample, size, rnd);
      if (cand === null || cand === undefined) { markovStats.nullSamples += 1; continue; }
      if (ref.legal(side, cand).legal) { chosen = cand; markovStats.sampled += 1; break; }
    }
    if (chosen < 0) { chosen = randomFallbackLegal(size, ref, placedPts, rnd); markovStats.fallbackPly += 1; } // 回退随机逻辑
    if (chosen < 0) break; // 无处可下（开局阶段不会发生）
    ref.play(side, chosen);
    placedPts.push({ x: chosen % size, y: Math.floor(chosen / size) });
    line.push({ color: side === 1 ? "B" : "W", vertex: vertexOf(chosen, size) });
    last = chosen;
    markovStats.pliesPlaced += 1;
  }
  return line;
}

// ---------------------------------------------------------------- 模式分派
const _logged = new Set();
function logOnce(key, fn) {
  if (_logged.has(key)) return;
  _logged.add(key);
  fn();
}

/**
 * 统一入口（签名与原实现兼容）：按 OPENINGS 环境变量分派。
 *   OPENINGS=markov 且模型可用 → Markov 开局；否则（缺模型 / 非 markov）→ 回退随机开局。
 */
export function openingLine(size, plies, seed) {
  const mode = (process.env.OPENINGS || "").trim().toLowerCase();
  if (mode === "markov") {
    try {
      const line = markovOpeningLine(size, plies, seed);
      logOnce("markov-ok", () => console.log(
        `[openings] OPENINGS=markov → 使用 Markov 开局模型（${MODEL_PATH}，训练样本 ${loadPolicy().seen}）`));
      return line;
    } catch (e) {
      logOnce("markov-fail", () => console.warn(
        `[openings] OPENINGS=markov 但模型不可用 → 回退随机开局：${e.message}`));
      return randomOpeningLine(size, plies, seed);
    }
  }
  if (mode && mode !== "random") {
    logOnce("bad-mode", () => console.warn(`[openings] OPENINGS=${mode} 未识别 → 使用随机开局（默认）`));
  } else {
    logOnce("random", () => console.log(
      "[openings] 使用随机开局（默认；设 OPENINGS=markov 启用 Markov 模型）"));
  }
  return randomOpeningLine(size, plies, seed);
}
