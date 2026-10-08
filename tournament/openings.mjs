// tournament/openings.mjs — 开局库（Tier 1 对应物）
//
// 9 路开局：在中央 5×5 区（C3..G7）内随机取点，避开已有的 2 邻域，生成多样化开局线。
// 由 seed 决定，可复现。

const COLS = "ABCDEFGHJKLMNOPQRST";

export function makeRng(seed) {
  let s = BigInt(seed) & ((1n << 64n) - 1n);
  const MASK = (1n << 64n) - 1n;
  return () => {
    s = (s + 0x9e3779b97f4a7c15n) & MASK;
    let z = s;
    z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK;
    z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK;
    z = (z ^ (z >> 31n)) & MASK;
    return Number(z % BigInt(1 << 30)) / (1 << 30);
  };
}

export function vertexOf(idx, size) {
  return COLS[idx % size] + String(Math.floor(idx / size) + 1);
}

/** 生成一条开局线：返回 [{color:"B",vertex:"E5"}, ...] */
export function openingLine(size, plies, seed) {
  const rnd = makeRng(seed);
  if (plies <= 0) return [];
  const lo = Math.max(0, Math.floor(size / 2) - 2);
  const hi = Math.min(size - 1, Math.floor(size / 2) + 2);
  const zone = [];
  for (let y = lo; y <= hi; y++) {
    for (let x = lo; x <= hi; x++) zone.push({ x, y, idx: y * size + x });
  }
  const picked = [];
  const line = [];
  let color = 1;
  for (let p = 0; p < plies; p++) {
    const cands = zone.filter(({ x, y }) =>
      picked.every((q) => Math.max(Math.abs(q.x - x), Math.abs(q.y - y)) >= 2));
    if (!cands.length) break;
    const c = cands[Math.floor(rnd() * cands.length) % cands.length];
    picked.push(c);
    line.push({ color: color === 1 ? "B" : "W", vertex: vertexOf(c.idx, size) });
    color = 3 - color;
  }
  return line;
}
