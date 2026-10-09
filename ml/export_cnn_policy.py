#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""ml/export_cnn_policy.py — 把 CNN 策略头的预测导出为 JSONL，供 tools/distill_to_table.mjs 蒸馏。

产物每行：
  {"g": <语料行号>, "p": <该局 moves 数组下标>, "n": <合法点数>, "top": [[<顶点索引>, <概率>], ...]}

统计口径与 ml/eval_compare.py 完全一致：
  - 合法点集合 = 空点平面（`legal_mask_from_input`，占用点屏蔽）
  - 「g/p」定位规则与 tools/train_markov.mjs::loadCorpus / ml/corpus.py::game_samples 一致：
    逐手 replay，仅当 last>=0 且本手非 pass 时产出一个样本

用法：
  python ml/export_cnn_policy.py --corpus spec/games/human-2026-10-09.jsonl --size 19 \
      --out ml/cnn_policy-19.jsonl --max-positions 300000 --topk 40
"""
import argparse
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import numpy as np  # noqa: E402

import corpus as C  # noqa: E402
from cnn import PolicyCNN, legal_mask_from_input  # noqa: E402


def read_games_indexed(path, size):
    """自行按行读 JSONL，显式携带**行号** _index（与 JS 侧 loadCorpus 的局号严格一致）。
    注意：不可直接用 corpus.read_games——它会按尺寸过滤，导致局号与行号漂移。"""
    games = []
    with open(path, "r", encoding="utf-8") as f:
        for i, line in enumerate(f):
            line = line.strip()
            if not line:
                continue
            g = json.loads(line)
            if int(g.get("size", size)) != int(size):
                continue
            moves = [(1 if s[0] == "B" else 2, C.parse_vertex(s[1:], int(g["size"]))) for s in g["moves"]]
            games.append({"_index": i, "size": int(g["size"]), "komi": g.get("komi"),
                          "black": g.get("black"), "white": g.get("white"),
                          "result": g.get("result"), "broken": g.get("broken"), "moves": moves})
    return games


def iter_samples_with_ply(moves, size):
    """与 ml/corpus.py::game_samples 同规则，但额外给出"本手在 moves 中的下标" ply。"""
    board = C.Board(size)
    last = -1
    for ply, (color, vertex) in enumerate(moves):
        if board.over:
            break
        if board.side != color:
            break
        if vertex >= 0 and last >= 0:
            yield ply, board.cells, color, last, vertex
        r = board.play(color, vertex)
        if not r.get("ok"):
            break
        last = vertex


def main():
    ap = argparse.ArgumentParser(description="导出 CNN 策略预测（供蒸馏）")
    ap.add_argument("--corpus", required=True)
    ap.add_argument("--size", type=int, required=True)
    ap.add_argument("--cnn", default=None, help="CNN npz（默认 ml/cnn-<size>.npz）")
    ap.add_argument("--out", default=None, help="输出 JSONL（默认 ml/cnn_policy-<size>.jsonl）")
    ap.add_argument("--max-games", type=int, default=None)
    ap.add_argument("--max-positions", type=int, default=300000)
    ap.add_argument("--topk", type=int, default=40)
    ap.add_argument("--batch", type=int, default=512)
    a = ap.parse_args()

    cnn_path = a.cnn or os.path.join(HERE, f"cnn-{a.size}.npz")
    out_path = a.out or os.path.join(HERE, f"cnn_policy-{a.size}.jsonl")
    if not os.path.exists(cnn_path):
        print(f"!! 找不到 CNN 权重 {cnn_path}", file=sys.stderr)
        sys.exit(2)

    net = PolicyCNN.load(cnn_path)
    S = a.size
    line_plane = C._line_plane(S)

    t0 = time.time()
    paths = C.resolve_corpus(a.corpus)
    n_pos = 0
    n_game = 0
    kept = 0
    buf_X = []
    buf_meta = []

    fout = open(out_path, "w", encoding="utf-8")

    def flush():
        nonlocal kept
        if not buf_X:
            return
        X = np.stack(buf_X).astype(np.float32)
        logits, _ = net.forward(X)                  # (N, S*S)；forward 返回 (logits, cache)
        mask = legal_mask_from_input(X.astype(np.uint8))
        big = np.where(mask, logits, np.float32(-1e30))
        K = min(a.topk, S * S)
        order = np.argpartition(-big, K - 1, axis=1)[:, :K]          # 粗选
        rows = np.arange(X.shape[0])[:, None]
        vals = big[rows, order]
        srt = np.argsort(-vals, axis=1)                              # 精排
        order = order[rows, srt]
        vals = vals[rows, srt]
        # 概率（对 top-K 归一化；已足够表达分布，尾部为噪声）
        p = np.exp(vals - vals[:, :1])
        p = p / p.sum(axis=1, keepdims=True)
        for i, (g, ply, legal_n) in enumerate(buf_meta):
            top = [[int(order[i, j]), float(p[i, j])] for j in range(K) if vals[i, j] > -1e29]
            if not top:
                continue
            fout.write(json.dumps({"g": g, "p": ply, "n": int(legal_n), "top": top}, ensure_ascii=False) + "\n")
            kept += 1
        buf_X.clear()
        buf_meta.clear()

    for path in paths:
        games = read_games_indexed(path, S)
        for g in games:
            if a.max_games is not None and n_game >= a.max_games:
                break
            if a.max_positions is not None and n_pos >= a.max_positions:
                break
            for ply, cells, color, last, nxt in iter_samples_with_ply(g["moves"], S):
                if a.max_positions is not None and n_pos >= a.max_positions:
                    break
                planes = C.make_planes(cells, S, color, last, line_plane)
                buf_X.append(planes)
                legal_n = int((np.asarray(cells, dtype=np.uint8) == 0).sum())
                buf_meta.append((int(g["_index"]), int(ply), legal_n))
                n_pos += 1
                if len(buf_X) >= a.batch:
                    flush()
            n_game += 1
            if n_game % 500 == 0:
                print(f"\r  games={n_game} positions={n_pos} written={kept}   ", end="")
    flush()
    fout.close()

    print(f"\n导出完成：positions={n_pos} written={kept} → {out_path}  用时 {time.time()-t0:.1f}s")


if __name__ == "__main__":
    main()
