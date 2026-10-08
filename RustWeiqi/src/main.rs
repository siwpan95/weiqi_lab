//! main.rs — RustWeiqi CLI
//!
//! 用法：
//!     rustweiqi test        # 黄金值 + 内部单测（验收门）
//!     rustweiqi selftest    # 仅黄金值
//!     rustweiqi driver      # JSON-stdio 驱动模式（harness/tournament 用）
//!     rustweiqi selfplay N  # 自对弈 N 手（冒烟）
//!     rustweiqi bench [N]   # 开发基准：纯 playout 吞吐（默认 20 万次）

mod ai;
mod driver;
mod golden;
mod rules;
mod tests;

use std::process::exit;
use std::time::Instant;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let mode = args.get(1).map(|s| s.as_str()).unwrap_or("test");
    let code = match mode {
        "driver" => driver::run_driver(),
        "test" | "selftest" => run_selftest(mode == "test"),
        "selfplay" => run_selfplay(&args),
        "bench" => run_bench(&args),
        _ => {
            println!("usage: rustweiqi test|selftest|driver|selfplay [n] [playouts]|bench [iters]");
            2
        }
    };
    exit(code);
}

fn golden_path() -> Option<String> {
    std::env::var("WEIQI_GOLDEN")
        .ok()
        .or_else(golden::default_golden_path)
}

fn run_selftest(include_unit: bool) -> i32 {
    let t0 = Instant::now();
    let path = match golden_path() {
        Some(p) => p,
        None => {
            println!("FAIL: cannot locate spec/golden.json");
            return 1;
        }
    };
    let g = match golden::run_golden(&path) {
        Ok(g) => g,
        Err(e) => {
            println!("FAIL: {}", e);
            return 1;
        }
    };
    let u = if include_unit {
        tests::run_unit_tests()
    } else {
        tests::TestResult::empty()
    };

    let (gp, gf) = (g.passed, g.failed);
    let (up, uf) = (u.passed, u.failed);
    let total = gp + gf + up + uf;

    for f in g.failures.iter().take(10) {
        let id = f.get("id").and_then(|v| v.as_str()).unwrap_or("?");
        let detail = f
            .get("miss")
            .cloned()
            .or_else(|| f.get("error").cloned())
            .unwrap_or(golden::Json::Null);
        println!("  GOLDEN FAIL {}: {}", id, golden::to_json_string(&detail));
    }
    for (name, detail) in u.failures.iter().take(10) {
        println!("  UNIT   FAIL {}: {}", name, detail);
    }

    let ok = gf == 0 && uf == 0;
    println!(
        "{}: {} passed, {} failed (golden {}/{}, unit {}/{}) {:.2}s",
        if ok { "PASS" } else { "FAIL" },
        total - gf - uf,
        gf + uf,
        gp,
        gp + gf,
        up,
        up + uf,
        t0.elapsed().as_secs_f64()
    );
    if ok {
        0
    } else {
        1
    }
}

fn run_bench(args: &[String]) -> i32 {
    let iters: i32 = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(200000);
    // 9 路中盘局面（与 MCTS 基准同型），纯 playout 吞吐。
    let mut b = rules::Board::new(9, None, rules::profile("cn").unwrap());
    let setup: &[(u8, &str)] = &[
        (1, "D4"), (1, "F4"), (1, "E3"), (2, "F6"), (2, "E6"),
        (1, "G7"), (2, "D7"), (1, "C6"), (2, "H3"),
    ];
    let stones: Vec<(u8, isize)> = setup
        .iter()
        .map(|&(c, s)| (c, rules::parse_vertex(s, 9).unwrap()))
        .collect();
    b.set_stones(&stones, 1);
    let (moves, secs) = ai::bench_playouts(&b, iters, 1);
    println!(
        "bench playouts={} moves={} {:.3}s  {:.0} playouts/s  {:.1} M moves/s",
        iters,
        moves,
        secs,
        iters as f64 / secs,
        moves as f64 / secs / 1e6
    );
    let (n, s2) = ai::bench_probe(&b, 20_000_000);
    println!("bench probe n={} {:.3}s  {:.1} ns/probe", n, s2, s2 / 20_000_000.0 * 1e9);
    0
}

fn run_selfplay(args: &[String]) -> i32 {    let n: i32 = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(60);
    let playouts: i32 = args.get(3).and_then(|s| s.parse().ok()).unwrap_or(30);
    let mut b = rules::Board::new(9, None, rules::profile("cn").unwrap());
    let t0 = Instant::now();
    let mut played = 0i32;
    while !b.is_over() && played < n {
        let g = ai::genmove(&b, playouts, played as i64 * 17 + 1, &ai::Profile::default());
        let mv = match g.mv {
            ai::Move::Resign => {
                println!("ply {}: resign", played);
                break;
            }
            ai::Move::Point(p) => p as isize,
            ai::Move::Pass => -1,
        };
        let r = b.play(b.side, mv);
        if !r.ok {
            println!("illegal pick: {:?}", r.reason);
            return 1;
        }
        played += 1;
    }
    let sc = b.score(None);
    println!(
        "selfplay plies={} over={} result={} black={} white={} dame={} {:.1}s",
        played,
        b.is_over(),
        sc.result,
        sc.black,
        sc.white,
        sc.dame,
        t0.elapsed().as_secs_f64()
    );
    0
}
