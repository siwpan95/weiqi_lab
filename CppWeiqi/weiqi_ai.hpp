// weiqi_ai.hpp -- MCTS (UCT+RAVE) engine (C++17 port of PyWeiqi/weiqi_ai.py)
//
// Design (see docs/PROTOCOL_SPEC.md 2.1 and docs/PORTING.md 5):
// - Tree and final move use the FULL rules (incl. superko); playout allows a
//   simple-ko approximation (Fuego/Pachi style trade-off).
// - Candidate pruning by Chebyshev radius around existing stones (0 = off).
// - "Local candidate" playout: first probe only the 1-neighbourhood of the last
//   move; only if empty fall back to a full-board scan.
// - RNG is a splitmix64 stream; same (position, playouts, seed, profile) is
//   reproducible within a language.
// - Performance: stamp-array generation markers (no set allocation), capture
//   pre-check, own-liberty lower bound, single-stone shortcut, reused scratch
//   buffers (zero allocation on the playout hot path).

#pragma once

#include <cstdint>
#include <vector>

#include "weiqi_rules.hpp"

namespace weiqi {

struct Profile {
    double c = 0.7;
    bool rave = true;
    double rave_k = 100.0;  // Python reference default (spec table says 1000)
    double capture_bias = 0.5;
    double pattern_bias = 0.5;
    int prune_radius = 2;
    double pass_bias = 0.0;
    double resign_threshold = 0.0;
    int resign_min_visits = 200;
    double mercy = 0.0;
    double pass_threshold = 0.5;
    double score_scale = 0.0;  // 0 -> auto = n2/2
};

// splitmix64 stream.
struct Rng {
    std::uint64_t state = 0;
    explicit Rng(long long seed);
    std::uint64_t next_u64();
    int randint(int n);
    double random();
};

double move_prior(int caps, std::size_t own_libs);

enum class MoveKind { Point, Pass, Resign };

struct GenResult {
    MoveKind kind = MoveKind::Pass;
    int point = -1;
    int visits = 0;
    double winrate = 0.0;
};

// Search `board` (full-rules Board) -> GenResult. Does NOT play the move
// (the caller re-validates with full rules).
GenResult genmove(const Board& board, int playouts, long long seed, const Profile& profile);

// Development benchmarks.
std::pair<unsigned long long, double> bench_playouts(const Board& board, int iters, long long seed);
std::pair<unsigned long long, double> bench_probe(const Board& board, int iters);

}  // namespace weiqi
