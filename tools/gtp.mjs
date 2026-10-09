// tools/gtp.mjs — GTP v2 适配器（零依赖，可执行）
//
//   用法： node tools/gtp.mjs <engineKey>      # engineKey ∈ harness/engines.mjs
//   帮助： node tools/gtp.mjs --help
//
// 本进程在**自身 stdin/stdout** 上说 GTP v2，内部 spawn 该引擎的 JSON-stdio 驱动
// （harness/client.mjs 的 EngineClient）。这样 GoGui / Sabaki / gogui-regress /
// gogui-twogtp 等标准工具可直接驱动 weiqi_lab 的全部引擎。
//
// ── 规范依据（已核对 GTP v2 原文，Gunnar Farnebäck, gtp2-spec-draft1）────────
//   · §2.6/§2.7  成功 "= <result>\n\n"，失败 "? <error>\n\n"（可带 id）
//   · §3.1       预处理：去 CR/控制字符、丢 `#` 注释、HT→空格、丢空行
//   · §2.11      坐标 A-T 跳 I（左→右），行号 1 在**下**（下→上）；A1 左下角
//   · §4.1.1     让子星位表（19 路固定表 + 其它尺寸的边距/中线规则）——见下
//   · §6         命令清单（required / tournament / regression / debug 子集）
//
// ── 让子约定（本适配器明文约定，控制器请注意）────────────────────────────
//   1. 让子子一律属**黑方**；放置完成后由**白方先走**（引擎侧 set_stones side=W）。
//   2. `komi` 由控制器显式设置；适配器**不**因让子自动改贴目。
//   3. `fixed_handicap` / `place_free_handicap` / `set_free_handicap` **仅在空盘有效**。
//   4. 让子子不计入走子历史（GTP 规定），故 `undo` 无法撤销让子。
//   5. 让子定式坐标表逐尺寸见本文件 `HANDICAP_TABLE`（由 §4.1.1 生成，tests_io 快照校验）。
//
// 编码：UTF-8 无 BOM，LF。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EngineClient } from "../harness/client.mjs";
import { ENGINES, ROOT } from "../harness/engines.mjs";
import { COLS, parseSgf, serializeSgf, toCommands } from "./sgf.mjs";

// ───────────────────────── 让子定式（GTP v2 §4.1.1）─────────────────────────

/**
 * 最大让子数（§4.1.1 表 + 规则）：
 *   size < 7            → 0（不成局）
 *   size == 7           → 4（规范单列：7x7 最多 4 子）
 *   size 为偶数         → 4（无中线，无 >4 的让子）
 *   size 为奇数(>=9)    → 9
 */
export function handicapMax(size) {
  if (size < 7) return 0;
  if (size === 7) return 4;
  if (size % 2 === 0) return 4;
  return 9;
}

/** 边星距边距离：size>=13 → 4（四线）；7..12 → 3（三线）。见 §4.1.1 表。 */
export function handicapEdgeDistance(size) {
  return size >= 13 ? 4 : 3;
}

/**
 * fixed_handicap 的顶点表（GTP v2 §4.1.1）。
 * 19 路固定表（规范原文）：
 *   2 D4 Q16
 *   3 D4 Q16 D16
 *   4 D4 Q16 D16 Q4
 *   5 D4 Q16 D16 Q4 K10
 *   6 D4 Q16 D16 Q4 D10 Q10
 *   7 D4 Q16 D16 Q4 D10 Q10 K10
 *   8 D4 Q16 D16 Q4 D10 Q10 K4 K16
 *   9 D4 Q16 D16 Q4 D10 Q10 K4 K16 K10
 * 规律：四角 → 边中点（左/右/下/上）→ **天元仅出现在奇数手数**（5/7/9）。
 * 推广：角点 (e,e)(hi,hi)(e,hi)(hi,e)，边中点 (e,m)(hi,m)(m,e)(m,hi)，天元 (m,m)；
 *       e = 边距（>=13 路取 4，7..12 路取 3），hi = size+1-e，m = 中线。
 */
export function fixedHandicapVertices(size, n) {
  const max = handicapMax(size);
  if (n < 2 || n > max) throw new Error(`invalid number of stones: ${n} (size ${size}, max ${max})`);
  const e = handicapEdgeDistance(size);   // 1-based 边距
  const hi = size + 1 - e;                // 对边 1-based
  const m = (size + 1) / 2;               // 中线（1-based；偶数尺寸不用）
  const pt = (c, r) => COLS[c - 1] + String(r);
  const corners = [pt(e, e), pt(hi, hi), pt(e, hi), pt(hi, e)];
  if (n <= 4) return corners.slice(0, n);
  const sides = [pt(e, m), pt(hi, m), pt(m, e), pt(m, hi)]; // 左/右/下/上 边中点
  const center = pt(m, m);
  const odd = n % 2 === 1;
  const nSide = odd ? n - 5 : n - 4;
  const out = corners.concat(sides.slice(0, nSide));
  if (odd) out.push(center);
  return out;
}

/** 供 tests_io 做快照：9/11/13/15/17/19 各尺寸 N=2..max 的坐标表 */
export function handicapTableSnapshot(sizes) {
  const out = {};
  for (const s of sizes) {
    const max = handicapMax(s);
    const rows = {};
    for (let n = 2; n <= max; n++) rows[n] = fixedHandicapVertices(s, n);
    out[s] = { max, edge: handicapEdgeDistance(s), rows };
  }
  return out;
}

// ───────────────────────── 轻量棋盘镜像（仅用于 showboard/printsgf）─────────
// 说明：引擎协议无“读回盘面”命令，showboard/printsgf 需一枚本地镜像。
// 只做落子/提子/撤销（不含劫与禁全同——那由引擎判定），足以渲染盘面。

class MiniBoard {
  constructor(size) { this.setSize(size); }

  setSize(size) {
    this.size = size;
    this.n2 = size * size;
    this.cells = new Int8Array(this.n2);
    this.hist = [];
    this.side = 1; // 1=黑 2=白
  }

  reset() { this.cells.fill(0); this.hist = []; this.side = 1; }

  setup(stones, side) {
    this.reset();
    for (const [c, v] of stones) {
      let idx = v;
      if (typeof v === "string") idx = parseVertexArg(v, this.size);
      if (idx >= 0 && idx < this.n2) this.cells[idx] = c === "B" ? 1 : 2;
    }
    this.side = side === "W" ? 2 : 1;
  }

  neigh(idx) {
    const x = idx % this.size, y = (idx / this.size) | 0, s = this.size, out = [];
    if (x > 0) out.push(idx - 1);
    if (x < s - 1) out.push(idx + 1);
    if (y > 0) out.push(idx - s);
    if (y < s - 1) out.push(idx + s);
    return out;
  }

  group(idx) {
    const color = this.cells[idx];
    const members = [];
    const libs = new Set();
    const seen = new Set([idx]);
    const stack = [idx];
    while (stack.length) {
      const cur = stack.pop();
      members.push(cur);
      for (const nb of this.neigh(cur)) {
        const v = this.cells[nb];
        if (v === 0) libs.add(nb);
        else if (v === color && !seen.has(nb)) { seen.add(nb); stack.push(nb); }
      }
    }
    return { members, libs };
  }

  place(color, vertex) {
    const c = color === "B" ? 1 : 2;
    if (vertex < 0) { this.hist.push({ type: "pass", color: c }); this.side = 3 - c; return; }
    const opp = 3 - c;
    this.cells[vertex] = c;
    const removed = [];
    const seen = new Set();
    for (const nb of this.neigh(vertex)) {
      if (this.cells[nb] === opp && !seen.has(nb)) {
        const { members, libs } = this.group(nb);
        if (libs.size === 0) for (const m of members) { seen.add(m); removed.push([m, opp]); }
      }
    }
    for (const [m] of removed) this.cells[m] = 0;
    const self = [];
    if (removed.length === 0) {
      const { members, libs } = this.group(vertex);
      if (libs.size === 0) for (const m of members) { self.push([m, c]); this.cells[m] = 0; }
    }
    this.hist.push({ type: "move", vertex, color: c, removed, self });
    this.side = 3 - c;
  }

  undo() {
    const rec = this.hist.pop();
    if (!rec) return false;
    if (rec.type === "pass") { this.side = rec.color; return true; }
    this.cells[rec.vertex] = 0;
    for (const [m, cc] of rec.removed) this.cells[m] = cc;
    for (const [m, cc] of rec.self) this.cells[m] = cc;
    this.side = rec.color;
    return true;
  }

  /** [[color, vertexStr], ...]（顶点串，跳 I），用于重建引擎盘面 */
  stonesAsList() {
    const out = [];
    for (let i = 0; i < this.n2; i++) {
      const v = this.cells[i];
      if (v !== 0) out.push([v === 1 ? "B" : "W", formatVertexArg(i, this.size)]);
    }
    return out;
  }

  /** 盘上是否为空（无任何棋子）。注意：摆子不经 hist，须直接扫盘面。 */
  isEmpty() {
    for (let i = 0; i < this.n2; i++) if (this.cells[i] !== 0) return false;
    return true;
  }
}

// ───────────────────────── 顶点/颜色工具 ─────────────────────────

export function parseVertexArg(v, size) {
  const t = String(v).trim().toUpperCase();
  if (t === "PASS" || t === "") return -1;
  const col = COLS.indexOf(t[0]);
  if (col < 0 || col >= size) throw new GtpError("invalid vertex");
  const row = parseInt(t.slice(1), 10);
  if (!Number.isFinite(row) || row < 1 || row > size) throw new GtpError("invalid vertex");
  return (row - 1) * size + col;
}

export function formatVertexArg(idx, size) {
  if (idx < 0) return "pass";
  return COLS[idx % size] + String(((idx / size) | 0) + 1);
}

function parseColorArg(c) {
  const t = String(c).trim().toUpperCase();
  if (t === "B" || t === "BLACK") return "B";
  if (t === "W" || t === "WHITE") return "W";
  throw new GtpError("invalid color");
}

export class GtpError extends Error {}

// ───────────────────────── 适配器主体 ─────────────────────────

const COMMANDS = [
  "protocol_version", "name", "version", "known_command", "list_commands", "quit",
  "boardsize", "clear_board", "komi",
  "play", "genmove", "undo", "showboard",
  "fixed_handicap", "place_free_handicap", "set_free_handicap",
  "time_settings", "time_left", "cputime",
  "final_score", "final_status_list",
  "loadsgf", "printsgf", "reg_genmove",
];

export class GtpAdapter {
  constructor(spec, opts = {}) {
    this.spec = spec;
    this.size = 9;
    this.komi = 7.5;
    this.rules = "cn";
    this.mirror = new MiniBoard(9);
    this.setupStones = [];        // 摆子（让子/loadsgf 的 AB/AW），不含走子
    this.moveLog = [];            // 走子序列 [{color, vertex}]
    this.handicapStones = [];     // 最近一次让子的顶点
    this.cpu0 = process.cpuUsage();
    this.engineName = spec.name;
    this.engineVersion = "v1";
    this.defaultPlayouts = opts.playouts || Number(process.env.WEIQI_GTP_PLAYOUTS || spec.playouts || 500);
  }

  async start() {
    this.client = new EngineClient(this.spec);
    const ready = await this.client.start();
    this.engineName = ready.name || this.spec.name;
    this.engineVersion = ready.version || "v1";
    // 初始同步：让引擎盘面与适配器状态一致（9 路空盘、黑先、默认 komi）
    await this._syncEmpty();
  }

  async stop() { try { await this.client.stop(); } catch { /* ignore */ } }

  // ---------- 引擎同步 ----------

  async _clearEngine() {
    await this.client.must("clear", { size: this.size, komi: this.komi, rules: this.rules });
  }

  async _syncEmpty() {
    this.mirror.setSize(this.size);
    await this._clearEngine();
  }

  /** 用镜像重建引擎盘面（用于改 komi 后保持局面一致） */
  async _resyncFromMirror() {
    await this._clearEngine();
    const stones = this.mirror.stonesAsList();
    await this.client.must("set_stones", { stones, side: this.mirror.side === 2 ? "W" : "B" });
  }

  async _applySetup(stones, side) {
    this.mirror.setup(stones, side);
    this.setupStones = stones.slice();
    await this.client.must("set_stones", { stones, side });
  }

  // ---------- GTP 命令 ----------

  cmd_protocol_version() { return "2"; }
  cmd_name() { return this.engineName; }
  cmd_version() { return this.engineVersion; }
  cmd_known_command(arg) {
    const name = (arg || "").trim().split(/\s+/)[0];
    return COMMANDS.includes(name) ? "true" : "false";
  }
  cmd_list_commands() { return COMMANDS.join("\n"); }

  async cmd_boardsize(arg) {
    const size = parseInt((arg || "").trim().split(/\s+/)[0], 10);
    if (!Number.isFinite(size)) throw new GtpError("syntax error");
    if (size < 2 || size > 19) throw new GtpError("unacceptable size");
    this.size = size;
    this.moveLog = [];
    this.setupStones = [];
    this.handicapStones = [];
    await this._syncEmpty();
    return "";
  }

  async cmd_clear_board() {
    this.moveLog = [];
    this.setupStones = [];
    this.handicapStones = [];
    this.mirror.setSize(this.size);
    await this._clearEngine();
    return "";
  }

  async cmd_komi(arg) {
    const v = parseFloat((arg || "").trim().split(/\s+/)[0]);
    if (!Number.isFinite(v)) throw new GtpError("syntax error");
    this.komi = v;
    await this._resyncFromMirror(); // 引擎 komi 只能经 clear 设置；用镜像重建保局面
    return "";
  }

  async cmd_play(arg) {
    const toks = (arg || "").trim().split(/\s+/).filter(Boolean);
    if (toks.length < 2) throw new GtpError("syntax error");
    const color = parseColorArg(toks[0]);
    const idx = parseVertexArg(toks[1], this.size);
    const vertex = idx < 0 ? "pass" : formatVertexArg(idx, this.size);
    const r = await this.client.rpc("play", { color, vertex });
    if (!r || r.ok !== true) throw new GtpError(`illegal move${r && r.reason ? " (" + r.reason + ")" : ""}`);
    this.mirror.place(color, idx);
    this.moveLog.push({ color, vertex });
    return "";
  }

  async cmd_genmove(arg) {
    const color = parseColorArg((arg || "").trim().split(/\s+/)[0]);
    return this._genmove(color);
  }

  async cmd_reg_genmove(arg) {
    const color = parseColorArg((arg || "").trim().split(/\s+/)[0]);
    // 生成但不落子（GTP regression 语义）：引擎 genmove 后立即 undo
    const played = this.moveLog.length;
    const vertex = await this._genmove(color);
    if (vertex !== "resign") {
      await this.client.must("undo", {});
      this.mirror.undo();
      this.moveLog.length = played;
    }
    return vertex;
  }

  async _genmove(color) {
    const r = await this.client.rpc("genmove", { color, playouts: this.defaultPlayouts, seed: 0 });
    if (!r || r.ok !== true) {
      // 引擎 genmove 仅在同色轮次时可用；异色 → 明确失败（偏离"fails never"，见报告）
      throw new GtpError(`cannot generate for ${color}${r && r.reason ? " (" + r.reason + ")" : ""}`);
    }
    const vertex = String(r.result.vertex);
    if (vertex !== "resign") {
      const idx = vertex === "pass" ? -1 : parseVertexArg(vertex, this.size);
      this.mirror.place(color, idx);
      this.moveLog.push({ color, vertex: vertex === "pass" ? "pass" : formatVertexArg(idx, this.size) });
    }
    return vertex;
  }

  async cmd_undo() {
    if (this.moveLog.length === 0) throw new GtpError("unable to undo");
    const r = await this.client.rpc("undo", {});
    if (!r || r.ok !== true) throw new GtpError("unable to undo");
    this.mirror.undo();
    this.moveLog.pop();
    return "";
  }

  cmd_showboard() {
    const s = this.size;
    const labels = COLS.slice(0, s).split("").join(" ");
    const lines = ["   " + labels];
    for (let r = s; r >= 1; r--) {
      let row = "";
      for (let x = 0; x < s; x++) {
        const c = this.mirror.cells[(r - 1) * s + x];
        row += (c === 1 ? "X" : c === 2 ? "O" : ".") + (x < s - 1 ? " " : "");
      }
      const rl = String(r).padStart(2, " ");
      lines.push(`${rl} ${row} ${rl}`);
    }
    lines.push("   " + labels);
    return lines.join("\n");
  }

  // ---------- 让子 ----------

  _requireEmpty() { if (!this.mirror.isEmpty()) throw new GtpError("board not empty"); }

  async cmd_fixed_handicap(arg) {
    this._requireEmpty();
    const n = parseInt((arg || "").trim().split(/\s+/)[0], 10);
    if (!Number.isFinite(n)) throw new GtpError("syntax error");
    let verts;
    try { verts = fixedHandicapVertices(this.size, n); }
    catch { throw new GtpError("invalid number of stones"); }
    const stones = verts.map((v) => ["B", v]);
    await this._applySetup(stones, "W"); // 让子属黑、白先走
    this.handicapStones = verts.slice();
    return verts.join(" ");
  }

  async cmd_place_free_handicap(arg) {
    this._requireEmpty();
    const n = parseInt((arg || "").trim().split(/\s+/)[0], 10);
    if (!Number.isFinite(n) || n < 2) throw new GtpError("invalid number of stones");
    const max = handicapMax(this.size);
    if (max < 2) throw new GtpError("invalid number of stones");
    // 引擎的自选偏好 = 标准星位表；请求数超过上限时按规范“可少放”
    const verts = fixedHandicapVertices(this.size, Math.min(n, max));
    const stones = verts.map((v) => ["B", v]);
    await this._applySetup(stones, "W");
    this.handicapStones = verts.slice();
    return verts.join(" ");
  }

  async cmd_set_free_handicap(arg) {
    this._requireEmpty();
    const raw = (arg || "").trim().split(/\s+/).filter(Boolean);
    if (raw.length < 2 || raw.length > this.size * this.size - 1) throw new GtpError("invalid number of stones");
    const verts = raw.map((v) => {
      const idx = parseVertexArg(v, this.size);
      if (idx < 0) throw new GtpError("invalid vertex");
      return formatVertexArg(idx, this.size);
    });
    const stones = verts.map((v) => ["B", v]);
    await this._applySetup(stones, "W");
    this.handicapStones = verts.slice();
    return "";
  }

  // ---------- 时间 / 计时 ----------

  cmd_time_settings() { return ""; }
  cmd_time_left() { return ""; }

  cmd_cputime() {
    const u = process.cpuUsage(this.cpu0);
    const secs = (u.user + u.system) / 1e6;
    return secs.toFixed(2);
  }

  // ---------- 计分 ----------

  async cmd_final_score() {
    const r = await this.client.must("score", {});
    return String(r.result); // 引擎已按 SGF RE 格式（B+3.5 / W+7.5 / 0）
  }

  cmd_final_status_list(arg) {
    const status = (arg || "").trim().split(/\s+/)[0];
    if (status === "alive") return this.mirror.stonesAsList().map(([, v]) => v).join("\n");
    if (status === "dead") return "";
    throw new GtpError("unsupported status");
  }

  // ---------- SGF ----------

  async cmd_loadsgf(arg) {
    const toks = (arg || "").trim().split(/\s+/).filter(Boolean);
    if (toks.length === 0) throw new GtpError("syntax error");
    let file = toks[0];
    if ((file.startsWith('"') && file.endsWith('"')) || (file.startsWith("'") && file.endsWith("'"))) {
      file = file.slice(1, -1);
    }
    const upTo = toks[1] !== undefined ? parseInt(toks[1], 10) : undefined;
    let text;
    try { text = fs.readFileSync(path.resolve(process.cwd(), file), "utf8"); }
    catch { throw new GtpError(`cannot open file: ${file}`); }
    let tree;
    try { tree = parseSgf(text); } catch (e) { throw new GtpError("invalid sgf"); }
    const cmds = toCommands(tree, { upTo });

    this.moveLog = [];
    this.setupStones = [];
    this.handicapStones = [];
    for (const c of cmds) {
      if (c.cmd === "clear") {
        this.size = c.size;
        this.komi = c.komi !== undefined ? c.komi : 7.5;
        this.rules = c.rules || "cn";
        this.mirror.setSize(this.size);
        await this.client.must("clear", { size: this.size, komi: this.komi, rules: this.rules });
      } else if (c.cmd === "set_stones") {
        await this._applySetup(c.stones, c.side);
        if (c.side === "W" && c.stones.length >= 2 && c.stones.every((s) => s[0] === "B")) {
          this.handicapStones = c.stones.map(([, v]) => v);
        }
      } else if (c.cmd === "play") {
        const r = await this.client.rpc("play", { color: c.color, vertex: c.vertex });
        if (!r || r.ok !== true) throw new GtpError("illegal move in sgf");
        const idx = c.vertex === "pass" ? -1 : parseVertexArg(c.vertex, this.size);
        this.mirror.place(c.color, idx);
        this.moveLog.push({ color: c.color, vertex: c.vertex });
      }
    }
    return "";
  }

  cmd_printsgf(arg) {
    const rootProps = { GM: ["1"], FF: ["4"], CA: ["UTF-8"], SZ: [String(this.size)], KM: [String(this.komi)] };
    const blackSetup = this.setupStones.filter((s) => s[0] === "B").map(([, v]) => vertexToSgfPoint(v, this.size));
    const whiteSetup = this.setupStones.filter((s) => s[0] === "W").map(([, v]) => vertexToSgfPoint(v, this.size));
    if (blackSetup.length) rootProps.AB = blackSetup;
    if (whiteSetup.length) rootProps.AW = whiteSetup;
    if (this.handicapStones.length >= 2) {
      rootProps.HA = [String(this.handicapStones.length)];
      rootProps.PL = ["W"];
    }
    const nodes = this.moveLog.map((m) => ({
      props: { [m.color]: [m.vertex === "pass" ? "" : vertexToSgfPoint(m.vertex, this.size)] },
      color: m.color,
      value: m.vertex === "pass" ? "" : vertexToSgfPoint(m.vertex, this.size),
    }));
    const text = serializeSgf({ root: rootProps, nodes, stats: { nodes: 1 + nodes.length, variations: 0 } });
    const toks = (arg || "").trim().split(/\s+/).filter(Boolean);
    if (toks.length) {
      let file = toks[0];
      if ((file.startsWith('"') && file.endsWith('"')) || (file.startsWith("'") && file.endsWith("'"))) file = file.slice(1, -1);
      try { fs.writeFileSync(path.resolve(process.cwd(), file), text); }
      catch { throw new GtpError(`cannot write file: ${file}`); }
      return "";
    }
    return text;
  }
}

// 顶点串 → SGF 点串（复用 sgf.mjs 的逆翻转，此处内联避免循环导入差异）
function vertexToSgfPoint(vertex, size) {
  const t = String(vertex).trim().toUpperCase();
  if (t === "PASS" || t === "") return "";
  const col = COLS.indexOf(t[0]);
  const row = parseInt(t.slice(1), 10);
  if (col < 0 || !Number.isFinite(row)) return "";
  const ySgf = size - row; // size-1-(row-1)
  return String.fromCharCode(97 + col) + String.fromCharCode(97 + ySgf);
}

// ───────────────────────── 行解析与主循环 ─────────────────────────

function preprocess(line) {
  let s = String(line).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "").replace(/\r/g, "");
  const h = s.indexOf("#");
  if (h >= 0) s = s.slice(0, h);
  s = s.replace(/\t/g, " ");
  return s.trim();
}

function splitCommand(cmdline) {
  const m = cmdline.match(/^(\d+)\s+(.*)$/);
  if (m) return { id: m[1], rest: m[2].trim() };
  return { id: null, rest: cmdline };
}

export async function runAdapter(engineKey) {
  const spec = ENGINES.find((e) => e.key === engineKey);
  if (!spec) {
    process.stderr.write(`未知引擎 ${engineKey}；可选：${ENGINES.map((e) => e.key).join(", ")}\n`);
    return 2;
  }
  const adapter = new GtpAdapter(spec);
  try {
    await adapter.start();
  } catch (e) {
    process.stderr.write(`引擎 ${engineKey} 启动失败：${e && e.message}\n`);
    return 2;
  }

  const write = (s) => fs.writeSync(1, s);

  let chain = Promise.resolve();
  const rl = (await import("node:readline")).createInterface({ input: process.stdin, crlfDelay: Infinity });

  const handle = async (raw) => {
    const line = preprocess(raw);
    if (!line) return;
    const { id, rest } = splitCommand(line);
    const sp = rest.search(/\s/);
    const name = sp < 0 ? rest : rest.slice(0, sp);
    const args = sp < 0 ? "" : rest.slice(sp + 1);
    const reply = (ok, text) => {
      const head = "=" + (id !== null ? id : "") + (ok ? "" : " ");
      // 成功："=<id> <result>\n\n"；失败："?<id> <error>\n\n"
      if (ok) write(head + (text ? " " + text : "") + "\n\n");
      else write("?" + (id !== null ? id : "") + " " + text + "\n\n");
    };
    const fn = adapter["cmd_" + name];
    if (typeof fn !== "function") {
      reply(false, "unknown command");
      return;
    }
    try {
      const result = await fn.call(adapter, args);
      reply(true, result === undefined ? "" : String(result));
    } catch (e) {
      reply(false, e instanceof GtpError ? e.message : String(e && e.message ? e.message : e));
    }
  };

  rl.on("line", (line) => {
    chain = chain.then(async () => {
      const l = preprocess(line);
      if (l === "quit" || /^\d+\s+quit$/.test(l)) {
        const { id } = splitCommand(l);
        write("=" + (id !== null ? id : "") + "\n\n");
        await adapter.stop();
        process.exit(0);
        return;
      }
      await handle(line);
    }).catch((e) => {
      process.stderr.write("adapter error: " + (e && e.message) + "\n");
    });
  });

  // 等 stdin 关闭后，**先把已排队的命令处理完**再停引擎，避免竞争
  await new Promise((resolve) => rl.on("close", resolve));
  await chain.catch(() => {});
  await adapter.stop();
  return 0;
}

// ---------- CLI ----------

const HELP = `weiqi_lab GTP v2 适配器
用法: node tools/gtp.mjs <engineKey>
  engineKey ∈ { ${ENGINES.map((e) => e.key).join(", ")} }   （见 harness/engines.mjs）

在自身 stdin/stdout 上说 GTP v2，内部 spawn 该引擎的 JSON-stdio 驱动。

让子约定:
  · 让子子属黑方；放置后由白方先走（引擎侧 set_stones side=W）。
  · komi 由控制器显式设置，适配器不因让子自动改贴目。
  · fixed_handicap/place_free_handicap/set_free_handicap 仅空盘有效。
  · 让子子不计入走子历史（GTP 规定），undo 不能撤销让子。
  · 星位表依据 GTP v2 §4.1.1（19 路固定表 + 其它尺寸边距/中线规则）。

命令: ${COMMANDS.join(" ")}
`;

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h") || argv.length === 0) {
    process.stdout.write(HELP);
    process.exit(0);
  }
  const key = argv.find((a) => !a.startsWith("-"));
  const code = await runAdapter(key);
  process.exit(code);
}

function isMain() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch { return false; }
}

if (isMain()) main();

export default { GtpAdapter, fixedHandicapVertices, handicapMax, handicapEdgeDistance, runAdapter };
