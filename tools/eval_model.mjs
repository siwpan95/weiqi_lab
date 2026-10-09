// tools/eval_model.mjs — 在给定语料上评测"任意一个落子模型"（与 train_markov.mjs 同口径）
//
// 口径（与 tools/train_markov.mjs 的 evaluate()/loadCorpus() 严格一致）：
//   - 逐局 replay 构造样本（仅 last>=0 且本手非 pass）
//   - 按局划分：前 80% 训练（此处不训练，仅用于对齐划分）/ 后 20% 留出
//   - 指标：覆盖率、top-1、top-3、均匀基线（1/空点）
// 用途：对比「计数表(markov_model*.json)」与「CNN 蒸馏表」在同一留出集上的表现。
//
// 用法：
//   node tools/eval_model.mjs --corpus spec/games/human-2026-10-09.jsonl --size 19 \
//        --model spec/markov_model-human19.json [--json out.json]

import fs from "node:fs";
import { Ref, parseVertex } from "../tournament/referee.mjs";
import { PatternPolicy } from "./markov.mjs";

function arg(name, dflt = null) {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 ? process.argv[i + 1] : dflt;
}

const CORPUS = arg("corpus");
const SIZE = Number(arg("size", 19));
const MODEL = arg("model");
const VAL_FRAC = Number(arg("val-frac", 0.2));
const JSON_OUT = arg("json");
if (!CORPUS || !MODEL) {
  console.error("用法: node tools/eval_model.mjs --corpus <jsonl> --size N --model <json> [--json out.json]");
  process.exit(2);
}

// ---------- 载入语料 ----------
const lines = fs.readFileSync(CORPUS, "utf8").trim().split("\n").filter(Boolean);

/** 与 train_markov.mjs::loadCorpus 同规则地重建样本（含所属局号） */
function samplesOfGame(g, size) {
  const ref = new Ref(size, g.komi ?? 7.5, "cn");
  const out = [];
  let last = -1;
  for (const mv of g.moves) {
    const color = mv[0] === "B" ? 1 : 2;
    if (ref.side !== color) break;
    const v = mv.slice(1) === "pass" ? -1 : parseVertex(mv.slice(1), size);
    if (v >= 0 && last >= 0) out.push({ cells: ref.cells.slice(), toMove: color, last, next: v });
    const r = ref.play(color, v);
    if (!r.ok) break;
    last = v;
  }
  return out;
}

const games = [];
for (const line of lines) {
  const g = JSON.parse(line);
  if (Number(g.size) !== SIZE) continue;
  games.push({ raw: g, samples: samplesOfGame(g, SIZE) });
}
const cut = Math.max(1, Math.floor(games.length * (1 - VAL_FRAC)));
const val = games.slice(cut);

// ---------- 载入模型 ----------
const obj = JSON.parse(fs.readFileSync(MODEL, "utf8"));
if (!obj || !obj.policy) {
  console.error(`模型缺少 policy 字段: ${MODEL}`);
  process.exit(2);
}
const policy = PatternPolicy.fromJSON(obj.policy);

// ---------- 评测 ----------
let total = 0;
let covered = 0;
let hit1 = 0;
let hit3 = 0;
let uni = 0;
let viaMain = 0;
let viaCross = 0;
for (const gm of val) {
  for (const s of gm.samples) {
    total += 1;
    const empties = s.cells.reduce((a, v) => a + (v === 0 ? 1 : 0), 0);
    uni += empties > 0 ? 1 / empties : 0;
    const { top, source } = policy.topK(s, SIZE, 3);
    if (!source) continue;
    covered += 1;
    if (source === "main") viaMain += 1;
    else viaCross += 1;
    if (top.length && top[0].vertex === s.next) hit1 += 1;
    if (top.some((t) => t.vertex === s.next)) hit3 += 1;
  }
}
const res = {
  model: MODEL, corpus: CORPUS, size: SIZE,
  games: games.length, valGames: val.length, plies: total,
  coverage: total ? covered / total : 0,
  top1: covered ? hit1 / covered : 0,
  top3: covered ? hit3 / covered : 0,
  uniform: total ? uni / total : 0,
  viaMain, viaCross,
  modelMeta: { spec: obj.spec || null, source: obj.source || null, distill: obj.distill || null },
};
console.log(`模型 ${MODEL.split(/[\\/]/).pop()}  spec=${res.modelMeta.spec || "?"}`);
console.log(`  留出 ${total} 手（${val.length} 局）· 覆盖 ${(res.coverage * 100).toFixed(1)}%（主表 ${viaMain} · 退避 ${viaCross}）`);
console.log(`  top-1 ${(res.top1 * 100).toFixed(2)}%  top-3 ${(res.top3 * 100).toFixed(2)}%  均匀基线 ${(res.uniform * 100).toFixed(2)}%  相对均匀 ${(res.top1 / (res.uniform || 1)).toFixed(2)}×`);
if (JSON_OUT) {
  fs.writeFileSync(JSON_OUT, JSON.stringify(res, null, 1) + "\n", "utf8");
  console.log(`  → ${JSON_OUT}`);
}
