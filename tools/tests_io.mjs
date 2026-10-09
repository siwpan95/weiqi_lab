// tools/tests_io.mjs — I/O 层自测（零依赖）
//
//   node tools/tests_io.mjs
//   → 末行输出 "PASS: N passed, 0 failed"（有失败则 "FAIL: ..." 并退出码 1）
//
// 覆盖：SGF 往返/坐标翻转/pass/AB-AW-AE-HA-PL-KM 映射/转义/变体；
//       GTP 握手/list_commands/fixed_handicap 各尺寸坐标表/showboard 形状；
//       让子星位表（GTP v2 §4.1.1）逐尺寸快照。

import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
  parseSgf, serializeSgf, toCommands, sgfToVertex, vertexToSgf,
} from "./sgf.mjs";
import { fixedHandicapVertices, handicapMax, handicapEdgeDistance } from "./gtp.mjs";
import { GtpClient } from "./regress.mjs";
import { ROOT } from "../harness/engines.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

let passed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) passed++;
  else failures.push(`${name}${detail ? " — " + detail : ""}`);
}
function stable(v) {
  if (Array.isArray(v)) return "[" + v.map(stable).join(",") + "]";
  if (v && typeof v === "object") {
    return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + stable(v[k])).join(",") + "}";
  }
  return JSON.stringify(v);
}
function eq(name, got, want) {
  check(name, stable(got) === stable(want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
}

// ─────────────────────────── SGF ───────────────────────────

function testSgf() {
  // 1. 坐标翻转（SGF 自上而下 ↔ 引擎自下而上）
  eq("sgf.yflip dd→D16", sgfToVertex("dd", 19), "D16");
  eq("sgf.yflip as→A1", sgfToVertex("as", 19), "A1");
  eq("sgf.yflip sa→T19", sgfToVertex("sa", 19), "T19");
  eq("sgf.inv A1→as", vertexToSgf("A1", 19), "as");
  eq("sgf.inv D16→dd", vertexToSgf("D16", 19), "dd");
  eq("sgf.inv T19→sa", vertexToSgf("T19", 19), "sa");
  eq("sgf.inv pass→''", vertexToSgf("pass", 19), "");

  // 2. pass：空值 与 遗留 tt
  eq("sgf.pass empty", sgfToVertex("", 19), "pass");
  eq("sgf.pass tt(19)", sgfToVertex("tt", 19), "pass");
  eq("sgf.pass tt(9)", sgfToVertex("tt", 9), "pass");

  // 3. 往返：parse → serialize → parse 稳定
  const src = "(;GM[1]FF[4]CA[UTF-8]SZ[9]KM[7.5]HA[2]PL[W]AB[cg][gg]AW[cc]C[hi\\]there\nline2];B[ee];W[];B[tt];W[dd])";
  const t1 = parseSgf(src);
  const s1 = serializeSgf(t1);
  const t2 = parseSgf(s1);
  eq("sgf.roundtrip stable", JSON.stringify(t2), JSON.stringify(t1));
  eq("sgf.roundtrip text2 stable", serializeSgf(t2), s1);

  // 4. 转义与空白折叠（Text 保留换行；SimpleText 折叠）
  eq("sgf.escape ]", t1.root.C[0], "hi]there\nline2");
  const ws = parseSgf("(;GM[1]FF[4]SZ[9]PB[  a   b  ]C[ x\n\ny ])");
  eq("sgf.simpletext fold", ws.root.PB[0], "a b");
  eq("sgf.text keep nl", ws.root.C[0], "x\n\ny");

  // 5. toCommands：SZ/KM/HA/PL/AB/AW + y 翻转 + pass
  //    9 路 SGF 字母 a..i（列 A..J），行字母序 = 9-row（a=第 9 行）
  //    C7→"cc"  G7→"gc"  E5→"ee"  F4→"ff"
  const tree = parseSgf("(;GM[1]FF[4]SZ[9]KM[0.5]HA[2]PL[W]AB[cc][gc];B[ee];W[];B[ff])");
  const cmds = toCommands(tree);
  eq("sgf.cmd clear", cmds[0], { cmd: "clear", size: 9, komi: 0.5, rules: "cn" });
  eq("sgf.cmd set_stones", cmds[1], { cmd: "set_stones", stones: [["B", "C7"], ["B", "G7"]], side: "W" });
  eq("sgf.cmd play1", cmds[2], { cmd: "play", color: "B", vertex: "E5" });
  eq("sgf.cmd pass", cmds[3], { cmd: "play", color: "W", vertex: "pass" });
  eq("sgf.cmd play3", cmds[4], { cmd: "play", color: "B", vertex: "F4" });
  // 19 路星位字面值（对照 GTP §4.1.1：D4/Q16/D16/Q4/K10 → SGF dp/pd/dd/pp/jj）
  eq("sgf.19 D4", sgfToVertex("dp", 19), "D4");
  eq("sgf.19 Q16", sgfToVertex("pd", 19), "Q16");
  eq("sgf.19 Q4", sgfToVertex("pp", 19), "Q4");
  eq("sgf.19 K10", sgfToVertex("jj", 19), "K10");

  // 6. PL 缺省：HA>=2 → 白先；无 HA → 黑先
  eq("sgf.pl ha2→W", toCommands(parseSgf("(;GM[1]FF[4]SZ[9]HA[2]AB[cg][gg])"))[1].side, "W");
  eq("sgf.pl none→B", toCommands(parseSgf("(;GM[1]FF[4]SZ[9];B[ee])"))[1].color, "B");
  eq("sgf.pl plB no setup", toCommands(parseSgf("(;GM[1]FF[4]SZ[9]PL[B];B[ee])")).length, 2);

  // 7. AE 移除不被放入（cc=C7 被 AE 移除）
  const ae = toCommands(parseSgf("(;GM[1]FF[4]SZ[9]AB[cc][gc]AW[ee]AE[cc])"));
  eq("sgf.ae removes", ae[1].stones, [["B", "G7"], ["W", "E5"]]);

  // 8. 变体解析（只保留主线）
  const v = parseSgf("(;GM[1]FF[4]SZ[9];B[c3](;W[g7];B[e5])(;W[g3]))");
  eq("sgf.variation mainline", v.nodes.map((n) => n.color + n.value), ["Bc3", "Wg7", "Be5"]);
  check("sgf.variation counted", v.stats.variations >= 1, `got ${v.stats.variations}`);

  // 9. upTo（loadsgf 的 move number）
  const up = parseSgf("(;GM[1]FF[4]SZ[9];B[ee];W[];B[ff])");
  eq("sgf.upTo=1", toCommands(up, { upTo: 1 }).filter((c) => c.cmd === "play").length, 1);
}

// ─────────────────────────── 让子星位表（GTP v2 §4.1.1）───────────────────────────

const HANDICAP_EXPECT = {
  9: {
    2: ["C3", "G7"], 3: ["C3", "G7", "C7"], 4: ["C3", "G7", "C7", "G3"],
    5: ["C3", "G7", "C7", "G3", "E5"],
    6: ["C3", "G7", "C7", "G3", "C5", "G5"],
    7: ["C3", "G7", "C7", "G3", "C5", "G5", "E5"],
    8: ["C3", "G7", "C7", "G3", "C5", "G5", "E3", "E7"],
    9: ["C3", "G7", "C7", "G3", "C5", "G5", "E3", "E7", "E5"],
  },
  13: {
    2: ["D4", "K10"], 3: ["D4", "K10", "D10"], 4: ["D4", "K10", "D10", "K4"],
    5: ["D4", "K10", "D10", "K4", "G7"],
    6: ["D4", "K10", "D10", "K4", "D7", "K7"],
    7: ["D4", "K10", "D10", "K4", "D7", "K7", "G7"],
    8: ["D4", "K10", "D10", "K4", "D7", "K7", "G4", "G10"],
    9: ["D4", "K10", "D10", "K4", "D7", "K7", "G4", "G10", "G7"],
  },
  19: {
    2: ["D4", "Q16"], 3: ["D4", "Q16", "D16"], 4: ["D4", "Q16", "D16", "Q4"],
    5: ["D4", "Q16", "D16", "Q4", "K10"],
    6: ["D4", "Q16", "D16", "Q4", "D10", "Q10"],
    7: ["D4", "Q16", "D16", "Q4", "D10", "Q10", "K10"],
    8: ["D4", "Q16", "D16", "Q4", "D10", "Q10", "K4", "K16"],
    9: ["D4", "Q16", "D16", "Q4", "D10", "Q10", "K4", "K16", "K10"],
  },
};

function testHandicapTable() {
  for (const size of [9, 13, 19]) {
    for (let n = 2; n <= 9; n++) {
      eq(`handicap.${size}.${n}`, fixedHandicapVertices(size, n), HANDICAP_EXPECT[size][n]);
    }
  }
  // 最大子数 / 边距（§4.1.1 表）
  eq("handicap.max 6", handicapMax(6), 0);
  eq("handicap.max 7", handicapMax(7), 4);
  eq("handicap.max 8", handicapMax(8), 4);
  eq("handicap.max 12", handicapMax(12), 4);
  eq("handicap.max 13", handicapMax(13), 9);
  eq("handicap.max 19", handicapMax(19), 9);
  eq("handicap.max 24", handicapMax(24), 4);
  eq("handicap.max 25", handicapMax(25), 9);
  eq("handicap.edge 12", handicapEdgeDistance(12), 3);
  eq("handicap.edge 13", handicapEdgeDistance(13), 4);
  // 越界应抛错
  let threw = false;
  try { fixedHandicapVertices(9, 10); } catch { threw = true; }
  check("handicap.n>max throws", threw);
  threw = false;
  try { fixedHandicapVertices(9, 1); } catch { threw = true; }
  check("handicap.n<2 throws", threw);
}

// ─────────────────────────── GTP（活体）───────────────────────────

async function testGtpLive() {
  const dir = path.join(ROOT, "spec", "regress");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const cli = new GtpClient("js", { cwd: dir, env: { WEIQI_GTP_PLAYOUTS: "64" } });
  try {
    const pv = await cli.send("protocol_version");
    eq("gtp.protocol_version", pv.text.trim(), "2");

    const nm = await cli.send("name");
    check("gtp.name non-empty", nm.ok && nm.text.trim().length > 0, JSON.stringify(nm));

    const lc = await cli.send("list_commands");
    const list = lc.text.split("\n").map((s) => s.trim()).filter(Boolean);
    for (const need of ["protocol_version", "name", "version", "known_command", "list_commands",
      "quit", "boardsize", "clear_board", "komi", "play", "genmove", "undo", "showboard",
      "fixed_handicap", "place_free_handicap", "set_free_handicap", "time_settings", "time_left",
      "cputime", "final_score", "final_status_list", "loadsgf", "printsgf", "reg_genmove"]) {
      check(`gtp.list_commands has ${need}`, list.includes(need));
    }
    const known = await cli.send("known_command genmove");
    eq("gtp.known_command genmove", known.text.trim(), "true");
    const unknown = await cli.send("known_command not_a_command");
    eq("gtp.known_command bogus", unknown.text.trim(), "false");

    // 失败格式
    const bad = await cli.send("boardsize 99");
    check("gtp.boardsize 99 fails", bad.ok === false && bad.text.trim() === "unacceptable size", JSON.stringify(bad));
    const badcmd = await cli.send("frobnicate");
    check("gtp.unknown cmd fails", badcmd.ok === false && /unknown command/.test(badcmd.text), JSON.stringify(badcmd));

    // 各尺寸 fixed_handicap 坐标表（含 9/13/19 的 N=2..max）
    for (const size of [9, 13, 19]) {
      await cli.send(`boardsize ${size}`);
      await cli.send("clear_board");
      const max = size === 9 ? 9 : 9;
      for (let n = 2; n <= max; n++) {
        const r = await cli.send(`fixed_handicap ${n}`);
        eq(`gtp.fixed_handicap ${size} ${n}`, r.text.trim().split(/\s+/), HANDICAP_EXPECT[size][n]);
        // 让子后不得再有第二次（盘非空）
        const again = await cli.send(`fixed_handicap ${n}`);
        check(`gtp.fixed_handicap ${size} 盘非空拒绝`, again.ok === false, JSON.stringify(again));
        await cli.send("clear_board");
      }
    }

    // showboard 形状
    await cli.send("boardsize 9");
    await cli.send("clear_board");
    await cli.send("fixed_handicap 5");
    const sb = await cli.send("showboard");
    const lines = sb.text.split("\n");
    check("gtp.showboard lines == size+2", lines.length === 11, `got ${lines.length}`);
    check("gtp.showboard header", lines[0].trim() === "A B C D E F G H J", JSON.stringify(lines[0]));
    check("gtp.showboard footer", lines[lines.length - 1].trim() === "A B C D E F G H J", JSON.stringify(lines[lines.length - 1]));
    check("gtp.showboard row7 has X", /^\s*7 .*X/.test(lines[3]), JSON.stringify(lines[3]));
    check("gtp.showboard 5 stones", (sb.text.match(/X/g) || []).length === 5, `X count=${(sb.text.match(/X/g) || []).length}`);

    // play/undo/genmove/final_score/printsgf 冒烟
    await cli.send("clear_board");
    const p1 = await cli.send("play black E5");
    check("gtp.play ok", p1.ok, JSON.stringify(p1));
    const p2 = await cli.send("play black C3");
    check("gtp.play wrong color fails(illegal)", p2.ok === false, JSON.stringify(p2));
    const u1 = await cli.send("undo");
    check("gtp.undo ok", u1.ok, JSON.stringify(u1));
    const gm = await cli.send("genmove black");
    check("gtp.genmove returns vertex", gm.ok && /^([A-T][0-9]{1,2}|pass|resign)$/.test(gm.text.trim()), JSON.stringify(gm));
    const rg = await cli.send("reg_genmove white");
    check("gtp.reg_genmove returns vertex", rg.ok && /^([A-T][0-9]{1,2}|pass|resign)$/.test(rg.text.trim()), JSON.stringify(rg));
    const fs1 = await cli.send("final_score");
    check("gtp.final_score SGF RE", /^(B\+|W\+|0)/.test(fs1.text.trim()), JSON.stringify(fs1));
    const cp = await cli.send("cputime");
    check("gtp.cputime numeric", /^[0-9]+\.[0-9]+$/.test(cp.text.trim()), JSON.stringify(cp));
    const ts = await cli.send("time_settings 0 10 5");
    check("gtp.time_settings no-op ok", ts.ok, JSON.stringify(ts));
    const tl = await cli.send("time_left black 10 0");
    check("gtp.time_left no-op ok", tl.ok, JSON.stringify(tl));

    const ps = await cli.send("printsgf");
    let ok = true;
    try { parseSgf(ps.text.trim()); } catch { ok = false; }
    check("gtp.printsgf parseable", ok, ps.text.slice(0, 80));

    // komi
    await cli.send("boardsize 9");
    await cli.send("clear_board");
    const km = await cli.send("komi 5.5");
    check("gtp.komi ok", km.ok, JSON.stringify(km));

    // place_free_handicap / set_free_handicap
    await cli.send("clear_board");
    const pf = await cli.send("place_free_handicap 4");
    eq("gtp.place_free_handicap 4", pf.text.trim().split(/\s+/), HANDICAP_EXPECT[9][4]);
    await cli.send("clear_board");
    const sf = await cli.send("set_free_handicap D4 F4 D6");
    check("gtp.set_free_handicap ok", sf.ok, JSON.stringify(sf));

    // final_status_list
    const alive = await cli.send("final_status_list alive");
    check("gtp.final_status_list alive ok", alive.ok, JSON.stringify(alive));
    const weird = await cli.send("final_status_list dame");
    check("gtp.final_status_list dame fails", weird.ok === false, JSON.stringify(weird));
  } finally {
    await cli.quit();
  }
}

// ─────────────────────────── main ───────────────────────────

async function main() {
  testSgf();
  testHandicapTable();
  await testGtpLive();
  for (const f of failures) process.stdout.write("  FAIL " + f + "\n");
  if (failures.length === 0) {
    process.stdout.write(`PASS: ${passed} passed, 0 failed\n`);
    return 0;
  }
  process.stdout.write(`FAIL: ${passed} passed, ${failures.length} failed\n`);
  return 1;
}

const code = await main();
process.exit(code);
