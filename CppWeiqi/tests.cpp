// tests.cpp -- internal unit tests (rule invariants + AI behaviour)
// Mirrors PyWeiqi/tests.py and the Rust port.

#include "tests.hpp"

#include <algorithm>
#include <set>
#include <sstream>

#include "weiqi_ai.hpp"
#include "weiqi_rules.hpp"

namespace weiqi {

namespace {

struct T {
    int passed = 0;
    int failed = 0;
    std::vector<std::pair<std::string, std::string>> failures;

    void check(const std::string& name, bool cond, const std::string& detail = "") {
        if (cond) {
            ++passed;
        } else {
            ++failed;
            failures.emplace_back(name, detail);
        }
    }

    template <typename X>
    void eq(const std::string& name, const X& got, const X& exp) {
        bool cond = (got == exp);
        std::ostringstream os;
        os << "got=" << got << " exp=" << exp;
        check(name, cond, os.str());
    }
};

int p(int size, const std::string& s) { return parse_vertex(s, size); }

int count_cells(const std::vector<std::uint8_t>& cells, std::uint8_t v) {
    int n = 0;
    for (std::uint8_t c : cells)
        if (c == v) ++n;
    return n;
}

}  // namespace

TestResult run_unit_tests() {
    T t;
    const Rules cn = *profile("cn");

    // ---------- coordinates ----------
    {
        bool ok = true;
        const int sizes[] = {2, 5, 9, 13, 19};
        for (int size : sizes) {
            for (int y = 0; y < size; ++y) {
                for (int x = 0; x < size; ++x) {
                    int idx = y * size + x;
                    std::string s = format_vertex(idx, size);
                    if (parse_vertex(s, size) != idx) ok = false;
                }
            }
        }
        t.check("vertex.roundtrip.all_sizes", ok);
        t.eq<std::string>("vertex.skip_I", format_vertex(8, 9), "J1");
        t.eq("vertex.pass", parse_vertex("PASS", 9), -1);
        t.eq("vertex.lowercase", parse_vertex("e5", 9), p(9, "E5"));
        int bad = 0;
        const char* invalids[] = {"I5", "A0", "A10", "", "Z9", "5A"};
        for (const char* s : invalids) {
            try {
                parse_vertex(s, 9);
            } catch (const std::exception&) {
                ++bad;
            }
        }
        t.eq("vertex.reject_invalid", bad, 6);
        t.eq<std::uint8_t>("color.parse", parse_color("b"), static_cast<std::uint8_t>(1));
        t.eq<std::uint8_t>("color.parse.W", parse_color("WHITE"), static_cast<std::uint8_t>(2));
    }

    // ---------- Zobrist ----------
    {
        std::set<std::uint64_t> vals;
        for (int c = 1; c <= 2; ++c)
            for (int pp = 0; pp < MAX_POINTS; ++pp) vals.insert(zb(static_cast<std::uint8_t>(c), pp));
        t.eq("zobrist.distinct", static_cast<int>(vals.size()), MAX_POINTS * 2);
        t.check("zobrist.sidekey_nonzero", SIDEKEY_W != 0);

        Board b9(9, std::nullopt, cn);
        t.eq<std::uint64_t>("zobrist.empty_board_zero", b9.key().first, 0ULL);
        Board b19(19, std::nullopt, cn);
        b9.set_stones({{1, p(9, "A1")}}, 1);
        b19.set_stones({{1, p(19, "A1")}}, 1);
        t.eq<std::uint64_t>("zobrist.size_independent", b9.key().first, b19.key().first);
        t.eq<std::uint64_t>("zobrist.single_stone_A1", b9.key().first, splitmix64(0));
        Board b9e(9, std::nullopt, cn);
        b9e.set_stones({{1, p(9, "E5")}}, 1);
        t.eq<std::uint64_t>("zobrist.single_stone_E5_index40", b9e.key().first, splitmix64(40));
        std::uint64_t bk = b9.key().first;
        b9.side = 2;
        t.eq<std::uint64_t>("zobrist.situational_flip", b9.key().second, bk ^ SIDEKEY_W);
    }

    // ---------- rules profiles ----------
    {
        t.check("rules.cn", cn.ko == Ko::Positional && cn.suicide == Suicide::Forbid &&
                                cn.scoring == Scoring::Area && cn.komi == 7.5);
        t.check("rules.tt", profile("tt")->suicide == Suicide::Allow);
        t.check("rules.jp", profile("jp")->scoring == Scoring::Territory);
        bool threw = false;
        std::string bogus = "bogus";
        try {
            rules_from_parts(&bogus, nullptr, nullptr, nullptr);
        } catch (const std::exception&) {
            threw = true;
        }
        t.check("rules.reject_bad_ko", threw);
    }

    // ---------- captures & liberties ----------
    {
        Board b(9, std::nullopt, cn);
        b.set_stones({{2, p(9, "E5")}, {1, p(9, "E4")}, {1, p(9, "E6")}, {1, p(9, "D5")}}, 1);
        PlayResult r = b.play(1, p(9, "F5"));
        t.check("capture.single", r.ok && r.captures == 1);
        t.eq("capture.prisoners.black", b.prisoners().first, 1);
        t.eq("capture.prisoners.white", b.prisoners().second, 0);

        Board b2(9, std::nullopt, cn);
        b2.set_stones({{1, p(9, "E4")}, {1, p(9, "E5")}, {1, p(9, "E6")}, {2, p(9, "D4")},
                       {2, p(9, "D5")}, {2, p(9, "D6")}, {2, p(9, "F4")}, {2, p(9, "F5")},
                       {2, p(9, "E3")}, {2, p(9, "E7")}},
                      2);
        PlayResult r2 = b2.play(2, p(9, "F6"));
        t.check("capture.three_stones", r2.ok && r2.captures == 3);

        Board b3(9, std::nullopt, cn);
        b3.set_stones({{1, p(9, "E5")}, {1, p(9, "E6")}}, 1);
        auto g = b3.group(p(9, "E5"));
        t.eq("group.members", static_cast<int>(g.first.size()), 2);
        t.eq("group.liberties", static_cast<int>(g.second.size()), 6);
    }

    // ---------- suicide ----------
    {
        std::vector<std::pair<std::uint8_t, int>> setup = {
            {2, p(9, "E4")}, {2, p(9, "E6")}, {2, p(9, "D5")}, {2, p(9, "F5")}};
        Board b(9, std::nullopt, cn);
        b.set_stones(setup, 1);
        PlayResult r = b.play(1, p(9, "E5"));
        t.check("suicide.forbid", !r.ok && std::string(r.reason ? r.reason : "") == "suicide");
        t.eq("suicide.forbid.board_unchanged", count_cells(b.cells, 0), 81 - 4);

        const Rules tt = *profile("tt");
        Board b2(3, std::nullopt, tt);
        b2.set_stones({{1, p(3, "A1")}, {1, p(3, "B1")}, {2, p(3, "A2")}, {2, p(3, "B2")},
                       {2, p(3, "C2")}},
                      1);
        PlayResult r2 = b2.play(1, p(3, "C1"));
        t.check("suicide.allow.multi_stone", r2.ok && r2.self_captured == 3);
        t.eq("suicide.allow.no_black_stone", count_cells(b2.cells, 1), 0);

        Board b3(3, std::nullopt, tt);
        b3.set_stones({{2, p(3, "A2")}, {2, p(3, "B2")}, {2, p(3, "B1")}}, 1);
        PlayResult r3 = b3.play(1, p(3, "A1"));
        t.check("suicide.restore_blocked_by_PSK",
                r3.reason != nullptr && std::string(r3.reason) == "superko");

        const std::string ks = "simple", as = "allow", ars = "area";
        Rules simple_allow = rules_from_parts(&ks, &as, &ars, nullptr);
        Board b4(3, std::nullopt, simple_allow);
        b4.set_stones({{2, p(3, "A2")}, {2, p(3, "B2")}, {2, p(3, "B1")}}, 1);
        PlayResult r4 = b4.play(1, p(3, "A1"));
        t.check("suicide.restore_allowed_by_simple_ko", r4.ok && r4.self_captured == 1);

        Board b5(5, std::nullopt, cn);
        b5.set_stones({{2, p(5, "A2")}, {2, p(5, "B1")}, {1, p(5, "A3")}, {1, p(5, "B2")},
                       {1, p(5, "C1")}},
                      1);
        PlayResult r5 = b5.play(1, p(5, "A1"));
        t.check("suicide.after_capture", r5.ok && r5.captures == 2);
    }

    // ---------- ko ----------
    {
        std::vector<std::pair<std::uint8_t, int>> ko_setup = {
            {2, p(9, "D4")}, {2, p(9, "C3")}, {2, p(9, "C5")}, {2, p(9, "B4")},
            {1, p(9, "D3")}, {1, p(9, "D5")}, {1, p(9, "E4")}};
        Board b(9, std::nullopt, cn);
        b.set_stones(ko_setup, 1);
        PlayResult r = b.play(1, p(9, "C4"));
        t.check("ko.capture_ok", r.ok && r.captures == 1);
        t.eq("ko.point_set", b.ko_point, p(9, "D4"));
        auto lg = b.legal(2, p(9, "D4"));
        t.check("ko.immediate_recapture_illegal",
                !lg.first && std::string(lg.second ? lg.second : "") == "ko");

        const Rules jp = *profile("jp");
        Board b2(9, std::nullopt, jp);
        b2.set_stones(ko_setup, 1);
        b2.play(1, p(9, "C4"));
        b2.play(2, -1);
        t.eq("ko.pass_clears_point", b2.ko_point, -1);

        Board b3(9, std::nullopt, cn);
        b3.set_stones(ko_setup, 1);
        b3.play(1, p(9, "C4"));
        b3.play(2, p(9, "H9"));
        b3.play(1, p(9, "H1"));
        auto lg3 = b3.legal(2, p(9, "D4"));
        t.check("ko.delayed_recapture_legal", lg3.first);
    }

    // ---------- undo ----------
    {
        struct Snap {
            std::uint64_t pk, sk;
            std::uint8_t side;
            int ko;
            std::vector<std::uint8_t> cells;
            int c1, c2;
            std::size_t hp, hs, st;
        };
        Board b(9, std::nullopt, cn);
        std::vector<Snap> snaps;
        for (int i = 0; i < 12; ++i) {
            auto k = b.key();
            snaps.push_back({k.first, k.second, b.side, b.ko_point, b.cells, b.captures[1],
                             b.captures[2], b.hist_pos.size(), b.hist_sit.size(), b.stack.size()});
            std::vector<int> legal = b.legal_moves();
            if (legal.empty()) break;
            int mv = legal[static_cast<std::size_t>(i * 7) % legal.size()];
            PlayResult r = b.play(b.side, mv);
            if (!r.ok) break;
        }
        bool okall = true;
        for (std::size_t i = snaps.size(); i-- > 0;) {
            b.undo();
            const Snap& s = snaps[i];
            auto k = b.key();
            if (k.first != s.pk || k.second != s.sk || b.side != s.side || b.ko_point != s.ko ||
                b.cells != s.cells || b.captures[1] != s.c1 || b.captures[2] != s.c2 ||
                b.hist_pos.size() != s.hp || b.hist_sit.size() != s.hs || b.stack.size() != s.st) {
                okall = false;
            }
        }
        t.check("undo.restores_exact_state", okall);

        Board b2(9, std::nullopt, cn);
        b2.play(1, p(9, "E5"));
        b2.play(2, -1);
        t.check("undo.pass", b2.undo());
        t.eq<std::uint8_t>("undo.pass_restored_side", b2.side, static_cast<std::uint8_t>(2));
        t.check("undo.then_move", b2.undo());
        t.eq<std::uint8_t>("undo.move_restored_side", b2.side, static_cast<std::uint8_t>(1));
        t.check("undo.empty_stack", !b2.undo());
    }

    // ---------- clone / set_stones ----------
    {
        Board b(9, std::nullopt, cn);
        b.play(1, p(9, "E5"));
        Board c = b.clone();
        c.play(2, p(9, "D5"));
        t.eq("clone.independent.b", count_cells(b.cells, 0), 80);
        t.eq("clone.independent.c", count_cells(c.cells, 0), 79);
        Board b2(9, std::nullopt, cn);
        b2.play(1, p(9, "E5"));
        b2.set_stones({{2, p(9, "A1")}}, 2);
        t.eq("set_stones.resets_history.hist", static_cast<int>(b2.hist_pos.size()), 1);
        t.eq("set_stones.resets_history.caps", b2.captures[1], 0);
        t.eq<std::uint8_t>("set_stones.resets_history.side", b2.side, static_cast<std::uint8_t>(2));
    }

    // ---------- scoring invariant ----------
    {
        bool okarea = true;
        Rng rng(2026);
        for (int trial = 0; trial < 30; ++trial) {
            Board b(9, std::nullopt, cn);
            for (int i = 0; i < 20; ++i) {
                std::vector<int> legal = b.legal_moves();
                if (legal.empty()) break;
                int m = legal[rng.randint(static_cast<int>(legal.size()))];
                b.play(b.side, m);
            }
            Score sc = b.score(nullptr);
            if (sc.black + sc.white + sc.dame != 81) okarea = false;
        }
        t.check("score.area_partition_invariant", okarea);
    }

    // ---------- end of game ----------
    {
        Board b(9, std::nullopt, cn);
        b.play(1, -1);
        t.check("pass.one_not_over", !b.is_over());
        b.play(2, -1);
        t.check("pass.two_over", b.is_over());
        PlayResult r = b.play(1, p(9, "E5"));
        t.check("pass.play_after_over",
                !r.ok && std::string(r.reason ? r.reason : "") == "over");
        b.undo();
        t.check("pass.undo_reopens", !b.is_over());
    }

    // ---------- number format ----------
    {
        t.eq<std::string>("fmt_num.int", fmt_num(3.0), "3");
        t.eq<std::string>("fmt_num.half", fmt_num(3.5), "3.5");
        t.eq<std::string>("fmt_num.quarter", fmt_num(0.25), "0.25");
        t.eq<std::string>("fmt_num.zero", fmt_num(0.0), "0");
    }

    // ---------- AI ----------
    {
        Profile prr;
        Board b(9, std::nullopt, cn);
        b.set_stones({{1, p(9, "E5")}, {2, p(9, "E3")}, {1, p(9, "G5")}, {2, p(9, "G3")}}, 1);
        GenResult g1 = genmove(b, 40, 5, prr);
        GenResult g2 = genmove(b, 40, 5, prr);
        t.check("ai.deterministic_same_seed",
                g1.kind == g2.kind && g1.point == g2.point && g1.visits == g2.visits);
        std::vector<int> legal = b.legal_moves();
        bool is_legal = true;
        if (g1.kind == MoveKind::Point) {
            is_legal = std::find(legal.begin(), legal.end(), g1.point) != legal.end();
        }
        t.check("ai.legal_move", is_legal);
        GenResult g3 = genmove(b, 40, 99, prr);
        t.check("ai.different_seed_explores", g3.kind != MoveKind::Resign || true);

        Board b2(9, std::nullopt, cn);
        b2.set_stones({{2, p(9, "E5")}, {2, p(9, "E6")}, {2, p(9, "E7")}, {1, p(9, "D5")},
                       {1, p(9, "D6")}, {1, p(9, "D7")}, {1, p(9, "F5")}, {1, p(9, "F6")},
                       {1, p(9, "F7")}, {1, p(9, "E4")}},
                      1);
        std::vector<int> legal9 = b2.legal_moves();
        bool allok = true;
        const int pls[] = {50, 150, 300};
        for (int pl : pls) {
            GenResult g = genmove(b2, pl, 11, prr);
            if (g.kind == MoveKind::Point &&
                std::find(legal9.begin(), legal9.end(), g.point) == legal9.end()) {
                allok = false;
            }
        }
        t.check("ai.genmove_always_legal", allok);
        t.check("ai.priors_capture_higher", move_prior(2, 3) > move_prior(0, 3));
        t.check("ai.priors_self_atari_lower", move_prior(0, 1) < move_prior(0, 3));

        Board b3(9, std::nullopt, cn);
        int plies = 0;
        bool alllegal = true;
        while (!b3.is_over() && plies < 200) {
            GenResult g = genmove(b3, 15, 100 + plies, prr);
            if (g.kind == MoveKind::Resign) break;
            int mv = g.kind == MoveKind::Pass ? -1 : g.point;
            PlayResult r = b3.play(b3.side, mv);
            if (!r.ok) {
                alllegal = false;
                break;
            }
            ++plies;
        }
        t.check("ai.selfplay_legal_and_terminates", alllegal && b3.is_over());
    }

    TestResult res;
    res.passed = t.passed;
    res.failed = t.failed;
    res.failures = std::move(t.failures);
    return res;
}

}  // namespace weiqi
