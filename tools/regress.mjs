// tools/regress.mjs — CGTC 式回归运行器（零依赖）
//
//   用法： node tools/regress.mjs [--engine KEY[,KEY...]] [--playouts N] [--verbose] [--dir DIR]
//   默认： 在所有可用引擎上跑 spec/regress/*.tst 全部用例。
//
// 测试文件格式（GNU Go / CGTC / gogui-regress 惯例）：
//     # 注释
//     loadsgf ./pos1.sgf 1         ← 非编号行：仍执行，但不判定
//     1 reg_genmove black          ← 编号行（<num> <command>）：该命令的响应被判定
//     #? [A1|B2]                   ← 期望集：上一编号命令的响应须命中其一
//     #? []                        ← 空期望集：只需返回一个合法着法（含 pass）
//     #? [!A1]                     ← 否定：除 A1 外均可
//     #? [A1]&                     ← '&' 后缀：忽略该条
//     #? [A1]*                     ← '*' 后缀：期望该条失败（记录，不算非预期失败）
//
// 判定：返回的着法（响应首个 token，大写）命中期望集即通过。
//
// 退出码：0 = 全部通过（无非预期失败）；1 = 有非预期失败；2 = 运行错误。

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ENGINES, availableEngines, ROOT } from "../harness/engines.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DIR = path.join(ROOT, "spec", "regress");

// ───────────────────────── 极简 GTP 客户端 ─────────────────────────

export class GtpClient {
  constructor(engineKey, { cwd, env, timeoutMs = 600000 } = {}) {
    this.engineKey = engineKey;
    this.script = path.join(HERE, "gtp.mjs");
    this.proc = spawn(process.execPath, [this.script, engineKey], {
      cwd: cwd || ROOT,
      env: { ...process.env, ...(env || {}) },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.buf = "";
    this.queue = [];
    this.stderrLines = [];
    this.closed = false;
    this.exitCode = null;
    this._timer = timeoutMs;
    this.proc.stdout.on("data", (d) => this._onData(d.toString("utf8")));
    this.proc.stderr.on("data", (d) => {
      for (const l of d.toString("utf8").split("\n")) if (l.trim()) this.stderrLines.push(l.trim());
    });
    this.proc.on("exit", (code) => { this.closed = true; this.exitCode = code; });
  }

  _onData(chunk) {
    this.buf += chunk;
    // GTP 响应以 "\n\n" 结尾（响应内部可含单个 "\n"）
    let idx;
    while ((idx = this.buf.indexOf("\n\n")) >= 0) {
      const raw = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 2);
      const slot = this.queue.shift();
      if (slot) slot.resolve(this._parse(raw));
    }
  }

  _parse(raw) {
    const first = raw[0];
    const ok = first === "=";
    // 去掉前导 '='/'?' 与可选 id
    let rest = raw.slice(1).replace(/^\d+/, "");
    if (rest.startsWith(" ")) rest = rest.slice(1);
    return { ok, text: rest };
  }

  send(cmdLine) {
    if (this.closed) return Promise.reject(new Error(`gtp[${this.engineKey}] 已退出`));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`gtp[${this.engineKey}] 超时: ${cmdLine}`)), this._timer);
      this.queue.push({ resolve: (r) => { clearTimeout(timer); resolve(r); }, reject });
      this.proc.stdin.write(cmdLine + "\n");
    });
  }

  async quit() {
    try { await this.send("quit"); } catch { /* ignore */ }
    await new Promise((r) => setTimeout(r, 80));
    if (!this.closed) { try { this.proc.kill(); } catch { /* ignore */ } }
  }
}

// ───────────────────────── .tst 解析与判定 ─────────────────────────

/** 解析 .tst 文本 → [{cmd, seq, expect, ignore, expectFail}]（只含被判定/执行的命令） */
export function parseTst(text) {
  const lines = String(text).split(/\r?\n/);
  const items = [];
  let pending = null; // 最近一条编号命令，等待 #?
  const flush = () => { if (pending) { items.push(pending); pending = null; } };
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (line.trim() === "") continue;
    const t = line.trimStart();
    if (t.startsWith("#?")) {
      const m = t.match(/^#\?\s*\[([^\]]*)\]\s*([*&]?)/);
      if (m && pending) {
        pending.expect = m[1];
        pending.suffix = m[2] || "";
        flush();
      } else if (!pending) {
        // 孤立 #?（无前置编号命令）：忽略
      }
      continue;
    }
    if (t.startsWith("#")) continue; // 普通注释
    // 命令：可带前导编号
    const m = t.match(/^(\d+)\s+(.*)$/);
    const seq = m ? parseInt(m[1], 10) : null;
    const cmd = (m ? m[2] : t).trim();
    if (!cmd) continue;
    if (seq !== null) {
      // 只有编号行的响应被判定
      if (pending) items.push(pending); // 上一条编号命令未跟 #?：仅执行
      pending = { cmd, seq, expect: undefined, suffix: "", tested: true };
    } else {
      // 非编号行：仍执行，但不判定
      if (pending) { /* 保留 pending，等待其 #? */ }
      items.push({ cmd, seq: null, tested: false });
    }
  }
  flush();
  return items;
}

/** 判定：cmdResult = {ok, text}；规则见文件头。→ {passed, detail} */
export function judge(item, result) {
  if (item.suffix === "&") return { passed: true, detail: "ignored(&)" };
  const resp = (result.text || "").trim();
  const token = (resp.split(/\s+/)[0] || "").toUpperCase();
  const content = (item.expect || "").trim();

  let match;
  if (content === "") {
    // 空期望集：只需返回合法着法（顶点或 pass）
    match = result.ok && (token === "PASS" || /^[A-T][0-9]{1,2}$/.test(token));
  } else {
    let neg = false;
    let body = content;
    if (body.startsWith("!")) { neg = true; body = body.slice(1); }
    const alts = body.split("|").map((s) => s.trim().toUpperCase()).filter(Boolean);
    match = alts.length === 0 ? result.ok : alts.includes(token);
    if (neg) match = !match;
  }

  const expectFail = item.suffix === "*";
  const actualPass = match;
  const passed = actualPass !== expectFail; // 非预期失败与非预期通过都算失败
  let detail;
  if (passed) detail = expectFail ? "expected-fail ok" : "ok";
  else if (match) detail = `unexpected pass (got ${token || "?"})`;
  else detail = `expected [${item.expect}], got "${resp.split("\n")[0] || "(none)"}"`;
  return { passed, detail };
}

// ───────────────────────── 运行器 ─────────────────────────

function parseArgs(argv) {
  const o = { engines: null, playouts: null, dir: DEFAULT_DIR, verbose: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--engine" || a === "-e") o.engines = (o.engines || []).concat(argv[++i].split(","));
    else if (a === "--playouts" || a === "-p") o.playouts = parseInt(argv[++i], 10);
    else if (a === "--dir") o.dir = path.resolve(argv[++i]);
    else if (a === "--verbose" || a === "-v") o.verbose = true;
    else if (a === "--help" || a === "-h") { o.help = true; }
  }
  return o;
}

export async function runRegress(opts) {
  const dir = opts.dir;
  const files = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => f.endsWith(".tst")).sort()
    : [];
  if (files.length === 0) {
    process.stdout.write(`未在 ${dir} 找到任何 .tst 测试文件\n`);
    return 2;
  }

  let engines = availableEngines();
  if (opts.engines) {
    engines = ENGINES.filter((e) => opts.engines.includes(e.key));
    const missing = opts.engines.filter((k) => !ENGINES.find((e) => e.key === k));
    if (missing.length) { process.stdout.write(`未知引擎: ${missing.join(", ")}\n`); return 2; }
  }
  if (engines.length === 0) { process.stdout.write("无可用引擎\n"); return 2; }

  const env = {};
  if (opts.playouts) env.WEIQI_GTP_PLAYOUTS = String(opts.playouts);

  let total = 0, passed = 0, failed = 0;
  const perEngine = [];

  for (const eng of engines) {
    if (opts.verbose) process.stdout.write(`\n=== 引擎 ${eng.key} (${eng.name}) ===\n`);
    const client = new GtpClient(eng.key, { cwd: dir, env });
    await client.send("protocol_version");
    const engStat = { key: eng.key, name: eng.name, total: 0, passed: 0, failed: 0, cases: [] };
    try {
      for (const f of files) {
        const text = fs.readFileSync(path.join(dir, f), "utf8");
        const items = parseTst(text);
        for (const item of items) {
          const r = await client.send(item.cmd);
          if (!item.tested) continue;
          total++; engStat.total++;
          const j = item.suffix === "&" ? { passed: true, detail: "ignored" } : judge(item, r);
          if (j.passed) { passed++; engStat.passed++; }
          else { failed++; engStat.failed++; }
          const mark = j.passed ? "PASS" : "FAIL";
          engStat.cases.push({ file: f, seq: item.seq, cmd: item.cmd, mark, detail: j.detail });
          if (opts.verbose || !j.passed) {
            process.stdout.write(`  [${mark}] ${f}:${item.seq} ${item.cmd}  → ${j.detail}\n`);
          }
        }
      }
    } finally {
      await client.quit();
    }
    perEngine.push(engStat);
    if (!opts.verbose) {
      process.stdout.write(`${eng.name.padEnd(12)} ${engStat.passed}/${engStat.total} 通过${engStat.failed ? `  (失败 ${engStat.failed})` : ""}\n`);
    }
  }

  process.stdout.write(`\n合计: ${passed}/${total} 通过, ${failed} 失败   引擎: ${perEngine.map((e) => e.key).join(",")}\n`);
  return failed === 0 ? 0 : 1;
}

const HELP = `weiqi_lab CGTC 回归运行器
用法: node tools/regress.mjs [选项]
  --engine, -e KEY[,KEY]   只跑指定引擎（默认全部可用引擎）
  --playouts, -p N         覆盖 genmove 模拟次数预算
  --dir DIR                测试目录（默认 spec/regress）
  --verbose, -v            打印逐条明细
`;

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { process.stdout.write(HELP); process.exit(0); }
  const code = await runRegress(opts);
  process.exit(code);
}

function isMain() {
  if (!process.argv[1]) return false;
  try { return fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
}

if (isMain()) main();

export default { runRegress, parseTst, judge, GtpClient };
