#!/usr/bin/env python
# ml/validate_value.py —— 用 board-replay 实战谱（跨引擎 9x9）验证价值头"预测胜者"能力。
#
# 思路：解析 SGF → 复刻 tools/sgf.mjs 坐标口径（yEngine = size-1-y_sgf）回放到引擎盘面 →
#       对每个中盘局面用价值头 forwardV 得黑胜概率 → 与整局真实结果比对。
# 朝向自检：末局（接近终局）局面的预测应与真实胜负高度一致；若坐标翻转则必然系统性反向。
#
# 用法：
#   G:/Python314/python.exe ml/validate_value.py \
#       --sgf-dir G:/repos/board-replay/samples --cnn ml/cnn-9-value.npz --size 9

import argparse
import glob
import json
import os
import re
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import corpus as C  # noqa: E402
from cnn import PolicyCNN  # noqa: E402

F32 = np.float32


def sgf_vertex_to_engine(v, size):
    """复刻 tools/sgf.mjs::sgfToVertex：x 不变，yEngine = size-1-y_sgf；空值/越界→pass(-1)。"""
    if v is None or len(v) == 0:
        return -1
    if len(v) < 2:
        return -1
    x = ord(v[0]) - 97
    y = ord(v[1]) - 97
    if x < 0 or y < 0 or x >= size or y >= size:
        return -1
    return (size - 1 - y) * size + x


def parse_sgf(text):
    m = re.search(r"SZ\[(\d+)\]", text)
    size = int(m.group(1)) if m else 9
    km = re.search(r"KM\[([^\]]+)\]", text)
    komi = float(km.group(1)) if km else 7.5
    re_ = re.search(r"RE\[([^\]]+)\]", text)
    result = re_.group(1) if re_ else None
    moves = []
    for mm in re.finditer(r";([BW])\[([a-s]{0,2})\]", text):
        color = 1 if mm.group(1) == "B" else 2
        moves.append((color, sgf_vertex_to_engine(mm.group(2), size)))
    return size, komi, result, moves


def label_from_result(result):
    if not result:
        return None
    r = result.strip()
    if r.startswith("B"):
        return 1.0
    if r.startswith("W"):
        return 0.0
    return None


def main():
    ap = argparse.ArgumentParser(description="board-replay 实战谱验证价值头")
    ap.add_argument("--sgf-dir", required=True)
    ap.add_argument("--cnn", required=True, help="价值头权重 npz")
    ap.add_argument("--size", type=int, default=9)
    ap.add_argument("--min-move", type=int, default=10, help="只统计该手数之后的中盘局面")
    a = ap.parse_args()

    net = PolicyCNN.load(a.cnn)
    line = C._line_plane(a.size)

    files = sorted(glob.glob(os.path.join(a.sgf_dir, "*.sgf")))
    mid_vals, mid_lab = [], []
    final_vals, final_lab = [], []
    games_ok = 0
    games_skip = 0
    illegal = 0

    for fp in files:
        try:
            text = open(fp, encoding="utf-8").read()
        except Exception:
            continue
        size, komi, result, moves = parse_sgf(text)
        if size != a.size:
            continue
        lab = label_from_result(result)
        if lab is None:
            games_skip += 1
            continue
        board = C.Board(size)
        last = -1
        ok = True
        mv = 0
        for (color, v) in moves:
            if board.over:
                break
            if mv >= a.min_move:
                X = C.make_planes(board.cells, size, board.side, last, line)[None]
                _, val, _ = net.forwardV(X.astype(F32))
                mid_vals.append(float(val[0]))
                mid_lab.append(lab)
            r = board.play(color, v)
            if not r.get("ok"):
                illegal += 1
                ok = False
                break
            last = v
            mv += 1
        if not ok:
            games_skip += 1
            continue
        # 末局局面（接近终局）自检
        X = C.make_planes(board.cells, size, board.side, last, line)[None]
        _, val, _ = net.forwardV(X.astype(F32))
        final_vals.append(float(val[0]))
        final_lab.append(lab)
        games_ok += 1

    def acc(vals, labs):
        vals = np.asarray(vals, dtype=F32)
        labs = np.asarray(labs, dtype=F32)
        pred = (vals >= 0.5).astype(F32)
        ybin = (labs >= 0.5).astype(F32)
        return float((pred == ybin).mean()) if len(vals) else float("nan")

    def mean_split(vals, labs):
        vals = np.asarray(vals, dtype=F32)
        labs = np.asarray(labs, dtype=F32)
        mb = vals[labs >= 0.5].mean() if (labs >= 0.5).any() else float("nan")
        mw = vals[labs < 0.5].mean() if (labs < 0.5).any() else float("nan")
        return float(mb), float(mw)

    n_mid = len(mid_lab)
    n_fin = len(final_lab)
    # 多数类基线
    if n_mid:
        maj = max(float(np.mean(np.asarray(mid_lab) >= 0.5)),
                  1 - float(np.mean(np.asarray(mid_lab) >= 0.5)))
    else:
        maj = float("nan")

    print(f"== 价值头实战谱验证 ==  size={a.size}  sgf目录={a.sgf_dir}")
    print(f"有效对局={games_ok}  跳过(无结果/非法)={games_skip}  非法着法={illegal}")
    print(f"中盘局面(≥{a.min_move}手)样本={n_mid}")
    if n_mid:
        mb, mw = mean_split(mid_vals, mid_lab)
        print(f"  · 中盘预测胜者准确率 = {acc(mid_vals, mid_lab)*100:.2f}%   "
              f"（多数类基线 {maj*100:.2f}%）")
        print(f"  · 平均黑胜概率：黑胜局 {mb:.3f} / 白胜局 {mw:.3f}（应 >0.5 / <0.5）")
    if n_fin:
        fb, fw = mean_split(final_vals, final_lab)
        print(f"  · 末局(自检)预测胜者准确率 = {acc(final_vals, final_lab)*100:.2f}%   "
              f"（黑胜局均 val {fb:.3f} / 白胜局均 val {fw:.3f}）")
    print("说明：末局准确率若显著偏低(<60%)，提示 SGF→引擎坐标朝向可能翻转，需核查。")


if __name__ == "__main__":
    main()
