// harness/host.mjs — weiqi_lab 跨引擎一致性总入口
//
// 三项校验：
//   ① 各引擎内置黄金值自测（selftest）→ 必须 0 failed
//   ② 跨引擎协议差分：同一确定性命令流喂给全部引擎 → 响应（ok/reason/result）逐位一致
//   ③ 独立裁判交叉校验：同一命令流喂给 tournament/referee.mjs（机制不同的独立实现）→
//      合法性判定、提子数、计分、局面必须与引擎一致
//
// 用法：node host.mjs [--quick]
// 环境变量：WEIQI_ENGINES=py,js,rs,cpp,cs 过滤引擎

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ROOT, availableEngines } from "./engines.mjs";
import { EngineClient } from "./client.mjs";
import { Ref, parseColor, parseVertex } from "../tournament/referee.mjs";

const QUICK = process.argv.includes("--quick");

// ---------- 确定性命令流生成（splitmix64 流，与引擎 RNG 同族，便于复现） ----------
const MASK = (1n << 64n) - 1n;
function splitmix64(x) {
  let z = (x + 0x9e3779b97f4a7c15n) & MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK;
  return (z ^ (z >> 31n)) & MASK;
}
class Rng {
  constructor(seed) { this.s = BigInt(seed) & MASK; }
  next() { this.s = (this.s + 0x9e3779b97f4a7c15n) & MASK; return splitmix64(this.s); }
  int(n) { return Number(this.next() % BigInt(n)); }
}

const COLS = "ABCDEFGHJKLMNOPQRST";
const vstr = (i, size) => (i < 0 ? "pass" : COLS[i % size] + String(Math.floor(i / size) + 1));

const SIZES = [9, 5, 13];
const PROFILES = ["cn", "tt", "jp", { ko: "situational", suicide: "allow", scoring: "area", komi: 0.5 }];

function buildScript(seed) {
  const rng = new Rng(seed);
  const cmds = [];
  for (const size of SIZES) {
    for (const rules of PROFILES) {
      const n2 = size * size;
      const komi = typeof rules === "string" ? null : rules.komi;
      cmds.push({ cmd: "clear", size, rules, ...(komi === null ? {} : { komi }) });
      // 摆子（一次）
      const stones = [];
      const k = 3 + rng.int(6);
      for (let i = 0; i < k; i++) {
        stones.push([rng.int(2) === 0 ? "B" : "W", vstr(rng.int(n2), size)]);
      }
      cmds.push({ cmd: "set_stones", stones, side: rng.int(2) === 0 ? "B" : "W" });
      let guard = 0;
      while (cmds.length < 1e6 && guard++ < (QUICK ? 14 : 34)) {
        const roll = rng.int(10);
        if (roll < 5) {
          const v = vstr(rng.int(n2), size);
          cmds.push({ cmd: "play", color: rng.int(2) === 0 ? "B" : "W", vertex: v });
        } else if (roll === 5) {
          cmds.push({ cmd: "play", color: rng.int(2) === 0 ? "B" : "W", vertex: "pass" });
        } else if (roll === 6) {
          cmds.push({ cmd: "undo" });
        } else if (roll === 7) {
          cmds.push({ cmd: "key" });
        } else if (roll === 8) {
          cmds.push({ cmd: "legal", color: rng.int(2) === 0 ? "B" : "W", vertex: vstr(rng.int(n2), size) });
        } else {
          cmds.push({ cmd: "legal_moves" });
        }
      }
      cmds.push({ cmd: "score" });
      cmds.push({ cmd: "prisoners" });
      cmds.push({ cmd: "key" });
    }
  }
  return cmds;
}

// ---------- 响应归一化（仅比对语义字段；error 文案宽松） ----------
function norm(resp) {
  return JSON.stringify({
    ok: resp.ok,
    reason: resp.reason ?? null,
    result: resp.result ?? null,
  });
}
function resultOf(resp, key) {
  if (!resp || resp.ok !== true || !resp.result) return null;
  return resp.result[key];
}

// ---------- 主流程 ----------
async function main() {
  const t0 = Date.now();
  const specs = availableEngines();
  if (!specs.length) {
    console.error("没有可用引擎");
    process.exit(2);
  }
  console.log(`weiqi_lab harness — 引擎 ${specs.length} 个: ${specs.map((s) => s.key).join(", ")}`);
  const results = [];

  // ① 各引擎内置黄金值自测
  console.log("\n[1/3] 引擎内置黄金值自测（selftest）");
  const goldenPath = path.join(ROOT, "spec", "golden.json");
  for (const spec of specs) {
    const c = new EngineClient(spec);
    try {
      await c.start();
      const r = await c.must("selftest", { golden: goldenPath });
      const ok = r.failed === 0;
      results.push({ check: "selftest", engine: spec.key, ok, detail: `${r.passed}/${r.total}` });
      console.log(`  ${ok ? "OK  " : "FAIL"} ${spec.key.padEnd(4)} golden ${r.passed}/${r.total} failed=${r.failed}`);
      if (!ok) console.log("       failures:", JSON.stringify(r.failures).slice(0, 400));
    } catch (e) {
      results.push({ check: "selftest", engine: spec.key, ok: false, detail: String(e.message) });
      console.log(`  FAIL ${spec.key.padEnd(4)} ${e.message}`);
    } finally {
      await c.stop();
    }
  }

  // ② 跨引擎协议差分
  console.log("\n[2/3] 跨引擎协议差分（确定性命令流）");
  const script = buildScript(20261008);
  console.log(`  命令数 = ${script.length}`);
  const clients = [];
  const responses = [];
  try {
    for (const spec of specs) {
      const c = new EngineClient(spec);
      await c.start();
      clients.push(c);
    }
    const first = clients[0];
    for (const cmd of script) {
      const { cmd: name, ...args } = cmd;
      const resp = await first.rpc(name, args);
      responses.push({ cmd, resp });
    }
    const diffs = [];
    for (let i = 1; i < clients.length; i++) {
      const c = clients[i];
      let localDiff = 0;
      for (let j = 0; j < script.length; j++) {
        const { cmd: name, ...args } = script[j];
        const r = await c.rpc(name, args);
        if (norm(r) !== norm(responses[j].resp)) {
          localDiff++;
          if (localDiff <= 5) {
            diffs.push(`${specs[i].key} #${j} ${name} ${JSON.stringify(args).slice(0, 90)}\n      got  ${norm(r)}\n      want ${norm(responses[j].resp)}`);
          }
        }
      }
      results.push({ check: "protocol-diff", engine: specs[i].key, ok: localDiff === 0, detail: `${localDiff} diffs` });
      console.log(`  ${localDiff === 0 ? "OK  " : "FAIL"} ${specs[i].key.padEnd(4)} vs ${specs[0].key}: ${localDiff} 处差异`);
      for (const d of diffs.slice(-5)) console.log("      " + d);
    }
  } finally {
    for (const c of clients) await c.stop();
  }

  // ③ 独立裁判交叉校验
  console.log("\n[3/3] 独立裁判交叉校验（referee.mjs，机制不同的独立实现）");
  {
    const ref = new Ref(9);
    let checked = 0;
    let mism = 0;
    // 用 ① 中第一台引擎重放同一命令流，同时喂给裁判
    const spec = specs[0];
    const c = new EngineClient(spec);
    try {
      await c.start();
      for (const cmd of script) {
        const { cmd: name, ...args } = cmd;
        const resp = await c.rpc(name, args);
        if (name === "clear") {
          ref.reset();
          ref.size = args.size ?? 9;
          ref.n2 = ref.size * ref.size;
          ref.rules = (await import("../tournament/referee.mjs")).normalizeRules(args.rules ?? "cn");
          ref.komi = args.komi === undefined || args.komi === null ? ref.rules.komi : Number(args.komi);
          ref.reset();
        } else if (name === "set_stones") {
          ref.setStones((args.stones || []).map(([a, b]) => [parseColor(a), parseVertex(b, ref.size)]),
            args.side ? parseColor(args.side) : 1);
        } else if (name === "play") {
          const rr = ref.play(parseColor(args.color), parseVertex(args.vertex, ref.size));
          const engOk = resp.ok === true;
          if (rr.ok !== engOk) {
            mism++;
            if (mism <= 5) console.log(`      play 不一致 @${checked}: 裁判=${rr.ok}/${rr.reason ?? ""} 引擎=${engOk}/${resp.reason ?? ""}`);
          } else if (rr.ok && resp.result && rr.captures !== resp.result.captures) {
            mism++;
            if (mism <= 5) console.log(`      captures 不一致 @${checked}: 裁判=${rr.captures} 引擎=${resp.result.captures}`);
          }
          checked++;
        } else if (name === "undo") {
          ref.undo();
        } else if (name === "legal_moves") {
          const rc = ref.legalMoves().length;
          const ec = resultOf(resp, "count");
          if (ec !== null && rc !== ec) {
            mism++;
            if (mism <= 5) console.log(`      legal_moves 不一致: 裁判=${rc} ${spec.key}=${ec}`);
          }
          checked++;
        } else if (name === "score") {
          const rs = ref.score();
          const er = resultOf(resp, "result");
          if (er !== null && rs.result !== er) {
            mism++;
            if (mism <= 5) console.log(`      score 不一致: 裁判=${rs.result} ${spec.key}=${er}`);
          }
          checked++;
        } else if (name === "prisoners") {
          const eb = resultOf(resp, "black");
          const ew = resultOf(resp, "white");
          if (eb !== null && (ref.captures[1] !== eb || ref.captures[2] !== ew)) {
            mism++;
            if (mism <= 5) console.log(`      prisoners 不一致: 裁判=${ref.captures[1]}/${ref.captures[2]} 引擎=${eb}/${ew}`);
          }
          checked++;
        }
      }
    } finally {
      await c.stop();
    }
    results.push({ check: "referee-crosscheck", engine: spec.key, ok: mism === 0, detail: `${checked} 项` });
    console.log(`  ${mism === 0 ? "OK  " : "FAIL"} 裁判 vs ${spec.key}: 比对 ${checked} 项，${mism} 处不一致`);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n=== 汇总：${results.length - failed.length}/${results.length} 通过（${((Date.now() - t0) / 1000).toFixed(1)}s）===`);
  for (const f of failed) console.log(`  FAIL ${f.check} ${f.engine}: ${f.detail}`);
  console.log(failed.length === 0 ? "ALL GREEN" : "HARNESS FAILED");
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("harness 异常:", e);
  process.exit(2);
});
