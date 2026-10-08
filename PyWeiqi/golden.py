"""golden.py — 黄金值用例执行器（各语言等价实现；数据源 spec/golden.json）"""

import json
import os

from weiqi_rules import (Board, parse_vertex, format_vertex, parse_color,
                         normalize_rules, fmt_key)


def build_board(setup):
    setup = setup or {}
    size = int(setup.get("size", 9))
    rules = setup.get("rules", "cn")
    rd = normalize_rules(rules)
    komi = setup.get("komi")
    b = Board(size, None if komi is None else float(komi), rd)
    if setup.get("stones") is not None:
        pairs = [(parse_color(it[0]), parse_vertex(it[1], size))
                 for it in setup["stones"]]
        b.set_stones(pairs, parse_color(setup.get("side", "B")))
        kp = setup.get("ko_point")
        if kp is not None:
            b.ko_point = parse_vertex(kp, size) if isinstance(kp, str) else int(kp)
    if setup.get("moves"):
        for item in setup["moves"]:
            c = parse_color(item[0])
            v = parse_vertex(item[1], size)
            r = b.play(c, v)
            if not r["ok"]:
                raise AssertionError("setup move illegal: %s %s (%s)"
                                     % (item[0], item[1], r.get("reason")))
    return b


def run_case(case):
    b = build_board(case.get("setup", {}))
    op = case["op"]
    args = case.get("args", {})
    if op == "key":
        pk, sk = b.key()
        return {"key": fmt_key(pk), "situational": fmt_key(sk)}
    if op == "legal":
        c = parse_color(args.get("color", "B"))
        v = parse_vertex(args["vertex"], b.size)
        ok, reason = b.legal(c, v)
        out = {"legal": ok}
        if not ok:
            out["reason"] = reason
        return out
    if op == "legal_moves":
        ms = b.legal_moves()
        return {"count": len(ms),
                "moves": [format_vertex(p, b.size) for p in ms]}
    if op == "play":
        c = parse_color(args["color"])
        v = parse_vertex(args["vertex"], b.size)
        r = b.play(c, v)
        if not r["ok"]:
            return {"ok": False, "reason": r["reason"]}
        return {"ok": True, "captures": r["captures"], "self_captured": r["self_captured"]}
    if op == "undo":
        n = int(args.get("n", 1))
        ok = True
        for _ in range(n):
            if not b.undo():
                ok = False
        return {"ok": ok}
    if op == "score":
        sc = b.score(dead=args.get("dead"))
        return {"black": sc["black"], "white": sc["white"], "dame": sc["dame"],
                "result": sc["result"]}
    if op == "prisoners":
        return b.prisoners()
    if op == "over":
        return {"over": b.is_over()}
    raise AssertionError("unknown op: %s" % op)


def compare(expect, got):
    miss = []
    for k, v in expect.items():
        gv = got.get(k)
        if isinstance(v, float) or isinstance(gv, float):
            try:
                if abs(float(gv) - float(v)) > 1e-9:
                    miss.append([k, v, gv])
            except (TypeError, ValueError):
                miss.append([k, v, gv])
        elif gv != v:
            miss.append([k, v, gv])
    return miss


def run_golden(path):
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    passed = 0
    failed = 0
    failures = []
    for case in data["cases"]:
        try:
            got = run_case(case)
            miss = compare(case["expect"], got)
            if miss:
                failed += 1
                failures.append({"id": case["id"], "got": got,
                                 "expect": case["expect"], "miss": miss})
            else:
                passed += 1
        except Exception as e:  # noqa: BLE001
            failed += 1
            failures.append({"id": case["id"], "error": str(e)})
    return {"passed": passed, "failed": failed, "total": passed + failed,
            "failures": failures}


def default_golden_path():
    base = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    return os.path.join(base, "spec", "golden.json")
