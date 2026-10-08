#!/usr/bin/env python3
"""diff_check.py -- random-game differential test: CppWeiqi vs PyWeiqi.

Feeds the SAME command sequence to both `driver` processes and compares every
response line semantically (id / ok / result / error / reason). A run with
"0 differences" is success. It does NOT compare genmove/selftest (the AI may
differ by design) nor the identity fields of the ready/hello payloads.

Run:  python _diffcheck/diff_check.py [rounds]
"""

import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))          # .../weiqi_lab
PY_MAIN = os.path.join(ROOT, "PyWeiqi", "main.py")
CPP_DIR = os.path.join(ROOT, "CppWeiqi")
CPP_EXE = os.path.join(CPP_DIR, "cppweiqi.exe")

COLS = "ABCDEFGHJKLMNOPQRST"


class Engine:
    def __init__(self, argv, cwd):
        self.p = subprocess.Popen(
            argv, cwd=cwd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, text=True, encoding="utf-8", bufsize=1,
        )
        self.ready = self.p.stdout.readline().strip()

    def request(self, obj):
        self.p.stdin.write(json.dumps(obj) + "\n")
        self.p.stdin.flush()
        line = self.p.stdout.readline()
        if line == "":
            raise RuntimeError("engine closed stdout unexpectedly")
        return json.loads(line)

    def close(self):
        try:
            self.p.stdin.close()
        except Exception:
            pass
        try:
            self.p.wait(timeout=5)
        except Exception:
            self.p.kill()


class R:
    """Deterministic controller RNG (independent of the engines)."""

    def __init__(self, seed):
        self.s = (seed * 6364136223846793005 + 1442695040888963407) & ((1 << 64) - 1)

    def u(self):
        self.s = (self.s * 6364136223846793005 + 1442695040888963407) & ((1 << 64) - 1)
        return self.s >> 11

    def randint(self, a, b=None):
        if b is None:
            return self.u() % a if a > 0 else 0
        return a + (self.u() % (b - a + 1))

    def choice(self, xs):
        return xs[self.randint(len(xs))]

    def random(self):
        return self.u() / float(1 << 53)


def vtx(r, size):
    return COLS[r.randint(size)] + str(r.randint(size) + 1)


# --- comparison -------------------------------------------------------------

def norm_ready(line):
    try:
        o = json.loads(line)
    except Exception:
        return line
    return {"event": o.get("event"), "protocol": o.get("protocol")}


def norm_result(cmd, res):
    if cmd == "hello" and isinstance(res, dict):
        return {"protocol": res.get("protocol")}   # identity differs by design
    return res


def deep_diff(a, b, path=""):
    out = []
    if isinstance(a, dict) and isinstance(b, dict):
        for k in sorted(set(a) | set(b)):
            if k not in a:
                out.append("%s.%s missing in PY" % (path, k))
            elif k not in b:
                out.append("%s.%s missing in CPP" % (path, k))
            else:
                out += deep_diff(a[k], b[k], path + "." + str(k))
        return out
    if isinstance(a, list) and isinstance(b, list):
        if len(a) != len(b):
            out.append("%s len %d vs %d" % (path, len(a), len(b)))
            return out
        for i, (x, y) in enumerate(zip(a, b)):
            out += deep_diff(x, y, path + "[%d]" % i)
        return out
    if isinstance(a, bool) or isinstance(b, bool):
        if a is not b:
            out.append("%s %r vs %r" % (path, a, b))
        return out
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        if abs(float(a) - float(b)) > 1e-9:
            out.append("%s %r vs %r" % (path, a, b))
        return out
    if a != b:
        out.append("%s %r vs %r" % (path, a, b))
    return out


def cmp_line(cmd, py, cpp):
    d = []
    if py.get("id") != cpp.get("id"):
        d.append("id %r vs %r" % (py.get("id"), cpp.get("id")))
    if py.get("ok") != cpp.get("ok"):
        d.append("ok %r vs %r" % (py.get("ok"), cpp.get("ok")))
    for k in ("error", "reason"):
        if py.get(k) != cpp.get(k):
            d.append("%s %r vs %r" % (k, py.get(k), cpp.get(k)))
    if "result" in py or "result" in cpp:
        d += deep_diff(norm_result(cmd, py.get("result")),
                       norm_result(cmd, cpp.get("result")), "result")
    return d


PROFILES = ["cn", "tt", "jp"]
RULE_OBJS = [
    {"ko": "positional", "suicide": "forbid", "scoring": "area"},
    {"ko": "simple", "suicide": "forbid", "scoring": "area"},
    {"ko": "situational", "suicide": "forbid", "scoring": "area"},
    {"ko": "positional", "suicide": "allow", "scoring": "area"},
    {"ko": "simple", "suicide": "allow", "scoring": "territory"},
    {"ko": "situational", "suicide": "allow", "scoring": "area"},
]


class Round:
    def __init__(self, py, cpp):
        self.py = py
        self.cpp = cpp
        self.cid = 0
        self.n = 0
        self.diffs = []

    def do(self, cmd):
        self.cid += 1
        c = dict(cmd)
        c["id"] = self.cid
        p = self.py.request(c)
        q = self.cpp.request(c)
        self.n += 1
        d = cmp_line(c.get("cmd"), p, q)
        if d:
            self.diffs.append("%s: %s" % (json.dumps(c), "; ".join(d)))
        return p, q


def run_round(rd, seed):
    r = R(seed)
    size = r.choice([9, 9, 9, 9, 13, 5, 7, 19, 3])

    py = Engine([sys.executable, PY_MAIN, "driver"], ROOT)
    cpp = Engine([CPP_EXE, "driver"], CPP_DIR)
    R_ = Round(py, cpp)

    if norm_ready(py.ready) != norm_ready(cpp.ready):
        R_.diffs.append("READY %r vs %r" % (py.ready, cpp.ready))

    # ---- phase 1: random independent ops (exercise every command) ----
    for _ in range(60 + r.randint(41)):
        k = r.randint(14)
        if k == 0:
            R_.do({"cmd": "clear", "size": r.choice([size, 9, 13, 19, 5, 7, 3, 2]),
                   "komi": r.choice([0, 0.5, 6.5, 7.5, 3]), "rules": r.choice(PROFILES + RULE_OBJS)})
        elif k == 1:
            stones, used = [], set()
            for _ in range(r.randint(0, 12)):
                v = vtx(r, size)
                if v in used:
                    continue
                used.add(v)
                stones.append([r.choice(["B", "W", "b", "white", "BLACK"]), v])
            R_.do({"cmd": "set_stones", "stones": stones, "side": r.choice(["B", "W"])})
        elif k == 2:
            R_.do({"cmd": "play", "vertex": vtx(r, size)})
        elif k == 3:
            R_.do({"cmd": "play", "vertex": "pass"})
        elif k == 4:
            R_.do({"cmd": "play", "color": r.choice(["B", "W", "b", "black"]),
                   "vertex": vtx(r, size)})
        elif k == 5:
            R_.do({"cmd": "undo"})
        elif k == 6:
            R_.do({"cmd": "key"})
        elif k == 7:
            R_.do({"cmd": "legal", "vertex": vtx(r, size)})
        elif k == 8:
            R_.do({"cmd": "legal", "color": r.choice(["B", "W"]),
                   "vertex": r.choice(["pass", vtx(r, size)])})
        elif k == 9:
            R_.do({"cmd": "legal_moves"})
        elif k == 10:
            R_.do({"cmd": "score"})
        elif k == 11:
            R_.do({"cmd": "score",
                   "dead": [[r.choice(["B", "W"]), vtx(r, size)] for _ in range(r.randint(0, 3))]})
        elif k == 12:
            R_.do({"cmd": "prisoners"})
        else:
            R_.do({"cmd": r.choice(["nope", "Hello", "PASS", "x"])})

    # ---- phase 2: a real game (deep capture / ko / superko coverage) ----
    R_.do({"cmd": "clear", "size": size, "komi": r.choice([0.5, 6.5, 7.5]),
           "rules": r.choice(PROFILES)})
    for ply in range(160):
        p, _ = R_.do({"cmd": "legal_moves"})
        moves = p.get("result", {}).get("moves", [])
        if not moves:
            p2, _ = R_.do({"cmd": "play", "vertex": "pass"})
            if not p2.get("ok"):
                break
        else:
            if r.random() < 0.04:
                p2, _ = R_.do({"cmd": "play", "vertex": "pass"})
            else:
                p2, _ = R_.do({"cmd": "play", "vertex": moves[r.randint(len(moves))]})
            if not p2.get("ok"):
                break
        if ply % 7 == 0:
            R_.do({"cmd": "key"})
        if ply % 11 == 0:
            R_.do({"cmd": "score"})
        if ply % 13 == 0:
            R_.do({"cmd": "prisoners"})
        if ply % 17 == 3:
            R_.do({"cmd": "undo"})

    R_.do({"cmd": "quit"})
    py.close()
    cpp.close()
    return R_.n, R_.diffs


def main():
    rounds = int(sys.argv[1]) if len(sys.argv) > 1 else 6
    seed0 = 20261008
    total = 0
    diffs = []
    for rd in range(rounds):
        n, d = run_round(rd, seed0 + rd * 7919)
        total += n
        for x in d:
            diffs.append("R%d %s" % (rd, x))
        sys.stdout.write("round %d: %d commands, %d diffs\n" % (rd, n, len(d)))
        sys.stdout.flush()

    print("commands compared: %d   rounds: %d" % (total, rounds))
    if diffs:
        print("DIFFS: %d" % len(diffs))
        for x in diffs[:40]:
            print("  " + x)
        return 1
    print("0 differences")
    return 0


if __name__ == "__main__":
    sys.exit(main())
