// scoring.mjs — 纯函数死子判定 + 含死子面积计分（area scoring with dead-stone removal）。
//
// 设计取向（与本项目「零依赖 / 可复现」一致）：
//   - 不依赖任何 Board 实现，只接受 (cells, size, neigh) 平面数据 → 引擎与裁判可共用，行为逐位一致。
//   - 与 tournament/referee.mjs 的 score(dead) 语义对齐：死子被移除后重做 flood-fill，
//     其原落点计入包围方领地（面积法下死子不另计 prisoner，与 referee 面积分支一致）。
//   - 死子判定是「区域的纯函数」，给定终局面唯一确定 → 满足同 (seed,playouts,profile) 可复现。
//
// 死子判定启发（经典 flood-fill + 眼/领地归属，与 Fuego/GnuGo 简化判定同构）：
//   1. 对空点做连通域 flood-fill，每空域的「归属」= 它只与某一色棋子相邻 ⇒ 该色领地；否则（同时邻两色或盘边）
//      为 neutral（dame）。
//   2. 对每个棋块：若它相邻的空域中存在「己方领地」（owner === 该块颜色），则活（拥有眼/领地空间）；
//      否则（相邻空域全为对方领地或 neutral，且自身不围出己方空间）判死。
//   ⚠️ 已知局限：双活（seki，双方共享 neutral 点）两方都会判死 → 误杀；本项目已明确 seki 降级不做（docs/ROADMAP.md §4）。
//      单官/大龙/打劫死活等常见情形正确。

/** 构造邻接表：neigh[i] = 与 i 正交相邻的合法点索引数组（无盘外哨兵）。 */
export function buildNeigh(size) {
  const n2 = size * size;
  const neigh = new Array(n2);
  for (let i = 0; i < n2; i++) {
    const x = i % size;
    const y = (i - x) / size;
    const arr = [];
    if (x > 0) arr.push(i - 1);
    if (x < size - 1) arr.push(i + 1);
    if (y > 0) arr.push(i - size);
    if (y < size - 1) arr.push(i + size);
    neigh[i] = arr;
  }
  return neigh;
}

/**
 * 死子判定：给定终局面（cells / size / neigh），返回死子点索引的 Set。
 * 纯函数、确定性、不修改入参。
 */
export function deadStones(cells, size, neigh) {
  const n2 = size * size;
  // 1) 空域 flood-fill，给每个空点打 region id，并记录每 region 的归属色。
  const regionId = new Int32Array(n2).fill(-1);
  const regionOwner = []; // 下标 = region id；值 = 0 neutral / 1 black / 2 white
  let rid = 0;
  for (let s = 0; s < n2; s++) {
    if (cells[s] !== 0 || regionId[s] !== -1) continue;
    const stack = [s];
    regionId[s] = rid;
    const borders = new Set();
    while (stack.length) {
      const cur = stack.pop();
      const nbArr = neigh[cur];
      for (let k = 0; k < nbArr.length; k++) {
        const nb = nbArr[k];
        const v = cells[nb];
        if (v === 0) {
          if (regionId[nb] === -1) { regionId[nb] = rid; stack.push(nb); }
        } else {
          borders.add(v);
        }
      }
    }
    regionOwner[rid] = borders.size === 1 ? (borders.has(1) ? 1 : 2) : 0;
    rid += 1;
  }
  // 2) 棋块扫描：若块相邻的空域中存在「己方领地」则活，否则死。
  const groupSeen = new Uint8Array(n2);
  const dead = new Set();
  for (let s = 0; s < n2; s++) {
    const c = cells[s];
    if (c === 0 || groupSeen[s]) continue;
    const stack = [s];
    groupSeen[s] = 1;
    const adjRegions = new Set();
    while (stack.length) {
      const cur = stack.pop();
      const nbArr = neigh[cur];
      for (let k = 0; k < nbArr.length; k++) {
        const nb = nbArr[k];
        if (cells[nb] === 0) {
          adjRegions.add(regionId[nb]);
        } else if (cells[nb] === c && !groupSeen[nb]) {
          groupSeen[nb] = 1;
          stack.push(nb);
        }
      }
    }
    let alive = false;
    for (const r of adjRegions) {
      if (regionOwner[r] === c) { alive = true; break; }
    }
    if (!alive) dead.add(s);
  }
  return dead;
}

/**
 * 含死子的面积计分：移除 deadSet 中的子（置 0），重做 flood-fill 算领地，
 * 返回 [blackArea, whiteArea]（= 活子数 + 领地数）。与 referee.score(dead) 面积分支逐位一致。
 * deadSet 为 null / 空 ⇒ 退化为普通面积法。
 */
export function areaWithDead(cells, size, neigh, deadSet) {
  const n2 = size * size;
  let work = cells;
  if (deadSet && deadSet.size) {
    work = cells.slice();
    for (const m of deadSet) {
      if (work[m] !== 0) work[m] = 0;
    }
  }
  const seen = new Uint8Array(n2);
  let bs = 0; // black 领地
  let ws = 0; // white 领地
  for (let s = 0; s < n2; s++) {
    if (work[s] !== 0 || seen[s]) continue;
    const stack = [s];
    seen[s] = 1;
    let sizeRegion = 1;
    const borders = new Set();
    while (stack.length) {
      const cur = stack.pop();
      const nbArr = neigh[cur];
      for (let k = 0; k < nbArr.length; k++) {
        const nb = nbArr[k];
        const v = work[nb];
        if (v === 0) {
          if (!seen[nb]) { seen[nb] = 1; stack.push(nb); sizeRegion += 1; }
        } else {
          borders.add(v);
        }
      }
    }
    if (borders.size === 1 && borders.has(1)) bs += sizeRegion;
    else if (borders.size === 1 && borders.has(2)) ws += sizeRegion;
  }
  let bStone = 0;
  let wStone = 0;
  for (let i = 0; i < n2; i++) {
    if (work[i] === 1) bStone += 1;
    else if (work[i] === 2) wStone += 1;
  }
  return [bStone + bs, wStone + ws];
}

/** 把 deadStones 的索引集合转成 referee.score(dead) 接受的 [color, vertex] 对数组。 */
export function deadPairs(cells, deadSet) {
  const out = [];
  for (const m of deadSet) out.push([cells[m], m]);
  return out;
}
