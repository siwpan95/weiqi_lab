"""driver.py — JSON-stdio 驱动（协议规范：docs/PROTOCOL_SPEC.md, protocol-v1）"""

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from weiqi_rules import (Board, parse_vertex, format_vertex, parse_color,
                         normalize_rules, fmt_key, color_name, PROFILES)
import weiqi_ai

NAME = "PyWeiqi"
LANG = "py"
VERSION = "v1"


class Driver:
    def __init__(self):
        self.board = Board(9)
        self.golden_runner = None

    # ---------- 命令实现 ----------

    def cmd_hello(self, req):
        return {"name": NAME, "version": VERSION, "lang": LANG, "protocol": 1}

    def cmd_clear(self, req):
        size = int(req.get("size", 9))
        rules = req.get("rules", "cn")
        rd = normalize_rules(rules)
        komi = req.get("komi")
        self.board = Board(size, None if komi is None else float(komi), rd)
        return {"size": self.board.size, "komi": self.board.komi,
                "rules": {"ko": rd["ko"], "suicide": rd["suicide"], "scoring": rd["scoring"]}}

    def cmd_set_stones(self, req):
        stones = req.get("stones", [])
        side = req.get("side", "B")
        side_i = parse_color(side)
        pairs = []
        for it in stones:
            c = parse_color(it[0])
            if isinstance(it[1], str):
                v = parse_vertex(it[1], self.board.size)
            else:
                v = int(it[1])
            pairs.append((c, v))
        self.board.set_stones(pairs, side_i)
        return {"stones": len(pairs)}

    def cmd_play(self, req):
        color = parse_color(req.get("color", color_name(self.board.side)))
        v = req.get("vertex")
        vertex = parse_vertex(v, self.board.size) if isinstance(v, str) else int(v)
        r = self.board.play(color, vertex)
        if not r["ok"]:
            raise CmdError("illegal move", r["reason"])
        return {"captures": r["captures"], "self_captured": r["self_captured"], "key": r["key"]}

    def cmd_undo(self, req):
        ok = self.board.undo()
        if not ok:
            raise CmdError("nothing to undo")
        return {"moves": len(self.board.stack)}

    def cmd_key(self, req):
        pk, sk = self.board.key()
        return {"key": fmt_key(pk), "situational": fmt_key(sk)}

    def cmd_legal(self, req):
        color = parse_color(req.get("color", color_name(self.board.side)))
        v = req.get("vertex")
        vertex = parse_vertex(v, self.board.size) if isinstance(v, str) else int(v)
        ok, reason = self.board.legal(color, vertex)
        out = {"legal": ok}
        if not ok:
            out["reason"] = reason
        return out

    def cmd_legal_moves(self, req):
        ms = self.board.legal_moves()
        return {"count": len(ms),
                "moves": [format_vertex(p, self.board.size) for p in ms]}

    def cmd_genmove(self, req):
        color = parse_color(req.get("color", color_name(self.board.side)))
        playouts = int(req.get("playouts", 500))
        seed = int(req.get("seed", 0))
        profile = req.get("profile") or {}
        if color != self.board.side:
            raise CmdError("genmove for wrong side", "turn")
        mv, n, wr = weiqi_ai.genmove(self.board, playouts=playouts, seed=seed, profile=profile)
        if mv == "resign":
            return {"vertex": "resign", "visits": n, "winrate": wr}
        if mv == weiqi_ai.PASS:
            vertex = "pass"
        else:
            vertex = format_vertex(mv, self.board.size)
        if vertex != "resign":
            r = self.board.play(color, mv)
            if not r["ok"]:
                raise CmdError("internal: chosen move illegal", r["reason"])
        return {"vertex": vertex, "visits": n, "winrate": wr}

    def cmd_score(self, req):
        dead = req.get("dead")
        sc = self.board.score(dead=dead)
        return sc

    def cmd_prisoners(self, req):
        return self.board.prisoners()

    def cmd_selftest(self, req):
        from golden import run_golden
        path = req.get("golden")
        if not path:
            base = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
            path = os.path.join(base, "spec", "golden.json")
        return run_golden(path)

    def cmd_quit(self, req):
        return {}

    # ---------- 主循环 ----------

    def dispatch(self, req):
        cmd = req.get("cmd")
        fn = getattr(self, "cmd_" + str(cmd), None)
        if fn is None:
            raise CmdError("unknown command")
        return fn(req)


class CmdError(Exception):
    def __init__(self, msg, reason=None):
        Exception.__init__(self, msg)
        self.msg = msg
        self.reason = reason


def main():
    drv = Driver()
    out = sys.stdout
    out.write(json.dumps({"event": "ready", "protocol": 1, "name": NAME,
                          "lang": LANG, "version": VERSION}, ensure_ascii=False) + "\n")
    out.flush()
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        rid = None
        try:
            req = json.loads(line)
            rid = req.get("id")
            if req.get("cmd") == "quit":
                out.write(json.dumps({"id": rid, "ok": True, "result": {}}) + "\n")
                out.flush()
                return 0
            res = drv.dispatch(req)
            out.write(json.dumps({"id": rid, "ok": True, "result": res},
                                 ensure_ascii=False) + "\n")
        except CmdError as e:
            resp = {"id": rid, "ok": False, "error": e.msg}
            if e.reason:
                resp["reason"] = e.reason
            out.write(json.dumps(resp, ensure_ascii=False) + "\n")
        except Exception as e:  # noqa: BLE001
            out.write(json.dumps({"id": rid, "ok": False, "error": str(e)}) + "\n")
        out.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
