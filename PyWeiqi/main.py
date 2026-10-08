"""main.py — PyWeiqi CLI

用法：
    python main.py test        # 黄金值 + 内部单测（验收门）
    python main.py selftest    # 仅黄金值
    python main.py driver      # JSON-stdio 驱动模式（harness/tournament 用）
    python main.py selfplay N  # 自对弈 N 手（冒烟）
"""

import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from golden import run_golden, default_golden_path

USAGE = "usage: python main.py test|selftest|driver|selfplay [n]"


def main(argv=None):
    args = list(sys.argv[1:] if argv is None else argv)
    mode = args[0] if args else "test"

    if mode == "driver":
        from driver import main as drv_main
        return drv_main()

    if mode in ("test", "selftest"):
        t0 = time.time()
        g = run_golden(default_golden_path())
        u = {"passed": 0, "failed": 0, "failures": []}
        if mode == "test":
            from tests import run_unit_tests
            u = run_unit_tests()
        gp, gf = g["passed"], g["failed"]
        up, uf = u["passed"], u["failed"]
        total = gp + gf + up + uf
        for f in g["failures"][:10]:
            print("  GOLDEN FAIL %s: %s" % (f.get("id"), f.get("miss") or f.get("error")))
        for f in u["failures"][:10]:
            print("  UNIT   FAIL %s: %s" % (f.get("name"), f.get("detail")))
        ok = (gf == 0 and uf == 0)
        print("%s: %d passed, %d failed (golden %d/%d, unit %d/%d) %.2fs"
              % ("PASS" if ok else "FAIL", total - gf - uf, gf + uf, gp, gp + gf,
                 up, up + uf, time.time() - t0))
        return 0 if ok else 1

    if mode == "selfplay":
        from weiqi_rules import Board
        import weiqi_ai
        n = int(args[1]) if len(args) > 1 else 60
        playouts = int(args[2]) if len(args) > 2 else 30
        b = Board(9)
        t0 = time.time()
        played = 0
        while not b.is_over() and played < n:
            mv, vis, wr = weiqi_ai.genmove(b, playouts=playouts, seed=played * 17 + 1)
            if mv == "resign":
                print("ply %d: resign" % played)
                break
            r = b.play(b.side, mv)
            if not r["ok"]:
                print("illegal pick:", r)
                return 1
            played += 1
        sc = b.score()
        print("selfplay plies=%d over=%s result=%s black=%d white=%d dame=%d %.1fs"
              % (played, b.is_over(), sc["result"], sc["black"], sc["white"],
                 sc["dame"], time.time() - t0))
        return 0

    print(USAGE)
    return 2


if __name__ == "__main__":
    sys.exit(main())
