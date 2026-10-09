// tools/tests_markov.mjs — 模式条件转移模型（PatternPolicy）自测（零依赖）
//
//   node tools/tests_markov.mjs
//   → 末行输出 "PASS: N passed, 0 failed"（有失败则 "FAIL: ..." 并退出码 1）
//
// 覆盖：① 对称帧（canonical frames）旋转一致性——主表 8 朝向 / 十字退避 4 旋转；
//       ② 原始帧（raw，旧模型语义）在同一判据下**必然失败**（把缺陷钉成回归测试）；
//       ③ toJSON/fromJSON 往返保帧语义；④ 分布归一性。

import { PatternPolicy, signatureEx, signatureCrossEx, symOffset, crossOffset } from "./markov.mjs";
import { sigProbe, xfProbe } from "../JsWeiqi/ai.mjs";

let passed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) passed++;
  else failures.push(`${name}${detail ? " — " + detail : ""}`);
}

const N = 9;
const center = 4 * N + 4;

/** 造一个"规范朝向"的样本：中心 = 对方最后一手，己方子落在 ownOff，返回 cells */
function makeCells(rot, ownOff) {
  const cells = new Uint8Array(N * N);
  cells[center] = 2;
  for (const [dx, dy] of ownOff) {
    const [nx, ny] = rot ? symOffset(rot, dx, dy, false) : [dx, dy];
    cells[center + ny * N + nx] = 1;
  }
  return cells;
}
const pt = (dx, dy) => center + dy * N + dx;
const offOf = (p) => [(p % N) - (center % N), Math.floor(p / N) - Math.floor(center / N)];

// ---------------------------------------------------------------- ① 主表：8 朝向旋转一致性
// 规则：己方子在 (1,0) 与 (1,1)（破坏全部 8 对称），应手在 (-1,0)。
// 训练时把 8 个朝向各喂一次；查询时对每个朝向取 top-1，正确者应为该朝向的应手。
{
  const ownOff = [[1, 0], [1, 1]];
  const respCanon = [-1, 0];
  const can = new PatternPolicy(1, 3, 0, 0, true);
  const raw = new PatternPolicy(1, 3, 0, 0, false);
  for (let r = 0; r < 8; r++) {
    const cells = makeCells(r, ownOff);
    const [rx, ry] = symOffset(r, respCanon[0], respCanon[1], false);
    const next = pt(rx, ry);
    check(`主表 observe(rot=${r})`, can.observe({ cells, toMove: 1, last: center }, N, next) === true);
    raw.observe({ cells, toMove: 1, last: center }, N, next);
  }
  let canHit = 0;
  let rawHit = 0;
  for (let r = 0; r < 8; r++) {
    const cells = makeCells(r, ownOff);
    const [rx, ry] = symOffset(r, respCanon[0], respCanon[1], false);
    const truth = pt(rx, ry);
    const a = can.topK({ cells, toMove: 1, last: center }, N, 1);
    const b = raw.topK({ cells, toMove: 1, last: center }, N, 1);
    if (a.top.length && a.top[0].vertex === truth) canHit += 1;
    if (b.top.length && b.top[0].vertex === truth) rawHit += 1;
  }
  check("主表 canonical：8 朝向 top-1 全中", canHit === 8, `hit=${canHit}/8`);
  check("主表 raw：朝向抹平（回归钉子，期望 ≤4/8）", rawHit <= 4, `hit=${rawHit}/8`);
}

// ---------------------------------------------------------------- ② 十字退避：4 旋转一致性
// backoffMin 设为极大 → 强制走退避表。己方子在 N（十字上唯一定向），应手在 W。
{
  const ownOff = [[0, 1]];
  const respCanon = [-1, 0];
  const can = new PatternPolicy(1, 3, 1e9, 0, true);
  const raw = new PatternPolicy(1, 3, 1e9, 0, false);
  for (let r = 0; r < 4; r++) {
    const cells = makeCells(r, ownOff);
    const [rx, ry] = symOffset(r, respCanon[0], respCanon[1], false);
    can.observe({ cells, toMove: 1, last: center }, N, pt(rx, ry));
    raw.observe({ cells, toMove: 1, last: center }, N, pt(rx, ry));
  }
  let canHit = 0;
  let rawHit = 0;
  for (let r = 0; r < 4; r++) {
    const cells = makeCells(r, ownOff);
    const [rx, ry] = symOffset(r, respCanon[0], respCanon[1], false);
    const truth = pt(rx, ry);
    const a = can.topK({ cells, toMove: 1, last: center }, N, 1);
    const b = raw.topK({ cells, toMove: 1, last: center }, N, 1);
    check(`十字表 canonical 走退避（rot=${r}）`, a.source === "cross", `source=${a.source}`);
    if (a.top.length && a.top[0].vertex === truth) canHit += 1;
    if (b.top.length && b.top[0].vertex === truth) rawHit += 1;
  }
  check("十字退避 canonical：4 旋转 top-1 全中", canHit === 4, `hit=${canHit}/4`);
  check("十字退避 raw：旋转抹平（回归钉子，期望 ≤2/4）", rawHit <= 2, `hit=${rawHit}/4`);
}

// ---------------------------------------------------------------- ③ 偏移变换自洽性
{
  let ok = true;
  for (let s = 0; s < 8; s++) {
    const f = symOffset(s, 2, 1, false);
    const b = symOffset(s, f[0], f[1], true);
    if (b[0] !== 2 || b[1] !== 1) ok = false;
  }
  check("symOffset 正逆互消（8 对称）", ok);
  let okC = true;
  for (let r = 0; r < 4; r++) {
    const f = crossOffset(r, 2, 1, false);
    const b = crossOffset(r, f[0], f[1], true);
    if (b[0] !== 2 || b[1] !== 1) okC = false;
  }
  check("crossOffset 正逆互消（4 旋转）", okC);
  // 与 signatureEx 的 argmin 下标一致性：同一棋形、8 个朝向的签名键必须相同
  const ownOff = [[1, 0], [1, 1]];
  const keys = [];
  for (let r = 0; r < 8; r++) keys.push(signatureEx({ cells: makeCells(r, ownOff), toMove: 1, last: center }, N, 1).key);
  check("signatureEx：8 朝向同键", new Set(keys).size === 1, `keys=${new Set(keys).size}`);
  const ckeys = [];
  for (let r = 0; r < 4; r++) ckeys.push(signatureCrossEx({ cells: makeCells(r, ownOff), toMove: 1, last: center }, N).key);
  check("signatureCrossEx：4 旋转同键", new Set(ckeys).size === 1, `keys=${new Set(ckeys).size}`);
}

// ---------------------------------------------------------------- ④ 序列化往返 + 归一性
{
  const ownOff = [[1, 0], [1, 1]];
  const p = new PatternPolicy(1, 3, 0, 0, true);
  for (let r = 0; r < 8; r++) {
    const [rx, ry] = symOffset(r, -1, 0, false);
    p.observe({ cells: makeCells(r, ownOff), toMove: 1, last: center }, N, pt(rx, ry));
  }
  const j = JSON.parse(JSON.stringify(p.toJSON()));
  check("toJSON 带 frames=canonical", j.frames === "canonical");
  const q = PatternPolicy.fromJSON(j);
  check("fromJSON 保帧语义", q.canonicalFrames === true);
  const s = { cells: makeCells(3, ownOff), toMove: 1, last: center };
  const [rx, ry] = symOffset(3, -1, 0, false);
  const t = q.topK(s, N, 1);
  check("往返后 top-1 不变", t.top.length === 1 && t.top[0].vertex === pt(rx, ry));
  const d = q.distribution(s, N);
  const sum = d.dist.reduce((a, x) => a + x.p, 0);
  check("分布归一（Σp=1）", Math.abs(sum - 1) < 1e-9, `sum=${sum}`);
  const oldModel = PatternPolicy.fromJSON({ radius: 1, moveRadius: 3, backoffMin: 1, backoffRadius: 0, samples: 0, table: {}, cross: {} });
  check("旧模型（无 frames 字段）按 raw 解释", oldModel.canonicalFrames === false);
}

// ---------------------------------------------------------------- ⑤ 偏移与点索引的一致性
{
  const ownOff = [[1, 0], [1, 1]];
  const p = new PatternPolicy(1, 3, 0, 0, true);
  const cells = makeCells(0, ownOff);
  p.observe({ cells, toMove: 1, last: center }, N, pt(-1, 0));
  const d = p.distribution({ cells, toMove: 1, last: center }, N);
  check("distribution 返回盘面帧偏移", d && d.dist.length === 1 && d.dist[0].off[0] === -1 && d.dist[0].off[1] === 0,
    JSON.stringify(d && d.dist));
  const [ox, oy] = offOf(pt(-1, 0));
  check("偏移 ↔ 点索引一致", ox === -1 && oy === 0);
}

// ---------------------------------------------------------------- ⑥ 引擎侧快速签名与 markov.mjs 的**逐位一致**
// 引擎（JsWeiqi/ai.mjs）为性能用基 4 整数编码重写了签名/偏移变换；此处交叉校验两者语义相同。
{
  let seed = 20261009;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  let n = 0;
  let mism = 0;
  let firstMism = "";
  for (const size of [9, 13, 19]) {
    for (let it = 0; it < 400; it++) {
      const cells = new Uint8Array(size * size);
      const empties = [];
      for (let i = 0; i < cells.length; i++) {
        const r = rnd();
        if (r < 0.15) { cells[i] = 1; } else if (r < 0.3) { cells[i] = 2; } else { empties.push(i); }
      }
      if (empties.length === 0) continue;
      const last = empties[Math.floor(rnd() * empties.length)];
      const toMove = rnd() < 0.5 ? 1 : 2;
      const sample = { cells: Array.from(cells), toMove, last };
      const ex1 = signatureEx(sample, size, 1);
      const ex2 = signatureEx(sample, size, 2);
      const exC = signatureCrossEx(sample, size);
      const got = sigProbe(cells, size, toMove, last, 1);
      const got2 = sigProbe(cells, size, toMove, last, 2);
      n += 1;
      // 引擎返回**数字串**（其内部为基 4 整数编码），markov.mjs 返回数字串 → 统一按基 4
      // 数值再转字符串比较（前导 0 不影响数值；键长 ≤ 2·边² ≤ 50 bit，未超 Number 安全整数）
      const k1 = String(parseInt(ex1.key, 4));
      const k2 = String(parseInt(ex2.key, 4));
      const kc = String(parseInt(exC.key, 4));
      if (got.main.key !== k1 || got.main.sym !== ex1.sym
          || got2.main.key !== k2 || got2.main.sym !== ex2.sym
          || got.cross.key !== kc || got.cross.rot !== exC.rot) {
        mism += 1;
        if (!firstMism) {
          firstMism = `size=${size} it=${it} last=${last} toMove=${toMove} `
            + `main(1): ${ex1.key}/${ex1.sym} vs ${got.main.key}/${got.main.sym} `
            + `| main(2): ${ex2.key}/${ex2.sym} vs ${got2.main.key}/${got2.main.sym} `
            + `| cross: ${exC.key}/${exC.rot} vs ${got.cross.key}/${got.cross.rot}`;
        }
      }
    }
  }
  check(`sigParity：引擎快速签名与 markov.mjs 逐位一致（${n} 组随机局面 ×3 签名）`, mism === 0, firstMism);

  let xfBad = 0;
  let xfFirst = "";
  for (let s = 0; s < 8; s++) {
    for (let dx = -3; dx <= 3; dx++) {
      for (let dy = -3; dy <= 3; dy++) {
        const want = symOffset(s, dx, dy, true);
        const got = xfProbe(s, dx, dy, false);
        if (got[0] !== want[0] || got[1] !== want[1]) {
          xfBad += 1;
          if (!xfFirst) xfFirst = `sym=${s} off=(${dx},${dy}) want=${want} got=${got}`;
        }
      }
    }
  }
  for (let r = 0; r < 4; r++) {
    for (let dx = -3; dx <= 3; dx++) {
      for (let dy = -3; dy <= 3; dy++) {
        const want = crossOffset(r, dx, dy, true);
        const got = xfProbe(r, dx, dy, true);
        if (got[0] !== want[0] || got[1] !== want[1]) {
          xfBad += 1;
          if (!xfFirst) xfFirst = `rot=${r} off=(${dx},${dy}) want=${want} got=${got}`;
        }
      }
    }
  }
  check("xfParity：引擎偏移变换与 markov.mjs 一致（8×49 + 4×49 组）", xfBad === 0, xfFirst);
}

for (const f of failures) process.stdout.write("  FAIL " + f + "\n");
if (failures.length === 0) {
  process.stdout.write(`PASS: ${passed} passed, 0 failed\n`);
  process.exit(0);
}
process.stdout.write(`FAIL: ${passed} passed, ${failures.length} failed\n`);
process.exit(1);
