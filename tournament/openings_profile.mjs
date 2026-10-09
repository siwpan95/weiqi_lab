// tournament/openings_profile.mjs — 开局方案的**结构画像**（离线复现，不依赖循环赛运行）
//
// 开局线由 (mode, size, plies, seed) 唯一决定；循环赛用 seed = 1000*gno + 7。
// 因此可在不重跑对局的前提下，用同一批种子为每种模式生成开局线并量化其棋形差异：
//   - 唯一开局线数 / 重复率
//   - 手均切比雪夫距离（连续手）、距中心平均距离
//   - 线位分布（1–2 线 / 3 线 / ≥4 线）——9 路均匀随机参考约 69% / 20% / 11%
//   - 首手分布
//
// 用法：
//   node tournament/openings_profile.mjs [--games 110] [--plies 4] [--size 9]

import path from "node:path";
import { fileURLToPath } from "node:url";
import { openingLine } from "./openings.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function arg(name, dflt) {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 ? process.argv[i + 1] : dflt;
}
const GAMES = Number(arg("games", 110));
const PLIES = Number(arg("plies", 4));
const SIZE = Number(arg("size", 9));

const COLS = "ABCDEFGHJKLMNOPQRST";
const toIdx = (v) => (COLS.indexOf(v[0]) + (Number(v.slice(1)) - 1) * SIZE);

const MODES = [
  { tag: "random", env: {} },
  { tag: "markov(计数表)", env: { OPENINGS: "markov" } },
  { tag: "cnndistill(蒸馏表)", env: { OPENINGS: "markov", MARKOV_MODEL: path.join(HERE, "..", "spec", "markov_model-cnn9.json") } },
  { tag: "cnnjs(CNN 前向)", env: { OPENINGS: "cnn" } },
];

const rows = [];
for (const m of MODES) {
  // 环境变量是模块级读取的，需在设置后重新导入才能生效
  for (const [k, v] of Object.entries(m.env)) process.env[k] = v;
  delete process.env.OPENINGS;
  for (const [k, v] of Object.entries(m.env)) process.env[k] = v;
  const mod = await import(`./openings.mjs?mode=${encodeURIComponent(m.tag)}&t=${Date.now()}`);

  const lines = [];
  const firstPts = new Map();
  let seqDist = 0;
  let seqN = 0;
  let centerDist = 0;
  let pts = 0;
  const lineHist = { line12: 0, line3: 0, center: 0 };
  for (let g = 1; g <= GAMES; g++) {
    const seed = 1000 * g + 7;
    const line = mod.openingLine(SIZE, PLIES, seed);
    lines.push(line.map((mv) => mv.color + mv.vertex).join(" "));
    if (line.length) {
      const f = toIdx(line[0].vertex);
      firstPts.set(line[0].vertex, (firstPts.get(line[0].vertex) || 0) + 1);
    }
    let prev = -1;
    for (const mv of line) {
      const i = toIdx(mv.vertex);
      const x = i % SIZE;
      const y = Math.floor(i / SIZE);
      const ln = Math.min(x, y, SIZE - 1 - x, SIZE - 1 - y) + 1;
      if (ln <= 2) lineHist.line12 += 1;
      else if (ln === 3) lineHist.line3 += 1;
      else lineHist.center += 1;
      centerDist += Math.hypot(x - (SIZE - 1) / 2, y - (SIZE - 1) / 2);
      pts += 1;
      if (prev >= 0) {
        const dx = Math.abs(x - (prev % SIZE));
        const dy = Math.abs(y - Math.floor(prev / SIZE));
        seqDist += Math.max(dx, dy);
        seqN += 1;
      }
      prev = i;
    }
  }
  const uniq = new Set(lines).size;
  rows.push({
    mode: m.tag,
    uniqueLines: uniq,
    games: GAMES,
    meanSeqDist: seqN ? seqDist / seqN : 0,
    meanCenterDist: pts ? centerDist / pts : 0,
    line12: lineHist.line12 / (pts || 1),
    line3: lineHist.line3 / (pts || 1),
    center: lineHist.center / (pts || 1),
    firstTop: [...firstPts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([v, c]) => `${v}×${c}`).join(" "),
  });
}

const L = [];
L.push(`# 开局方案结构画像（${SIZE} 路 · 每条 ${PLIES} 手 · ${GAMES} 条种子）`);
L.push("");
L.push("| 模式 | 唯一开局线 | 手均切比雪夫距离 | 距中心平均 | 1–2 线 | 3 线 | ≥4 线 | 高频首手 |");
L.push("|---|---|---|---|---|---|---|---|");
for (const r of rows) {
  L.push(`| ${r.mode} | ${r.uniqueLines}/${r.games} | ${r.meanSeqDist.toFixed(2)} | ${r.meanCenterDist.toFixed(2)} | ${(r.line12 * 100).toFixed(1)}% | ${(r.line3 * 100).toFixed(1)}% | ${(r.center * 100).toFixed(1)}% | ${r.firstTop} |`);
}
L.push("");
L.push("> 参考：9 路**均匀随机**的线位分布约 1–2 线 69% / 3 线 20% / ≥4 线 11%；");
L.push("> 手均切比雪夫距离越大越「分散」，越小越「贴身」。");
const out = L.join("\n") + "\n";
console.log(out);
const fs = await import("node:fs");
fs.writeFileSync(path.resolve("reports", `openings-profile-${new Date().toISOString().slice(0, 10)}.md`), out, "utf8");
