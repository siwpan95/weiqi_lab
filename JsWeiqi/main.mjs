// main.mjs — JsWeiqi CLI
//
// 用法：
//     node main.mjs test        # 黄金值 + 内部单测（验收门）
//     node main.mjs selftest    # 仅黄金值
//     node main.mjs driver      # JSON-stdio 驱动模式（harness/tournament 用）
//     node main.mjs selfplay N [playouts]  # 自对弈 N 手（冒烟）

import { run_golden, default_golden_path } from "./golden.mjs";

const USAGE = "usage: node main.mjs test|selftest|driver|selfplay [n] [playouts]";

async function main() {
  const args = process.argv.slice(2);
  const mode = args.length ? args[0] : "test";

  if (mode === "driver") {
    const { main: drv_main } = await import("./driver.mjs");
    return await drv_main();
  }

  if (mode === "test" || mode === "selftest") {
    const t0 = Date.now();
    const g = run_golden(default_golden_path());
    let u = { passed: 0, failed: 0, failures: [] };
    if (mode === "test") {
      const { run_unit_tests } = await import("./tests.mjs");
      u = run_unit_tests();
    }
    const gp = g.passed;
    const gf = g.failed;
    const up = u.passed;
    const uf = u.failed;
    const total = gp + gf + up + uf;
    for (const f of g.failures.slice(0, 10)) {
      console.log("  GOLDEN FAIL " + f.id + ": " + JSON.stringify(f.miss || f.error));
    }
    for (const f of u.failures.slice(0, 10)) {
      console.log("  UNIT   FAIL " + f.name + ": " + f.detail);
    }
    const ok = gf === 0 && uf === 0;
    const elapsed = ((Date.now() - t0) / 1000).toFixed(2);
    console.log(
      (ok ? "PASS" : "FAIL") + ": " + (total - gf - uf) + " passed, " + (gf + uf)
      + " failed (golden " + gp + "/" + (gp + gf) + ", unit " + up + "/" + (up + uf)
      + ") " + elapsed + "s",
    );
    return ok ? 0 : 1;
  }

  if (mode === "selfplay") {
    const { Board } = await import("./rules.mjs");
    const ai = await import("./ai.mjs");
    const n = args.length > 1 ? parseInt(args[1], 10) : 60;
    const playouts = args.length > 2 ? parseInt(args[2], 10) : 30;
    const b = new Board(9);
    const t0 = Date.now();
    let played = 0;
    while (!b.is_over() && played < n) {
      const [mv] = ai.genmove(b, playouts, played * 17 + 1, null);
      if (mv === "resign") {
        console.log("ply " + played + ": resign");
        break;
      }
      const r = b.play(b.side, mv);
      if (!r.ok) {
        console.log("illegal pick: " + JSON.stringify(r));
        return 1;
      }
      played += 1;
    }
    const sc = b.score();
    console.log("selfplay plies=" + played + " over=" + b.is_over() + " result=" + sc.result
      + " black=" + sc.black + " white=" + sc.white + " dame=" + sc.dame
      + " " + ((Date.now() - t0) / 1000).toFixed(1) + "s");
    return 0;
  }

  console.log(USAGE);
  return 2;
}

main().then((code) => process.exit(code));
