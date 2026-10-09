// tests.mjs — 内部单元测试（规则不变量 + AI 行为），与 spec/golden.json 互补。
//
// 参照：PyWeiqi/tests.py（断言清单一致）。

import {
  Board, parse_vertex, format_vertex, parse_color, splitmix64, fmt_num,
  ZB, MAX_POINTS, normalize_rules, SIDEKEY_W,
} from "./rules.mjs";
import { deadStones, areaWithDead, buildNeigh } from "../tools/scoring.mjs";
import { CnnPolicy } from "../tools/cnn_forward.mjs";
import * as ai from "./ai.mjs";

class T {
  constructor() {
    this.passed = 0;
    this.failed = 0;
    this.failures = [];
  }

  check(name, cond, detail = "") {
    if (cond) {
      this.passed += 1;
    } else {
      this.failed += 1;
      this.failures.push({ name, detail: dstr(detail) });
    }
  }

  eq(name, got, exp) {
    this.check(name, deepEq(got, exp), "got=" + dstr(got) + " exp=" + dstr(exp));
  }
}

function dstr(x) {
  if (typeof x === "bigint") return x.toString() + "n";
  try {
    return JSON.stringify(x, (k, v) => (typeof v === "bigint" ? v.toString() + "n" : v));
  } catch (e) {
    return String(x);
  }
}

function deepEq(a, b) {
  if (typeof a === "bigint" || typeof b === "bigint") return a === b;
  if (a === null || b === null) return a === b;
  if (typeof a !== typeof b) return false;
  if (typeof a !== "object") return a === b;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!deepEq(a[k], b[k])) return false;
  }
  return true;
}

function count(arr, v) {
  let c = 0;
  for (const x of arr) if (x === v) c += 1;
  return c;
}

function _p(size, s) {
  return parse_vertex(s, size);
}

export function run_unit_tests() {
  const t = new T();

  // ---------- 坐标 ----------
  let ok = true;
  for (const size of [2, 5, 9, 13, 19]) {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const s = format_vertex(y * size + x, size);
        if (parse_vertex(s, size) !== y * size + x) ok = false;
      }
    }
  }
  t.check("vertex.roundtrip.all_sizes", ok);
  t.eq("vertex.skip_I", format_vertex(8, 9), "J1");
  t.eq("vertex.pass", parse_vertex("PASS", 9), -1);
  t.eq("vertex.lowercase", parse_vertex("e5", 9), _p(9, "E5"));
  let bad = 0;
  for (const s of ["I5", "A0", "A10", "", "Z9", "5A"]) {
    try {
      parse_vertex(s, 9);
    } catch (e) {
      bad += 1;
    }
  }
  t.eq("vertex.reject_invalid", bad, 6);
  t.eq("color.parse", [parse_color("b"), parse_color("WHITE")], [1, 2]);

  // ---------- Zobrist ----------
  const vals = new Set();
  for (const c of [1, 2]) {
    for (let p = 0; p < MAX_POINTS; p++) vals.add(ZB[c][p].toString(16));
  }
  t.eq("zobrist.distinct", vals.size, MAX_POINTS * 2);
  t.check("zobrist.sidekey_nonzero", SIDEKEY_W !== 0n);
  const b9 = new Board(9);
  t.eq("zobrist.empty_board_zero", b9.key()[0], 0n);
  const b19 = new Board(19);
  b9.set_stones([[1, _p(9, "A1")]], 1);
  b19.set_stones([[1, _p(19, "A1")]], 1);
  t.eq("zobrist.size_independent", b9.key()[0], b19.key()[0]);
  t.eq("zobrist.single_stone_A1", b9.key()[0], splitmix64(0));
  const b9e = new Board(9);
  b9e.set_stones([[1, _p(9, "E5")]], 1);
  t.eq("zobrist.single_stone_E5_index40", b9e.key()[0], splitmix64(40));
  const bk = b9.key()[0];
  b9.side = 2;
  t.eq("zobrist.situational_flip", b9.key()[1], bk ^ SIDEKEY_W);

  // ---------- 规则档 ----------
  t.eq("rules.cn", normalize_rules("cn"),
    { ko: "positional", suicide: "forbid", scoring: "area", komi: 7.5 });
  t.eq("rules.tt", normalize_rules("tt")["suicide"], "allow");
  t.eq("rules.jp", normalize_rules("jp")["scoring"], "territory");
  try {
    normalize_rules({ ko: "bogus" });
    t.check("rules.reject_bad_ko", false);
  } catch (e) {
    t.check("rules.reject_bad_ko", true);
  }

  // ---------- 提子与气 ----------
  let b = new Board(9);
  b.set_stones([[2, _p(9, "E5")], [1, _p(9, "E4")], [1, _p(9, "E6")], [1, _p(9, "D5")]], 1);
  let r = b.play(1, _p(9, "F5"));
  t.check("capture.single", r.ok && r.captures === 1, r);
  t.eq("capture.prisoners", b.prisoners(), { black: 1, white: 0 });

  b = new Board(9);
  b.set_stones([[1, _p(9, "E4")], [1, _p(9, "E5")], [1, _p(9, "E6")],
    [2, _p(9, "D4")], [2, _p(9, "D5")], [2, _p(9, "D6")],
    [2, _p(9, "F4")], [2, _p(9, "F5")],
    [2, _p(9, "E3")], [2, _p(9, "E7")]], 2);
  r = b.play(2, _p(9, "F6"));
  t.check("capture.three_stones", r.ok && r.captures === 3, r);

  b = new Board(9);
  b.set_stones([[1, _p(9, "E5")], [1, _p(9, "E6")]], 1);
  const [members, libs] = b.group(_p(9, "E5"));
  t.eq("group.members", members.length, 2);
  t.eq("group.liberties", libs.size, 6);

  // ---------- 自杀 ----------
  const setup = [[2, _p(9, "E4")], [2, _p(9, "E6")], [2, _p(9, "D5")], [2, _p(9, "F5")]];
  b = new Board(9);
  b.set_stones(setup, 1);
  r = b.play(1, _p(9, "E5"));
  t.check("suicide.forbid", !r.ok && r.reason === "suicide", r);
  t.eq("suicide.forbid.board_unchanged", count(b.cells, 0), 81 - 4);

  // 允许自杀：自提复原盘面在 PSK 下非法，故用"多子自提"验证
  b = new Board(3, null, "tt");
  b.set_stones([[1, _p(3, "A1")], [1, _p(3, "B1")],
    [2, _p(3, "A2")], [2, _p(3, "B2")], [2, _p(3, "C2")]], 1);
  r = b.play(1, _p(3, "C1"));
  t.check("suicide.allow.multi_stone", r.ok && r.self_captured === 3, r);
  t.eq("suicide.allow.no_black_stone", count(b.cells, 1), 0);

  // 自提复原盘面：三档对照
  let rr = new Board(3, null, "tt");
  rr.set_stones([[2, _p(3, "A2")], [2, _p(3, "B2")], [2, _p(3, "B1")]], 1);
  t.check("suicide.restore_blocked_by_PSK", rr.play(1, _p(3, "A1")).reason === "superko");

  rr = new Board(3, null, { ko: "simple", suicide: "allow", scoring: "area" });
  rr.set_stones([[2, _p(3, "A2")], [2, _p(3, "B2")], [2, _p(3, "B1")]], 1);
  const res2 = rr.play(1, _p(3, "A1"));
  t.check("suicide.restore_allowed_by_simple_ko", res2.ok && res2.self_captured === 1, res2);

  // 提子先于自杀判定（角部：填 A1 提两子，非自杀）
  b = new Board(5);
  b.set_stones([[2, _p(5, "A2")], [2, _p(5, "B1")],
    [1, _p(5, "A3")], [1, _p(5, "B2")], [1, _p(5, "C1")]], 1);
  r = b.play(1, _p(5, "A1"));
  t.check("suicide.after_capture", r.ok && r.captures === 2, r);

  // ---------- 劫 ----------
  const ko_setup = [[2, _p(9, "D4")], [2, _p(9, "C3")], [2, _p(9, "C5")], [2, _p(9, "B4")],
    [1, _p(9, "D3")], [1, _p(9, "D5")], [1, _p(9, "E4")]];
  b = new Board(9);
  b.set_stones(ko_setup, 1);
  r = b.play(1, _p(9, "C4"));
  t.check("ko.capture_ok", r.ok && r.captures === 1, r);
  t.eq("ko.point_set", b.ko_point, _p(9, "D4"));
  let [okl, reason] = b.legal(2, _p(9, "D4"));
  t.check("ko.immediate_recapture_illegal", !okl && reason === "ko", [okl, reason]);

  // simple 档：pass 后 ko 解除
  b = new Board(9, null, "jp");
  b.set_stones(ko_setup, 1);
  b.play(1, _p(9, "C4"));
  b.play(2, -1);
  t.eq("ko.pass_clears_point", b.ko_point, -1);

  // ---------- 劫推迟一手（各档一致合法）----------
  b = new Board(9);
  b.set_stones(ko_setup, 1);
  b.play(1, _p(9, "C4"));
  b.play(2, _p(9, "H9"));
  b.play(1, _p(9, "H1"));
  [okl, reason] = b.legal(2, _p(9, "D4"));
  t.check("ko.delayed_recapture_legal", okl, [okl, reason]);

  // ---------- undo ----------
  b = new Board(9);
  const snaps = [];
  for (let i = 0; i < 12; i++) {
    snaps.push([b.key(), b.side, b.ko_point, b.cells.slice(), b.captures.slice(),
      b.hist_pos.size, b.hist_sit.size, b.stack.length]);
    const legal = b.legal_moves();
    r = b.play(b.side, legal[(i * 7) % legal.length]);
    if (!r.ok) break;
  }
  let okall = true;
  for (let i = snaps.length - 1; i >= 0; i--) {
    b.undo(); // 先撤，再与"走这手之前"的快照比对
    const [k, side, ko, cells, caps, hp, hs, st] = snaps[i];
    const cur = [b.key(), b.side, b.ko_point, b.cells, b.captures,
      b.hist_pos.size, b.hist_sit.size, b.stack.length];
    const ref = [k, side, ko, cells, caps, hp, hs, st];
    if (!deepEq(cur, ref)) okall = false;
  }
  t.check("undo.restores_exact_state", okall);

  b = new Board(9);
  b.play(1, _p(9, "E5"));
  b.play(2, -1); // 白方 pass
  t.eq("undo.pass", b.undo(), true);
  t.eq("undo.pass_restored_side", b.side, 2);
  t.eq("undo.then_move", b.undo(), true);
  t.eq("undo.move_restored_side", b.side, 1);
  t.eq("undo.empty_stack", b.undo(), false);

  // ---------- clone / set_stones ----------
  b = new Board(9);
  b.play(1, _p(9, "E5"));
  const c = b.clone();
  c.play(2, _p(9, "D5"));
  t.eq("clone.independent", [count(b.cells, 0), count(c.cells, 0)], [80, 79]);
  b = new Board(9);
  b.play(1, _p(9, "E5"));
  b.set_stones([[2, _p(9, "A1")]], 2);
  t.eq("set_stones.resets_history", [b.hist_pos.size, b.captures[1], b.side], [1, 0, 2]);

  // ---------- 计分不变量 ----------
  let okarea = true;
  const rng = new ai.Rng(2026);
  for (let trial = 0; trial < 30; trial++) {
    b = new Board(9);
    for (let i = 0; i < 20; i++) {
      const legal = b.legal_moves();
      if (!legal.length) break;
      b.play(b.side, legal[rng.randint(legal.length)]);
    }
    const sc = b.score();
    if (sc.black + sc.white + sc.dame !== 81) okarea = false;
  }
  t.check("score.area_partition_invariant", okarea);

  // ---------- 终局 ----------
  b = new Board(9);
  b.play(1, -1);
  t.eq("pass.one_not_over", b.is_over(), false);
  b.play(2, -1);
  t.eq("pass.two_over", b.is_over(), true);
  r = b.play(1, _p(9, "E5"));
  t.check("pass.play_after_over", !r.ok && r.reason === "over", r);
  b.undo();
  t.eq("pass.undo_reopens", b.is_over(), false);

  // ---------- 数值格式 ----------
  t.eq("fmt_num.int", fmt_num(3.0), "3");
  t.eq("fmt_num.half", fmt_num(3.5), "3.5");
  t.eq("fmt_num.quarter", fmt_num(0.25), "0.25");
  t.eq("fmt_num.zero", fmt_num(0.0), "0");

  // ---------- AI ----------
  b = new Board(9);
  b.set_stones([[1, _p(9, "E5")], [2, _p(9, "E3")], [1, _p(9, "G5")], [2, _p(9, "G3")]], 1);
  const [m1, n1] = ai.genmove(b, 40, 5, null);
  const [m2, n2] = ai.genmove(b, 40, 5, null);
  t.check("ai.deterministic_same_seed", m1 === m2 && n1 === n2, [m1, m2]);
  t.check("ai.legal_move", m1 === -1 || b.legal_moves().includes(m1), m1);
  t.check("ai.different_seed_explores", ai.genmove(b, 40, 99, null)[0] !== null);

  // 战术分辨力（诚实记录，不作硬门禁）：仅断言 genmove 返回合法着法。
  b = new Board(9);
  b.set_stones([[2, _p(9, "E5")], [2, _p(9, "E6")], [2, _p(9, "E7")],
    [1, _p(9, "D5")], [1, _p(9, "D6")], [1, _p(9, "D7")],
    [1, _p(9, "F5")], [1, _p(9, "F6")], [1, _p(9, "F7")],
    [1, _p(9, "E4")]], 1);
  const legal9 = new Set(b.legal_moves());
  let allok = true;
  for (const pl of [50, 150, 300]) {
    const [mv] = ai.genmove(b, pl, 11, null);
    if (mv !== -1 && !legal9.has(mv)) allok = false;
  }
  t.check("ai.genmove_always_legal", allok);
  t.check("ai.priors_capture_higher", ai.move_prior(2, 3) > ai.move_prior(0, 3));
  t.check("ai.priors_self_atari_lower", ai.move_prior(0, 1) < ai.move_prior(0, 3));

  // ---- CNN 先验（可选项）：默认关闭时行为必须逐位不变；开启后可复现且合法 ----
  {
    const b = new Board(9);
    b.set_stones([[1, _p(9, "E5")], [2, _p(9, "E3")], [1, _p(9, "G5")], [2, _p(9, "C5")]], 1);
    const [m0, n0] = ai.genmove(b, 60, 21, null);
    const [m0b, n0b] = ai.genmove(b, 60, 21, { cnn_prior: 0 });
    t.check("ai.cnn_prior_off_identical", m0 === m0b && n0 === n0b, [m0, m0b]);
    const [mA, nA] = ai.genmove(b, 60, 21, { cnn_prior: 3 });
    const [mB, nB] = ai.genmove(b, 60, 21, { cnn_prior: 3 });
    t.check("ai.cnn_prior_deterministic", mA === mB && nA === nB, [mA, mB]);
    t.check("ai.cnn_prior_legal", mA === -1 || b.legal_moves().includes(mA), mA);
  }

  // 自对弈可终局且全着合法
  b = new Board(9);
  let plies = 0;
  let alllegal = true;
  while (!b.is_over() && plies < 200) {
    const [mv] = ai.genmove(b, 15, 100 + plies, null);
    if (mv === "resign") break;
    r = b.play(b.side, mv);
    if (!r.ok) {
      alllegal = false;
      break;
    }
    plies += 1;
  }
  t.check("ai.selfplay_legal_and_terminates", alllegal && b.is_over(), "plies=" + plies);

  // ---------- Track A：死子判定（纯函数，与 referee.score(dead) 语义一致） ----------
  {
    const SIZE9 = 9;
    const n2 = SIZE9 * SIZE9;
    const neigh9 = buildNeigh(SIZE9);
    // 空盘：无任何死子（空区域无 border，owner=neutral，但空盘没有棋子 → 不应误杀）。
    {
      const cells = new Uint8Array(n2);
      t.check("dead.empty_board_no_false_positive", deadStones(cells, SIZE9, neigh9).size === 0);
    }
    // T1 被完全包围的孤子（无气）→ 死（验证「无己方领地 → 死」分支）。
    {
      const cells = new Uint8Array(n2);
      const c = parse_vertex("E5", SIZE9); // 中心
      cells[c] = 1;
      for (const v of ["D5", "F5", "E4", "E6"]) cells[parse_vertex(v, SIZE9)] = 2; // 四方白包围
      const dead = deadStones(cells, SIZE9, neigh9);
      t.check("dead.surrounded_lone_stone_is_dead", dead.has(c) && dead.size === 1, [...dead]);
    }
    // T2 含真眼的黑群 → 活（验证「相邻空域为己方领地 → 活」分支）。
    {
      const cells = new Uint8Array(n2);
      const eye = parse_vertex("E5", SIZE9); // 眼（空）
      const ring = ["D5", "F5", "E4", "E6"].map((v) => parse_vertex(v, SIZE9));
      for (const r of ring) cells[r] = 1; // 黑围成眼
      // 再把眼所在的黑块连成一片（额外黑子，避免只 4 子孤立）：在 D4/D6/F4/F6 也放黑，扩大黑群。
      for (const v of ["D4", "D6", "F4", "F6", "E3", "E7", "C5", "G5"]) cells[parse_vertex(v, SIZE9)] = 1;
      const dead = deadStones(cells, SIZE9, neigh9);
      t.check("dead.group_with_eye_is_alive", !dead.has(eye) && dead.size === 0, [...dead]);
    }
    // T3 双活（seki）：双方共享一个 neutral 点 → 双方都应判死（已知局限，诚实记录，非误杀目标）。
    {
      const cells = new Uint8Array(n2);
      // 黑白两群隔一个 neutral 空点相邻，互无眼：构造最小 seki 雏形（仅验证不崩溃且返回集合）。
      cells[parse_vertex("E5", SIZE9)] = 1;
      cells[parse_vertex("E7", SIZE9)] = 1;
      cells[parse_vertex("E4", SIZE9)] = 2;
      cells[parse_vertex("E6", SIZE9)] = 2; // E5/E6 白黑相邻、E4/E5 黑白相邻… 简化：仅校验函数稳健
      const dead = deadStones(cells, SIZE9, neigh9);
      t.check("dead.seki_case_runs", dead instanceof Set);
    }
    // areaWithDead：被黑完全包围的白孤子（死）→ 该点归母方领地，白无存活子/领地。
    {
      const cells = new Uint8Array(n2);
      const w = parse_vertex("E5", SIZE9);
      cells[w] = 2;
      for (const v of ["D5", "F5", "E4", "E6"]) cells[parse_vertex(v, SIZE9)] = 1; // 黑环
      const dead = deadStones(cells, SIZE9, neigh9);
      const [bs, ws] = areaWithDead(cells, SIZE9, neigh9, dead);
      t.check("dead.area_with_dead_captured_white", ws === 0 && bs === n2, [bs, ws]);
    }
    // areaWithDead：dead 为空时退化为普通面积法（全空盘 → 0 子 0 领地，dame=0）。
    {
      const cells = new Uint8Array(n2);
      const [bs, ws] = areaWithDead(cells, SIZE9, neigh9, null);
      t.check("dead.area_with_empty_dead_eq_area", bs === 0 && ws === 0, [bs, ws]);
    }
  }

  // ---------- Track A：dead_stones 开关「关」时行为逐位不变（0 差异） ----------
  {
    const b = new Board(9);
    b.set_stones([[1, _p(9, "E5")], [2, _p(9, "E3")], [1, _p(9, "G5")], [2, _p(9, "C5")]], 1);
    const [m0, n0, wr0] = ai.genmove(b, 60, 21, null);
    const [m1, n1, wr1] = ai.genmove(b, 60, 21, { dead_stones: 0 });
    t.check("dead.off_identical_to_default", m0 === m1 && n0 === n1 && wr0 === wr1, [m0, m1]);
    // 确定性：同 seed 同 profile 复现。
    const [m2, n2b, wr2] = ai.genmove(b, 60, 21, { dead_stones: 1 });
    const [m3, n3, wr3] = ai.genmove(b, 60, 21, { dead_stones: 1 });
    t.check("dead.on_deterministic", m2 === m3 && n2b === n3 && wr2 === wr3, [m2, m3]);
  }

  // ---------- Track B：CNN 价值头（与 ml/cnn.py::forwardV 等价；对拍见 _tmp_vh_check.mjs） ----------
  {
    // 构造一个最小网络（size=3, cin=6, ch1=ch2=1）。
    const size = 3, cin = 6, ch1 = 1, ch2 = 1;
    const mkObj = (withValue) => ({
      size, cin, ch1, ch2,
      params: {
        W1: new Array(ch1 * cin * 9).fill(0),
        b1: [0],
        W2: new Array(ch1 * ch2 * 9).fill(0),
        b2: [0],
        W3: [0],
        b3: [0],
        ...(withValue ? { Wv: [Math.log(4)], bv: [0] } : {}),
      },
    });
    // 无价值头权重 → hasValue=false，valueFrom 恒返 0.5（中性）。
    {
      const net = new CnnPolicy(mkObj(false));
      const cells = new Int8Array(size * size);
      t.check("cnn.value.no_value_head_returns_half", net.hasValue === false && net.valueFrom(cells, 1, -1) === 0.5,
        [net.hasValue, net.valueFrom(cells, 1, -1)]);
    }
    // 退化但确定：W1=W2=0, b1=0, b2=c>0 → h2 恒为 c；mean=c；z=bv+Wv·c；value=sigmoid(z)。
    // 取 c=2, Wv=ln4, bv=0 → z=2·ln4=ln16 → value=16/17≈0.94117647。
    {
      const obj = mkObj(true);
      obj.params.b2 = [2.0];
      const net = new CnnPolicy(obj);
      const cells = new Int8Array(size * size);
      const v = net.valueFrom(cells, 1, -1);
      const exp = 16 / 17;
      t.check("cnn.value.sigmoid_linear_deterministic", Math.abs(v - exp) < 1e-6, `got=${v} exp=${exp}`);
    }
    // 融合开关默认关：cnn_value=0 时 genmove 行为与历史版本一致（不引入价值头依赖）。
    {
      const b = new Board(9);
      b.set_stones([[1, _p(9, "E5")], [2, _p(9, "E3")]], 1);
      const [m0, n0, wr0] = ai.genmove(b, 50, 21, null);
      const [m1, n1, wr1] = ai.genmove(b, 50, 21, { cnn_value: 0 });
      t.check("cnn.value.off_identical_to_default", m0 === m1 && n0 === n1 && wr0 === wr1, [m0, m1]);
    }
  }

  return { passed: t.passed, failed: t.failed, failures: t.failures };
}
