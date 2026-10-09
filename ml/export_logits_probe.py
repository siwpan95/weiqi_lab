#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""ml/export_logits_probe.py — 导出 Python 侧 CNN logits 探针（用于与纯 JS 前向对拍）

选取规则必须与 tools/cnn_forward.mjs 的 CLI 完全一致：
  按 JSONL 行序遍历各局；逐手 replay；窗口条件 `last>=0 and v>=0 and ply%7==0`；取满 count 个为止。

用法：
  python ml/export_logits_probe.py --corpus spec/games/human-2026-10-09.jsonl --size 19 \
      --count 20 --out /tmp/py_logits.jsonl
"""
import argparse
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--corpus", required=True)
    ap.add_argument("--size", type=int, required=True)
    ap.add_argument("--cnn", default=None)
    ap.add_argument("--count", type=int, default=20)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()

    import numpy as np
    import corpus as C
    from cnn import PolicyCNN

    cnn_path = a.cnn or os.path.join(HERE, f"cnn-{a.size}.npz")
    net = PolicyCNN.load(cnn_path)
    S = a.size
    line_plane = C._line_plane(S)

    rows = []
    done = 0
    lines = [l for l in open(a.corpus, encoding="utf-8").read().strip().split("\n") if l]
    for gi, line in enumerate(lines):
        if done >= a.count:
            break
        g = json.loads(line)
        if int(g.get("size", S)) != S:
            continue
        board = C.Board(S)
        last = -1
        for ply, s in enumerate(g["moves"]):
            if done >= a.count:
                break
            color = 1 if s[0] == "B" else 2
            if board.side != color:
                break
            v = -1 if s[1:] == "pass" else C.parse_vertex(s[1:], S)
            if last >= 0 and v >= 0 and ply % 7 == 0:
                planes = C.make_planes(board.cells, S, color, last, line_plane)
                X = planes[None, :, :, :].astype(np.float32)
                logits, _ = net.forward(X)
                rows.append(json.dumps({"g": gi, "p": ply, "logits": [float(x) for x in logits[0]]}))
                done += 1
            r = board.play(color, v)
            if not r.get("ok"):
                break
            last = v
    with open(a.out, "w", encoding="utf-8") as f:
        f.write("\n".join(rows) + "\n")
    print(f"Python 探针导出 {len(rows)} 个局面 → {a.out}")


if __name__ == "__main__":
    main()
