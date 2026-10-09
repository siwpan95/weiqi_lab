// tools/cnn_forward.mjs — 纯 JavaScript 的 CNN 策略前向（**运行期零依赖**：只读权重 JSON）
//
// 与 ml/cnn.py 的 PolicyCNN 严格等价（conv3x3→relu→conv3x3→relu→conv1x1 → 每点 logit）。
// 权重由 `python ml/export_weights.py --cnn ml/cnn-<size>.npz --out spec/cnn_weights-<size>.json` 导出。
//
// 设计说明（为什么不用"模式表蒸馏"）：实测把 CNN 蒸馏成 3×3/5×5 局部查表后 top-1 只有
// 7.05%/7.33%（与计数表 7.25% 持平），而 CNN 本体是 25.84% —— 局部上下文装不下全局信息。
// 故"零依赖化"选**权重导出 + 纯 JS 前向**这条路：保留完整预测力，运行期不需要 numpy。

import fs from "node:fs";
import { pathToFileURL } from "node:url";

export const COLS = "ABCDEFGHJKLMNOPQRST";

/** 线位平面：到最近边距离 +1（与 ml/corpus.py::_line_plane 一致，0 起） */
export function linePlane(size) {
  const p = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      p[y * size + x] = Math.min(x, y, size - 1 - x, size - 1 - y) + 1;
    }
  }
  return p;
}

/** 构造 6 个平面（与 ml/corpus.py::make_planes 完全一致） */
export function makePlanes(cells, size, toMove, last, line) {
  const n = size * size;
  const P = new Float32Array(6 * n);
  for (let i = 0; i < n; i++) {
    const v = cells[i];
    P[0 * n + i] = v === toMove ? 1 : 0;
    P[1 * n + i] = v === 3 - toMove ? 1 : 0;
    P[2 * n + i] = v === 0 ? 1 : 0;
    P[4 * n + i] = toMove === 1 ? 1 : 0;
    P[5 * n + i] = line[i];
  }
  if (last >= 0) P[3 * n + last] = 1;
  return P;
}

export class CnnPolicy {
  constructor(obj) {
    this.size = obj.size;
    this.cin = obj.cin;
    this.ch1 = obj.ch1;
    this.ch2 = obj.ch2;
    const q = obj.params;
    this.W1 = Float32Array.from(q.W1);
    this.b1 = Float32Array.from(q.b1);
    this.W2 = Float32Array.from(q.W2);
    this.b2 = Float32Array.from(q.b2);
    this.W3 = Float32Array.from(q.W3);
    this.b3 = Float32Array.from(q.b3);
    this.line = linePlane(this.size);
  }

  static load(path) {
    return new CnnPolicy(JSON.parse(fs.readFileSync(path, "utf8")));
  }

  /**
   * 单样本前向。planes: Float32Array(cin*S*S) → logits Float32Array(S*S)
   * 逐点卷积（无 im2col 矩阵库），19×19 实测约 20–40 ms/次。
   */
  forwardOne(planes, out = new Float32Array(this.size * this.size)) {
    const S = this.size;
    const HW = S * S;
    const { cin, ch1, ch2, W1, b1, W2, b2, W3, b3 } = this;
    // ---- layer1: conv3x3 + relu ----
    const h1 = new Float32Array(ch1 * HW);
    for (let o = 0; o < ch1; o++) {
      const wBase = o * cin * 9;
      const bb = b1[o];
      for (let y = 0; y < S; y++) {
        for (let x = 0; x < S; x++) {
          let acc = bb;
          for (let c = 0; c < cin; c++) {
            const cBase = c * HW;
            for (let i = 0; i < 3; i++) {
              const yy = y + i - 1;
              if (yy < 0 || yy >= S) continue;
              for (let j = 0; j < 3; j++) {
                const xx = x + j - 1;
                if (xx < 0 || xx >= S) continue;
                acc += planes[cBase + yy * S + xx] * W1[wBase + c * 9 + i * 3 + j];
              }
            }
          }
          h1[o * HW + y * S + x] = acc > 0 ? acc : 0;
        }
      }
    }
    // ---- layer2: conv3x3 + relu ----
    const h2 = new Float32Array(ch2 * HW);
    for (let o = 0; o < ch2; o++) {
      const wBase = o * ch1 * 9;
      const bb = b2[o];
      for (let y = 0; y < S; y++) {
        for (let x = 0; x < S; x++) {
          let acc = bb;
          for (let c = 0; c < ch1; c++) {
            const cBase = c * HW;
            for (let i = 0; i < 3; i++) {
              const yy = y + i - 1;
              if (yy < 0 || yy >= S) continue;
              for (let j = 0; j < 3; j++) {
                const xx = x + j - 1;
                if (xx < 0 || xx >= S) continue;
                acc += h1[cBase + yy * S + xx] * W2[wBase + c * 9 + i * 3 + j];
              }
            }
          }
          h2[o * HW + y * S + x] = acc > 0 ? acc : 0;
        }
      }
    }
    // ---- layer3: 1x1 → logits ----
    for (let p = 0; p < HW; p++) {
      let acc = b3[0];
      for (let o = 0; o < ch2; o++) acc += h2[o * HW + p] * W3[o];
      out[p] = acc;
    }
    return out;
  }

  /** 便捷：由盘面直接得到 logits */
  logitsFrom(cells, toMove, last) {
    return this.forwardOne(makePlanes(cells, this.size, toMove, last, this.line));
  }

  /** 软掩码（占用点）后取 top-K：cells 为空点集合 */
  topK(cells, toMove, last, k = 3) {
    const logits = this.logitsFrom(cells, toMove, last);
    const idx = [];
    for (let i = 0; i < cells.length; i++) if (cells[i] === 0) idx.push(i);
    idx.sort((a, b) => logits[b] - logits[a] || a - b);
    const top = idx.slice(0, k);
    // softmax 仅在 top-K 上做（仅需相对概率以采样）
    const mx = logits[top[0]];
    const exps = top.map((i) => Math.exp(logits[i] - mx));
    const s = exps.reduce((a, b) => a + b, 0);
    return top.map((i, j) => ({ vertex: i, p: exps[j] / s }));
  }
}

// ---------- CLI：校验用探针（导出若干局面的 JS logits，供与 Python 对拍） ----------
async function main() {
  const args = process.argv.slice(2);
  const arg = (n, d = null) => {
    const i = args.indexOf("--" + n);
    return i >= 0 ? args[i + 1] : d;
  };
  const corpus = arg("corpus");
  const weights = arg("weights");
  const size = Number(arg("size", 19));
  const count = Number(arg("count", 20));
  const out = arg("out");
  if (!corpus || !weights || !out) {
    console.error("用法: node tools/cnn_forward.mjs --corpus <jsonl> --weights <json> --size 19 --count 20 --out <jsonl>");
    process.exit(2);
  }
  const { Ref, parseVertex } = await import("../tournament/referee.mjs");
  const net = CnnPolicy.load(weights);
  const lines = fs.readFileSync(corpus, "utf8").trim().split("\n").filter(Boolean);
  const outp = [];
  let done = 0;
  for (let gi = 0; gi < lines.length && done < count; gi++) {
    const g = JSON.parse(lines[gi]);
    if (Number(g.size) !== size) continue;
    const ref = new Ref(size, g.komi ?? 7.5, "cn");
    let last = -1;
    for (let ply = 0; ply < g.moves.length && done < count; ply++) {
      const s = g.moves[ply];
      const color = s[0] === "B" ? 1 : 2;
      if (ref.side !== color) break;
      const v = s.slice(1) === "pass" ? -1 : parseVertex(s.slice(1), size);
      if (last >= 0 && v >= 0 && ply % 7 === 0) {
        const logits = net.logitsFrom(ref.cells, color, last);
        outp.push(JSON.stringify({ g: gi, p: ply, logits: Array.from(logits) }));
        done += 1;
      }
      const r = ref.play(color, v);
      if (!r.ok) break;
      last = v;
    }
  }
  fs.writeFileSync(out, outp.join("\n") + "\n", "utf8");
  console.log(`JS 探针导出 ${outp.length} 个局面 → ${out}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
