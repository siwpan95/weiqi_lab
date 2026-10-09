// tournament/ab_prior.mjs — 单引擎自对弈 A/B：CNN 先验 开/关（或任意两 profile）对比
//
// 设计：同一引擎（默认 js）自对弈，黑白分别使用 profile A / B，逐局交换黑白以消除先手偏差。
//   - 每手 genmove 的 profile 由协议逐次传入（引擎无需重启）
//   - 裁判（tournament/referee.mjs）裁决合法性与终局；非法/异常判负并记录
//   - 输出：胜率、平均手数、每手耗时、两比例 z 检验 p 值；写 reports/ab-prior-<date>.json/.md
//
// 用法：
//   node tournament/ab_prior.mjs [--engine js] [--size 9] [--playouts 150] [--games 90] \
//        [--priorA 0] [--priorB 3] [--weight 3] [--tag prior-w3]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { availableEngines } from "../harness/engines.mjs";
import { EngineClient } from "../harness/client.mjs";
import { Ref, parseVertex } from "./referee.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const arg = (n, d) => {
  const i = process.argv.indexOf("--" + n);
  return i >= 0 ? process.argv[i + 1] : d;
};

const ENGINE_KEY = arg("engine", "js");
const SIZE = Number(arg("size", 9));
const PLAYOUTS = Number(arg("playouts", 150));
const GAMES = Number(arg("games", 90));
const SEED_BASE = Number(arg("seed", 20261009));

// 通用 profile 支持：--profA/--profB 传 JSON；亦兼容旧的 --priorA/--priorB（布尔权重）
function parseProf(jsonArg, priorArg) {
  if (jsonArg) return JSON.parse(jsonArg);
  const w = Number(priorArg ?? 0);
  return w > 0 ? { cnn_prior: w } : {};
}
const PROF_A = parseProf(arg("profA", null), arg("priorA", 0));
const PROF_B = parseProf(arg("profB", null), arg("priorB", 0));
const LABEL_A = arg("labelA", JSON.stringify(PROF_A) === "{}" ? "默认(全关)" : JSON.stringify(PROF_A));
const LABEL_B = arg("labelB", JSON.stringify(PROF_B) === "{}" ? "默认(全关)" : JSON.stringify(PROF_B));
const TAG = arg("tag", `ab-${Date.now().toString(36)}`);

function normalCdf(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp((-z * z) / 2);
  const p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z > 0 ? 1 - p : p;
}
function twoProportionP(x1, n1, x2, n2) {
  if (!n1 || !n2) return 1;
  const p = (x1 + x2) / (n1 + n2);
  const se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
  if (se === 0) return 1;
  return 2 * (1 - normalCdf(Math.abs(x1 / n1 - x2 / n2) / se));
}

// 两臂 profile 已在文件头解析（PROF_A / PROF_B）

async function main() {
  const spec = availableEngines().find((e) => e.key === ENGINE_KEY);
  if (!spec) {
    console.error(`引擎 ${ENGINE_KEY} 不可用`);
    process.exit(2);
  }
  const t0 = Date.now();
  console.log(`== CNN 先验自对弈 A/B ==`);
  console.log(`引擎 ${spec.name}（${spec.key}）· ${SIZE} 路 · ${PLAYOUTS} playouts/手 · ${GAMES} 局`);
  console.log(`A = ${LABEL_A}\n   B = ${LABEL_B}`);

  const client = new EngineClient(spec, { genmoveTimeoutMs: 600000 });
  await client.start();

  const games = [];
  let timeA = 0;
  let timeB = 0;
  let movesA = 0;
  let movesB = 0;
  try {
    for (let g = 1; g <= GAMES; g++) {
      // 偶数局：黑=A；奇数局：黑=B（交换黑白）
      const aIsBlack = g % 2 === 0;
      const ref = new Ref(SIZE, 7.5, "cn");
      await client.must("clear", { size: SIZE, komi: 7.5, rules: "cn" });
      let plies = 0;
      let anomaly = null;
      let winnerSide = null;
      const cap = 3 * SIZE * SIZE;
      while (!ref.over && plies < cap) {
        const side = ref.side; // 1=B / 2=W
        const isA = (side === 1) === aIsBlack;
        const prof = isA ? PROF_A : PROF_B;
        const tStart = Date.now();
        let res;
        try {
          res = await client.must("genmove", {
            color: side === 1 ? "B" : "W",
            playouts: PLAYOUTS,
            seed: SEED_BASE + g * 7919 + plies * 131,
            profile: prof,
          });
        } catch (e) {
          anomaly = `引擎错误: ${e.message}`;
          winnerSide = side === 1 ? 2 : 1;
          break;
        }
        const dt = Date.now() - tStart;
        if (isA) { timeA += dt; movesA += 1; } else { timeB += dt; movesB += 1; }
        if (res.vertex === "resign") {
          winnerSide = side === 1 ? 2 : 1;
          break;
        }
        const v = res.vertex === "pass" ? -1 : parseVertex(res.vertex, SIZE);
        const r = ref.play(side, v);
        if (!r.ok) {
          anomaly = `非法着法 ${res.vertex} (${r.reason})`;
          winnerSide = side === 1 ? 2 : 1;
          break;
        }
        plies += 1;
      }
      let result = "0";
      if (winnerSide === null) {
        const sc = ref.scoreAuto();
        result = sc.result;
        if (result.startsWith("B+")) winnerSide = 1;
        else if (result.startsWith("W+")) winnerSide = 2;
        else winnerSide = 0;
      } else {
        result = (winnerSide === 1 ? "B+" : "W+") + (anomaly ? "F" : "R");
      }
      const winnerIsA = winnerSide === 0 ? null : ((winnerSide === 1) === aIsBlack);
      games.push({ gno: g, aIsBlack, winnerIsA, result, plies, anomaly });
      const done = games.filter((x) => !x.anomaly).length;
      const wA = games.filter((x) => x.winnerIsA === true).length;
      const wB = games.filter((x) => x.winnerIsA === false).length;
      process.stdout.write(`\r  局 ${g}/${GAMES}（有效 ${done}） A胜 ${wA} · B胜 ${wB} · 本局 ${result} ${plies}手 ${anomaly ? "!!" + anomaly : ""}      `);
    }
  } finally {
    await client.stop();
  }

  const valid = games.filter((x) => !x.anomaly && x.winnerIsA !== null);
  const draws = games.filter((x) => !x.anomaly && x.winnerIsA === null).length;
  const wA = valid.filter((x) => x.winnerIsA === true).length;
  const wB = valid.filter((x) => x.winnerIsA === false).length;
  const nA = wA + wB;
  const p = twoProportionP(wA, nA, wB, nA);
  const avgMoves = games.reduce((a, x) => a + x.plies, 0) / Math.max(1, games.length);
  const msA = movesA ? timeA / movesA : 0;
  const msB = movesB ? timeB / movesB : 0;
  const anomalies = games.filter((x) => x.anomaly).length;

  const L = [];
  L.push(`# 引擎 Profile 自对弈 A/B — ${new Date().toISOString().slice(0, 10)}`);
  L.push("");
  L.push(`- 引擎：**${spec.name}**（自对弈）· ${SIZE} 路 · ${PLAYOUTS} playouts/手 · ${GAMES} 局（黑白对调）`);
  L.push(`- A = \`${LABEL_A}\`   B = \`${LABEL_B}\``);
  L.push(`- 引擎版本：\`${process.env.GIT_HEAD || "working-tree"}\``);
  L.push("");
  L.push(`| 指标 | A | B |`);
  L.push(`|---|---|---|`);
  L.push(`| 胜 | ${wA} | ${wB} |`);
  L.push(`| 负 | ${wB} | ${wA} |`);
  L.push(`| 胜率 | ${nA ? (wA / nA * 100).toFixed(1) : "-"}% | ${nA ? (wB / nA * 100).toFixed(1) : "-"}% |`);
  L.push(`| 平均每手耗时 | ${msA.toFixed(0)} ms | ${msB.toFixed(0)} ms |`);
  L.push("");
  L.push(`- 有效局：${valid.length}；和棋：${draws}；异常局：${anomalies}；平均手数：${avgMoves.toFixed(1)}`);
  L.push(`- 两比例 z 检验（双尾）：p = **${p.toFixed(4)}**（n=${nA}）→ ${p < 0.05 ? "**显著**" : "不显著（无稳健差异）"}`);
  L.push("");
  L.push("## 逐局");
  L.push("");
  L.push("| # | 黑 | 结果 | 手数 | 胜方 | 异常 |");
  L.push("|---|---|---|---|---|---|");
  for (const x of games) {
    L.push(`| ${x.gno} | ${x.aIsBlack ? "A" : "B"} | ${x.result} | ${x.plies} | ${x.winnerIsA === null ? "和" : x.winnerIsA ? "A" : "B"} | ${x.anomaly || ""} |`);
  }
  L.push("");
  L.push(`> 生成耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s；\`tournament/ab_prior.mjs\` 自动生成。`);
  const out = L.join("\n") + "\n";
  const dir = path.join(HERE, "reports");
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(path.join(dir, `ab-profile-${stamp}-${TAG}.md`), out, "utf8");
  fs.writeFileSync(path.join(dir, `ab-profile-${stamp}-${TAG}.json`),
    JSON.stringify({ settings: { engine: ENGINE_KEY, size: SIZE, playouts: PLAYOUTS, games: GAMES, profA: PROF_A, profB: PROF_B, labelA: LABEL_A, labelB: LABEL_B, tag: TAG },
      wA, wB, draws, anomalies, avgMoves, msA, msB, p, games }, null, 1) + "\n", "utf8");
  console.log(`\nA胜 ${wA} · B胜 ${wB} · 和 ${draws} · 异常 ${anomalies} · p=${p.toFixed(4)}`);
  console.log(`平均每手：A ${msA.toFixed(0)}ms · B ${msB.toFixed(0)}ms`);
  console.log(`→ reports/ab-profile-${stamp}-${TAG}.md`);
}

main().catch((e) => {
  console.error("A/B 异常:", e);
  process.exit(2);
});
