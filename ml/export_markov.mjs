// ml/export_markov.mjs —— 复用只读的 tools/markov.mjs（PatternPolicy），
// 在 Python 侧导出的**同一批样本**上产出预测，供 eval_compare.py 做同口径对比。
//
// 设计要点：样本不靠 JS 重新 replay（避免两套规则实现漂移），而是由 Python 导出
// 每个样本在「最后一手 3×3 邻域」的原始棋色（9 个值）。PatternPolicy 的签名只读取
// 该邻域，故用零矩阵 + 回填 9 格即可等价重建其所需输入 → **样本与坐标口径 100% 一致**。
//
// 用法：
//   node ml/export_markov.mjs --train train.json --val val.json --size 9 --out markov_pred.json
//
// 输入 JSON：
//   train.json = {size, samples:[{t,l,n,nb:[9]}]}
//   val.json   = {size, samples:[{t,l,n,nb:[9]}]}     // 只用 t,l,nb 预测，n 仅用于交叉核对
// 输出 JSON：
//   {size, trained, val_n, covered, predict_ms, preds:[[[vertex,p],...],...], val_next:[...]}

import fs from "node:fs";
import { PatternPolicy } from "../tools/markov.mjs";

const args = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 2) args[argv[i].replace(/^--/, "")] = argv[i + 1];

const size = Number(args.size);
const train = JSON.parse(fs.readFileSync(args.train, "utf8"));
const val = JSON.parse(fs.readFileSync(args.val, "utf8"));

function cellsFromBlock(size, last, nb) {
  const cells = new Array(size * size).fill(0);
  const lx = last % size;
  const ly = Math.floor(last / size);
  for (let ky = 0; ky < 3; ky++) {
    for (let kx = 0; kx < 3; kx++) {
      const x = lx + (kx - 1);
      const y = ly + (ky - 1);
      if (x < 0 || y < 0 || x >= size || y >= size) continue;
      cells[y * size + x] = nb[ky * 3 + kx];
    }
  }
  return cells;
}

// 训练：模式条件转移模型（与 tools/train_markov.mjs 相同的默认参数 1 / 3 / 4）
const policy = new PatternPolicy(1, 3, 4);
let trained = 0;
for (const s of train.samples) {
  const cells = cellsFromBlock(size, s.l, s.nb);
  if (policy.observe({ cells, toMove: s.t, last: s.l }, size, s.n)) trained++;
}

// 预测
const t0 = Date.now();
const preds = [];
let covered = 0;
for (const s of val.samples) {
  const cells = cellsFromBlock(size, s.l, s.nb);
  const { top, source } = policy.topK({ cells, toMove: s.t, last: s.l }, size, 60);
  const arr = top.map((o) => [o.vertex, o.p]);
  if (source !== null && arr.length > 0) covered++;
  preds.push(arr);
}
const dt = Date.now() - t0;

const out = {
  size, trained, val_n: val.samples.length, covered, predict_ms: dt,
  preds, val_next: val.samples.map((s) => s.n),
};
fs.writeFileSync(args.out, JSON.stringify(out), "utf8");
console.log(`markov: 有效训练样本 ${trained}/${train.samples.length}；留出 ${val.samples.length} 手；` +
  `有上下文覆盖 ${covered}（${(covered / Math.max(1, val.samples.length) * 100).toFixed(1)}%）；` +
  `预测耗时 ${dt}ms`);
