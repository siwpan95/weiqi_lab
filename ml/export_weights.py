#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""ml/export_weights.py — 把 numpy CNN 的权重导出为 JSON，供纯 JS 前向（tools/cnn_forward.mjs）使用。

设计意图：**保留 CNN 的完整预测力**，同时让运行期零依赖（只需权重 JSON，不需要 numpy）。
这是 `tools/distill_to_table.mjs`（模式表蒸馏）之外的第二条"零依赖化"路径 ——
前者把 CNN 压成局部查表（实测有损），后者原样保留前向（仅需一次权重导出）。

用法：
  python ml/export_weights.py --cnn ml/cnn-19.npz --out spec/cnn_weights-19.json
"""
import argparse
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import numpy as np  # noqa: E402
from cnn import PolicyCNN  # noqa: E402


def main():
    ap = argparse.ArgumentParser(description="导出 CNN 权重为 JSON（纯 JS 前向用）")
    ap.add_argument("--cnn", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()

    net = PolicyCNN.load(a.cnn)
    p = net.params
    has_value = "Wv" in p
    w = {
        "protocol": 1,
        "spec": "cnn-weights-v1",
        "source": os.path.basename(a.cnn),
        "size": int(net.size),
        "cin": int(net.cin),
        "ch1": int(net.ch1),
        "ch2": int(net.ch2),
        "has_value": has_value,
        "layers": "conv3x3(relu) -> conv3x3(relu) -> conv1x1 -> logits(HW)"
                  + (" ; value_head: globalmean(h2) -> linear -> sigmoid" if has_value else ""),
        "params": {
            "W1": p["W1"].astype(np.float32).ravel().tolist(),  # (ch1, cin, 3, 3) row-major
            "b1": p["b1"].astype(np.float32).tolist(),
            "W2": p["W2"].astype(np.float32).ravel().tolist(),  # (ch2, ch1, 3, 3)
            "b2": p["b2"].astype(np.float32).tolist(),
            "W3": p["W3"].astype(np.float32).ravel().tolist(),  # (1, ch2)
            "b3": p["b3"].astype(np.float32).tolist(),
        },
    }
    if has_value:
        w["params"]["Wv"] = p["Wv"].astype(np.float32).ravel().tolist()  # (ch2,)
        w["params"]["bv"] = p["bv"].astype(np.float32).ravel().tolist()  # (1,)
    with open(a.out, "w", encoding="utf-8") as f:
        json.dump(w, f, separators=(",", ":"))
    n = sum(len(v) for v in w["params"].values())
    print(f"导出 {n} 个参数 → {a.out}（{os.path.getsize(a.out)/1048576:.2f} MB）")


if __name__ == "__main__":
    main()
