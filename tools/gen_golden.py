"""gen_golden.py — 生成 spec/golden.json（跨语言黄金值测试集）

用法：python tools/gen_golden.py
产物：spec/golden.json（**冻结产物**，入库；改动需走 review）

注：本脚本用 PyWeiqi 参考实现计算期望值。凡可手算的用例（合法点数、提子数、
计分）在 EXPECT_HAND 中给出人工推导值，脚本会**断言二者一致**；
不一致即视为参考实现缺陷，禁止生成。
"""

import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "PyWeiqi"))

import golden  # noqa: E402

# 基础局面
KO_SETUP = [["W", "D4"], ["W", "C3"], ["W", "C5"], ["W", "B4"],
            ["B", "D3"], ["B", "D5"], ["B", "E4"]]
COL_AB_5 = [["B", "A1"], ["B", "A2"], ["B", "A3"], ["B", "A4"], ["B", "A5"],
            ["B", "B1"], ["B", "B2"], ["B", "B3"], ["B", "B4"], ["B", "B5"]]
CORNER_3 = [["B", "A1"], ["B", "A2"], ["B", "A3"], ["W", "C1"], ["W", "C2"], ["W", "C3"]]
SELF_CAP_3 = [["W", "A2"], ["W", "B2"], ["W", "B1"]]

CASES = [
    # ---------- Zobrist 键 ----------
    {"id": "K01", "op": "key", "note": "空盘：键为 0",
     "setup": {"size": 9, "stones": [], "side": "B"}},
    {"id": "K02", "op": "key", "note": "9路 A1 一子",
     "setup": {"size": 9, "stones": [["B", "A1"]], "side": "B"}},
    {"id": "K03", "op": "key", "note": "19路 A1 一子：与 K02 同值（表尺寸无关）",
     "setup": {"size": 19, "stones": [["B", "A1"]], "side": "B"}},
    {"id": "K04", "op": "key", "note": "白方轮次：situational 含 SIDEKEY_W",
     "setup": {"size": 9, "stones": [["B", "A1"], ["W", "J9"]], "side": "W"}},

    # ---------- 合法点计数 ----------
    {"id": "L01", "op": "legal_moves", "note": "9路空盘 81 点",
     "setup": {"size": 9}},
    {"id": "L02", "op": "legal_moves", "note": "19路空盘 361 点",
     "setup": {"size": 19}},
    {"id": "L03", "op": "legal_moves", "note": "4 子局面：77 空点全合法",
     "setup": {"size": 9, "stones": [["W", "E5"], ["B", "E4"], ["B", "E6"], ["B", "D5"]],
               "side": "B"}},
    {"id": "L04", "op": "legal_moves", "note": "劫后：白方 D4 禁着 → 73 点",
     "setup": {"size": 9, "side": "W", "ko_point": "D4",
               "stones": [["W", "C3"], ["W", "C5"], ["W", "B4"],
                          ["B", "D3"], ["B", "D5"], ["B", "E4"], ["B", "C4"]]}},

    # ---------- 提子 ----------
    {"id": "C01", "op": "play", "note": "提 1 子",
     "setup": {"size": 9, "stones": [["W", "E5"], ["B", "E4"], ["B", "E6"], ["B", "D5"]],
               "side": "B"},
     "args": {"color": "B", "vertex": "F5"}},
    {"id": "C02", "op": "play", "note": "提 3 子（边上整块）",
     "setup": {"size": 9, "stones": [["B", "A1"], ["B", "A2"], ["B", "A3"],
                                     ["W", "A4"], ["W", "B1"], ["W", "B2"]], "side": "W"},
     "args": {"color": "W", "vertex": "B3"}},
    {"id": "C03", "op": "play", "note": "角部填 A1 提 2 子（提子在自杀判定之前）",
     "setup": {"size": 5, "stones": [["W", "A2"], ["W", "B1"],
                                     ["B", "A3"], ["B", "B2"], ["B", "C1"]], "side": "B"},
     "args": {"color": "B", "vertex": "A1"}},

    # ---------- 自杀 ----------
    {"id": "S01", "op": "play", "note": "禁自杀档：填眼非法",
     "setup": {"size": 9, "stones": [["W", "E4"], ["W", "E6"], ["W", "D5"], ["W", "F5"]],
               "side": "B"},
     "args": {"color": "B", "vertex": "E5"}},
    {"id": "S02", "op": "play", "note": "允许自杀档（tt）：3 子自提（盘面改变 → 非禁全同）",
     "setup": {"size": 3, "rules": "tt",
               "stones": [["B", "A1"], ["B", "B1"], ["W", "A2"], ["W", "B2"], ["W", "C2"]],
               "side": "B"},
     "args": {"color": "B", "vertex": "C1"}},
    {"id": "S03", "op": "legal", "note": "禁自杀档：legal 接口同判",
     "setup": {"size": 9, "stones": [["W", "E4"], ["W", "E6"], ["W", "D5"], ["W", "F5"]],
               "side": "B"},
     "args": {"color": "B", "vertex": "E5"}},
    {"id": "S04", "op": "play", "note": "自提复原盘面 → PSK 判非法（tt 档）",
     "setup": {"size": 3, "rules": "tt", "stones": SELF_CAP_3, "side": "B"},
     "args": {"color": "B", "vertex": "A1"}},
    {"id": "S05", "op": "play", "note": "同局面在 jp 档：先判自杀（判定次序）",
     "setup": {"size": 3, "rules": "jp", "stones": SELF_CAP_3, "side": "B"},
     "args": {"color": "B", "vertex": "A1"}},
    {"id": "S06", "op": "play", "note": "自定档（simple ko + allow suicide）：自提复原盘面合法（三档对照）",
     "setup": {"size": 3,
               "rules": {"ko": "simple", "suicide": "allow", "scoring": "area"},
               "stones": SELF_CAP_3, "side": "B"},
     "args": {"color": "B", "vertex": "A1"}},

    # ---------- 劫与禁全同 ----------
    {"id": "X01", "op": "play", "note": "打劫提子成功，ko_point=D4",
     "setup": {"size": 9, "stones": KO_SETUP, "side": "B"},
     "args": {"color": "B", "vertex": "C4"}},
    {"id": "X02", "op": "legal", "note": "立刻回提非法（ko）",
     "setup": {"size": 9, "stones": KO_SETUP, "side": "B",
               "moves": [["B", "C4"]]},
     "args": {"color": "W", "vertex": "D4"}},
    {"id": "X03", "op": "legal", "note": "劫推迟一手后回提合法（各档一致）",
     "setup": {"size": 9, "stones": KO_SETUP, "side": "B",
               "moves": [["B", "C4"], ["W", "H9"], ["B", "H1"]]},
     "args": {"color": "W", "vertex": "D4"}},

    # ---------- 终局与 undo ----------
    {"id": "O01", "op": "over", "note": "两连 pass → 终局",
     "setup": {"size": 9, "moves": [["B", "E5"], ["W", "E3"], ["B", "pass"], ["W", "pass"]]}},
    {"id": "O02", "op": "play", "note": "终局后落子非法（over）",
     "setup": {"size": 9, "moves": [["B", "E5"], ["W", "E3"], ["B", "pass"], ["W", "pass"]]},
     "args": {"color": "B", "vertex": "A1"}},
    {"id": "O03", "op": "undo", "note": "undo 后终局解除",
     "setup": {"size": 9, "moves": [["B", "pass"], ["W", "pass"]]},
     "args": {"n": 1}},
    {"id": "U01", "op": "undo", "note": "连撤 2 手（含提子）",
     "setup": {"size": 9, "stones": [["B", "E4"], ["B", "E6"], ["B", "D5"], ["W", "E5"]],
               "side": "B", "moves": [["B", "F5"], ["W", "A1"]]},
     "args": {"n": 2}},

    # ---------- 计分 ----------
    {"id": "Z01", "op": "score", "note": "空盘：全单官，W+7.5",
     "setup": {"size": 9, "komi": 7.5}},
    {"id": "Z02", "op": "score", "note": "5路左两列黑：黑 10 子 + 15 目",
     "setup": {"size": 5, "komi": 0.5, "stones": COL_AB_5, "side": "B"}},
    {"id": "Z03", "op": "score", "note": "同上加白 C3：该区同时接触双色 → 24 单官",
     "setup": {"size": 5, "komi": 0.5, "stones": COL_AB_5 + [["W", "C3"]], "side": "B"}},
    {"id": "Z04", "op": "score", "note": "3路 左右各 3 子 + 中列单官 → 和棋",
     "setup": {"size": 3, "komi": 0, "stones": CORNER_3, "side": "B"}},
    {"id": "Z05", "op": "score", "note": "数目档 + 显式死子 C3",
     "setup": {"size": 5, "komi": 0.5, "rules": "jp",
               "stones": COL_AB_5 + [["W", "C3"]], "side": "B"},
     "args": {"dead": [["W", "C3"]]}},
    {"id": "Z06", "op": "score", "note": "数目档，不标死子（白子计入白方）",
     "setup": {"size": 5, "komi": 0.5, "rules": "jp",
               "stones": COL_AB_5 + [["W", "C3"]], "side": "B"}},

    # ---------- 提子计数 ----------
    {"id": "R01", "op": "prisoners", "note": "黑提 1 子",
     "setup": {"size": 9, "stones": [["W", "E5"], ["B", "E4"], ["B", "E6"], ["B", "D5"]],
               "side": "B", "moves": [["B", "F5"]]}},
    {"id": "R02", "op": "prisoners", "note": "黑白各提 1 子（两处独立提子）",
     "setup": {"size": 9,
               "stones": [["W", "D4"], ["B", "D3"], ["B", "D5"], ["B", "E4"],
                          ["B", "G7"], ["W", "G6"], ["W", "G8"], ["W", "F7"]],
               "side": "B", "moves": [["B", "C4"], ["W", "H7"]]}},

    # ---------- 轮次与状态 ----------
    {"id": "T01", "op": "play", "note": "非轮次方落子 → turn",
     "setup": {"size": 9, "stones": [], "side": "B"},
     "args": {"color": "W", "vertex": "E5"}},
    {"id": "T02", "op": "play", "note": "已占点 → occupied",
     "setup": {"size": 9, "stones": [["B", "E5"]], "side": "W"},
     "args": {"color": "W", "vertex": "E5"}},
    {"id": "T03", "op": "legal_moves", "note": "set_stones 后白方轮次：80 点",
     "setup": {"size": 9, "stones": [["B", "A1"]], "side": "W"}},
]


def main():
    # 生成 moves2（K04 等需要"先摆子再走子"的场景由 golden.build_board 支持 moves 优先；
    # L04 用 stones+moves 组合：build_board 中 moves 优先于 stones，故这里用 moves 序列表达）
    out = []
    problems = []
    for case in CASES:
        c = {k: v for k, v in case.items() if k in ("id", "op", "setup", "args", "note")}
        setup = dict(c.get("setup", {}))
        got = golden.run_case(c)
        # 人工推导断言（可手算者）
        hand = HAND.get(case["id"])
        if hand:
            for k, v in hand.items():
                if got.get(k) != v:
                    problems.append("%s: %s 参考=%r 手算=%r" % (case["id"], k, got.get(k), v))
        c["expect"] = got
        out.append(c)

    if problems:
        print("!! 参考实现与手算不符，拒绝生成：")
        for p in problems:
            print("   ", p)
        return 1

    data = {"protocol": 1, "spec": "spec-v1", "cases": out}
    path = os.path.join(ROOT, "spec", "golden.json")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        json.dump(data, f, ensure_ascii=False, indent=1, sort_keys=False)
        f.write("\n")
    print("written: %s  (%d cases)" % (path, len(out)))
    for c in out:
        print("  %-4s %-12s %s" % (c["id"], c["op"], json.dumps(c["expect"], ensure_ascii=False)))
    return 0


# 人工推导的期望值（与参考实现交叉验证；不一致即缺陷）
HAND = {
    "K01": {"key": "0x0000000000000000", "situational": "0x0000000000000000"},
    "L01": {"count": 81},
    "L02": {"count": 361},
    "L03": {"count": 77},
    "L04": {"count": 73},
    "C01": {"ok": True, "captures": 1, "self_captured": 0},
    "C02": {"ok": True, "captures": 3, "self_captured": 0},
    "C03": {"ok": True, "captures": 2, "self_captured": 0},
    "S01": {"ok": False, "reason": "suicide"},
    "S02": {"ok": True, "captures": 0, "self_captured": 3},
    "S03": {"legal": False, "reason": "suicide"},
    "S04": {"ok": False, "reason": "superko"},
    "S05": {"ok": False, "reason": "suicide"},
    "S06": {"ok": True, "captures": 0, "self_captured": 1},
    "X01": {"ok": True, "captures": 1, "self_captured": 0},
    "X02": {"legal": False, "reason": "ko"},
    "X03": {"legal": True},
    "O01": {"over": True},
    "O02": {"ok": False, "reason": "over"},
    "O03": {"ok": True},
    "U01": {"ok": True},
    "Z01": {"black": 0, "white": 0, "dame": 81, "result": "W+7.5"},
    "Z02": {"black": 25, "white": 0, "dame": 0, "result": "B+24.5"},
    "Z03": {"black": 10, "white": 1, "dame": 14, "result": "B+8.5"},
    "Z04": {"black": 3, "white": 3, "dame": 3, "result": "0"},
    "Z05": {"black": 16, "white": 0, "dame": 0, "result": "B+15.5"},
    "Z06": {"black": 0, "white": 0, "dame": 14, "result": "W+0.5"},
    "R01": {"black": 1, "white": 0},
    "T01": {"ok": False, "reason": "turn"},
    "T02": {"ok": False, "reason": "occupied"},
    "T03": {"count": 80},
}

if __name__ == "__main__":
    sys.exit(main())
