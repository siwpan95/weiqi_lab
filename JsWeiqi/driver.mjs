// driver.mjs — JSON-stdio 驱动（协议：docs/PROTOCOL_SPEC.md, protocol-v1）
//
// 线格式：stdin/stdout 每行一个 JSON 对象（UTF-8，\n 结尾，无 BOM）。
// 启动即输出 ready 事件；日志一律写 stderr。
// 输出用 fs.writeSync(1, ...) 同步落盘，保证"单条响应在下一请求前完整输出"。

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

import {
  Board, parse_vertex, format_vertex, parse_color, normalize_rules, fmt_key,
  color_name, WeiqiError,
} from "./rules.mjs";
import { genmove, PASS } from "./ai.mjs";
import { run_golden, default_golden_path } from "./golden.mjs";

export const NAME = "JsWeiqi";
export const LANG = "js";
export const VERSION = "v1";

export function out(obj) {
  fs.writeSync(1, JSON.stringify(obj) + "\n");
}

export class CmdError extends Error {
  constructor(msg, reason = null) {
    super(msg);
    this.name = "CmdError";
    this.msg = msg;
    this.reason = reason;
  }
}

function as_int(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new CmdError("bad args");
  return Math.trunc(n);
}

export class Driver {
  constructor() {
    this.board = new Board(9);
  }

  // ---------- 命令实现 ----------

  cmd_hello() {
    return { name: NAME, version: VERSION, lang: LANG, protocol: 1 };
  }

  cmd_clear(req) {
    const size = as_int(req["size"] !== undefined ? req["size"] : 9);
    const rules = req["rules"] !== undefined ? req["rules"] : "cn";
    const rd = normalize_rules(rules);
    const komi = req["komi"];
    this.board = new Board(size, komi === undefined || komi === null ? null : Number(komi), rd);
    return {
      size: this.board.size,
      komi: this.board.komi,
      rules: { ko: rd["ko"], suicide: rd["suicide"], scoring: rd["scoring"] },
    };
  }

  cmd_set_stones(req) {
    const stones = req["stones"] !== undefined ? req["stones"] : [];
    const side = req["side"] !== undefined ? req["side"] : "B";
    const side_i = parse_color(side);
    const pairs = [];
    for (const it of stones) {
      const c = parse_color(it[0]);
      let v;
      if (typeof it[1] === "string") v = parse_vertex(it[1], this.board.size);
      else v = as_int(it[1]);
      pairs.push([c, v]);
    }
    this.board.set_stones(pairs, side_i);
    return { stones: pairs.length };
  }

  cmd_play(req) {
    const color = parse_color(req["color"] !== undefined ? req["color"] : color_name(this.board.side));
    const v = req["vertex"];
    let vertex;
    if (typeof v === "string") vertex = parse_vertex(v, this.board.size);
    else if (typeof v === "number") vertex = Math.trunc(v);
    else throw new CmdError("bad args");
    const r = this.board.play(color, vertex);
    if (!r.ok) throw new CmdError("illegal move", r.reason);
    return { captures: r.captures, self_captured: r.self_captured, key: r.key };
  }

  cmd_undo() {
    const ok = this.board.undo();
    if (!ok) throw new CmdError("nothing to undo");
    return { moves: this.board.stack.length };
  }

  cmd_key() {
    const [pk, sk] = this.board.key();
    return { key: fmt_key(pk), situational: fmt_key(sk) };
  }

  cmd_legal(req) {
    const color = parse_color(req["color"] !== undefined ? req["color"] : color_name(this.board.side));
    const v = req["vertex"];
    let vertex;
    if (typeof v === "string") vertex = parse_vertex(v, this.board.size);
    else if (typeof v === "number") vertex = Math.trunc(v);
    else throw new CmdError("bad args");
    const [ok, reason] = this.board.legal(color, vertex);
    const res = { legal: ok };
    if (!ok) res["reason"] = reason;
    return res;
  }

  cmd_legal_moves() {
    const ms = this.board.legal_moves();
    return { count: ms.length, moves: ms.map((p) => format_vertex(p, this.board.size)) };
  }

  cmd_genmove(req) {
    const color = parse_color(req["color"] !== undefined ? req["color"] : color_name(this.board.side));
    const playouts = as_int(req["playouts"] !== undefined ? req["playouts"] : 500);
    const seed = as_int(req["seed"] !== undefined ? req["seed"] : 0);
    const profile = req["profile"] || {};
    if (color !== this.board.side) throw new CmdError("genmove for wrong side", "turn");
    const [mv, n, wr] = genmove(this.board, playouts, seed, profile);
    if (mv === "resign") return { vertex: "resign", visits: n, winrate: wr };
    const vertex = mv === PASS ? "pass" : format_vertex(mv, this.board.size);
    const r = this.board.play(color, mv);
    if (!r.ok) throw new CmdError("internal: chosen move illegal", r.reason);
    return { vertex, visits: n, winrate: wr };
  }

  cmd_score(req) {
    const dead = req["dead"] !== undefined ? req["dead"] : null;
    return this.board.score(dead);
  }

  cmd_prisoners() {
    return this.board.prisoners();
  }

  cmd_selftest(req) {
    let p = req["golden"];
    if (!p) p = default_golden_path();
    return run_golden(p);
  }

  cmd_quit() {
    return {};
  }

  dispatch(req) {
    const cmd = req["cmd"];
    const fn = this["cmd_" + String(cmd)];
    if (typeof fn !== "function") throw new CmdError("unknown command");
    return fn.call(this, req);
  }
}

export async function main() {
  const drv = new Driver();
  out({ event: "ready", protocol: 1, name: NAME, lang: LANG, version: VERSION });
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (let line of rl) {
    line = line.trim();
    if (!line) continue;
    let rid = null;
    try {
      const req = JSON.parse(line);
      rid = req["id"] !== undefined ? req["id"] : null;
      if (req["cmd"] === "quit") {
        out({ id: rid, ok: true, result: {} });
        rl.close();
        process.exit(0);
      }
      const res = drv.dispatch(req);
      out({ id: rid, ok: true, result: res });
    } catch (e) {
      if (e instanceof CmdError) {
        const resp = { id: rid, ok: false, error: e.msg };
        if (e.reason) resp["reason"] = e.reason;
        out(resp);
      } else if (e instanceof WeiqiError && e.reason) {
        // 顶点越界/非法格式 → 规范 §4 的稳定标识 "range"
        out({ id: rid, ok: false, error: e.msg, reason: e.reason });
      } else {
        out({ id: rid, ok: false, error: String(e && e.message ? e.message : e) });
      }
    }
  }
  return 0;
}

// 直接以 `node driver.mjs` 运行时进入驱动模式
function is_main_module() {
  if (!process.argv[1]) return false;
  try {
    const invoked = fs.realpathSync(path.resolve(process.argv[1]));
    const self = fs.realpathSync(fileURLToPath(import.meta.url));
    return invoked === self;
  } catch (e) {
    return false;
  }
}

if (is_main_module()) {
  main().then((code) => process.exit(code));
}
