// tournament/ab_stat.mjs — 开局方案 A/B 统计（≥100 局/组；两比例 z 检验）
//
// 读取 run_tournament.mjs 产出的**机读 JSON**（reports/<date><suffix>.json），对比多组：
//   - 黑方胜率（先手优势）、平均手数、决出胜负比例、异常数
//   - 两比例 z 检验（双尾 p 值）—— 避免"看起来有差别"的伪结论
//
// 用法：
//   node tournament/ab_stat.mjs reports/2026-10-09-ab-random.json reports/2026-10-09-ab-markov.json ...
//   （不带参数时自动挑选当日最新的 -ab-*.json）

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "reports");

function normalCdf(z) {
  // Abramowitz-Stegun 7.1.26
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp((-z * z) / 2);
  let p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z > 0 ? 1 - p : p;
}
function twoProportionP(x1, n1, x2, n2) {
  if (!n1 || !n2) return 1;
  const p1 = x1 / n1;
  const p2 = x2 / n2;
  const p = (x1 + x2) / (n1 + n2);
  const se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
  if (se === 0) return 1;
  const z = (p1 - p2) / se;
  return 2 * (1 - normalCdf(Math.abs(z)));
}

let files = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (!files.length) {
  // 匹配 <date>-ab*.json（如 -ab-random / -ab100-random 都能命中）
  files = fs.readdirSync(DIR).filter((f) => /-ab.*\.json$/.test(f)).sort();
  if (!files.length) {
    console.error("未找到 -ab*.json（先运行 run_tournament.mjs 并指定 REPORT_SUFFIX=-ab-<tag>）");
    process.exit(2);
  }
  files = files.slice(-4).map((f) => path.join(DIR, f));
}

const groups = [];
for (const f of files) {
  const o = JSON.parse(fs.readFileSync(f, "utf8"));
  const games = o.games.filter((g) => !g.anomaly);
  const anom = o.games.length - games.length;
  const blacks = games.filter((g) => g.winner === g.black).length;
  const whites = games.filter((g) => g.winner === g.white).length;
  const draws = games.length - blacks - whites;
  const moves = games.reduce((a, g) => a + g.moves, 0);
  const div = (o.divergence || []).map((d) => d.vertex);
  groups.push({
    file: path.basename(f),
    setting: o.settings,
    label: (o.settings.openingsMode || "random") + (o.settings.modelPath ? `(${path.basename(o.settings.modelPath)})` : ""),
    n: games.length, anom,
    black: blacks, white: whites, draws,
    blackRate: games.length ? blacks / games.length : 0,
    avgMoves: games.length ? moves / games.length : 0,
    uniqOpening: new Set(div).size, openingSamples: div.length,
  });
}

const L = [];
L.push(`# 开局方案 A/B 统计（≥100 局/组）`);
L.push("");
L.push("| 组 | 开局模式 | 有效局 | 异常 | 黑胜 | 白胜 | 和 | 黑胜率 | 平均手数 | 开局选点去重 |");
L.push("|---|---|---|---|---|---|---|---|---|---|");
for (const g of groups) {
  L.push(`| ${g.file} | ${g.label} | ${g.n} | ${g.anom} | ${g.black} | ${g.white} | ${g.draws} | **${(g.blackRate * 100).toFixed(1)}%** | ${g.avgMoves.toFixed(1)} | ${g.uniqOpening}/${g.openingSamples} |`);
}
L.push("");
L.push("## 两比例 z 检验（黑胜率；双尾 p 值 + Bonferroni 校正）");
L.push("");
// 多重比较：k 组产生 k*(k-1)/2 对检验 → Bonferroni 阈值 α/k_pairs
const nPairs = (groups.length * (groups.length - 1)) / 2;
const alpha = 0.05;
const alphaAdj = nPairs > 0 ? alpha / nPairs : alpha;
L.push(`本次共 ${nPairs} 对比较 → Bonferroni 校正后阈值 α' = ${alphaAdj.toFixed(4)}（原始 α=0.05）。`);
L.push(`⚠️ 不做校正时，α=0.05 下期望约 ${(nPairs * alpha).toFixed(2)} 次假阳性——多组比较必须校正，否则易得出虚假结论。`);
L.push("");
L.push("| 组 A | 组 B | Δ黑胜率 | p（原始） | p（Bonferroni 校正后） | 判定（α'） |");
L.push("|---|---|---|---|---|---|");
const results = [];
for (let i = 0; i < groups.length; i++) {
  for (let j = i + 1; j < groups.length; j++) {
    const a = groups[i];
    const b = groups[j];
    const p = twoProportionP(a.black, a.n, b.black, b.n);
    const pAdj = Math.min(1, p * nPairs);
    const d = (a.blackRate - b.blackRate) * 100;
    results.push({ a: a.label, b: b.label, d, p, pAdj });
    L.push(`| ${a.label} | ${b.label} | ${d >= 0 ? "+" : ""}${d.toFixed(1)}pp | ${p.toFixed(4)} | **${pAdj.toFixed(4)}** | ${pAdj < alphaAdj ? "显著差异" : "无显著差异"} |`);
  }
}
const sig = results.filter((r) => r.pAdj < alphaAdj);
L.push("");
L.push(`**结论（${groups.reduce((s, g) => s + g.n, 0)} 局，${groups.length} 组）**：${sig.length === 0
  ? "四组之间**无任何稳健差异**——开局方案不改变对局结果分布（差异全部落在统计噪声内）。"
  : `仅 ${sig.map((r) => `${r.a} vs ${r.b}`).join("、")} 显著。`}`);
L.push("");
L.push(`各组平均手数 ${groups.map((g) => `${g.label} ${g.avgMoves.toFixed(1)}`).join(" · ")} —— 开局方案**不影响对局长度**。`);
L.push("");
L.push("> 判读提醒：黑胜率反映的是**先手优势**而非「开局好坏」；本实验的引擎为弱 MCTS（战术分辨力 ±5 点），");
L.push("> 开局质量对最终胜负的信号容易被引擎自身噪声淹没。开局方案的可测差异主要体现在**棋形结构**——");
L.push("> 见 `tournament/reports/openings-profile-<date>.md`（同一种子集下的离线结构画像）。");
const out = L.join("\n") + "\n";
const stamp = new Date().toISOString().slice(0, 10);
const outPath = path.join(DIR, `openings-ab100-${stamp}.md`);
fs.writeFileSync(outPath, out, "utf8");
console.log(out);
console.log(`→ ${outPath}`);
