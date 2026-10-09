#!/usr/bin/env python
# ml/train_value.py —— 训练 CNN 价值头（黑胜概率），固定已训练的策略卷积特征。
#
# 设计：
#   - 复用 ml/corpus.py 的特征构造（make_planes / game_samples / read_games），与策略训练、
#     引擎、对拍口径完全一致。
#   - 标签 = 整局最终胜负（黑胜概率）：B 胜→1.0，W 胜→0.0，和/无结果→0.5。
#   - **类别平衡（--balance）**：按"整局胜负"对局级下采样，使训练集黑/白胜局数一致，
#     强制模型读盘而非押注类别先验（否则会学到"白方常胜"的先验，跨引擎泛化崩）。
#   - 冻结卷积 + 策略头（W1..W3），只训价值头 Wv(32) / bv(1)，Adam + value_mse（纯 numpy）。
#   - 按局划分训练/留出（后 20% 局），避免同局泄漏。
#
# 用法：
#   G:/Python314/python.exe ml/train_value.py \
#       --corpus spec/games/corpus-2026-10-09.jsonl,spec/games/corpus-2026-10-09-cpp5k.jsonl \
#       --size 9 --cnn ml/cnn-9.npz --out ml/cnn-9-value.npz --balance \
#       --steps 400 --batch 256 --lr 1e-2 --max-positions 400000

import argparse
import json
import os
import sys
import time

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import corpus as C  # noqa: E402
from cnn import PolicyCNN, Adam, value_mse  # noqa: E402

F32 = np.float32


def parse_result_label(result, broken):
    """整局结果 → 黑胜概率标签 ∈ {0.0, 0.5, 1.0}；无法判定返回 None。"""
    if broken:
        return None
    if result is None:
        return None
    r = str(result).strip()
    if r == "" or r in ("0", "0.0", "Draw", "B+0", "W+0"):
        return 0.5  # 和 / 无结果
    if r.startswith("B"):
        return 1.0
    if r.startswith("W"):
        return 0.0
    return None


def load_labeled_games(corpus_arg, size):
    """读取语料 → [(game_dict, label)]，仅保留有有效标签的对局。"""
    paths = C.resolve_corpus(corpus_arg)
    if not paths:
        raise FileNotFoundError(f"未找到语料: {corpus_arg}")
    out = []
    for path in paths:
        for g in C.read_games(path, size=size):
            lab = parse_result_label(g.get("result"), g.get("broken"))
            if lab is None:
                continue
            out.append((g, lab))
    return out


def balance_games(games, seed=0):
    """按整局胜负（1.0 / 0.0）对局级下采样，使两类局数一致；和棋（0.5）保留。"""
    rng = np.random.default_rng(seed)
    black = [x for x in games if x[1] >= 0.5 + 1e-6]
    white = [x for x in games if x[1] <= 0.5 - 1e-6]
    draws = [x for x in games if abs(x[1] - 0.5) < 1e-6]
    n = min(len(black), len(white))
    rng.shuffle(black)
    rng.shuffle(white)
    sel = black[:n] + white[:n] + draws
    rng.shuffle(sel)
    return sel, (len(black), len(white), len(draws), n)


def build_positions(games, size, max_positions=None, tail=0):
    """构造 (X, Y, G)。tail>0 时只保留每局最后 tail 手（接近终局，与叶子部署对齐）。"""
    line = C._line_plane(size)
    per_game = []
    for (g, lab) in games:
        samples = C.game_samples(g["moves"], size)
        if tail and len(samples) > tail:
            samples = samples[-tail:]
        per_game.append((samples, lab))
    Xs, Ys, Gs = [], [], []
    n = 0
    gid = 0
    for (samples, lab) in per_game:
        if not samples:
            gid += 1
            continue
        for (cells, toMove, last, nxt) in samples:
            if max_positions is not None and n >= max_positions:
                break
            Xs.append(C.make_planes(cells, size, toMove, last, line))
            Ys.append(lab)
            Gs.append(gid)
            n += 1
        gid += 1
    if n == 0:
        raise ValueError("无样本")
    X = np.stack(Xs).astype(F32)
    Y = np.asarray(Ys, dtype=F32)
    G = np.asarray(Gs, dtype=np.int64)
    return X, Y, G, gid


def split_by_game(G, num_games, val_frac=0.2):
    cut = int(np.floor(num_games * (1.0 - val_frac)))
    cut = max(1, min(cut, max(1, num_games - 1))) if num_games > 1 else num_games
    return np.where(G < cut)[0], np.where(G >= cut)[0], cut


def eval_val(net, X, Y, idx, batch=512):
    vals = np.zeros(len(idx), dtype=F32)
    for j in range(0, len(idx), batch):
        jb = idx[j:j + batch]
        _, v, _ = net.forwardV(X[jb].astype(F32))
        vals[j:j + len(jb)] = v
    loss = float(((vals - Y[idx]) ** 2).mean() * 0.5)
    pred = (vals >= 0.5).astype(np.float32)
    ybin = (Y[idx] >= 0.5).astype(np.float32)
    acc = float((pred == ybin).mean())
    # 黑胜局 / 白胜局 平均预测（>0.5 表示判黑胜）
    mb = float(vals[(Y[idx] >= 0.5)].mean()) if (Y[idx] >= 0.5).any() else float("nan")
    mw = float(vals[(Y[idx] < 0.5)].mean()) if (Y[idx] < 0.5).any() else float("nan")
    return loss, acc, mb, mw


def main():
    ap = argparse.ArgumentParser(description="CNN 价值头训练（冻结策略卷积）")
    ap.add_argument("--corpus", required=True, help="逗号分隔的语料路径")
    ap.add_argument("--size", type=int, required=True)
    ap.add_argument("--cnn", required=True, help="已训练策略权重 npz（如 ml/cnn-9.npz）")
    ap.add_argument("--out", required=True, help="输出 npz（如 ml/cnn-9-value.npz）")
    ap.add_argument("--balance", action="store_true", help="按整局胜负对局级平衡")
    ap.add_argument("--steps", type=int, default=400)
    ap.add_argument("--batch", type=int, default=256)
    ap.add_argument("--lr", type=float, default=1e-2)
    ap.add_argument("--val-frac", type=float, default=0.2)
    ap.add_argument("--max-positions", type=int, default=400000)
    ap.add_argument("--tail", type=int, default=0, help="只保留每局最后 N 手（接近终局，与叶子部署对齐）")
    ap.add_argument("--finetune-conv", action="store_true",
                   help="微调策略卷积（W1/b1/W2/b2）以承载价值信息；默认仅训价值头")
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--log-every", type=int, default=100)
    a = ap.parse_args()

    t0 = time.time()
    games = load_labeled_games(a.corpus, a.size)
    if a.balance:
        games, (nb, nw, nd, nbal) = balance_games(games, seed=a.seed)
        print(f"平衡：黑胜局={nb} 白胜局={nw} 和局={nd} → 各取 {nbal} + 和局 → 共 {len(games)} 局")
    X, Y, G, ng = build_positions(games, a.size, a.max_positions, tail=a.tail)
    tr, va, cut = split_by_game(G, ng, a.val_frac)
    dt_build = time.time() - t0

    print(f"== CNN 价值头训练 ==  size={a.size}  corpus={a.corpus}")
    print(f"语料：局数={ng} 样本={X.shape[0]} 训练={len(tr)} 留出={len(va)}（cut game={cut}） 用时 {dt_build:.1f}s")
    if len(tr) == 0 or len(va) == 0:
        print("!! 样本不足", file=sys.stderr)
        sys.exit(2)

    net = PolicyCNN.load(a.cnn)
    vkeys = ["Wv", "bv"]
    ckeys = ["W1", "b1", "W2", "b2"]
    opt_keys = (ckeys + vkeys) if a.finetune_conv else vkeys
    opt = Adam({k: net.params[k] for k in opt_keys}, lr=a.lr)
    print(f"微调卷积: {'是(W1/b1/W2/b2+价值头)' if a.finetune_conv else '否(仅价值头)'}")

    curve = []
    t1 = time.time()
    step = 0
    last_loss = float("nan")
    rng = np.random.default_rng(a.seed)
    zeros = None
    while step < a.steps:
        perm = rng.permutation(tr)
        for i in range(0, len(perm) - a.batch + 1, a.batch):
            if step >= a.steps:
                break
            b = perm[i:i + a.batch]
            xb = X[b].astype(F32)
            yb = Y[b]
            logits, value, cache = net.forwardV(xb)
            loss, dvalue = value_mse(value, yb)
            if zeros is None or zeros.shape != logits.shape:
                zeros = np.zeros_like(logits)
            # 微调卷积时传零 dlogits（非 None）→ 价值梯度流入卷积；否则 None 早返回只训价值头
            dlogits = zeros if a.finetune_conv else None
            grads = net.backward(cache, dlogits, dvalue)
            sub_params = {k: net.params[k] for k in opt_keys}
            sub_grads = {k: grads[k] for k in opt_keys}
            new = opt.step(sub_params, sub_grads)
            for k in opt_keys:
                net.params[k] = new[k]
            last_loss = loss
            step += 1
            if step % a.log_every == 0 or step == a.steps:
                vloss, vacc, vmb, vmw = eval_val(net, X, Y, va)
                curve.append({
                    "step": step, "train_mse": round(float(loss), 4),
                    "val_mse": round(vloss, 4), "val_acc": round(vacc, 4),
                    "val_mean_blackwon": round(vmb, 3), "val_mean_whitewon": round(vmw, 3),
                    "elapsed_s": round(time.time() - t1, 1),
                })
                print(f"step {step:5d} | train_mse {loss:.4f} | val_mse {vloss:.4f} | "
                      f"val_acc {vacc*100:5.2f}% | val_mean(B胜局/白胜局) {vmb:.3f}/{vmw:.3f} | "
                      f"{time.time() - t1:6.1f}s")

    dt = time.time() - t1
    vloss, vacc, vmb, vmw = eval_val(net, X, Y, va)
    _, tacc, tmb, tmw = eval_val(net, X, Y, tr)

    meta = {
        "size": a.size, "corpus": a.corpus, "base_cnn": a.cnn, "balance": bool(a.balance),
        "steps": a.steps, "batch": a.batch, "lr": a.lr, "seed": a.seed,
        "val_frac": a.val_frac, "num_games": int(ng), "train_samples": int(len(tr)),
        "val_samples": int(len(va)), "cut_game": int(cut), "max_positions": a.max_positions,
        "final_train_mse": round(float(last_loss), 4),
        "val_mse": round(vloss, 4), "val_acc": round(vacc, 4),
        "val_mean_blackwon": round(vmb, 3), "val_mean_whitewon": round(vmw, 3),
        "train_acc": round(tacc, 4), "train_mean_blackwon": round(tmb, 3),
        "train_mean_whitewon": round(tmw, 3), "elapsed_s": round(dt, 1),
    }
    net.save(a.out, meta=meta)
    with open(a.out + ".curve.json", "w", encoding="utf-8") as f:
        json.dump({"meta": meta, "curve": curve}, f, ensure_ascii=False, indent=1)

    print(f"耗时 {dt:.1f}s（{step} 步 × batch {a.batch}）")
    print(f"留出：val_mse={vloss:.4f} val_acc={vacc*100:.2f}%  "
          f"val_mean(B胜局 {vmb:.3f}/白胜局 {vmw:.3f})")
    print(f"训练：train_acc={tacc*100:.2f}%  train_mean(B胜局 {tmb:.3f}/白胜局 {tmw:.3f})")
    print(f"权重已保存：{a.out}")
    print(f"FINAL size={a.size} val_mse={vloss:.4f} val_acc={vacc*100:.2f}% elapsed={dt:.1f}s")


if __name__ == "__main__":
    main()
