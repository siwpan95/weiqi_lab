#!/usr/bin/env python
# ml/eval_compare.py —— 在同一留出集上对比 CNN 与「模式条件转移模型」(tools/markov.mjs)
#
# 口径保证：
#   - 同一语料、同一按局划分（后 val_frac 局留出）、同一批留出样本（Python 统一生成）；
#   - 同一坐标口径（引擎格式 vertex=(row-1)*size+col，y 自下而上）；
#   - 同一合法性屏蔽：**占用点屏蔽**（两个模型都只能从空点里选）；
#     为追溯历史，额外给出 Markov 的「不屏蔽」legacy 数值（对齐旧报告 4.1%）。
#
# Markov 侧：由 Python 导出每个样本「最后一手 3×3 邻域」的 9 个棋色，
#   调 node ml/export_markov.mjs（内部 import tools/markov.mjs 的 PatternPolicy）产出候选。
#
# 用法：
#   python ml/eval_compare.py --corpus spec/games/corpus-2026-10-09.jsonl --size 9
#   python ml/eval_compare.py --corpus "spec/games/human-*.jsonl" --size 19

import argparse
import json
import os
import subprocess
import sys
import tempfile
import time

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import corpus as C          # noqa: E402
from cnn import PolicyCNN, legal_mask_from_input  # noqa: E402

F32 = np.float32
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)


def block9(cells_flat, size, last):
    """最后一手 3×3 邻域的 9 个原始棋色（行主序 ky,kx = 0..2）。"""
    nb = [0] * 9
    lx = last % size
    ly = last // size
    for ky in range(3):
        for kx in range(3):
            x = lx + (kx - 1)
            y = ly + (ky - 1)
            if 0 <= x < size and 0 <= y < size:
                nb[ky * 3 + kx] = int(cells_flat[y * size + x])
    return nb


def export_samples_json(samples, size, path):
    """samples: list of (cells_flat, toMove, last, next)。"""
    out = {"size": size, "samples": []}
    for (cells, toMove, last, nxt) in samples:
        out["samples"].append({"t": int(toMove), "l": int(last), "n": int(nxt),
                               "nb": block9(cells, size, last)})
    with open(path, "w", encoding="utf-8") as f:
        json.dump(out, f)


def topk_from_candidates(cands, occupied, targets, k=3):
    """cands: list of (vertex, score) 已按 score 降序；occupied: bool[HW]；
    返回 (hit1, hit3, covered) 命中计数。"""
    filtered = [v for (v, _) in cands if 0 <= v < len(occupied) and not occupied[v]]
    if not filtered:
        return 0, 0, 0
    t = targets
    hit1 = 1 if filtered[0] == t else 0
    hit3 = 1 if t in filtered[:k] else 0
    return hit1, hit3, 1


def main():
    ap = argparse.ArgumentParser(description="CNN vs Markov 同留出集对比")
    ap.add_argument("--corpus", required=True)
    ap.add_argument("--size", type=int, required=True)
    ap.add_argument("--cnn", default=None, help="CNN npz（默认 ml/cnn-<size>.npz）")
    ap.add_argument("--val-frac", type=float, default=0.2)
    ap.add_argument("--max-games", type=int, default=None)
    ap.add_argument("--max-positions", type=int, default=None)
    ap.add_argument("--batch", type=int, default=256)
    ap.add_argument("--keep-temp", action="store_true")
    a = ap.parse_args()

    cnn_path = a.cnn or os.path.join(HERE, f"cnn-{a.size}.npz")
    if not os.path.exists(cnn_path):
        print(f"!! 找不到 CNN 权重 {cnn_path}（先运行 train_cnn.py）", file=sys.stderr)
        sys.exit(2)

    # ---- 数据（与训练完全同参，保证同划分）----
    t_build = time.time()
    ds = C.build_dataset(a.corpus, a.size, a.max_games, a.max_positions, strict_replay=False)
    train_idx, val_idx, cut = ds.split(a.val_frac)
    legal = legal_mask_from_input(ds.X)
    print(f"语料 {ds.stats()}  用时 {time.time()-t_build:.1f}s")
    print(f"划分（后 {int(a.val_frac*100)}% 局留出）：训练 {len(train_idx)} / 留出 {len(val_idx)} 手（cut={cut}）")

    S = a.size
    HW = S * S
    Xva = ds.X[val_idx]
    Yva = ds.Y[val_idx]
    Lva = legal[val_idx]
    occ_va = ~Lva  # 占用点

    # ---- 均匀基线 & 常数基线（全局众数偏移，来自训练集）----
    empties = Lva.sum(axis=1).astype(np.float64)
    uniform_top1 = float((1.0 / np.maximum(empties, 1)).mean())
    uniform_top3 = float(np.minimum(3.0 / np.maximum(empties, 1), 1.0).mean())

    # ---- 导出样本给 Markov（需要 last 与 9 邻域）----
    # 重新生成留出样本（含 last）——与 build_dataset 同顺序，保证与 val_idx 对齐。
    val_samples = []
    train_samples_blocks = []
    # 重建：按局顺序复演，收集所有样本，再按 cut 切成 train/val（与 build_dataset 完全同规则）
    gid = 0
    n_total = 0
    used_games = 0
    for path in C.resolve_corpus(a.corpus):
        games = C.read_games(path, size=S)
        for g in games:
            if a.max_games is not None and used_games >= a.max_games:
                break
            if a.max_positions is not None and n_total >= a.max_positions:
                break
            samples = C.game_samples(g["moves"], S, strict=False)
            if not samples:
                continue
            for s in samples:
                if a.max_positions is not None and n_total >= a.max_positions:
                    break
                if gid < cut:
                    train_samples_blocks.append(s)
                else:
                    val_samples.append(s)
                n_total += 1
            gid += 1
            used_games += 1
        if (a.max_games is not None and used_games >= a.max_games) or (
                a.max_positions is not None and n_total >= a.max_positions):
            break
    assert len(val_samples) == len(val_idx), (len(val_samples), len(val_idx))

    # 训练集偏移众数（常数基线的预测器）：仅用训练样本统计（避免留出泄漏）
    dev_hist = {}
    for (cells, toMove, last, nxt) in train_samples_blocks:
        key = ((nxt % S) - (last % S), (nxt // S) - (last // S))
        dev_hist[key] = dev_hist.get(key, 0) + 1
    mode_off = max(dev_hist.items(), key=lambda kv: kv[1])[0] if dev_hist else (0, 0)

    # 常数基线（用上面重建的留出样本）
    const_hit1 = 0
    const_cov = 0
    for ((cells, toMove, last, nxt)) in val_samples:
        lx = last % S
        ly = last // S
        px = lx + mode_off[0]
        py = ly + mode_off[1]
        if 0 <= px < S and 0 <= py < S:
            pv = py * S + px
            const_cov += 1
            if pv == nxt:
                const_hit1 += 1
    const_top1 = const_hit1 / max(1, len(val_samples))
    const_top3 = const_top1  # 常数预测器只有一个点

    # ---- Markov 预测（node + tools/markov.mjs）----
    tmpdir = tempfile.mkdtemp(prefix="weqiml_")
    train_json = os.path.join(tmpdir, "train.json")
    val_json = os.path.join(tmpdir, "val.json")
    pred_json = os.path.join(tmpdir, "markov_pred.json")
    export_samples_json(train_samples_blocks, S, train_json)
    export_samples_json(val_samples, S, val_json)
    node = subprocess.run(
        ["node", os.path.join(HERE, "export_markov.mjs"),
         "--train", train_json, "--val", val_json,
         "--size", str(S), "--out", pred_json],
        capture_output=True, text=True, cwd=ROOT)
    sys.stdout.write(node.stdout)
    if node.returncode != 0:
        print(node.stderr, file=sys.stderr)
        print("!! node 导出失败", file=sys.stderr)
        sys.exit(3)
    with open(pred_json, "r", encoding="utf-8") as f:
        mk = json.load(f)
    assert mk["val_next"] == [s[3] for s in val_samples], "留出样本顺序/目标不一致"
    assert len(mk["preds"]) == len(val_samples)

    # ---- Markov 指标（占用点屏蔽 + legacy 不屏蔽）----
    mk1 = mk3 = mkcov = 0
    mk1_leg = mk3_leg = mk_cov_leg = 0
    for j, ((cells, toMove, last, nxt)) in enumerate(val_samples):
        cells_arr = np.asarray(cells, dtype=np.uint8)
        occupied = cells_arr != 0
        h1, h3, cov = topk_from_candidates(mk["preds"][j], occupied, nxt, 3)
        mk1 += h1; mk3 += h3; mkcov += cov
        # legacy：不屏蔽占用点
        cs = mk["preds"][j]
        if cs:
            mk_cov_leg += 1
            mk1_leg += 1 if cs[0][0] == nxt else 0
            mk3_leg += 1 if nxt in [v for v, _ in cs[:3]] else 0
    N = len(val_samples)
    mk = {
        "top1": mk1 / N, "top3": mk3 / N, "coverage": mkcov / N,
        "top1_legacy": mk1_leg / max(1, mk_cov_leg), "top3_legacy": mk3_leg / max(1, mk_cov_leg),
        "coverage_source": mk["covered"] / N,
        "predict_ms": mk["predict_ms"], "trained": mk["trained"],
    }

    # ---- CNN 指标 ----
    net = PolicyCNN.load(cnn_path)
    assert net.size == S, (net.size, S)
    t0 = time.time()
    cnn_top1 = cnn_top3 = 0
    K = 3
    for i in range(0, Xva.shape[0], a.batch):
        xb = Xva[i:i + a.batch].astype(F32)
        lb = Lva[i:i + a.batch]
        logits, _ = net.forward(xb)
        L = np.where(lb, logits, F32(-1e30))
        order = np.argsort(-L, axis=1)[:, :K]
        yb = Yva[i:i + a.batch]
        cnn_top1 += int((order[:, 0] == yb).sum())
        cnn_top3 += int((order == yb[:, None]).any(axis=1).sum())
    cnn_ms = (time.time() - t0) * 1000.0
    cnn = {
        "top1": cnn_top1 / N, "top3": cnn_top3 / N, "coverage": 1.0,
        "predict_ms": cnn_ms,
    }

    # ---- 输出表格 ----
    print("")
    print(f"## 留出集对比（size={S}，留出 {N} 手；占用点屏蔽口径）")
    print("")
    print("| 模型 | top-1 | top-3 | 覆盖率 | 每手耗时 |")
    print("|---|---|---|---|---|")
    print(f"| **CNN（numpy 手写）** | {cnn['top1']*100:.2f}% | {cnn['top3']*100:.2f}% | "
          f"{cnn['coverage']*100:.1f}% | {cnn_ms/N*1000:.2f} µs |")
    print(f"| Markov 模式条件转移 | {mk['top1']*100:.2f}% | {mk['top3']*100:.2f}% | "
          f"{mk['coverage']*100:.1f}% | {mk['predict_ms']/N*1000:.2f} µs |")
    print(f"| Markov（不屏蔽，legacy 口径） | {mk['top1_legacy']*100:.2f}% | {mk['top3_legacy']*100:.2f}% | "
          f"{mk['coverage_source']*100:.1f}% | — |")
    print(f"| 均匀基线（1/空点） | {uniform_top1*100:.2f}% | {uniform_top3*100:.2f}% | 100.0% | — |")
    print(f"| 常数基线（全局众数偏移 {mode_off}） | {const_top1*100:.2f}% | {const_top3*100:.2f}% | "
          f"{const_cov/max(1,N)*100:.1f}% | — |")
    print("")
    print(f"（Markov 有效训练样本 {mk['trained']}；CNN 权重 {os.path.relpath(cnn_path, ROOT)}；"
          f"每手耗时为进程内前向/预测均值，跨语言仅供量级参考）")

    result = {
        "size": S, "num_val": N, "cut_game": cut,
        "cnn": {**cnn, "top1_rate": cnn["top1"], "us_per_ply": cnn_ms / N * 1000},
        "markov": {**mk, "us_per_ply": mk["predict_ms"] / N * 1000},
        "uniform": {"top1": uniform_top1, "top3": uniform_top3},
        "constant": {"top1": const_top1, "top3": const_top3, "mode_off": list(mode_off),
                     "coverage": const_cov / max(1, N)},
        "corpus": a.corpus,
    }
    out_rec = os.path.join(HERE, f"eval-{S}.json")
    with open(out_rec, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=1)
    print(f"记录：{os.path.relpath(out_rec, ROOT)}")
    if not a.keep_temp:
        import shutil
        shutil.rmtree(tmpdir, ignore_errors=True)


if __name__ == "__main__":
    main()
