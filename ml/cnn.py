#!/usr/bin/env python
# ml/cnn.py —— 纯 numpy 手写小型 CNN 策略网络（前向 + 反向 + 训练）
#
# 架构（与任务要求一致）：
#   input(C_IN×S×S) → conv3x3(C1) → relu → conv3x3(C2) → relu → conv1x1(1) → 每点一个 logit
# 损失：掩码 softmax 交叉熵（只在合法/空点集合上归一化）。
# 优化器：Adam。
# 依赖：仅 numpy（禁止 torch/tensorflow/sklearn）。
#
# 实现说明：3×3 卷积用 im2col + BLAS matmul（numpy 的 matmul 走 BLAS，快）；
# 反向用 col2im 的 9 次切片累加（避免慢速 np.add.at）。

import numpy as np

F32 = np.float32


# --------------------------------------------------------------- im2col / col2im
def im2col(X, pad=1):
    """X (N,C,H,W) → (N, C*9, H*W)；3×3 核、stride 1、指定 pad。返回 strided view。"""
    N, C, H, W = X.shape
    if pad > 0:
        Xp = np.pad(X, ((0, 0), (0, 0), (pad, pad), (pad, pad)))
    else:
        Xp = X
    s = Xp.strides
    col = np.lib.stride_tricks.as_strided(
        Xp, shape=(N, C, 3, 3, H, W),
        strides=(s[0], s[1], s[2], s[3], s[2], s[3]))
    return col.reshape(N, C * 9, H * W)


def col2im(col, N, C, H, W, pad=1):
    """im2col 的伴随（scatter-add）。col (N,C*9,H*W) → (N,C,H,W)。"""
    col = col.reshape(N, C, 3, 3, H, W)
    Hp, Wp = H + 2 * pad, W + 2 * pad
    Xp = np.zeros((N, C, Hp, Wp), dtype=col.dtype)
    for i in range(3):
        for j in range(3):
            Xp[:, :, i:i + H, j:j + W] += col[:, :, i, j, :, :]
    if pad > 0:
        return Xp[:, :, pad:pad + H, pad:pad + W]
    return Xp


# --------------------------------------------------------------- 网络
class PolicyCNN:
    """小型策略 CNN。参数以 dict 保存；size 决定输出点数 (size*size)。"""

    def __init__(self, size, cin=6, ch1=32, ch2=32, seed=0):
        self.size = int(size)
        self.cin = int(cin)
        self.ch1 = int(ch1)
        self.ch2 = int(ch2)
        rng = np.random.default_rng(seed)
        # He 初始化
        self.params = {
            "W1": (rng.normal(0, np.sqrt(2.0 / (cin * 9)), (ch1, cin, 3, 3))).astype(F32),
            "b1": np.zeros(ch1, dtype=F32),
            "W2": (rng.normal(0, np.sqrt(2.0 / (ch1 * 9)), (ch2, ch1, 3, 3))).astype(F32),
            "b2": np.zeros(ch2, dtype=F32),
            "W3": (rng.normal(0, np.sqrt(1.0 / ch2), (1, ch2))).astype(F32),
            "b3": np.zeros(1, dtype=F32),
            # ---- 价值头：在 h2 上全局均值池化 → 线性 → sigmoid（黑胜概率）----
            # 未训练时为零 → 恒输出 0.5（中性），不影响策略训练。
            "Wv": (rng.normal(0, np.sqrt(1.0 / ch2), (ch2,))).astype(F32),
            "bv": np.zeros(1, dtype=F32),
        }

    # ---------- 前向 ----------
    def forward(self, X):
        p = self.params
        N, cin, S, _ = X.shape
        HW = S * S
        ch1, ch2 = self.ch1, self.ch2
        col1 = im2col(X)                                   # (N, cin*9, HW)
        W1r = p["W1"].reshape(ch1, cin * 9)
        z1 = (col1.transpose(0, 2, 1) @ W1r.T) + p["b1"]   # (N,HW,ch1)
        z1 = z1.transpose(0, 2, 1)                         # (N,ch1,HW)
        h1 = np.maximum(z1, F32(0))
        col2 = im2col(h1.reshape(N, ch1, S, S))            # (N, ch1*9, HW)
        W2r = p["W2"].reshape(ch2, ch1 * 9)
        z2 = (col2.transpose(0, 2, 1) @ W2r.T) + p["b2"]   # (N,HW,ch2)
        z2 = z2.transpose(0, 2, 1)                         # (N,ch2,HW)
        h2 = np.maximum(z2, F32(0))
        logits = (h2.transpose(0, 2, 1) @ p["W3"].T)[:, :, 0] + p["b3"][0]  # (N,HW)
        cache = {"col1": col1, "z1": z1, "h1": h1, "col2": col2,
                 "z2": z2, "h2": h2, "N": N, "HW": HW}
        cache = {"col1": col1, "z1": z1, "h1": h1, "col2": col2,
                 "z2": z2, "h2": h2, "N": N, "HW": HW}
        return logits.astype(F32), cache

    # ---------- 前向（含价值头） ----------
    def forwardV(self, X):
        """与 forward 相同，但额外返回 value（黑胜概率 ∈ (0,1)）。
        价值头在 h2 上做全局均值池化 → 线性(Wv,bv) → sigmoid。"""
        logits, cache = self.forward(X)
        p = self.params
        N, ch2, HW = cache["N"], self.ch2, cache["HW"]
        h2 = cache["h2"]                                       # (N, ch2, H, W)
        h2mean = h2.reshape(N, ch2, HW).mean(axis=2)           # (N, ch2)
        zv = (h2mean @ p["Wv"] + p["bv"][0]).astype(F32)        # (N,)
        value = (1.0 / (1.0 + np.exp(-zv))).astype(F32)
        cache["zv"] = zv
        cache["h2mean"] = h2mean
        return logits.astype(F32), value, cache

    # ---------- 反向 ----------
    def backward(self, cache, dlogits, dvalue=None):
        p = self.params
        ch1, ch2 = self.ch1, self.ch2
        N = cache["N"]
        S = self.size
        HW = cache["HW"]
        h2 = cache["h2"]
        z2 = cache["z2"]
        h1 = cache["h1"]
        z1 = cache["z1"]
        col1 = cache["col1"]
        col2 = cache["col2"]
        # ---- 价值头梯度（汇入 dh2，并产 Wv/bv 梯度）----
        if dvalue is not None:
            zv = cache["zv"]
            sigm = 1.0 / (1.0 + np.exp(-zv))
            dsig = (dvalue * sigm * (1.0 - sigm)).astype(F32)            # (N,)
            h2mean = cache["h2mean"]                                       # (N, ch2)
            Wv = p["Wv"]
            dWv = (h2mean.T @ dsig).astype(F32)                            # (ch2,)
            dbv = np.asarray([dsig.sum()], dtype=F32)
            dh2_value = (dsig[:, None] * Wv[None, :])[:, :, None].repeat(HW, axis=2)  # (N,ch2,HW)
        else:
            dWv = None
            dbv = None
            dh2_value = 0.0
        # ---- 策略头梯度 ----
        W2r = p["W2"].reshape(ch2, ch1 * 9)
        h2t = h2.transpose(0, 2, 1)                        # (N,HW,ch2)
        db3 = dlogits.sum()
        dW3 = np.tensordot(h2t, dlogits, axes=([0, 1], [0, 1])).reshape(1, ch2)
        dh2_policy = (dlogits[:, :, None] * p["W3"][None, :]).transpose(0, 2, 1)  # (N,ch2,HW)
        dh2 = dh2_policy + dh2_value
        dpre2 = dh2 * (z2 > 0)
        dW2r = np.tensordot(dpre2, col2, axes=([0, 2], [0, 2]))  # (ch2,K2)
        db2 = dpre2.sum(axis=(0, 2))
        dcol2 = np.matmul(W2r.T, dpre2)                    # (N,K2,HW)
        dh1 = col2im(dcol2, N, ch1, S, S)                  # (N,ch1,S,S)
        dpre1 = dh1.reshape(N, ch1, HW) * (z1 > 0)
        dW1r = np.tensordot(dpre1, col1, axes=([0, 2], [0, 2]))  # (ch1,K1)
        db1 = dpre1.sum(axis=(0, 2))
        grads = {
            "W1": dW1r.reshape(p["W1"].shape),
            "b1": db1,
            "W2": dW2r.reshape(p["W2"].shape),
            "b2": db2,
            "W3": dW3,
            "b3": np.asarray([db3], dtype=F32),
        }
        if dWv is not None:
            grads["Wv"] = dWv
            grads["bv"] = dbv
        return grads

    # ---------- 保存 / 载入 ----------
    def save(self, path, meta=None):
        arrs = {k: v for k, v in self.params.items()}
        arrs["_meta_size"] = np.asarray([self.size])
        arrs["_meta_cin"] = np.asarray([self.cin])
        arrs["_meta_ch1"] = np.asarray([self.ch1])
        arrs["_meta_ch2"] = np.asarray([self.ch2])
        if meta:
            arrs["_meta_json"] = np.asarray([_meta_dumps(meta)])
        np.savez_compressed(path, **arrs)

    @classmethod
    def load(cls, path):
        z = np.load(path, allow_pickle=False)
        size = int(z["_meta_size"][0])
        cin = int(z["_meta_cin"][0])
        ch1 = int(z["_meta_ch1"][0])
        ch2 = int(z["_meta_ch2"][0])
        net = cls(size, cin, ch1, ch2)
        for k in ["W1", "b1", "W2", "b2", "W3", "b3"]:
            net.params[k] = z[k].astype(F32)
        # 价值头：旧权重文件可能不含 Wv/bv → 补零（输出恒 0.5，中性，不影响策略）
        if "Wv" in z:
            net.params["Wv"] = z["Wv"].astype(F32)
            net.params["bv"] = z["bv"].astype(F32)
        else:
            net.params["Wv"] = np.zeros(ch2, dtype=F32)
            net.params["bv"] = np.zeros(1, dtype=F32)
        return net


def _meta_dumps(meta):
    import json
    return json.dumps(meta, ensure_ascii=False)


# --------------------------------------------------------------- 损失 / 指标
def masked_softmax_ce(logits, targets, legal_mask):
    """掩码 softmax 交叉熵。logits (N,P) f32；targets (N,)；legal_mask (N,P) bool。
    返回 (loss, dlogits)（dlogits 已除以 N 且对非法点置 0）。"""
    L = np.where(legal_mask, logits, F32(-1e30))
    L = L - L.max(axis=1, keepdims=True)
    e = np.exp(L, dtype=F32)
    p = e / e.sum(axis=1, keepdims=True)
    n = np.arange(logits.shape[0])
    probs = np.maximum(p[n, targets], F32(1e-30))
    loss = float(-np.log(probs).mean())
    dL = p
    dL[n, targets] -= F32(1.0)
    dL *= F32(1.0 / logits.shape[0])
    dL *= legal_mask
    return loss, dL.astype(F32)


def legal_mask_from_input(X):
    """空点平面（索引 2）非零处即合法落点（占用点屏蔽）。
    注：未做 ko/自杀细判；**两个模型使用完全相同的屏蔽口径**。"""
    N, C, S, _ = X.shape
    return (X[:, 2].reshape(N, S * S) > 0)


def topk_hit(logits, targets, legal_mask, k=3):
    """返回 (hit1, hitk, covered)；covered=样本是否至少有一个合法点。"""
    L = np.where(legal_mask, logits, F32(-1e30))
    order = np.argsort(-L, axis=1)[:, :k]
    covered = legal_mask.any(axis=1)
    hit1 = (order[:, 0] == targets) & covered
    hitk = (order == targets[:, None]).any(axis=1) & covered
    return hit1.astype(np.float64), hitk.astype(np.float64), covered


def legal_target_valid(legal_mask, targets):
    """目标点是否在合法集合内（用于统计评估分母）。"""
    n = np.arange(targets.shape[0])
    return legal_mask[n, targets]


def value_mse(value, targets):
    """价值头回归损失（MSE on 黑胜概率）。value (N,) ∈ (0,1)；targets (N,) ∈ [0,1]
    （1=黑胜, 0=白胜, 0.5=和）。返回 (loss, dvalue)，dvalue 已除以 N。"""
    N = max(int(value.shape[0]), 1)
    diff = (value - targets).astype(F32)
    loss = float((diff * diff).mean() * 0.5)
    dvalue = (diff / N).astype(F32)
    return loss, dvalue


# --------------------------------------------------------------- Adam
class Adam:
    def __init__(self, params, lr=1e-3, beta1=0.9, beta2=0.999, eps=1e-8):
        self.lr = lr
        self.beta1 = beta1
        self.beta2 = beta2
        self.eps = eps
        self.t = 0
        self.m = {k: np.zeros_like(v) for k, v in params.items()}
        self.v = {k: np.zeros_like(v) for k, v in params.items()}

    def step(self, params, grads):
        self.t += 1
        b1, b2 = self.beta1, self.beta2
        for k in params:
            g = grads[k].astype(F32)
            self.m[k] = b1 * self.m[k] + (1 - b1) * g
            self.v[k] = b2 * self.v[k] + (1 - b2) * (g * g)
            mhat = self.m[k] / (1 - b1 ** self.t)
            vhat = self.v[k] / (1 - b2 ** self.t)
            params[k] = params[k] - (self.lr * mhat / (np.sqrt(vhat) + self.eps)).astype(F32)
        return params
