// harness/client.mjs — 引擎 JSON-stdio 客户端（零依赖）
//
// 契约见 docs/PROTOCOL_SPEC.md §7：spawn 子进程 → 等 ready 行 → 逐条 rpc（带超时）。

import { spawn } from "node:child_process";
import readline from "node:readline";

export class EngineError extends Error {}

export class EngineClient {
  constructor(spec, { timeoutMs = 120000, genmoveTimeoutMs = 600000 } = {}) {
    this.spec = spec;
    this.timeoutMs = timeoutMs;
    this.genmoveTimeoutMs = genmoveTimeoutMs;
    this.nextId = 1;
    this.pending = new Map();
    this.ready = null;
    this.stderrLines = [];
    this.dead = false;
  }

  async start() {
    this.proc = spawn(this.spec.cmd, this.spec.args, {
      cwd: this.spec.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.proc.on("error", (e) => {
      this.dead = true;
      for (const { reject } of this.pending.values()) reject(e);
      this.pending.clear();
    });
    this.proc.on("exit", (code) => {
      this.dead = true;
      const err = new EngineError(`${this.spec.name} exited (code=${code})`);
      for (const { reject } of this.pending.values()) reject(err);
      this.pending.clear();
    });
    const rlErr = readline.createInterface({ input: this.proc.stderr });
    rlErr.on("line", (l) => {
      if (this.stderrLines.length < 200) this.stderrLines.push(l);
    });
    const rl = readline.createInterface({ input: this.proc.stdout });
    this.readyPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new EngineError(`${this.spec.name} ready 超时`)), 60000);
      rl.on("line", (line) => {
        const t = line.trim();
        if (!t) return;
        let msg;
        try {
          msg = JSON.parse(t);
        } catch {
          this.stderrLines.push("[non-json stdout] " + t);
          return;
        }
        if (msg.event === "ready") {
          clearTimeout(timer);
          this.ready = msg;
          resolve(msg);
          return;
        }
        const slot = this.pending.get(msg.id);
        if (slot) {
          this.pending.delete(msg.id);
          clearTimeout(slot.timer);
          slot.resolve(msg);
        }
      });
    });
    return this.readyPromise;
  }

  rpc(cmd, args = {}) {
    if (this.dead) return Promise.reject(new EngineError(`${this.spec.name} 已退出`));
    const id = this.nextId++;
    const payload = JSON.stringify({ id, cmd, ...args });
    const timeout = cmd === "genmove" ? this.genmoveTimeoutMs : this.timeoutMs;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new EngineError(`${this.spec.name} ${cmd} 超时 (${timeout}ms)`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.proc.stdin.write(payload + "\n");
    });
  }

  /** rpc 且要求 ok=true，否则抛出（含 reason） */
  async must(cmd, args = {}) {
    const r = await this.rpc(cmd, args);
    if (!r || r.ok !== true) {
      const e = new EngineError(`${this.spec.name} ${cmd} 失败: ${r && (r.error || r.reason)}`);
      e.reason = r && r.reason;
      throw e;
    }
    return r.result;
  }

  async stop() {
    try {
      if (!this.dead) await this.rpc("quit");
    } catch {
      /* ignore */
    }
    try {
      this.proc.stdin.end();
    } catch {
      /* ignore */
    }
    await new Promise((r) => setTimeout(r, 60));
    if (this.proc && this.proc.exitCode === null) {
      try {
        this.proc.kill();
      } catch {
        /* ignore */
      }
    }
  }
}

export async function startEngine(spec, opts) {
  const c = new EngineClient(spec, opts);
  await c.start();
  return c;
}
