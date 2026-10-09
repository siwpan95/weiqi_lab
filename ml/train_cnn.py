#!/usr/bin/env python
# ml/train_cnn.py —— CNN 着法预测训练 CLI
#
# 用法：
#   python ml/train_cnn.py --corpus spec/games/corpus-2026-10-09.jsonl --size 9 --steps 800
#   python ml/train_cnn.py --corpus "spec/games/human-*.jsonl" --size 19 --steps 3000 --max-positions 120000
#
# 划分：按**局**（后 20% 局作留出），与 tools/train_markov.mjs 一致。
# 每 --log-every 步打印 train/val 的 top-1/top-3。
#
# 依赖：仅 numpy（见 ml/requirements.txt）。

import argparse
import json
import os
import sys
import time

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import corpus as C      # noqa: E402
from cnn import PolicyCNN, Adam, masked_softmax_ce, legal_mask_from_input, topk_hit  # noqa: E402

F32 = np.float32


def make_batches(idx, batch, seed, epoch):
    rng = np.random.default_rng(seed + epoch)
    perm = rng.permutation(idx)
    for i in range(0, len(perm) - batch + 1, batch):
        yield perm[i:i + batch]


def eval_val(net, X, Y, legal, batch=256):
    hit1 = 0.0
    hit3 = 0.0
    tot = 0
    for i in range(0, X.shape[0], batch):
        xb = X[i:i + batch].astype(F32)
        logits, _ = net.forward(xb)
        h1, h3, cov = topk_hit(logits, Y[i:i + batch], legal[i:i + batch], k=3)
        hit1 += h1.sum()
        hit3 += h3.sum()
        tot += xb.shape[0]
    return hit1 / max(1, tot), hit3 / max(1, tot)


def main():
    ap = argparse.ArgumentParser(description="CNN 着法预测训练（纯 numpy）")
    ap.add_argument("--corpus", required=True, help="语料路径/逗号分隔/glob")
    ap.add_argument("--size", type=int, required=True)
    ap.add_argument("--steps", type=int, default=800, help="mini-batch 训练步数")
    ap.add_argument("--batch", type=int, default=64)
    ap.add_argument("--out", default=None, help="输出 npz（默认 ml/cnn-<size>.npz）")
    ap.add_argument("--channels", type=int, default=32, help="卷积通道数 ch1=ch2")
    ap.add_argument("--lr", type=float, default=2e-3)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--val-frac", type=float, default=0.2)
    ap.add_argument("--max-games", type=int, default=None, help="最多使用的局数（按文件顺序）")
    ap.add_argument("--max-positions", type=int, default=None, help="最多使用的样本数（早停）")
    ap.add_argument("--log-every", type=int, default=100)
    ap.add_argument("--strict-replay", action="store_true", help="语料手数非法时抛错")
    a = ap.parse_args()

    here = os.path.dirname(os.path.abspath(__file__))
    out_path = a.out or os.path.join(here, f"cnn-{a.size}.npz")

    t_build = time.time()
    ds = C.build_dataset(a.corpus, a.size, a.max_games, a.max_positions,
                         strict_replay=a.strict_replay)
    train_idx, val_idx, cut = ds.split(a.val_frac)
    legal = legal_mask_from_input(ds.X)
    dt_build = time.time() - t_build

    print(f"== CNN 着法预测训练 ==  size={a.size}  corpus={a.corpus}")
    print(f"语料：{ds.stats()}  用时 {dt_build:.1f}s")
    print(f"划分（按局，后 {int(a.val_frac*100)}% 留出）：训练 {len(train_idx)} 样本 / "
          f"留出 {len(val_idx)} 样本（cut game={cut}）")
    if len(train_idx) == 0 or len(val_idx) == 0:
        print("!! 样本不足，无法训练/评测", file=sys.stderr)
        sys.exit(2)

    Ytr = ds.Y[train_idx]
    Ltr = legal[train_idx]
    Xva = ds.X[val_idx]
    Yva = ds.Y[val_idx]
    Lva = legal[val_idx]
    # 目标必须合法（占用点不可能被落子，除非语料/复演不一致）
    bad_tr = int((~Ltr[np.arange(len(Ytr)), Ytr]).sum())
    bad_va = int((~Lva[np.arange(len(Yva)), Yva]).sum())
    if bad_tr or bad_va:
        print(f"!! 警告：非法目标样本 train={bad_tr} val={bad_va}（复演/语料不一致）", file=sys.stderr)

    net = PolicyCNN(a.size, cin=C.C_IN, ch1=a.channels, ch2=a.channels, seed=a.seed)
    opt = Adam(net.params, lr=a.lr)

    # 均匀基线（1/空点）作为参照
    uniform = float((1.0 / np.maximum(Ltr.sum(axis=1), 1)).mean())

    curve = []
    t0 = time.time()
    ep = 0
    step = 0
    last_loss = float("nan")
    while step < a.steps:
        for bidx in make_batches(train_idx, a.batch, a.seed, ep):
            if step >= a.steps:
                break
            xb = ds.X[bidx].astype(F32)
            yb = ds.Y[bidx]
            lb = legal[bidx]
            logits, cache = net.forward(xb)
            loss, dlogits = masked_softmax_ce(logits, yb, lb)
            grads = net.backward(cache, dlogits)
            net.params = opt.step(net.params, grads)
            last_loss = loss
            step += 1
            if step % a.log_every == 0 or step == a.steps:
                h1, h3, _ = topk_hit(logits, yb, lb, k=3)
                v1, v3 = eval_val(net, Xva, Yva, Lva)
                curve.append({"step": step, "train_loss": round(loss, 4),
                              "batch_top1": round(float(h1.mean()), 4),
                              "val_top1": round(float(v1), 4),
                              "val_top3": round(float(v3), 4),
                              "elapsed_s": round(time.time() - t0, 1)})
                print(f"step {step:6d} | loss {loss:.4f} | train top1 {h1.mean()*100:5.2f}% "
                      f"top3 {h3.mean()*100:5.2f}% | VAL top1 {v1*100:5.2f}% top3 {v3*100:5.2f}% "
                      f"| {time.time()-t0:6.1f}s")
        ep += 1

    dt = time.time() - t0
    v1, v3 = eval_val(net, Xva, Yva, Lva)
    per_ply_ms = dt / max(1, step * a.batch) * 1000.0  # 每样本(约)训练耗时

    meta = {
        "size": a.size, "corpus": a.corpus, "steps": a.steps, "batch": a.batch,
        "channels": a.channels, "lr": a.lr, "seed": a.seed, "val_frac": a.val_frac,
        "train_samples": int(len(train_idx)), "val_samples": int(len(val_idx)),
        "cut_game": int(cut), "num_games": int(ds.num_games),
        "max_games": a.max_games, "max_positions": a.max_positions,
        "final_train_loss": round(float(last_loss), 4),
        "val_top1": round(float(v1), 4), "val_top3": round(float(v3), 4),
        "uniform_top1": round(uniform, 4), "elapsed_s": round(dt, 1),
        "sources": ds.sources,
    }
    net.save(out_path, meta=meta)
    with open(out_path + ".curve.json", "w", encoding="utf-8") as f:
        json.dump({"meta": meta, "curve": curve}, f, ensure_ascii=False, indent=1)

    print(f"耗时 {dt:.1f}s（{step} 步 × batch {a.batch}）；均匀基线 top1 ≈ {uniform*100:.2f}%")
    print(f"权重已保存：{out_path}")
    # 末行（验收用）：
    print(f"FINAL size={a.size} steps={a.steps} val_top1={v1*100:.2f}% val_top3={v3*100:.2f}% "
          f"uniform_top1={uniform*100:.2f}% elapsed={dt:.1f}s")


if __name__ == "__main__":
    main()
