// tournament/sweep.mjs — 单参数"扫描"驱动（P1：参数系统扫描）
//
// 作用：以同一个基线 profile 为 A 方，对每个候选取值各跑一场 ab_prior 自对弈 A/B，
//       最后汇总成一张带 **Bonferroni 多重比较校正** 的筛选表。
//
// 用法：
//   node tournament/sweep.mjs --base '{"probe_k":3}' --games 100 --playouts 150 --seed 7777 \
//        --var 'c=0.4' --var 'rave_k=40' [--size 9] [--engine js] [--tag sw1]
//
// 说明：
//   - 筛选（screening）阶段用较小局数；被判"显著"的项再用 ab_prior.mjs 单独放大局数复核。
//   - 每项写成 reports/ab-profile-<date>-<tag>-<i>.json/.md（由 ab_prior.mjs 产出），
//     汇总写入 reports/sweep-<date>-<tag>.md。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const arg = (n, d) => {
  const i = process.argv.indexOf("--" + n);
  return i >= 0 ? process.argv[i + 1] : d;
};
const argsAll = (n) => process.argv.reduce((a, v, i) => (v === "--" + n ? [...a, process.argv[i + 1]] : a), []);

const BASE = JSON.parse(arg("base", '{"probe_k":3}'));
const GAMES = Number(arg("games", 100));
const PLAYOUTS = Number(arg("playouts", 150));
const SIZE = Number(arg("size", 9));
const ENGINE = arg("engine", "js");
const SEED = Number(arg("seed", 7777));
const TAG = arg("tag", "sw1");
const VARS = argsAll("var");
if (VARS.length === 0) {
  console.error("用法: node tournament/sweep.mjs --base '{...}' --games 100 --var 'k=v' [--var ...]");
  process.exit(2);
}

const STAMP = new Date().toISOString().slice(0, 10);
const results = [];

for (let i = 0; i < VARS.length; i++) {
  const v = VARS[i];
  const eq = v.indexOf("=");
  const key = v.slice(0, eq);
  const rawVal = v.slice(eq + 1);
  let val;
  try { val = JSON.parse(rawVal); } catch { val = rawVal; }
  const profB = { ...BASE, [key]: val };
  const labelA = `基线 ${JSON.stringify(BASE)}`;
  const labelB = `${key}=${rawVal}`;
  const tag = `${TAG}-${i}`;
  console.log(`[sweep ${i + 1}/${VARS.length}] ${labelB}  ← 基线 ${JSON.stringify(BASE)}（${GAMES} 局）`);
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [
    path.join(HERE, "ab_prior.mjs"),
    "--engine", ENGINE, "--size", String(SIZE), "--playouts", String(PLAYOUTS),
    "--games", String(GAMES), "--seed", String(SEED),
    "--profA", JSON.stringify(BASE), "--profB", JSON.stringify(profB),
    "--labelA", labelA, "--labelB", labelB, "--tag", tag,
  ], { stdio: "inherit", cwd: ROOT });
  if (r.status !== 0) {
    console.error(`  ⚠ 该项失败（exit=${r.status}），跳过`);
    results.push({ key, rawVal, labelB, fail: true });
    continue;
  }
  const rep = JSON.parse(fs.readFileSync(path.join(HERE, "reports", `ab-profile-${STAMP}-${tag}.json`), "utf8"));
  const n = rep.wA + rep.wB;
  results.push({
    key, rawVal, labelB, tag,
    wA: rep.wA, wB: rep.wB, wr: n ? rep.wB / n : 0, p: rep.p, n,
    msA: rep.msA, msB: rep.msB, secs: (Date.now() - t0) / 1000,
  });
  console.log(`  → B 胜率 ${(100 * results[results.length - 1].wr).toFixed(1)}%  p=${rep.p.toFixed(4)}`);
}

const k = results.filter((x) => !x.fail).length;
const alpha = 0.05 / Math.max(1, k);

const L = [];
L.push(`# 参数扫描（筛选）— ${STAMP} #${TAG}`);
L.push("");
L.push(`- 基线 A：\`${JSON.stringify(BASE)}\`；每项 ${GAMES} 局 · ${SIZE} 路 · ${PLAYOUTS} playouts/手 · 黑白对调`);
L.push(`- 比较数 k=${k} → **Bonferroni 校正阈值 α' = 0.05/${k} = ${alpha.toFixed(5)}**`);
L.push(`- 判定口径：p < α' = **显著**；p < 0.05 = 趋势（未过校正）；否则无差异`);
L.push("");
L.push("| 参数 | B 胜率 | p | vs α' | 判定 | 每手耗时 A/B | 参考 |");
L.push("|---|---|---|---|---|---|---|");
for (const x of results) {
  if (x.fail) {
    L.push(`| ${x.labelB} | — | — | — | 运行失败 | — | — |`);
    continue;
  }
  const verdict = x.p < alpha ? "**显著**" : x.p < 0.05 ? "趋势" : "无差异";
  const sign = x.wr > 0.5 ? "+" : "";
  L.push(`| ${x.labelB} | ${sign}${(100 * x.wr).toFixed(1)}% (${x.wB}/${x.n}) | ${x.p.toFixed(4)} | ${x.p < alpha ? "✅" : "❌"} | ${verdict} | ${x.msA.toFixed(0)}/${x.msB.toFixed(0)} ms | reports/ab-profile-${STAMP}-${x.tag}.md |`);
}
L.push("");
L.push("> 筛选阶段局数有限、比较数多：只有通过 α' 的项才视为有效改进；通过者应再单独放大局数复核。");
L.push("> `tournament/sweep.mjs` 自动生成。");
const out = L.join("\n") + "\n";
fs.writeFileSync(path.join(HERE, "reports", `sweep-${STAMP}-${TAG}.md`), out, "utf8");
fs.writeFileSync(path.join(HERE, "reports", `sweep-${STAMP}-${TAG}.json`),
  JSON.stringify({ base: BASE, games: GAMES, playouts: PLAYOUTS, size: SIZE, seed: SEED, tag: TAG, alpha, k, results }, null, 1) + "\n", "utf8");
console.log(`\n${L.join("\n")}`);
console.log(`→ reports/sweep-${STAMP}-${TAG}.md`);
