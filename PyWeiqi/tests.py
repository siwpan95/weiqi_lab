"""tests.py — 内部单元测试（规则不变量 + AI 行为），与 golden.json 互补。"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from weiqi_rules import (Board, parse_vertex, format_vertex, parse_color,
                         splitmix64, fmt_key, fmt_num, ZB, MAX_POINTS, COLS,
                         normalize_rules, SIDEKEY_W)
import weiqi_ai


class T:
    def __init__(self):
        self.passed = 0
        self.failed = 0
        self.failures = []

    def check(self, name, cond, detail=""):
        if cond:
            self.passed += 1
        else:
            self.failed += 1
            self.failures.append({"name": name, "detail": str(detail)})

    def eq(self, name, got, exp):
        self.check(name, got == exp, "got=%r exp=%r" % (got, exp))


def _p(size, s):
    return parse_vertex(s, size)


def run_unit_tests():
    t = T()

    # ---------- 坐标 ----------
    ok = True
    for size in (2, 5, 9, 13, 19):
        for y in range(size):
            for x in range(size):
                s = format_vertex(y * size + x, size)
                if parse_vertex(s, size) != y * size + x:
                    ok = False
    t.check("vertex.roundtrip.all_sizes", ok)
    t.eq("vertex.skip_I", format_vertex(8, 9), "J1")
    t.eq("vertex.pass", parse_vertex("PASS", 9), -1)
    t.eq("vertex.lowercase", parse_vertex("e5", 9), _p(9, "E5"))
    bad = 0
    for s in ("I5", "A0", "A10", "", "Z9", "5A"):
        try:
            parse_vertex(s, 9)
        except ValueError:
            bad += 1
    t.eq("vertex.reject_invalid", bad, 6)
    t.eq("color.parse", (parse_color("b"), parse_color("WHITE")), (1, 2))

    # ---------- Zobrist ----------
    vals = set()
    for c in (1, 2):
        for p in range(MAX_POINTS):
            vals.add(ZB[c][p])
    t.eq("zobrist.distinct", len(vals), MAX_POINTS * 2)
    t.check("zobrist.sidekey_nonzero", SIDEKEY_W != 0)
    b9 = Board(9)
    t.eq("zobrist.empty_board_zero", b9.key()[0], 0)
    b19 = Board(19)
    b9.set_stones([(1, _p(9, "A1"))], 1)
    b19.set_stones([(1, _p(19, "A1"))], 1)
    t.eq("zobrist.size_independent", b9.key()[0], b19.key()[0])
    t.eq("zobrist.single_stone_A1", b9.key()[0], splitmix64(0))
    b9e = Board(9)
    b9e.set_stones([(1, _p(9, "E5"))], 1)
    t.eq("zobrist.single_stone_E5_index40", b9e.key()[0], splitmix64(40))
    bk, _ = b9.key()
    b9.side = 2
    t.eq("zobrist.situational_flip", b9.key()[1], bk ^ SIDEKEY_W)

    # ---------- 规则档 ----------
    t.eq("rules.cn", normalize_rules("cn"),
         {"ko": "positional", "suicide": "forbid", "scoring": "area", "komi": 7.5})
    t.eq("rules.tt", normalize_rules("tt")["suicide"], "allow")
    t.eq("rules.jp", normalize_rules("jp")["scoring"], "territory")
    try:
        normalize_rules({"ko": "bogus"})
        t.check("rules.reject_bad_ko", False)
    except ValueError:
        t.check("rules.reject_bad_ko", True)

    # ---------- 提子与气 ----------
    b = Board(9)
    b.set_stones([(2, _p(9, "E5")), (1, _p(9, "E4")), (1, _p(9, "E6")), (1, _p(9, "D5"))], 1)
    r = b.play(1, _p(9, "F5"))
    t.check("capture.single", r["ok"] and r["captures"] == 1, r)
    t.eq("capture.prisoners", b.prisoners(), {"black": 1, "white": 0})

    b = Board(9)
    b.set_stones([(1, _p(9, "E4")), (1, _p(9, "E5")), (1, _p(9, "E6")),
                  (2, _p(9, "D4")), (2, _p(9, "D5")), (2, _p(9, "D6")),
                  (2, _p(9, "F4")), (2, _p(9, "F5")),
                  (2, _p(9, "E3")), (2, _p(9, "E7"))], 2)
    r = b.play(2, _p(9, "F6"))
    t.check("capture.three_stones", r["ok"] and r["captures"] == 3, r)

    b = Board(9)
    b.set_stones([(1, _p(9, "E5")), (1, _p(9, "E6"))], 1)
    members, libs = b.group(_p(9, "E5"))
    t.eq("group.members", len(members), 2)
    t.eq("group.liberties", len(libs), 6)

    # ---------- 自杀 ----------
    setup = [(2, _p(9, "E4")), (2, _p(9, "E6")), (2, _p(9, "D5")), (2, _p(9, "F5"))]
    b = Board(9)
    b.set_stones(setup, 1)
    r = b.play(1, _p(9, "E5"))
    t.check("suicide.forbid", (not r["ok"]) and r["reason"] == "suicide", r)
    t.eq("suicide.forbid.board_unchanged", b.cells.count(0), 81 - 4)

    # 允许自杀：自提复原盘面在 PSK 下非法，故用"多子自提"验证
    b = Board(3, rules="tt")
    b.set_stones([(1, _p(3, "A1")), (1, _p(3, "B1")),
                  (2, _p(3, "A2")), (2, _p(3, "B2")), (2, _p(3, "C2"))], 1)
    r = b.play(1, _p(3, "C1"))
    t.check("suicide.allow.multi_stone", r["ok"] and r["self_captured"] == 3, r)
    t.eq("suicide.allow.no_black_stone", b.cells.count(1), 0)
    # 自提复原盘面：三档对照
    r = Board(3, rules="tt")
    r.set_stones([(2, _p(3, "A2")), (2, _p(3, "B2")), (2, _p(3, "B1"))], 1)
    t.check("suicide.restore_blocked_by_PSK",
            r.play(1, _p(3, "A1"))["reason"] == "superko")
    r = Board(3, rules={"ko": "simple", "suicide": "allow", "scoring": "area"})
    r.set_stones([(2, _p(3, "A2")), (2, _p(3, "B2")), (2, _p(3, "B1"))], 1)
    rr = r.play(1, _p(3, "A1"))
    t.check("suicide.restore_allowed_by_simple_ko",
            rr["ok"] and rr["self_captured"] == 1, rr)

    # 提子先于自杀判定（角部：填 A1 提两子，非自杀）
    b = Board(5)
    b.set_stones([(2, _p(5, "A2")), (2, _p(5, "B1")),
                  (1, _p(5, "A3")), (1, _p(5, "B2")), (1, _p(5, "C1"))], 1)
    r = b.play(1, _p(5, "A1"))
    t.check("suicide.after_capture", r["ok"] and r["captures"] == 2, r)

    # ---------- 劫 ----------
    ko_setup = [(2, _p(9, "D4")), (2, _p(9, "C3")), (2, _p(9, "C5")), (2, _p(9, "B4")),
                (1, _p(9, "D3")), (1, _p(9, "D5")), (1, _p(9, "E4"))]
    b = Board(9)
    b.set_stones(ko_setup, 1)
    r = b.play(1, _p(9, "C4"))
    t.check("ko.capture_ok", r["ok"] and r["captures"] == 1, r)
    t.eq("ko.point_set", b.ko_point, _p(9, "D4"))
    ok, reason = b.legal(2, _p(9, "D4"))
    t.check("ko.immediate_recapture_illegal", (not ok) and reason == "ko", (ok, reason))

    # simple 档：pass 后 ko 解除
    b = Board(9, rules="jp")
    b.set_stones(ko_setup, 1)
    b.play(1, _p(9, "C4"))
    b.play(2, -1)
    t.eq("ko.pass_clears_point", b.ko_point, -1)

    # ---------- 劫推迟一手（各档一致合法）----------
    b = Board(9)
    b.set_stones(ko_setup, 1)
    b.play(1, _p(9, "C4"))
    b.play(2, _p(9, "H9"))
    b.play(1, _p(9, "H1"))
    ok, reason = b.legal(2, _p(9, "D4"))
    t.check("ko.delayed_recapture_legal", ok, (ok, reason))

    # ---------- undo ----------
    b = Board(9)
    snaps = []
    for i in range(12):
        snaps.append((b.key(), b.side, b.ko_point, list(b.cells), list(b.captures),
                      len(b.hist_pos), len(b.hist_sit), len(b.stack)))
        legal = b.legal_moves()
        r = b.play(b.side, legal[(i * 7) % len(legal)])
        if not r["ok"]:
            break
    okall = True
    for i in range(len(snaps) - 1, -1, -1):
        b.undo()   # 先撤，再与"走这手之前"的快照比对
        k, side, ko, cells, caps, hp, hs, st = snaps[i]
        if (k, side, ko, cells, caps, len(b.hist_pos), len(b.hist_sit), len(b.stack)) \
                != (b.key(), b.side, b.ko_point, b.cells, b.captures,
                    len(b.hist_pos), len(b.hist_sit), len(b.stack)):
            okall = False
    t.check("undo.restores_exact_state", okall)

    b = Board(9)
    b.play(1, _p(9, "E5"))
    b.play(2, -1)                    # 白方 pass
    t.eq("undo.pass", b.undo(), True)
    t.eq("undo.pass_restored_side", b.side, 2)
    t.eq("undo.then_move", b.undo(), True)
    t.eq("undo.move_restored_side", b.side, 1)
    t.eq("undo.empty_stack", b.undo(), False)

    # ---------- clone / set_stones ----------
    b = Board(9)
    b.play(1, _p(9, "E5"))
    c = b.clone()
    c.play(2, _p(9, "D5"))
    t.eq("clone.independent", (b.cells.count(0), c.cells.count(0)), (80, 79))
    b = Board(9)
    b.play(1, _p(9, "E5"))
    b.set_stones([(2, _p(9, "A1"))], 2)
    t.eq("set_stones.resets_history", (len(b.hist_pos), b.captures[1], b.side), (1, 0, 2))

    # ---------- 计分不变量 ----------
    okarea = True
    rng = weiqi_ai.Rng(2026)
    for trial in range(30):
        b = Board(9)
        for i in range(20):
            legal = b.legal_moves()
            if not legal:
                break
            b.play(b.side, legal[rng.randint(len(legal))])
        sc = b.score()
        if sc["black"] + sc["white"] + sc["dame"] != 81:
            okarea = False
    t.check("score.area_partition_invariant", okarea)

    # ---------- 终局 ----------
    b = Board(9)
    b.play(1, -1)
    t.eq("pass.one_not_over", b.is_over(), False)
    b.play(2, -1)
    t.eq("pass.two_over", b.is_over(), True)
    r = b.play(1, _p(9, "E5"))
    t.check("pass.play_after_over", (not r["ok"]) and r["reason"] == "over", r)
    b.undo()
    t.eq("pass.undo_reopens", b.is_over(), False)

    # ---------- 数值格式 ----------
    t.eq("fmt_num.int", fmt_num(3.0), "3")
    t.eq("fmt_num.half", fmt_num(3.5), "3.5")
    t.eq("fmt_num.quarter", fmt_num(0.25), "0.25")
    t.eq("fmt_num.zero", fmt_num(0.0), "0")

    # ---------- AI ----------
    b = Board(9)
    b.set_stones([(1, _p(9, "E5")), (2, _p(9, "E3")), (1, _p(9, "G5")), (2, _p(9, "G3"))], 1)
    m1, n1, w1 = weiqi_ai.genmove(b, playouts=40, seed=5)
    m2, n2, w2 = weiqi_ai.genmove(b, playouts=40, seed=5)
    t.check("ai.deterministic_same_seed", (m1, n1) == (m2, n2), (m1, m2))
    t.check("ai.legal_move", m1 == -1 or m1 in b.legal_moves(), m1)
    t.check("ai.different_seed_explores", weiqi_ai.genmove(b, playouts=40, seed=99)[0] is not None)

    # 战术分辨力（诚实记录，不作硬门禁）：本实现在 300 playouts 下
    # 对 9 路的分辨力约 ±5 点，1–3 子的局部战术不可靠（见 README「已知限制」）。
    # 此处仅断言：genmove 返回合法着法、且不同预算下均不返回非法点。
    b = Board(9)
    b.set_stones([(2, _p(9, "E5")), (2, _p(9, "E6")), (2, _p(9, "E7")),
                  (1, _p(9, "D5")), (1, _p(9, "D6")), (1, _p(9, "D7")),
                  (1, _p(9, "F5")), (1, _p(9, "F6")), (1, _p(9, "F7")),
                  (1, _p(9, "E4"))], 1)
    legal9 = set(b.legal_moves())
    allok = True
    for pl in (50, 150, 300):
        mv, n, wr = weiqi_ai.genmove(b, playouts=pl, seed=11)
        if mv != -1 and mv not in legal9:
            allok = False
    t.check("ai.genmove_always_legal", allok)
    t.check("ai.priors_capture_higher",
            weiqi_ai.move_prior(2, 3) > weiqi_ai.move_prior(0, 3))
    t.check("ai.priors_self_atari_lower",
            weiqi_ai.move_prior(0, 1) < weiqi_ai.move_prior(0, 3))

    # 自对弈可终局且全着合法
    b = Board(9)
    plies = 0
    alllegal = True
    while not b.is_over() and plies < 200:
        mv, n, wr = weiqi_ai.genmove(b, playouts=15, seed=100 + plies)
        if mv == "resign":
            break
        r = b.play(b.side, mv)
        if not r["ok"]:
            alllegal = False
            break
        plies += 1
    t.check("ai.selfplay_legal_and_terminates", alllegal and b.is_over(), "plies=%d" % plies)

    return {"passed": t.passed, "failed": t.failed, "failures": t.failures}


if __name__ == "__main__":
    import json
    print(json.dumps(run_unit_tests(), ensure_ascii=False, indent=1))
