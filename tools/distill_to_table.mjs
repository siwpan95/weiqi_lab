// tools/distill_to_table.mjs — 把 CNN 策略头蒸馏成**零依赖可查表**的模式先验表
//
// 输入：
//   --corpus  spec/games/<...>.jsonl        语料（提供盘面与 last，用于算上下文键）
//   --policy  ml/cnn_policy-<size>.jsonl    由 ml/export_cnn_policy.py 导出的 CNN 预测
// 输出：
//   --out     spec/markov_model-<tag>.json  与 tools/markov.mjs::PatternPolicy 同构的表
//            （权重为**概率累加值**，非计数；normalize() 会自行归一化）
//
// 上下文（与既有模型同族）：
//   主表 radius  = --radius-main（默认 2，即 5×5）
//   退避 radius  = --radius-backoff（默认 1，即 3×3；0 = 用十字邻域）
//   键 = tools/markov.mjs::signature（8 对称归一化、相对应手方编码）
//   动作 = 相对最后一手的偏移 (dx,dy)，半径 moveRadius（**不做对称归一化**，与既有模型一致）
//
// 剪枝（控制体积）：仅保留权重和 ≥ --min-main 的主上下文，且每上下文仅保留权重最高的
//   --top-offsets 个偏移；退避表不剪枝。
//
// 用法：
//   node tools/distill_to_table.mjs --corpus spec/games/human-2026-10-09.jsonl \
//        --policy ml/cnn_policy-19.jsonl --size 19 --out spec/markov_model-cnn19.json --tag cnn19 \
//        [--radius-main 2] [--radius-backoff 1] [--min-main 5] [--top-offsets 12]

import fs from "node:fs";
import { Ref, parseVertex } from "../tournament/referee.mjs";
import { signatureEx, signatureCrossEx, symOffset, crossOffset } from "./markov.mjs";

function arg(name, dflt = null) {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 ? process.argv[i + 1] : dflt;
}

const CORPUS = arg("corpus");
const POLICY = arg("policy");
const SIZE = Number(arg("size", 19));
const OUT = arg("out");
const TAG = arg("tag", "cnn");
const RADIUS_MAIN = Number(arg("radius-main", 2));
const RADIUS_BACKOFF = Number(arg("radius-backoff", 1));
const MIN_MAIN = Number(arg("min-main", 5));
const TOP_OFFSETS = Number(arg("top-offsets", 12));
const MOVE_RADIUS = Number(arg("move-radius", 3));
if (!CORPUS || !POLICY || !OUT) {
  console.error("用法: node tools/distill_to_table.mjs --corpus <jsonl> --policy <jsonl> --size N --out <json>");
  process.exit(2);
}

const corpusLines = fs.readFileSync(CORPUS, "utf8").trim().split("\n").filter(Boolean);
const games = corpusLines.map((line, idx) => ({ g: JSON.parse(line), idx }));

const byGame = new Map();
let policyRows = 0;
for (const line of fs.readFileSync(POLICY, "utf8").trim().split("\n")) {
  if (!line) continue;
  const r = JSON.parse(line);
  if (!byGame.has(r.g)) byGame.set(r.g, new Map());
  byGame.get(r.g).set(r.p, r);
  policyRows += 1;
}

const table = new Map();
const cross = new Map();
let used = 0;
let skipped = 0;

function add(map, key, offKey, w) {
  if (!map.has(key)) map.set(key, new Map());
  const row = map.get(key);
  row.set(offKey, (row.get(offKey) || 0) + w);
}

for (const { g, idx } of games) {
  const rows = byGame.get(idx);
  if (!rows || Number(g.size) !== SIZE) continue;
  const ref = new Ref(SIZE, g.komi ?? 7.5, "cn");
  let last = -1;
  for (let ply = 0; ply < g.moves.length; ply++) {
    const s = g.moves[ply];
    const color = s[0] === "B" ? 1 : 2;
    if (ref.side !== color) break;
    const v = s.slice(1) === "pass" ? -1 : parseVertex(s.slice(1), SIZE);
    const row = rows.get(ply);
    if (row && last >= 0 && v >= 0) {
      const sample = { cells: ref.cells.slice(), toMove: color, last };
      const main = signatureEx(sample, SIZE, RADIUS_MAIN);
      const backEx = RADIUS_BACKOFF >= 1
        ? { kind: "main", ...signatureEx(sample, SIZE, RADIUS_BACKOFF) }
        : { kind: "cross", ...signatureCrossEx(sample, SIZE) };
      const lx = last % SIZE;
      const ly = Math.floor(last / SIZE);
      for (const [pt, p] of row.top) {
        const dx = (pt % SIZE) - lx;
        const dy = Math.floor(pt / SIZE) - ly;
        if (Math.abs(dx) > MOVE_RADIUS || Math.abs(dy) > MOVE_RADIUS) continue;
        // 对称帧：偏移转进规范帧后再累加（修正"朝向抹平"，与 tools/markov.mjs 注释一致）
        const [kdx, kdy] = symOffset(main.sym, dx, dy, true);
        const [bdx, bdy] = backEx.kind === "cross"
          ? crossOffset(backEx.rot, dx, dy, true)
          : symOffset(backEx.sym, dx, dy, true);
        add(table, main.key, `${kdx},${kdy}`, p);
        add(cross, backEx.key, `${bdx},${bdy}`, p);
      }
      used += 1;
    } else if (row) {
      skipped += 1;
    }
    const r = ref.play(color, v);
    if (!r.ok) break;
    last = v;
  }
}

// ---------- 剪枝 ----------
function prune(map, minWeight, topN) {
  const out = new Map();
  let droppedCtx = 0;
  for (const [key, row] of map) {
    const total = [...row.values()].reduce((a, b) => a + b, 0);
    if (minWeight > 0 && total < minWeight) {
      droppedCtx += 1;
      continue;
    }
    let entries = [...row.entries()].sort((a, b) => b[1] - a[1]);
    if (topN > 0) entries = entries.slice(0, topN);
    out.set(key, new Map(entries));
  }
  return { map: out, droppedCtx };
}

const pruned = prune(table, MIN_MAIN, TOP_OFFSETS);
const finalMain = pruned.map;
const finalCross = prune(cross, 0, 0).map;

const toObj = (m) => {
  const o = {};
  for (const [k, row] of m) o[k] = Object.fromEntries(row);
  return o;
};
let entries = 0;
for (const row of finalMain.values()) entries += row.size;
let crossEntries = 0;
for (const row of finalCross.values()) crossEntries += row.size;

const model = {
  protocol: 1,
  spec: "markov-v1-distilled",
  created: new Date().toISOString().slice(0, 10),
  size: SIZE,
  komi: 7.5,
  source: {
    kind: "cnn-distill",
    teacher: `ml/cnn-${SIZE}.npz`,
    policy: POLICY,
    corpus: CORPUS,
    note: "teacher 为 numpy 小型策略 CNN；本表为按其策略在语料上聚合的零依赖查表近似",
  },
  distill: {
    tag: TAG, positions: used, skipped, policyRows,
    radiusMain: RADIUS_MAIN, radiusBackoff: RADIUS_BACKOFF,
    minMain: MIN_MAIN, topOffsets: TOP_OFFSETS,
    contextsRaw: table.size, droppedCtx: pruned.droppedCtx,
    contexts: finalMain.size, entries,
    crossContexts: finalCross.size, crossEntries,
  },
  policy: {
    radius: RADIUS_MAIN, moveRadius: MOVE_RADIUS,
    backoffMin: MIN_MAIN, backoffRadius: RADIUS_BACKOFF,
    frames: "canonical",
    samples: used, table: toObj(finalMain), cross: toObj(finalCross),
  },
};

fs.writeFileSync(OUT, JSON.stringify(model), "utf8");
console.log(`蒸馏完成：位置 ${used}（跳过 ${skipped}）· 主 ${RADIUS_MAIN === 1 ? "3×3" : RADIUS_MAIN === 2 ? "5×5" : RADIUS_MAIN + "邻域"} 上下文 ${finalMain.size}（剪掉 ${pruned.droppedCtx}，${entries} 条目）· 退避 ${finalCross.size}（${crossEntries} 条目）`);
console.log(`→ ${OUT}  (${(fs.statSync(OUT).size / 1048576).toFixed(1)} MB)`);
