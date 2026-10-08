// golden.mjs — 黄金值用例执行器（各语言等价实现；数据源 spec/golden.json）
//
// 参照：PyWeiqi/golden.py。spec/golden.json 只读，不得修改。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  Board, parse_vertex, format_vertex, parse_color, normalize_rules, fmt_key,
} from "./rules.mjs";

export function build_board(setup) {
  setup = setup || {};
  const size = Math.trunc(Number(setup["size"] !== undefined ? setup["size"] : 9));
  const rules = setup["rules"] !== undefined ? setup["rules"] : "cn";
  const rd = normalize_rules(rules);
  const komi = setup["komi"];
  const b = new Board(size, komi === undefined || komi === null ? null : Number(komi), rd);
  if (setup["stones"] !== undefined && setup["stones"] !== null) {
    const pairs = setup["stones"].map(
      (it) => [parse_color(it[0]), parse_vertex(it[1], size)],
    );
    const side = setup["side"] !== undefined ? setup["side"] : "B";
    b.set_stones(pairs, parse_color(side));
    const kp = setup["ko_point"];
    if (kp !== undefined && kp !== null) {
      b.ko_point = typeof kp === "string" ? parse_vertex(kp, size) : Math.trunc(Number(kp));
    }
  }
  if (setup["moves"] && setup["moves"].length) {
    for (const item of setup["moves"]) {
      const c = parse_color(item[0]);
      const v = parse_vertex(item[1], size);
      const r = b.play(c, v);
      if (!r.ok) {
        throw new Error(
          "setup move illegal: " + item[0] + " " + item[1] + " (" + r.reason + ")",
        );
      }
    }
  }
  return b;
}

export function run_case(case_) {
  const b = build_board(case_["setup"] || {});
  const op = case_["op"];
  const args = case_["args"] || {};
  if (op === "key") {
    const [pk, sk] = b.key();
    return { key: fmt_key(pk), situational: fmt_key(sk) };
  }
  if (op === "legal") {
    const c = parse_color(args["color"] !== undefined ? args["color"] : "B");
    const v = parse_vertex(args["vertex"], b.size);
    const [ok, reason] = b.legal(c, v);
    const out = { legal: ok };
    if (!ok) out["reason"] = reason;
    return out;
  }
  if (op === "legal_moves") {
    const ms = b.legal_moves();
    return { count: ms.length, moves: ms.map((p) => format_vertex(p, b.size)) };
  }
  if (op === "play") {
    const c = parse_color(args["color"]);
    const v = parse_vertex(args["vertex"], b.size);
    const r = b.play(c, v);
    if (!r.ok) return { ok: false, reason: r.reason };
    return { ok: true, captures: r.captures, self_captured: r.self_captured };
  }
  if (op === "undo") {
    const n = Math.trunc(Number(args["n"] !== undefined ? args["n"] : 1));
    let ok = true;
    for (let i = 0; i < n; i++) {
      if (!b.undo()) ok = false;
    }
    return { ok };
  }
  if (op === "score") {
    const sc = b.score(args["dead"] !== undefined ? args["dead"] : null);
    return { black: sc["black"], white: sc["white"], dame: sc["dame"], result: sc["result"] };
  }
  if (op === "prisoners") {
    return b.prisoners();
  }
  if (op === "over") {
    return { over: b.is_over() };
  }
  throw new Error("unknown op: " + op);
}

function eq_val(a, b) {
  if (typeof a === "number" && typeof b === "number") {
    // 浮点比较容差（对齐 golden.py 的 1e-9）
    return Math.abs(a - b) <= 1e-9;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!eq_val(a[i], b[i])) return false;
    }
    return true;
  }
  return a === b;
}

export function compare(expect, got) {
  const miss = [];
  for (const k of Object.keys(expect)) {
    const v = expect[k];
    const gv = got[k];
    if (!eq_val(v, gv)) miss.push([k, v, gv === undefined ? null : gv]);
  }
  return miss;
}

export function run_golden(p) {
  const data = JSON.parse(fs.readFileSync(p, "utf8"));
  let passed = 0;
  let failed = 0;
  const failures = [];
  for (const case_ of data["cases"]) {
    try {
      const got = run_case(case_);
      const miss = compare(case_["expect"], got);
      if (miss.length) {
        failed += 1;
        failures.push({ id: case_["id"], got, expect: case_["expect"], miss });
      } else {
        passed += 1;
      }
    } catch (e) {
      failed += 1;
      failures.push({ id: case_["id"], error: String(e && e.message ? e.message : e) });
    }
  }
  return { passed, failed, total: passed + failed, failures };
}

export function default_golden_path() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const base = path.dirname(here);
  return path.join(base, "spec", "golden.json");
}
