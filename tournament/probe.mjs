// tournament/probe.mjs — 引擎可用性探针（探针制：起不来的自动剔除，不出假结果）
//
// 用法：node probe.mjs
// 输出：每个引擎的 hello 信息 + 一次 9 路空盘 genmove 的耗时与速度

import { availableEngines } from "../harness/engines.mjs";
import { EngineClient } from "../harness/client.mjs";

const PROBE_PLAYOUTS = Number(process.env.PROBE_PLAYOUTS || 200);

async function main() {
  const specs = availableEngines();
  console.log(`探针：候选引擎 ${specs.length} 个`);
  let ok = 0;
  for (const spec of specs) {
    const c = new EngineClient(spec);
    const t0 = Date.now();
    try {
      const ready = await c.start();
      await c.must("clear", { size: 9 });
      const t1 = Date.now();
      const r = await c.must("genmove", { color: "B", playouts: PROBE_PLAYOUTS, seed: 1 });
      const t2 = Date.now();
      ok++;
      console.log(`  OK   ${spec.key.padEnd(4)} ${ready.name} v${ready.version} ` +
        `start=${t1 - t0}ms genmove=${r.vertex} visits=${r.visits} ` +
        `${((t2 - t1) / 1000).toFixed(2)}s (${(PROBE_PLAYOUTS / ((t2 - t1) / 1000)).toFixed(0)} playouts/s)`);
    } catch (e) {
      console.log(`  FAIL ${spec.key.padEnd(4)} ${e.message}`);
    } finally {
      await c.stop();
    }
  }
  console.log(`可用：${ok}/${specs.length}`);
  process.exit(ok >= 2 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
