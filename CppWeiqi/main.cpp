// main.cpp -- CppWeiqi CLI
//
// Usage:
//     cppweiqi.exe test        # golden values + internal unit tests (acceptance gate)
//     cppweiqi.exe selftest    # golden values only
//     cppweiqi.exe driver      # JSON-stdio driver (harness / tournament)
//     cppweiqi.exe selfplay N  # self-play N moves (smoke)
//     cppweiqi.exe bench [N]   # dev benchmark: pure playout throughput

#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <iostream>
#include <optional>
#include <string>
#include <utility>
#include <vector>

#include "driver.hpp"
#include "golden.hpp"
#include "tests.hpp"
#include "weiqi_ai.hpp"
#include "weiqi_rules.hpp"

namespace {

using namespace weiqi;

std::optional<std::string> golden_path() {
    if (const char* env = std::getenv("WEIQI_GOLDEN")) {
        if (*env != '\0') return std::string(env);
    }
    return default_golden_path();
}

int run_selftest(bool include_unit) {
    auto t0 = std::chrono::steady_clock::now();
    std::optional<std::string> path = golden_path();
    if (!path.has_value()) {
        std::cout << "FAIL: cannot locate spec/golden.json\n";
        return 1;
    }
    GoldenResult g;
    try {
        g = run_golden(*path);
    } catch (const std::exception& e) {
        std::cout << "FAIL: " << e.what() << "\n";
        return 1;
    }
    TestResult u = include_unit ? run_unit_tests() : TestResult::empty();

    int gp = g.passed, gf = g.failed;
    int up = u.passed, uf = u.failed;
    int total = gp + gf + up + uf;

    int shown = 0;
    for (const Json& f : g.failures) {
        if (shown++ >= 10) break;
        const Json* id = f.get("id");
        const Json* miss = f.get("miss");
        const Json* err = f.get("error");
        std::cout << "  GOLDEN FAIL "
                  << (id && id->type == Json::Str ? id->s : std::string("?")) << ": "
                  << to_json_string(miss ? *miss : (err ? *err : Json::make_null())) << "\n";
    }
    shown = 0;
    for (const auto& fu : u.failures) {
        if (shown++ >= 10) break;
        std::cout << "  UNIT   FAIL " << fu.first << ": " << fu.second << "\n";
    }

    bool ok = (gf == 0 && uf == 0);
    double secs = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
    char buf[256];
    std::snprintf(buf, sizeof(buf), "%s: %d passed, %d failed (golden %d/%d, unit %d/%d) %.2fs\n",
                  ok ? "PASS" : "FAIL", total - gf - uf, gf + uf, gp, gp + gf, up, up + uf, secs);
    std::cout << buf;
    return ok ? 0 : 1;
}

int run_selfplay(const std::vector<std::string>& args) {
    int n = args.size() > 1 ? std::atoi(args[1].c_str()) : 60;
    int playouts = args.size() > 2 ? std::atoi(args[2].c_str()) : 30;
    Board b(9, std::nullopt, *profile("cn"));
    Profile pr;
    auto t0 = std::chrono::steady_clock::now();
    int played = 0;
    while (!b.is_over() && played < n) {
        GenResult g = genmove(b, playouts, static_cast<long long>(played) * 17 + 1, pr);
        if (g.kind == MoveKind::Resign) {
            std::cout << "ply " << played << ": resign\n";
            break;
        }
        int mv = g.kind == MoveKind::Pass ? -1 : g.point;
        PlayResult r = b.play(b.side, mv);
        if (!r.ok) {
            std::cout << "illegal pick: " << (r.reason ? r.reason : "?") << "\n";
            return 1;
        }
        ++played;
    }
    Score sc = b.score(nullptr);
    double secs = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
    std::cout << "selfplay plies=" << played << " over=" << (b.is_over() ? "True" : "False")
              << " result=" << sc.result << " black=" << sc.black << " white=" << sc.white
              << " dame=" << sc.dame << " " << secs << "s\n";
    return 0;
}

int run_bench(const std::vector<std::string>& args) {
    int iters = args.size() > 1 ? std::atoi(args[1].c_str()) : 200000;
    Board b(9, std::nullopt, *profile("cn"));
    const std::pair<std::uint8_t, const char*> setup[] = {
        {1, "D4"}, {1, "F4"}, {1, "E3"}, {2, "F6"}, {2, "E6"},
        {1, "G7"}, {2, "D7"}, {1, "C6"}, {2, "H3"},
    };
    std::vector<std::pair<std::uint8_t, int>> stones;
    for (const auto& s : setup) stones.emplace_back(s.first, parse_vertex(s.second, 9));
    b.set_stones(stones, 1);

    auto bp = bench_playouts(b, iters, 1);
    std::printf("bench playouts=%d moves=%llu %.3fs  %.0f playouts/s  %.1f M moves/s\n", iters,
                bp.first, bp.second, iters / bp.second,
                static_cast<double>(bp.first) / bp.second / 1e6);

    auto bpr = bench_probe(b, 20000000);
    std::printf("bench probe n=%llu %.3fs  %.1f ns/probe\n", bpr.first, bpr.second,
                bpr.second / 20000000.0 * 1e9);

    // End-to-end genmove throughput on the same mid-game position.
    int gm_playouts = 20000;
    Profile pr;
    auto t0 = std::chrono::steady_clock::now();
    GenResult g = genmove(b, gm_playouts, 7, pr);
    double secs = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
    std::printf("bench genmove playouts=%d visits=%d %.3fs  %.0f playouts/s (mv=%d wr=%.3f)\n",
                gm_playouts, g.visits, secs, gm_playouts / secs,
                g.kind == MoveKind::Point ? g.point : -1, g.winrate);
    return 0;
}

}  // namespace

int main(int argc, char** argv) {
    std::vector<std::string> args;
    for (int i = 1; i < argc; ++i) args.emplace_back(argv[i]);
    std::string mode = args.empty() ? "test" : args[0];

    if (mode == "driver") return run_driver();
    if (mode == "test") return run_selftest(true);
    if (mode == "selftest") return run_selftest(false);
    if (mode == "selfplay") return run_selfplay(args);
    if (mode == "bench") return run_bench(args);

    std::cout << "usage: cppweiqi test|selftest|driver|selfplay [n] [playouts]|bench [iters]\n";
    return 2;
}
