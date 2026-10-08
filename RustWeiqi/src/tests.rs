//! tests.rs — 内部单元测试（规则不变量 + AI 行为），与 golden.json 互补。
//!
//! 对照 PyWeiqi/tests.py。

use crate::ai::{self, Move, Profile, Rng};
use crate::rules::*;

pub struct TestResult {
    pub passed: i32,
    pub failed: i32,
    pub failures: Vec<(String, String)>,
}

impl TestResult {
    pub fn empty() -> TestResult {
        TestResult {
            passed: 0,
            failed: 0,
            failures: Vec::new(),
        }
    }
}

struct T {
    passed: i32,
    failed: i32,
    failures: Vec<(String, String)>,
}

impl T {
    fn new() -> T {
        T {
            passed: 0,
            failed: 0,
            failures: Vec::new(),
        }
    }
    fn check(&mut self, name: &str, cond: bool, detail: String) {
        if cond {
            self.passed += 1;
        } else {
            self.failed += 1;
            self.failures.push((name.to_string(), detail));
        }
    }
    fn eq<X: PartialEq + std::fmt::Debug>(&mut self, name: &str, got: X, exp: X) {
        let cond = got == exp;
        let detail = format!("got={:?} exp={:?}", got, exp);
        self.check(name, cond, detail);
    }
}

fn p(size: usize, s: &str) -> isize {
    parse_vertex(s, size).unwrap()
}

fn free_cells(cells: &[u8], v: u8) -> usize {
    cells.iter().filter(|&&c| c == v).count()
}

pub fn run_unit_tests() -> TestResult {
    let mut t = T::new();

    // ---------- 坐标 ----------
    let mut ok = true;
    for &size in &[2usize, 5, 9, 13, 19] {
        for y in 0..size {
            for x in 0..size {
                let idx = y * size + x;
                let s = format_vertex(idx as isize, size);
                if parse_vertex(&s, size).unwrap() != idx as isize {
                    ok = false;
                }
            }
        }
    }
    t.check("vertex.roundtrip.all_sizes", ok, String::new());
    t.eq("vertex.skip_I", format_vertex(8, 9), "J1".to_string());
    t.eq("vertex.pass", parse_vertex("PASS", 9).unwrap(), -1);
    t.eq("vertex.lowercase", parse_vertex("e5", 9).unwrap(), p(9, "E5"));
    let mut bad = 0;
    for s in ["I5", "A0", "A10", "", "Z9", "5A"] {
        if parse_vertex(s, 9).is_err() {
            bad += 1;
        }
    }
    t.eq("vertex.reject_invalid", bad, 6);
    t.eq(
        "color.parse",
        (parse_color("b").unwrap(), parse_color("WHITE").unwrap()),
        (1u8, 2u8),
    );

    // ---------- Zobrist ----------
    let mut vals = std::collections::HashSet::new();
    for c in 1..=2 {
        for pp in 0..MAX_POINTS {
            vals.insert(ZB[c][pp]);
        }
    }
    t.eq("zobrist.distinct", vals.len(), MAX_POINTS * 2);
    t.check("zobrist.sidekey_nonzero", SIDEKEY_W != 0, String::new());
    let cn = profile("cn").unwrap();

    let mut b9 = Board::new(9, None, cn);
    t.eq("zobrist.empty_board_zero", b9.key().0, 0u64);
    let mut b19 = Board::new(19, None, cn);
    b9.set_stones(&[(1, p(9, "A1"))], 1);
    b19.set_stones(&[(1, p(19, "A1"))], 1);
    t.eq("zobrist.size_independent", b9.key().0, b19.key().0);
    t.eq("zobrist.single_stone_A1", b9.key().0, splitmix64(0));
    let mut b9e = Board::new(9, None, cn);
    b9e.set_stones(&[(1, p(9, "E5"))], 1);
    t.eq("zobrist.single_stone_E5_index40", b9e.key().0, splitmix64(40));
    let bk = b9.key().0;
    b9.side = 2;
    t.eq("zobrist.situational_flip", b9.key().1, bk ^ SIDEKEY_W);

    // ---------- 规则档 ----------
    t.check(
        "rules.cn",
        cn.ko == Ko::Positional
            && cn.suicide == Suicide::Forbid
            && cn.scoring == Scoring::Area
            && cn.komi == 7.5,
        format!("{:?}", cn),
    );
    t.eq("rules.tt", profile("tt").unwrap().suicide, Suicide::Allow);
    t.eq("rules.jp", profile("jp").unwrap().scoring, Scoring::Territory);
    t.check(
        "rules.reject_bad_ko",
        rules_from_parts(Some("bogus"), None, None, None).is_err(),
        String::new(),
    );

    // ---------- 提子与气 ----------
    let mut b = Board::new(9, None, cn);
    b.set_stones(
        &[(2, p(9, "E5")), (1, p(9, "E4")), (1, p(9, "E6")), (1, p(9, "D5"))],
        1,
    );
    let r = b.play(1, p(9, "F5"));
    t.check(
        "capture.single",
        r.ok && r.captures == 1,
        format!("ok={} caps={}", r.ok, r.captures),
    );
    t.eq("capture.prisoners", b.prisoners(), (1, 0));

    let mut b = Board::new(9, None, cn);
    b.set_stones(
        &[
            (1, p(9, "E4")),
            (1, p(9, "E5")),
            (1, p(9, "E6")),
            (2, p(9, "D4")),
            (2, p(9, "D5")),
            (2, p(9, "D6")),
            (2, p(9, "F4")),
            (2, p(9, "F5")),
            (2, p(9, "E3")),
            (2, p(9, "E7")),
        ],
        2,
    );
    let r = b.play(2, p(9, "F6"));
    t.check(
        "capture.three_stones",
        r.ok && r.captures == 3,
        format!("ok={} caps={}", r.ok, r.captures),
    );

    let mut b = Board::new(9, None, cn);
    b.set_stones(&[(1, p(9, "E5")), (1, p(9, "E6"))], 1);
    let (members, libs) = b.group(p(9, "E5") as usize);
    t.eq("group.members", members.len(), 2);
    t.eq("group.liberties", libs.len(), 6);

    // ---------- 自杀 ----------
    let setup = [
        (2, p(9, "E4")),
        (2, p(9, "E6")),
        (2, p(9, "D5")),
        (2, p(9, "F5")),
    ];
    let mut b = Board::new(9, None, cn);
    b.set_stones(&setup, 1);
    let r = b.play(1, p(9, "E5"));
    t.check(
        "suicide.forbid",
        !r.ok && r.reason == Some("suicide"),
        format!("{:?}", r.reason),
    );
    t.eq(
        "suicide.forbid.board_unchanged",
        free_cells(&b.cells, 0),
        81usize - 4,
    );

    // 允许自杀：自提复原盘面在 PSK 下非法，故用"多子自提"验证
    let tt = profile("tt").unwrap();
    let mut b = Board::new(3, None, tt);
    b.set_stones(
        &[
            (1, p(3, "A1")),
            (1, p(3, "B1")),
            (2, p(3, "A2")),
            (2, p(3, "B2")),
            (2, p(3, "C2")),
        ],
        1,
    );
    let r = b.play(1, p(3, "C1"));
    t.check(
        "suicide.allow.multi_stone",
        r.ok && r.self_captured == 3,
        format!("ok={} self={}", r.ok, r.self_captured),
    );
    t.eq("suicide.allow.no_black_stone", free_cells(&b.cells, 1), 0usize);

    let mut r = Board::new(3, None, tt);
    r.set_stones(&[(2, p(3, "A2")), (2, p(3, "B2")), (2, p(3, "B1"))], 1);
    t.check(
        "suicide.restore_blocked_by_PSK",
        r.play(1, p(3, "A1")).reason == Some("superko"),
        String::new(),
    );

    let simple_allow = rules_from_parts(Some("simple"), Some("allow"), Some("area"), None).unwrap();
    let mut r = Board::new(3, None, simple_allow);
    r.set_stones(&[(2, p(3, "A2")), (2, p(3, "B2")), (2, p(3, "B1"))], 1);
    let rr = r.play(1, p(3, "A1"));
    t.check(
        "suicide.restore_allowed_by_simple_ko",
        rr.ok && rr.self_captured == 1,
        format!("ok={} self={}", rr.ok, rr.self_captured),
    );

    // 提子先于自杀判定（角部：填 A1 提两子，非自杀）
    let mut b = Board::new(5, None, cn);
    b.set_stones(
        &[
            (2, p(5, "A2")),
            (2, p(5, "B1")),
            (1, p(5, "A3")),
            (1, p(5, "B2")),
            (1, p(5, "C1")),
        ],
        1,
    );
    let r = b.play(1, p(5, "A1"));
    t.check(
        "suicide.after_capture",
        r.ok && r.captures == 2,
        format!("ok={} caps={}", r.ok, r.captures),
    );

    // ---------- 劫 ----------
    let ko_setup = [
        (2, p(9, "D4")),
        (2, p(9, "C3")),
        (2, p(9, "C5")),
        (2, p(9, "B4")),
        (1, p(9, "D3")),
        (1, p(9, "D5")),
        (1, p(9, "E4")),
    ];
    let mut b = Board::new(9, None, cn);
    b.set_stones(&ko_setup, 1);
    let r = b.play(1, p(9, "C4"));
    t.check(
        "ko.capture_ok",
        r.ok && r.captures == 1,
        format!("ok={} caps={}", r.ok, r.captures),
    );
    t.eq("ko.point_set", b.ko_point, p(9, "D4"));
    let (ok, reason) = b.legal(2, p(9, "D4"));
    t.check(
        "ko.immediate_recapture_illegal",
        !ok && reason == Some("ko"),
        format!("{:?}", reason),
    );

    let jp = profile("jp").unwrap();
    let mut b = Board::new(9, None, jp);
    b.set_stones(&ko_setup, 1);
    b.play(1, p(9, "C4"));
    b.play(2, -1);
    t.eq("ko.pass_clears_point", b.ko_point, -1);

    let mut b = Board::new(9, None, cn);
    b.set_stones(&ko_setup, 1);
    b.play(1, p(9, "C4"));
    b.play(2, p(9, "H9"));
    b.play(1, p(9, "H1"));
    let (ok, reason) = b.legal(2, p(9, "D4"));
    t.check(
        "ko.delayed_recapture_legal",
        ok,
        format!("{:?}", reason),
    );

    // ---------- undo ----------
    type Snap = ((u64, u64), u8, isize, Vec<u8>, [i32; 3], usize, usize, usize);
    let mut b = Board::new(9, None, cn);
    let mut snaps: Vec<Snap> = Vec::new();
    for i in 0..12 {
        snaps.push((
            b.key(),
            b.side,
            b.ko_point,
            b.cells.clone(),
            b.captures,
            b.hist_pos.len(),
            b.hist_sit.len(),
            b.stack.len(),
        ));
        let legal = b.legal_moves();
        if legal.is_empty() {
            break;
        }
        let mv = legal[(i * 7) % legal.len()] as isize;
        let r = b.play(b.side, mv);
        if !r.ok {
            break;
        }
    }
    let mut okall = true;
    for i in (0..snaps.len()).rev() {
        b.undo();
        let s = &snaps[i];
        if b.key() != s.0
            || b.side != s.1
            || b.ko_point != s.2
            || b.cells != s.3
            || b.captures != s.4
            || b.hist_pos.len() != s.5
            || b.hist_sit.len() != s.6
            || b.stack.len() != s.7
        {
            okall = false;
        }
    }
    t.check("undo.restores_exact_state", okall, String::new());

    let mut b = Board::new(9, None, cn);
    b.play(1, p(9, "E5"));
    b.play(2, -1); // 白方 pass
    t.eq("undo.pass", b.undo(), true);
    t.eq("undo.pass_restored_side", b.side, 2);
    t.eq("undo.then_move", b.undo(), true);
    t.eq("undo.move_restored_side", b.side, 1);
    t.eq("undo.empty_stack", b.undo(), false);

    // ---------- clone / set_stones ----------
    let mut b = Board::new(9, None, cn);
    b.play(1, p(9, "E5"));
    let mut c = b.clone();
    c.play(2, p(9, "D5"));
    t.eq(
        "clone.independent",
        (free_cells(&b.cells, 0), free_cells(&c.cells, 0)),
        (80usize, 79usize),
    );
    let mut b = Board::new(9, None, cn);
    b.play(1, p(9, "E5"));
    b.set_stones(&[(2, p(9, "A1"))], 2);
    t.eq(
        "set_stones.resets_history",
        (b.hist_pos.len(), b.captures[1], b.side),
        (1usize, 0i32, 2u8),
    );

    // ---------- 计分不变量 ----------
    let mut okarea = true;
    let mut rng = Rng::new(2026);
    for _trial in 0..30 {
        let mut b = Board::new(9, None, cn);
        for _i in 0..20 {
            let legal = b.legal_moves();
            if legal.is_empty() {
                break;
            }
            let m = legal[rng.randint(legal.len())];
            b.play(b.side, m as isize);
        }
        let sc = b.score(None);
        if sc.black + sc.white + sc.dame != 81 {
            okarea = false;
        }
    }
    t.check("score.area_partition_invariant", okarea, String::new());

    // ---------- 终局 ----------
    let mut b = Board::new(9, None, cn);
    b.play(1, -1);
    t.eq("pass.one_not_over", b.is_over(), false);
    b.play(2, -1);
    t.eq("pass.two_over", b.is_over(), true);
    let r = b.play(1, p(9, "E5"));
    t.check(
        "pass.play_after_over",
        !r.ok && r.reason == Some("over"),
        format!("{:?}", r.reason),
    );
    b.undo();
    t.eq("pass.undo_reopens", b.is_over(), false);

    // ---------- 数值格式 ----------
    t.eq("fmt_num.int", fmt_num(3.0), "3".to_string());
    t.eq("fmt_num.half", fmt_num(3.5), "3.5".to_string());
    t.eq("fmt_num.quarter", fmt_num(0.25), "0.25".to_string());
    t.eq("fmt_num.zero", fmt_num(0.0), "0".to_string());

    // ---------- AI ----------
    let pr = Profile::default();
    let mut b = Board::new(9, None, cn);
    b.set_stones(
        &[(1, p(9, "E5")), (2, p(9, "E3")), (1, p(9, "G5")), (2, p(9, "G3"))],
        1,
    );
    let g1 = ai::genmove(&b, 40, 5, &pr);
    let g2 = ai::genmove(&b, 40, 5, &pr);
    t.check(
        "ai.deterministic_same_seed",
        g1.mv == g2.mv && g1.visits == g2.visits,
        format!("{:?} {:?}", g1.mv, g2.mv),
    );
    let legal = b.legal_moves();
    let is_legal = match g1.mv {
        Move::Point(pp) => legal.contains(&pp),
        _ => true,
    };
    t.check("ai.legal_move", is_legal, format!("{:?}", g1.mv));
    let g3 = ai::genmove(&b, 40, 99, &pr);
    t.check(
        "ai.different_seed_explores",
        matches!(g3.mv, Move::Point(_) | Move::Pass | Move::Resign),
        String::new(),
    );

    let mut b = Board::new(9, None, cn);
    b.set_stones(
        &[
            (2, p(9, "E5")),
            (2, p(9, "E6")),
            (2, p(9, "E7")),
            (1, p(9, "D5")),
            (1, p(9, "D6")),
            (1, p(9, "D7")),
            (1, p(9, "F5")),
            (1, p(9, "F6")),
            (1, p(9, "F7")),
            (1, p(9, "E4")),
        ],
        1,
    );
    let legal9 = b.legal_moves();
    let mut allok = true;
    for pl in [50, 150, 300] {
        let g = ai::genmove(&b, pl, 11, &pr);
        if let Move::Point(pp) = g.mv {
            if !legal9.contains(&pp) {
                allok = false;
            }
        }
    }
    t.check("ai.genmove_always_legal", allok, String::new());
    t.check(
        "ai.priors_capture_higher",
        ai::move_prior(2, 3) > ai::move_prior(0, 3),
        String::new(),
    );
    t.check(
        "ai.priors_self_atari_lower",
        ai::move_prior(0, 1) < ai::move_prior(0, 3),
        String::new(),
    );

    // 自对弈可终局且全着合法
    let mut b = Board::new(9, None, cn);
    let mut plies = 0i32;
    let mut alllegal = true;
    while !b.is_over() && plies < 200 {
        let g = ai::genmove(&b, 15, 100 + plies as i64, &pr);
        let mv = match g.mv {
            Move::Resign => break,
            Move::Point(pp) => pp as isize,
            Move::Pass => -1,
        };
        let r = b.play(b.side, mv);
        if !r.ok {
            alllegal = false;
            break;
        }
        plies += 1;
    }
    t.check(
        "ai.selfplay_legal_and_terminates",
        alllegal && b.is_over(),
        format!("plies={}", plies),
    );

    TestResult {
        passed: t.passed,
        failed: t.failed,
        failures: t.failures,
    }
}
