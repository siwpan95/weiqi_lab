import numpy as np, sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cnn import PolicyCNN, masked_softmax_ce
F32 = np.float32
rng = np.random.default_rng(0)
S = 5
net = PolicyCNN(S, cin=6, ch1=4, ch2=3, seed=1)
N = 4
X = (rng.random((N, 6, S, S)) > 0.6).astype(F32)
legal = (X[:, 2].reshape(N, S * S) > 0)
Y = np.array([int(np.where(legal[i])[0][0]) for i in range(N)])

def L(params_copy, X, Y, legal):
    old = {k: net.params[k] for k in net.params}
    net.params = params_copy
    l, _ = masked_softmax_ce(net.forward(X)[0], Y, legal)
    net.params = old
    return l

logits, cache = net.forward(X)
loss, dlogits = masked_softmax_ce(logits, Y, legal)
grads = net.backward(cache, dlogits)

# 方向导数校验（对每个参数张量分别做；避免跨参数量纲混叠）
eps = 5e-3
allpass = True
for k in ["W1", "b1", "W2", "b2", "W3", "b3"]:
    P = net.params[k]
    D = rng.standard_normal(P.shape).astype(F32)
    # 归一化方向
    D = D / (np.linalg.norm(D.reshape(-1)) + 1e-12)
    Pp = {kk: v.copy() for kk, v in net.params.items()}
    Pm = {kk: v.copy() for kk, v in net.params.items()}
    Pp[k] = (P + eps * D).astype(F32)
    Pm[k] = (P - eps * D).astype(F32)
    num = (L(Pp, X, Y, legal) - L(Pm, X, Y, legal)) / (2 * eps)
    ana = float((grads[k].astype(np.float64) * D.astype(np.float64)).sum())
    rel = abs(num - ana) / max(1e-6, abs(num) + abs(ana))
    ok = rel < 5e-2 or (abs(num) < 1e-5 and abs(ana) < 1e-5)  # 两者同近 0（如 b3 对 softmax 不变）视为一致
    allpass = allpass and ok
    print(f"{k:3s} 方向导数 数值={num:+.6e} 解析={ana:+.6e} 相对误差={rel:.2e} {'OK' if ok else 'BAD'}")
print("loss =", loss)
print("GATE:", "PASS" if allpass else "FAIL")
