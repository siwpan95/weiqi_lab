// tools/human_agreement.mjs — 人类一致度探针：MCTS(+CNN 先验) 与人类棋谱着法的吻合率
//
// 动机：9 路 CNN 学自**弱引擎**语料（先验偏角部）；19 路 CNN 学自**人类职业棋谱**（先验正常）。
// 本探针在人类 19 路局面集上对比"引擎选点 vs 人类实战着法"的吻合率：
//   A = 基线 profile（默认 {})
//   B = 实验 profile（默认 {cnn_prior: PRIOR}）
// 若 B 的吻合率显著高于 A，则说明**该机制有效，且效果取决于教师质量**（与 T3-A 结论一致）。
//
// 用法（通用 profile 版）：
//   node tools/human_agreement.mjs --corpus spec/games/human-2026-10-09.jsonl --size 19 \
//        --positions 16 --playouts 60 --prior 3 [--seed 7] \
//        [--profA '{"probe_k":3}' --profB '{"probe_k":3,"pbias":0.5,"pbias_model":"..."}'] \
//        [--start 4800]   # 起点行号（跳过训练集，做**留出**探针；训练集为前 80% 局）
//   ⚠️ 若被评估的表正是用该语料前 80% 训练的，必须用 --start 跳过训练段，否则一致性被高估。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Ref, parseVertex, formatVertex } from "../tournament/referee.mjs";
import * as ai from "../JsWeiqi/ai.mjs";
import { Board } from "../JsWeiqi/rules.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const arg = (n, d) => {
  const i = process.argv.indexOf("--" + n);
  return i >= 0 ? process.argv[i + 1] : d;
};

const CORPUS = arg("corpus", path.join(HERE, "..", "spec", "games", "human-2026-10-09.jsonl"));
const SIZE = Number(arg("size", 19));
const POSITIONS = Number(arg("positions", 16));
const PLAYOUTS = Number(arg("playouts", 60));
const PRIOR = Number(arg("prior", 3));
const SEED = Number(arg("seed", 7));
const START = Number(arg("start", 0));
const LABEL_A = arg("labelA", null);
const LABEL_B = arg("labelB", null);
const PROF_A = arg("profA", null) ? JSON.parse(arg("profA")) : {};
const PROF_B = arg("profB", null) ? JSON.parse(arg("profB")) : { cnn_prior: PRIOR };

function normalCdf(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp((-z * z) / 2);
  const p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z > 0 ? 1 - p : p;
}
function binomP(k, n) {
  // 双尾二项检验（正态近似即可，n≈16 → 仅作参考）
  if (n === 0) return 1;
  const p0 = 0.5;
  const se = Math.sqrt(p0 * (1 - p0) / n);
  return 2 * (1 - normalCdf(Math.abs(k / n - p0) / se));
}

/** 两个点索引的切比雪夫距离 */
function cheb(i, j, size) {
  if (i < 0 || j < 0) return 99;
  const dx = Math.abs((i % size) - (j % size));
  const dy = Math.abs(Math.floor(i / size) - Math.floor(j / size));
  return Math.max(dx, dy);
}

/** 双侧两比例 z 检验 p 值（用于 A/B 的命中率比较） */
function z2(x1, n1, x2, n2) {
  if (!n1 || !n2) return 1;
  const p = (x1 + x2) / (n1 + n2);
  const se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
  if (se === 0) return 1;
  return 2 * (1 - normalCdf(Math.abs(x1 / n1 - x2 / n2) / se));
}

const lines = fs.readFileSync(CORPUS, "utf8").trim().split("\n").filter(Boolean);
const rows = [];
let picked = 0;
for (let gi = START; gi < lines.length && picked < POSITIONS; gi += 7) {
  const g = JSON.parse(lines[gi]);
  if (Number(g.size) !== SIZE) continue;
  // 取该局第 ~40 手附近的局面（开局已过、尚未终局）
  const b = new Board(SIZE);
  let ply = 0;
  for (const s of g.moves) {
    const color = s[0] === "B" ? 1 : 2;
    if (b.side !== color) break;
    const v = s.slice(1) === "pass" ? -1 : parseVertex(s.slice(1), SIZE);
    if (ply >= 40) {
      const human = v;
      if (human >= 0) {
        const t0 = Date.now();
        const [mvA] = ai.genmove(b, PLAYOUTS, SEED + gi, PROF_A);
        const tA = Date.now() - t0;
        const t1 = Date.now();
        const [mvB] = ai.genmove(b, PLAYOUTS, SEED + gi, PROF_B);
        const tB = Date.now() - t1;
        // CNN 先验自身的 top-1（不搜索，直接取策略最大）
        let cnnTop = -1;
        try {
          const net = (await import("./cnn_forward.mjs")).CnnPolicy.load(
            path.join(HERE, "..", "spec", `cnn_weights-${SIZE}.json`));
          const p = net.policyFrom(b.cells, b.side, ai.lastMoveOf(b));
          let mx = -1;
          for (let i = 0; i < p.length; i++) if (p[i] > mx) { mx = p[i]; cnnTop = i; }
        } catch { /* 忽略 */ }

        rows.push({
          game: gi, ply, human: formatVertex(human, SIZE),
          a: formatVertex(mvA, SIZE), b: formatVertex(mvB, SIZE),
          cnn: cnnTop >= 0 ? formatVertex(cnnTop, SIZE) : "-",
          hitA: mvA === human, hitB: mvB === human, hitCnn: cnnTop === human,
          nearA: cheb(mvA, human, SIZE) <= 2,
          nearB: cheb(mvB, human, SIZE) <= 2,
          nearCnn: cheb(cnnTop, human, SIZE) <= 2,
          tA, tB,
        });
        picked += 1;
        break;
      }
    }
    const r = b.play(color, v);
    if (!r.ok) break;
    ply += 1;
  }
}

const n = rows.length;
const hA = rows.filter((r) => r.hitA).length;
const hB = rows.filter((r) => r.hitB).length;
const hC = rows.filter((r) => r.hitCnn).length;
const emptyAvg = 361 - 45; // 粗略：40 手后约剩 320 空点
const L = [];
L.push(`# 人类一致度探针 — ${new Date().toISOString().slice(0, 10)}`);
L.push("");
L.push(`- 语料：\`${path.basename(CORPUS)}\`（19 路人类职业棋谱）· 局面：各局第 ~40 手 · n=${n}`);
L.push(`- 引擎：JsWeiqi · ${PLAYOUTS} playouts/手 · 局面采样起点行 ${START}${START > 0 ? "（**留出段**）" : ""}`);
L.push(`- A = \`${LABEL_A || JSON.stringify(PROF_A)}\` · B = \`${LABEL_B || JSON.stringify(PROF_B)}\``);
L.push("");
L.push("| 配置 | 与人类着法吻合 | 吻合率 | 邻近(≤2 路) | 邻近率 | 平均耗时 |");
L.push("|---|---|---|---|---|---|");
const nA = rows.filter((r) => r.nearA).length;
const nB = rows.filter((r) => r.nearB).length;
const nC = rows.filter((r) => r.nearCnn).length;
L.push(`| A 基线 | ${hA}/${n} | **${(hA / n * 100).toFixed(1)}%** | ${nA}/${n} | ${(nA / n * 100).toFixed(1)}% | ${(rows.reduce((a, r) => a + r.tA, 0) / n / 1000).toFixed(1)}s |`);
L.push(`| B 实验组 | ${hB}/${n} | **${(hB / n * 100).toFixed(1)}%** | ${nB}/${n} | ${(nB / n * 100).toFixed(1)}% | ${(rows.reduce((a, r) => a + r.tB, 0) / n / 1000).toFixed(1)}s |`);
L.push(`| （参考）CNN top-1 不搜索 | ${hC}/${n} | ${(hC / n * 100).toFixed(1)}% | ${nC}/${n} | ${(nC / n * 100).toFixed(1)}% | — |`);
L.push("");
L.push(`- 随机基线（约 320 空点）：~${(1 / emptyAvg * 100).toFixed(2)}%`);
L.push(`- 精确命中 A vs B：双侧两比例 z 检验 p = ${z2(hA, n, hB, n).toFixed(4)}`);
L.push(`- **邻近命中（≤2 路）A vs B：双侧两比例 z 检验 p = ${z2(nA, n, nB, n).toFixed(4)}**${z2(nA, n, nB, n) < 0.05 ? " → 显著" : ""}`);
L.push("");
L.push("## 逐局面");
L.push("");
L.push("| 局 | 手 | 人类 | A(无先验) | B(有先验) | CNN top-1 |");
L.push("|---|---|---|---|---|---|");
for (const r of rows) {
  L.push(`| ${r.game} | ${r.ply} | ${r.human} | ${r.a}${r.hitA ? " ✓" : ""} | ${r.b}${r.hitB ? " ✓" : ""} | ${r.cnn}${r.hitCnn ? " ✓" : ""} |`);
}
const out = L.join("\n") + "\n";
const stamp = new Date().toISOString().slice(0, 10);
const outPath = path.join(HERE, "..", "tournament", "reports", `human-agreement-${stamp}.md`);
fs.writeFileSync(outPath, out, "utf8");
console.log(out);
console.log(`→ ${outPath}`);
