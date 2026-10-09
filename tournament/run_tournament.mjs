// tournament/run_tournament.mjs — 跨语言循环赛（9 路 · 中国数子口径）
//
// 设计（对应 G:\repos\lab 的 tournament/ 范式）：
//   - 裁判层：tournament/referee.mjs（独立实现，机制不同于五引擎）负责合法性裁决与终局计分
//   - 固定算力：每引擎每手固定 playouts 预算（harness/engines.mjs，按实测速度折算 ≈1s/手）
//   - 开局库：openings.mjs 随机开局（Tier 1），削减同质化
//   - 违规处置：非法着法/超时/崩溃 → 该局判负并 kill，后续局继续（保证有界不挂死）
//   - 增量写战报：tournament/reports/YYYY-MM-DD.md
//
// 用法：
//   node run_tournament.mjs
//   TOURNAMENT_PLAYOUTS=200 GAMES_PER_PAIR=1 OPENING_PLIES=2 ENGINES_FILTER=py,rs,cs node run_tournament.mjs
//   TOURNAMENT_SIZE=9  （棋盘路数）

import fs from "node:fs";
import path from "node:path";
import { ROOT, availableEngines } from "../harness/engines.mjs";
import { EngineClient } from "../harness/client.mjs";
import { Ref, parseVertex, formatVertex, parseColor } from "./referee.mjs";
import { openingLine } from "./openings.mjs";

const SIZE = Number(process.env.TOURNAMENT_SIZE || 9);
const GAMES_PER_PAIR = Number(process.env.GAMES_PER_PAIR || 2);
const OPENING_PLIES = Number(process.env.OPENING_PLIES ?? 2);
const MOVES_CAP = Number(process.env.MOVES_CAP || 3 * SIZE * SIZE);
const FILTER = (process.env.ENGINES_FILTER || "").split(",").map((s) => s.trim()).filter(Boolean);
// 战报文件名后缀（追加到 <date>.md 之前）；默认空串 → 行为不变
const REPORT_SUFFIX = process.env.REPORT_SUFFIX || "";
// 可选：给所有引擎统一传一个 profile（如 PROFILE_JSON='{"probe_k":3,"pw_c":0.5,"pw_min":6}'）。
// ⚠️ 默认 `{}` = 全关闭 → 跨语言对比公平。仅当**所有参赛语言都实现了**这些开关时才用于跨语言赛；
//    否则只应用于同语言实验（见 docs/PORTING.md §4.1 的移植待办）。
let PROFILE = {};
if (process.env.PROFILE_JSON) {
  try {
    PROFILE = JSON.parse(process.env.PROFILE_JSON);
  } catch (e) {
    console.error(`PROFILE_JSON 不是合法 JSON：${e.message}`);
    process.exit(2);
  }
}

function specFiltered() {
  let list = availableEngines();
  if (FILTER.length) list = list.filter((e) => FILTER.includes(e.key));
  return list;
}

function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

async function main() {
  const specs = specFiltered();
  if (specs.length < 2) {
    console.error("可用引擎不足 2 个，无法开赛");
    process.exit(2);
  }
  const t0 = Date.now();
  const budgets = new Map(specs.map((s) => [s.key, Number(process.env.TOURNAMENT_PLAYOUTS || s.playouts)]));
  console.log(`== weiqi_lab 循环赛 ==`);
  console.log(`棋盘 ${SIZE}×${SIZE} · 规则 cn(positional/forbid/area) · komi 7.5 · 开局 ${OPENING_PLIES} 手 · 每对 ${GAMES_PER_PAIR} 局`);
  console.log(`引擎与每手预算: ${specs.map((s) => `${s.key}=${budgets.get(s.key)}`).join(", ")}`);

  const clients = new Map();
  const stats = new Map();
  for (const s of specs) {
    stats.set(s.key, { key: s.key, name: s.name, wins: 0, losses: 0, draws: 0, moves: 0,
      visits: 0, winrate: 0, illegal: 0, timeout: 0, crash: 0, genmoves: 0 });
  }
  const games = [];
  const divergence = [];

  try {
    for (const s of specs) {
      const c = new EngineClient(s, { genmoveTimeoutMs: 600000 });
      await c.start();
      clients.set(s.key, c);
    }

    const pairs = [];
    for (let i = 0; i < specs.length; i++) {
      for (let j = i + 1; j < specs.length; j++) pairs.push([specs[i], specs[j]]);
    }

    let gno = 0;
    for (const [A, B] of pairs) {
      for (let g = 0; g < GAMES_PER_PAIR; g++) {
        gno += 1;
        const black = g % 2 === 0 ? A : B;
        const white = g % 2 === 0 ? B : A;
        const game = await playGame(gno, black, white, clients, budgets, stats, divergence);
        games.push(game);
        const sa = stats.get(A.key);
        const sb = stats.get(B.key);
        if (game.winner === black.key) { sa.wins++; sb.losses++; }
        else if (game.winner === white.key) { sb.wins++; sa.losses++; }
        else { sa.draws++; sb.draws++; }
        console.log(`  局${gno} ${black.key}(B) vs ${white.key}(W) → ${game.result}  [${game.moves}手${game.anomaly ? " !!" + game.anomaly : ""}]`);
      }
    }
  } finally {
    for (const c of clients.values()) await c.stop();
  }

  // ---------- 战报 ----------
  const report = renderReport({ specs, stats, games, divergence, budgets, t0 });
  const dir = path.join(ROOT, "tournament", "reports");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${today()}${REPORT_SUFFIX}.md`);
  fs.writeFileSync(file, report, "utf8");
  console.log(`\n战报已写入: ${file}`);

  // ---------- 机读记录（供 A/B 统计；不参与展示）----------
  const jsonPath = path.join(dir, `${today()}${REPORT_SUFFIX}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify({
    date: today(), suffix: REPORT_SUFFIX || "",
    settings: {
      size: SIZE, gamesPerPair: GAMES_PER_PAIR, openingPlies: OPENING_PLIES,
      movesCap: MOVES_CAP, openingsMode: (process.env.OPENINGS || "random"),
      modelPath: (process.env.OPENINGS || "").toLowerCase() === "markov"
        ? (process.env.MARKOV_MODEL || "spec/markov_model.json") : null,
      engines: specs.map((s) => ({ key: s.key, name: s.name, playouts: budgets.get(s.key) })),
      filter: FILTER,
    },
    games: games.map((g) => ({
      gno: g.gno, black: g.black, white: g.white, winner: g.winner,
      result: g.result, moves: g.moves, anomaly: g.anomaly || null,
    })),
    stats: Object.fromEntries([...stats.entries()].map(([k, v]) => [k, { ...v }])),
    divergence,
  }, null, 1) + "\n", "utf8");
  console.log(`机读记录: ${jsonPath}`);

  // ---------- 交叉表摘要 ----------
  console.log("\n交叉表（行=黑胜/白胜合并计入胜负）:");
  const keys = specs.map((s) => s.key);
  console.log("      " + keys.map((k) => k.padStart(5)).join(""));
  for (const a of keys) {
    let row = a.padEnd(5) + " ";
    for (const b of keys) {
      if (a === b) { row += "    -"; continue; }
      const sa = stats.get(a);
      let w = 0;
      let l = 0;
      for (const gm of games) {
        if ((gm.black === a && gm.white === b && gm.winner === a) ||
            (gm.black === b && gm.white === a && gm.winner === a)) w++;
        if ((gm.black === a && gm.white === b && gm.winner === b) ||
            (gm.black === b && gm.white === a && gm.winner === b)) l++;
      }
      row += `  ${w}-${l}`;
    }
    console.log(row);
  }
  console.log(`\n总耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

async function playGame(gno, blackSpec, whiteSpec, clients, budgets, stats, divergence) {
  const ref = new Ref(SIZE, 7.5, "cn");
  const seedBase = 1000 * gno + 7;
  let anomaly = null;
  let plies = 0;
  const moves = [];
  // 每局重置双方引擎状态（棋盘/规则/贴目必须与裁判一致）
  for (const spec of [blackSpec, whiteSpec]) {
    await clients.get(spec.key).must("clear", { size: SIZE, komi: 7.5, rules: "cn" });
  }
  const opening = openingLine(SIZE, OPENING_PLIES, seedBase);
  for (const mv of opening) {
    const r = ref.play(parseColor(mv.color), parseVertex(mv.vertex, SIZE));
    if (!r.ok) break;
    // 开局线双方都需要被告知（genmove 之外的着法一律同步）
    for (const spec of [blackSpec, whiteSpec]) {
      await clients.get(spec.key).must("play", { color: mv.color, vertex: mv.vertex });
    }
    moves.push(mv);
    plies++;
  }

  let winnerKey = null;
  let result = "";
  while (!ref.over && plies < MOVES_CAP) {
    const color = ref.side === 1 ? "B" : "W";
    const spec = ref.side === 1 ? blackSpec : whiteSpec;
    const st = stats.get(spec.key);
    const client = clients.get(spec.key);
    let mv;
    try {
      const res = await client.must("genmove", {
        color,
        playouts: budgets.get(spec.key),
        seed: seedBase + plies * 131,
        profile: PROFILE,
      });
      mv = res.vertex;
      st.genmoves++;
      st.visits += res.visits || 0;
      st.winrate += res.winrate || 0;
      if (plies === OPENING_PLIES) {
        divergence.push({ ply: plies, engine: spec.key, vertex: res.vertex, visits: res.visits });
      }
    } catch (e) {
      st.illegal++;
      if (String(e.message).includes("超时")) st.timeout++;
      st.crash++;
      anomaly = `${spec.key} 引擎错误: ${e.message}`;
      winnerKey = spec.key === blackSpec.key ? whiteSpec.key : blackSpec.key;
      result = `${winnerKey === blackSpec.key ? "B" : "W"}+R`;
      return { gno, black: blackSpec.key, white: whiteSpec.key, winner: winnerKey, result, moves: plies, anomaly, movesTail: tail(moves) };
    }
    if (mv === "resign") {
      winnerKey = spec.key === blackSpec.key ? whiteSpec.key : blackSpec.key;
      result = (winnerKey === blackSpec.key ? "B" : "W") + "+R";
      return { gno, black: blackSpec.key, white: whiteSpec.key, winner: winnerKey, result, moves: plies, anomaly, movesTail: tail(moves) };
    }
    const vertex = mv === "pass" ? -1 : parseVertex(mv, SIZE);
    const r = ref.play(parseColor(color), vertex);
    if (!r.ok) {
      st.illegal++;
      anomaly = `${spec.key} 非法着法 ${mv} (${r.reason})`;
      winnerKey = spec.key === blackSpec.key ? whiteSpec.key : blackSpec.key;
      result = `${winnerKey === blackSpec.key ? "B" : "W"}+F`;
      return { gno, black: blackSpec.key, white: whiteSpec.key, winner: winnerKey, result, moves: plies, anomaly, movesTail: tail(moves) };
    }
    moves.push({ color, vertex: mv });
    if (vertex === -1) st.moves += 0;
    else st.moves++;
    plies++;
    // 对手侧同步：行棋方经 genmove 已自行落子，另一方需显式 play
    const other = ref.side === 1 ? blackSpec : whiteSpec;
    try {
      await clients.get(other.key).must("play", { color, vertex: mv });
    } catch (e) {
      const ost = stats.get(other.key);
      ost.illegal++;
      ost.crash++;
      anomaly = `${other.key} 同步 play 失败: ${e.message}`;
      winnerKey = other.key === blackSpec.key ? whiteSpec.key : blackSpec.key;
      result = `${winnerKey === blackSpec.key ? "B" : "W"}+F`;
      return { gno, black: blackSpec.key, white: whiteSpec.key, winner: winnerKey,
        result, moves: plies, anomaly, movesTail: tail(moves) };
    }
  }

  const sc = ref.score();
  const winnerIsBlack = sc.result.startsWith("B+");
  const winnerIsWhite = sc.result.startsWith("W+");
  if (winnerIsBlack) winnerKey = blackSpec.key;
  else if (winnerIsWhite) winnerKey = whiteSpec.key;
  else winnerKey = null;
  result = sc.result;
  if (plies >= MOVES_CAP) {
    anomaly = `达到手数上限 ${MOVES_CAP}（按现状计分）`;
  }
  return { gno, black: blackSpec.key, white: whiteSpec.key, winner: winnerKey, result,
    moves: plies, anomaly, movesTail: tail(moves), score: sc };
}

function tail(moves, n = 6) {
  return moves.slice(-n).map((m) => `${m.color}${m.vertex === -1 ? "pass" : m.vertex}`).join(" ");
}

function renderReport({ specs, stats, games, divergence, budgets, t0 }) {
  const L = [];
  L.push(`# weiqi_lab 循环赛战报 — ${today()}`);
  L.push("");
  L.push("## 设置");
  L.push("");
  L.push(`- 棋盘：${SIZE}×${SIZE}；规则：cn（数子 + 位置禁全同 + 禁自杀）；komi 7.5`);
  L.push(`- 每对局数：${GAMES_PER_PAIR}；开局库手数：${OPENING_PLIES}（随机开局，Tier 1）`);
  L.push(`- 手数上限：${MOVES_CAP}；裁判：\`tournament/referee.mjs\`（独立实现）`);
  L.push(`- 固定算力预算（playouts/手，按各引擎实测速度折算 ≈1s/手）：`);
  L.push("");
  L.push("| 引擎 | 语言 | playouts/手 |");
  L.push("|---|---|---|");
  for (const s of specs) L.push(`| ${s.name} | ${s.lang} | ${budgets.get(s.key)} |`);
  L.push("");
  L.push("## 交叉表（胜-负）");
  L.push("");
  const keys = specs.map((s) => s.key);
  L.push("| 引擎 \\ 对手 | " + keys.join(" | ") + " |");
  L.push("|---" + "|---".repeat(keys.length) + "|");
  for (const a of keys) {
    const cells = keys.map((b) => {
      if (a === b) return "—";
      let w = 0;
      let l = 0;
      for (const gm of games) {
        if ((gm.black === a && gm.white === b && gm.winner === a) ||
            (gm.black === b && gm.white === a && gm.winner === a)) w++;
        if ((gm.black === a && gm.white === b && gm.winner === b) ||
            (gm.black === b && gm.white === a && gm.winner === b)) l++;
      }
      return `${w}-${l}`;
    });
    L.push(`| **${a}** | ${cells.join(" | ")} |`);
  }
  L.push("");
  L.push("## 逐局结果");
  L.push("");
  L.push("| # | 黑 | 白 | 结果 | 手数 | 尾盘 | 异常 |");
  L.push("|---|---|---|---|---|---|---|");
  for (const g of games) {
    L.push(`| ${g.gno} | ${g.black} | ${g.white} | ${g.result} | ${g.moves} | ${g.movesTail || ""} | ${g.anomaly || ""} |`);
  }
  L.push("");
  L.push("## 引擎统计");
  L.push("");
  L.push("| 引擎 | 胜 | 负 | 和 | 落子数 | 平均访问/手 | 平均估值 | 非法/错误 |");
  L.push("|---|---|---|---|---|---|---|---|");
  for (const s of specs) {
    const st = stats.get(s.key);
    const avgV = st.genmoves ? (st.visits / st.genmoves).toFixed(0) : "-";
    const avgW = st.genmoves ? (st.winrate / st.genmoves).toFixed(3) : "-";
    L.push(`| ${st.name} | ${st.wins} | ${st.losses} | ${st.draws} | ${st.moves} | ${avgV} | ${avgW} | ${st.illegal} |`);
  }
  L.push("");
  L.push("## 走法分歧（同一局面下不同引擎的首手中盘选择）");
  L.push("");
  if (!divergence.length) {
    L.push("（本次无样本：需 ≥2 个引擎且开局手数一致）");
  } else {
    const byEngine = new Map();
    for (const d of divergence) {
      if (!byEngine.has(d.engine)) byEngine.set(d.engine, []);
      byEngine.get(d.engine).push(d);
    }
    const uniq = new Set(divergence.map((d) => d.vertex));
    L.push(`- 样本：${divergence.length} 手（引擎 × 该手局面）`);
    L.push(`- 不同选点：${uniq.size} 个 → 选点分歧率 ${(1 - (divergence.length ? (divergence.length - uniq.size + 1) / divergence.length : 0)).toFixed(3)}（近似，供跨期对比）`);
    L.push("");
    L.push("| 引擎 | 选点 | 访问数 |");
    L.push("|---|---|---|");
    for (const d of divergence) L.push(`| ${d.engine} | ${d.vertex} | ${d.visits} |`);
  }
  L.push("");
  L.push(`> 生成耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s；由 \`tournament/run_tournament.mjs\` 自动生成。`);
  return L.join("\n") + "\n";
}

main().catch((e) => {
  console.error("循环赛异常:", e);
  process.exit(2);
});
