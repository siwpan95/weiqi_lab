// tools/import_human.mjs — 人类棋谱导入器（T3-A 语料升级）
//
// 从 tar.gz 归档（如 wangjinzhuo/pgd 职业棋谱库）**流式**抽取 SGF 并转为
// 与自对弈语料同构的 JSONL（spec/games/human-<date>.jsonl），供 tools/train_markov.mjs 直接复用：
//   MARKOV_CORPUS=spec/games/human-<date>.jsonl MARKOV_SIZE=19 node tools/train_markov.mjs
//
// 设计要点：
//   - 自研最小 tar 读取器 + zlib 流式解压：**不落地数万个 .sgf 文件**（Windows 上尤其重要）
//   - 逐局经 SGF 解析 → 过滤（盘径/手数/让子）→ 输出 `moves: ["Bdd","Wpp",...]`（引擎顶点串）
//   - 每类丢弃原因计数并输出，便于审计
//
// 用法：
//   node tools/import_human.mjs <tar.gz> [--max 6000] [--size 19] [--min-moves 100] [--max-scan 60000]

import fs from "node:fs";
import zlib from "node:zlib";
import { parseSgf } from "./sgf.mjs";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
const opt = (name, dflt) => {
  const i = args.indexOf("--" + name);
  return i >= 0 ? Number(args[i + 1]) : dflt;
};
const MAX_GAMES = opt("max", 6000);
const WANT_SIZE = opt("size", 19);
const MIN_MOVES = opt("min-moves", 100);
const MAX_SCAN = opt("max-scan", Math.max(20000, MAX_GAMES * 10));
const COLS = "ABCDEFGHJKLMNOPQRST";

if (!file) {
  console.error("用法: node tools/import_human.mjs <tar.gz> [--max N] [--size 19] [--min-moves 100]");
  process.exit(2);
}

const today = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

/** 最小 tar 读取器：512 字节块头 + 内容 + 对齐；流式，不落盘 */
async function* tarEntries(gzPath) {
  const stream = fs.createReadStream(gzPath).pipe(zlib.createGunzip());
  let buf = Buffer.alloc(0);
  let pending = null;
  try {
    for await (const chunk of stream) {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      for (;;) {
        if (!pending) {
          if (buf.length < 512) break;
          const header = buf.subarray(0, 512);
          buf = buf.subarray(512);
          const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
          if (!name) continue;
          const size = parseInt(header.subarray(124, 136).toString("utf8").replace(/\0.*$/, "").trim(), 8) || 0;
          const type = header[156];
          // tar typeflag：'0'(0x30) 与 '\0'(0x00) = 常规文件；'5'(0x35) = 目录；'L'/'K'/'x'/'g' = 扩展头
          // ⚠️ 曾经把 0x30 误判为目录 → 全部 SGF 被跳过（见 tools/import_human.mjs 修订记录）
          if (type !== 0x30 && type !== 0x00) continue;
          pending = { name, size, pad: (512 - (size % 512)) % 512 };
        }
        const needBytes = pending.size + pending.pad;
        if (buf.length < needBytes) break;
        const body = buf.subarray(0, pending.size);
        buf = buf.subarray(needBytes);
        const ent = { name: pending.name, body };
        pending = null;
        yield ent;
      }
    }
  } finally {
    stream.destroy();
  }
}

function extract(tree) {
  const root = tree.root || {};
  const size = root.SZ ? parseInt(String(root.SZ[0]).split(":")[0], 10) : 19;
  const komi = root.KM && root.KM[0] !== "" ? Number(root.KM[0]) : 7.5;
  const handicap = root.HA ? parseInt(String(root.HA[0]), 10) : 0;
  const setup = (root.AB || []).length + (root.AW || []).length;
  const moves = [];
  for (const nd of tree.nodes || []) {
    if (nd.color === "B" || nd.color === "W") moves.push({ color: nd.color, value: nd.value || "" });
  }
  return { size, komi, moves, handicap, setup };
}

/** SGF 点串（小写 "dd"/空）→ 引擎顶点串（"D16"/"pass"） */
function toVertex(value, size) {
  if (!value) return "pass";
  const x = value.charCodeAt(0) - 97;
  const y = value.charCodeAt(1) - 97;
  if (x < 0 || y < 0 || x >= size || y >= size) return "pass";
  return COLS[x] + String(size - y);
}

const out = [];
const reasons = { notSgf: 0, parseError: 0, badSize: 0, handicap: 0, tooShort: 0 };
let scanned = 0;

for await (const ent of tarEntries(file)) {
  if (out.length >= MAX_GAMES || scanned >= MAX_SCAN) break;
  if (!/\.sgf$/i.test(ent.name)) {
    reasons.notSgf++;
    continue;
  }
  scanned++;
  let tree;
  try {
    tree = parseSgf(ent.body.toString("utf8"));
  } catch {
    reasons.parseError++;
    continue;
  }
  const g = extract(tree);
  if (g.size !== WANT_SIZE) {
    reasons.badSize++;
    continue;
  }
  if (g.handicap >= 2 || g.setup > 0) {
    reasons.handicap++;
    continue;
  }
  if (g.moves.length < MIN_MOVES) {
    reasons.tooShort++;
    continue;
  }
  out.push({
    size: g.size, komi: g.komi, playouts: 0, source: "human:pgd",
    black: "human", white: "human", result: "", plies: g.moves.length, broken: null,
    moves: g.moves.map((m) => m.color + toVertex(m.value, g.size)),
  });
  if (out.length % 1000 === 0) process.stdout.write(`\r  已采用 ${out.length} 局（扫描 ${scanned}）   `);
}

const stamp = today();
const outPath = `G:/local/weiqi_lab/spec/games/human-${stamp}.jsonl`;
fs.writeFileSync(outPath, out.map((g) => JSON.stringify(g)).join("\n") + "\n", "utf8");
const totalMoves = out.reduce((a, g) => a + g.moves.length, 0);
console.log(`\n扫描 ${scanned} 个 SGF → 采用 ${out.length} 局（${totalMoves} 手，平均 ${(totalMoves / Math.max(1, out.length)).toFixed(1)} 手/局）`);
console.log(`丢弃：${JSON.stringify(reasons)}`);
console.log(`输出：${outPath}`);
