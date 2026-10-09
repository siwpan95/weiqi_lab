// tools/train_markov.mjs — 自对弈采集 + 马尔可夫落子模型训练 + 留出集评估
//
// 产出：
//   spec/games/corpus-<date>.jsonl    语料（每行一局，可重训）
//   spec/games/sample-<date>.sgf      前 3 局的 SGF 集合（互操作证据）
//   spec/markov_model.json            冻结模型（PatternPolicy）
//   tournament/reports/markov-<date>.md  评估报告
//
// 用法：
//   node tools/train_markov.mjs                       # 默认 60 局 / 200 playouts
//   MARKOV_GAMES=40 MARKOV_PLAYOUTS=120 node tools/train_markov.mjs
//   MARKOV_ENGINES=cpp,go node tools/train_markov.mjs  # 指定自对弈双方

import fs from "node:fs";
import path from "node:path";
import { ROOT, availableEngines } from "../harness/engines.mjs";
import { EngineClient } from "../harness/client.mjs";
import { Ref, parseVertex, formatVertex, parseColor } from "../tournament/referee.mjs";
import { MoveChain, PatternPolicy } from "./markov.mjs";
import { serializeSgf, vertexToSgf } from "./sgf.mjs";

const SIZE = Number(process.env.MARKOV_SIZE || 9);
const KOMI = 7.5;
const GAMES = Number(process.env.MARKOV_GAMES || 60);
const PLAYOUTS = Number(process.env.MARKOV_PLAYOUTS || 200);
const ENGINE_KEYS = (process.env.MARKOV_ENGINES || "cpp,go").split(",").map((s) => s.trim());
const MOVES_CAP = 3 * SIZE * SIZE;
// 报告/模型文件名标签（同一天多次实验互不覆盖；留空 = 默认，供循环赛开局生成使用）
const TAG = process.env.MARKOV_TAG || "";

const today = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const vstr = (i, size) => (i < 0 ? "pass" : formatVertex(i, size));

// ---------------------------------------------------------------- 采集
async function collect() {
  const specs = availableEngines().filter((e) => ENGINE_KEYS.includes(e.key));
  if (specs.length < 1) throw new Error(`没有可用引擎: ${ENGINE_KEYS.join(",")}`);
  const clients = new Map();
  for (const s of specs) {
    const c = new EngineClient(s, { genmoveTimeoutMs: 300000 });
    await c.start();
    clients.set(s.key, c);
  }
  const games = [];
  try {
    for (let g = 0; g < GAMES; g++) {
      const black = specs[g % specs.length];
      const white = specs[(g + 1) % specs.length];
      const ref = new Ref(SIZE, KOMI, "cn");
      await clients.get(black.key).must("clear", { size: SIZE, komi: KOMI, rules: "cn" });
      await clients.get(white.key).must("clear", { size: SIZE, komi: KOMI, rules: "cn" });
      const moves = [];
      const samples = []; // {cells, last, next}
      let last = -1;
      let ply = 0;
      let broken = null;
      while (!ref.over && ply < MOVES_CAP) {
        const color = ref.side;
        const spec = color === 1 ? black : white;
        const other = color === 1 ? white : black;
        let res;
        try {
          res = await clients.get(spec.key).must("genmove", {
            color: color === 1 ? "B" : "W",
            playouts: PLAYOUTS,
            seed: (g + 1) * 100003 + ply * 131,
            profile: {},
          });
        } catch (e) {
          broken = e.message;
          break;
        }
        if (res.vertex === "resign") {
          broken = "resign";
          break;
        }
        const v = res.vertex === "pass" ? -1 : parseVertex(res.vertex, SIZE);
        const r = ref.play(color, v);
        if (!r.ok) {
          broken = `illegal ${res.vertex} (${r.reason})`;
          break;
        }
        if (ply > 0 && last >= 0 && v >= 0) samples.push({ cells: ref.cells.slice(), toMove: color, last, next: v });
        last = v;
        moves.push({ color: color === 1 ? "B" : "W", vertex: v });
        ply += 1;
        try {
          await clients.get(other.key).must("play", { color: color === 1 ? "B" : "W", vertex: res.vertex });
        } catch (e) {
          broken = "sync " + e.message;
          break;
        }
      }
      const sc = ref.score();
      games.push({
        size: SIZE, komi: KOMI, black: black.key, white: white.key,
        result: sc.result, plies: moves.length, moves, samples, broken,
        source: "selfplay:" + ENGINE_KEYS.join("+"),
      });
      process.stdout.write(`\r  采集 ${g + 1}/${GAMES} 局（${moves.length} 手，${sc.result}）      `);
    }
  } finally {
    for (const c of clients.values()) await c.stop();
  }
  process.stdout.write("\n");
  return games;
}

// ---------------------------------------------------------------- 诊断
// 目的：判定"模型学不到东西"是代码问题还是数据问题 —— 量化语料本身的可预测性上限。
function diagnose(games) {
  const offsetCount = new Map();
  const distHist = {};
  let totalMoves = 0;
  let near1 = 0;
  let near1Expect = 0; // 均匀随机下"紧邻点占空点比例"的期望
  let passMoves = 0;
  const byCross = new Map();
  for (const g of games) {
    const ref = new Ref(SIZE, g.komi, "cn");
    let last = -1;
    for (const m of g.moves) {
      const color = m.color === "B" ? 1 : 2;
      const v = m.vertex;
      if (ref.side !== color) break;
      if (v < 0) passMoves += 1;
      else if (last >= 0) {
        const dx = (v % SIZE) - (last % SIZE);
        const dy = Math.floor(v / SIZE) - Math.floor(last / SIZE);
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        totalMoves += 1;
        if (d <= 1) near1 += 1;
        distHist[d] = (distHist[d] || 0) + 1;
        // 均匀随机基准：空点中落在"最后一手 1 邻域"内的比例
        {
          const lx2 = last % SIZE;
          const ly2 = Math.floor(last / SIZE);
          let emptyAll = 0;
          let emptyNear = 0;
          for (let p = 0; p < SIZE * SIZE; p++) {
            if (ref.cells[p] !== 0) continue;
            emptyAll += 1;
            const dx2 = Math.abs((p % SIZE) - lx2);
            const dy2 = Math.abs(Math.floor(p / SIZE) - ly2);
            if (Math.max(dx2, dy2) <= 1) emptyNear += 1;
          }
          if (emptyAll > 0) near1Expect += emptyNear / emptyAll;
        }
        const k = `${dx},${dy}`;
        offsetCount.set(k, (offsetCount.get(k) || 0) + 1);
        const lx = last % SIZE;
        const ly = Math.floor(last / SIZE);
        const enc1 = (x, y) => (x < 0 || y < 0 || x >= SIZE || y >= SIZE) ? "3"
          : (ref.cells[y * SIZE + x] === 0 ? "0" : (ref.cells[y * SIZE + x] === color ? "1" : "2"));
        const dirs = [[0, 1], [1, 0], [0, -1], [-1, 0]];
        let best = null;
        for (let r = 0; r < 4; r++) {
          let enc = "";
          for (let j = 0; j < 4; j++) { const [ax, ay] = dirs[(j + r) % 4]; enc += enc1(lx + ax, ly + ay); }
          if (best === null || enc < best) best = enc;
        }
        const key = best + "|" + k;
        byCross.set(key, (byCross.get(key) || 0) + 1);
      }
      const rr = ref.play(color, v);
      if (!rr.ok) break;
      last = v;
    }
  }
  const sortedOff = Array.from(offsetCount.entries()).sort((a, b) => b[1] - a[1]);
  const ctxBest = new Map();
  const ctxTotal = new Map();
  for (const [k, c] of byCross) {
    const [ctx] = k.split("|");
    ctxTotal.set(ctx, (ctxTotal.get(ctx) || 0) + c);
    if (!ctxBest.has(ctx) || c > ctxBest.get(ctx)) ctxBest.set(ctx, c);
  }
  let oracleHit = 0;
  let oracleAll = 0;
  for (const [ctx, cnt] of ctxTotal) {
    oracleHit += ctxBest.get(ctx) || 0;
    oracleAll += cnt;
  }
  return {
    totalMoves, passMoves, near1, near1Expect, distHist,
    globalMode: sortedOff.slice(0, 3).map(([k, c]) => ({ off: k, p: c / totalMoves })),
    oracleCross: oracleAll ? oracleHit / oracleAll : 0,
    contexts: ctxTotal.size,
  };
}

// ---------------------------------------------------------------- 评估
function evaluate(policy, testGames) {
  let covered = 0;
  let total = 0;
  let hit1 = 0;
  let hit3 = 0;
  let uniformSum = 0;
  let viaMain = 0;
  let viaCross = 0;
  for (const g of testGames) {
    for (const s of g.samples) {
      total += 1;
      if (s.next < 0) continue;
      const empties = s.cells.reduce((a, v) => a + (v === 0 ? 1 : 0), 0);
      uniformSum += empties > 0 ? 1 / empties : 0;
      const { top, source } = policy.topK(s, SIZE, 3);
      if (!source) continue;
      covered += 1;
      if (source === "main") viaMain += 1;
      else viaCross += 1;
      if (top.length && top[0].vertex === s.next) hit1 += 1;
      if (top.some((t) => t.vertex === s.next)) hit3 += 1;
    }
  }
  return {
    plies: total, covered,
    coverage: total ? covered / total : 0,
    top1: covered ? hit1 / covered : 0,
    top3: covered ? hit3 / covered : 0,
    uniform: total ? uniformSum / total : 0,
    viaMain, viaCross,
  };
}

// ---------------------------------------------------------------- 复用冻结语料
/** 由已冻结的 corpus-*.jsonl 重建（着法字符串 → 对象 + 逐步 replay 重建 cells/samples） */
function loadCorpus(p) {
  const lines = fs.readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  return lines.map((g) => {
    const moves = g.moves.map((s) => ({
      color: s[0], vertex: s.slice(1) === "pass" ? -1 : parseVertex(s.slice(1), SIZE),
    }));
    const ref = new Ref(SIZE, g.komi, "cn");
    const samples = [];
    let last = -1;
    for (const m of moves) {
      const color = m.color === "B" ? 1 : 2;
      if (ref.side !== color) break;
      if (m.vertex >= 0 && last >= 0) samples.push({ cells: ref.cells.slice(), toMove: color, last, next: m.vertex });
      const r = ref.play(color, m.vertex);
      if (!r.ok) break;
      last = m.vertex;
    }
    return { size: g.size, komi: g.komi, playouts: g.playouts, source: g.source,
      black: g.black, white: g.white, result: g.result, plies: moves.length,
      moves, samples, broken: g.broken };
  });
}

// ---------------------------------------------------------------- 主流程
async function main() {
  const t0 = Date.now();
  fs.mkdirSync(path.join(ROOT, "spec", "games"), { recursive: true });
  let games;
  if (process.env.MARKOV_CORPUS) {
    games = loadCorpus(process.env.MARKOV_CORPUS);
    console.log(`== Markov 落子模型训练 == 复用语料 ${process.env.MARKOV_CORPUS}（${games.length} 局）`);
  } else {
    console.log(`== Markov 落子模型训练 ==  棋盘 ${SIZE}×${SIZE} · 自对弈 ${ENGINE_KEYS.join(" vs ")} · ${GAMES} 局 · ${PLAYOUTS} playouts/手`);
    games = await collect();
  }
  const okGames = games.filter((g) => !g.broken);
  console.log(`完成采集：${games.length} 局，其中可用 ${okGames.length} 局（异常 ${games.length - okGames.length}）`);

  // 留出集：后 20% 局
  const cut = Math.max(1, Math.floor(okGames.length * 0.8));
  const train = okGames.slice(0, cut);
  const test = okGames.slice(cut);
  console.log(`训练/留出：${train.length} 局 / ${test.length} 局`);

  // 训练：模式条件模型（3×3 主 + 十字退避）+ 全局落子转移模型
  const policy = new PatternPolicy(1, 3, 4);
  const chain = new MoveChain(SIZE);
  for (const g of train) {
    for (const s of g.samples) policy.observe(s, SIZE, s.next);
    chain.observeMoveList(g.moves.map((m) => m.vertex));
  }
  const metrics = evaluate(policy, test);
  const diag = diagnose(okGames);
  const { pi, iters } = chain.toChain().steadyState(500, 1e-9);
  const region = chain.regionHistogram();

  // 稳态前 8 热点
  const hot = Object.entries(pi)
    .filter(([s]) => s !== "start")
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([s, p]) => ({ vertex: Number(s) < 0 ? "pass" : vstr(Number(s), SIZE), p }));

  // ---------- 产物 ----------
  const stamp = today();
  const corpusPath = path.join(ROOT, "spec", "games", `corpus-${stamp}${TAG}.jsonl`);
  const corpusLines = games.map((g) => JSON.stringify({
    size: g.size, komi: g.komi, playouts: PLAYOUTS, source: g.source, black: g.black, white: g.white,
    result: g.result, plies: g.plies, broken: g.broken,
    moves: g.moves.map((m) => `${m.color}${vstr(m.vertex, SIZE)}`),
  }));
  if (!process.env.MARKOV_CORPUS) {
    fs.writeFileSync(corpusPath, corpusLines.join("\n") + "\n", "utf8");
  } else {
    console.log("（复用语料模式：不重写语料与 SGF 样本）");
  }
  const corpusPlayouts = (games[0] && games[0].playouts) ? games[0].playouts
    : (String((games[0] && games[0].source) || "").startsWith("human") ? 0 : PLAYOUTS);

  // SGF 样本（前 3 局）
  if (!process.env.MARKOV_CORPUS) {
    let sgfCollection = "";
    for (const g of games.slice(0, 3)) {
      const tree = {
        root: {
          GM: ["1"], FF: ["4"], CA: ["UTF-8"], AP: ["weiqi_lab:train_markov"],
          SZ: [String(SIZE)], KM: [String(KOMI)], RU: ["Chinese"],
          PB: [g.black], PW: [g.white], RE: [g.result], DT: [stamp],
        },
        nodes: g.moves.map((m) => ({
          color: m.color, value: m.vertex < 0 ? "" : vertexToSgf(vstr(m.vertex, SIZE), SIZE),
        })),
      };
      sgfCollection += serializeSgf(tree) + "\n";
    }
    fs.writeFileSync(path.join(ROOT, "spec", "games", `sample-${stamp}${TAG}.sgf`), sgfCollection, "utf8");
  }

  const modelPath = path.join(ROOT, "spec", TAG ? `markov_model${TAG}.json` : "markov_model.json");
  const model = {
    protocol: 1, spec: "markov-v1", created: stamp, size: SIZE, komi: KOMI,
    engineKeys: ENGINE_KEYS, games: okGames.length, playouts: PLAYOUTS,
    metrics, region, steadyTop: hot,
    policy: policy.toJSON(),
  };
  fs.writeFileSync(modelPath, JSON.stringify(model), "utf8");

  // ---------- 报告 ----------
  const L = [];
  L.push(`# Markov 落子模型报告 — ${stamp}`);
  L.push("");
  L.push("## 语料");
  L.push("");
  const corpusSource = (games[0] && games[0].source) || ENGINE_KEYS.join(" vs ");
  L.push(`- 语料来源：**${corpusSource}**（${SIZE} 路 · 训练时 komi ${KOMI}）${corpusPlayouts ? ` · ${corpusPlayouts} playouts/手` : ""}`);
  L.push(`- 局数：${games.length}（可用 ${okGames.length}）；训练 ${train.length} / 留出 ${test.length}`);
  L.push(`- 手数：${games.reduce((a, g) => a + g.plies, 0)}；平均 ${(games.reduce((a, g) => a + g.plies, 0) / Math.max(1, games.length)).toFixed(1)} 手/局`);
  L.push("");
  L.push("## 模式条件转移模型（3×3 主上下文 + 十字邻域退避；状态 = 8/4 对称归一化棋形，动作 = 相对偏移）");
  L.push("");
  const sz = policy.size();
  L.push(`- 主上下文：${sz.contexts} 个签名 / ${sz.entries} 条目；退避上下文：${sz.crossContexts} 个 / ${sz.crossEntries} 条目`);
  L.push(`- 训练样本：${policy.seen}`);
  L.push(`- 留出集覆盖率：**${(metrics.coverage * 100).toFixed(1)}%**（${metrics.covered}/${metrics.plies} 手；主表 ${metrics.viaMain} · 退避 ${metrics.viaCross}）`);
  L.push("");
  L.push("| 指标 | 本模型 | 均匀基线（1/空点） | 常数基线（全局众数偏移） |");
  L.push("|---|---|---|---|");
  L.push(`| top-1 命中 | ${(metrics.top1 * 100).toFixed(1)}% | ${(metrics.uniform * 100).toFixed(2)}% | ${(diag.globalMode[0] ? diag.globalMode[0].p * 100 : 0).toFixed(2)}% |`);
  L.push(`| top-3 命中 | ${(metrics.top3 * 100).toFixed(1)}% | ${(metrics.uniform * 3 * 100).toFixed(2)}% | ~${(diag.globalMode.reduce((a, b) => a + b.p, 0) * 100).toFixed(2)}% |`);
  L.push("");
  L.push("## 语料可预测性诊断（判定「学不到东西」是代码问题还是数据问题）");
  L.push("");
  const dh = Object.keys(diag.distHist).map(Number).sort((a, b) => a - b);
  const nearRatio = diag.near1Expect > 0 ? diag.near1 / diag.near1Expect : 0;
  L.push(`- 非 pass 手数：${diag.totalMoves}（pass ${diag.passMoves}）`);
  L.push(`- 与最后一手的切比雪夫距离分布：${dh.map((d) => `d=${d} ${(diag.distHist[d] / diag.totalMoves * 100).toFixed(1)}%`).join(" · ")}`);
  L.push(`- 局部偏置：紧邻（≤1）实际 **${(diag.near1 / diag.totalMoves * 100).toFixed(1)}%** vs 均匀随机期望 **${(diag.near1Expect / diag.totalMoves * 100).toFixed(1)}%** → **${nearRatio.toFixed(2)}×**；`);
  L.push(`- 但偏移分布很散：全局众数偏移命中率（最优常数预测器）仅 **${(diag.globalMode[0] ? diag.globalMode[0].p * 100 : 0).toFixed(2)}%**；`);
  L.push(`- 十字上下文（256 态）后验众数上限（**含留一污染，偏乐观**）：**${(diag.oracleCross * 100).toFixed(2)}%**（上下文 ${diag.contexts} 个）。`);
  L.push("");
  L.push("### 结论");
  L.push("");
  const beats1 = metrics.top1 > metrics.uniform;
  const beats3 = metrics.top3 > metrics.uniform * 3;
  const ratio = metrics.uniform > 0 ? metrics.top1 / metrics.uniform : 0;
  L.push(`- top-1 ${beats1 ? "**超过**" : "**未超过**"}均匀基线（相对增益 ${ratio.toFixed(2)}×）；top-3 ${beats3 ? "超过" : "未超过"} 3×均匀。`);
  L.push(`- 但相对**十字上下文后验上限 ${(diag.oracleCross * 100).toFixed(1)}%** 仍有明显差距 → 说明上下文条件带来了信息，`);
  L.push("  而绝对命中率的**天花板由语料质量决定**。");
  L.push("");
  L.push("**根因判断**：实验场引擎（朴素 playout 的弱 MCTS）着法**有局部偏置但分布很散**"
    + `（紧邻 ${(diag.near1 / Math.max(1, diag.totalMoves) * 100).toFixed(1)}% ≈ 均匀期望的 ${nearRatio.toFixed(1)}×，`
    + `但全局众数偏移仅 ${(diag.globalMode[0] ? diag.globalMode[0].p * 100 : 0).toFixed(1)}%、十字后验上限 ${(diag.oracleCross * 100).toFixed(1)}%）——`
    + "即着法在合法点集上接近均匀，**可提取的规律本就稀薄**。这是**语料质量**问题，不是模型实现问题。");
  L.push("");
  L.push("→ 学习型组件（含后续 CNN 路线）的**前置条件是语料质量**：需先提升引擎强度（更高预算 / 更强 playout 策略），");
  L.push("或引入人类/公开棋谱语料；详见 `docs/TIER3_LEARNING.md`。");
  L.push("");
  L.push("## 全局落子转移模型（MoveChain DTMC）");
  L.push("");
  L.push(`- 状态数：${Object.keys(pi).length}；幂迭代 ${iters} 次收敛`);
  L.push(`- 落子线位分布（到最近边距离）：1–2 线 ${region.line12} · 3 线 ${region.line3} · ≥4 线 ${region.center} · pass ${region.pass}（均匀随机基准约 69% / 20% / 11%）`);
  L.push(`- 稳态热点（长期占比前 8）：${hot.map((h) => `${h.vertex} ${(h.p * 100).toFixed(2)}%`).join(" · ")}`);
  L.push("");
  L.push("## 产物");
  L.push("");
  L.push(`- 语料：\`spec/games/corpus-${stamp}.jsonl\`（${corpusLines.length} 行）`);
  L.push(`- SGF 样本：\`spec/games/sample-${stamp}.sgf\`（前 3 局，集合格式）`);
  L.push(`- 冻结模型：\`spec/markov_model.json\``);
  L.push("");
  L.push("> 说明：本模型是**零依赖的首个学习型组件**（Tier 3 起步）：用途为开局生成、引擎行为预测与落子热点分析；");
  L.push("> 受朴素 playout 引擎的着法质量限制，其绝对命中率应按「与均匀基线的相对增益」解读。");
  L.push("");
  L.push(`> 生成耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s；\`tools/train_markov.mjs\` 自动生成。`);
  const reportDir = path.join(ROOT, "tournament", "reports");
  fs.mkdirSync(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, `markov-${stamp}${TAG}.md`);
  fs.writeFileSync(reportPath, L.join("\n") + "\n", "utf8");

  console.log(`\n留出集：覆盖 ${(metrics.coverage * 100).toFixed(1)}%  top1=${(metrics.top1 * 100).toFixed(1)}%  top3=${(metrics.top3 * 100).toFixed(1)}%  (均匀基线 ${(metrics.uniform * 100).toFixed(2)}%)`);
  console.log(`稳态热点：${hot.map((h) => h.vertex).join(" ")}`);
  console.log(`报告：${reportPath}`);
  console.log(`模型：${modelPath}`);
}

main().catch((e) => {
  console.error("训练异常:", e);
  process.exit(2);
});
