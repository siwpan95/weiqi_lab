// weiqi_ai.cpp -- MCTS (UCT+RAVE) engine (C++17 port of PyWeiqi/weiqi_ai.py)
//
// Performance notes (PORTING.md section 5):
// - Generation-stamp arrays instead of hash sets (zero allocation).
// - Capture pre-check, own-liberty lower bound, single-stone shortcut.
// - All hot state lives in FIXED-SIZE C ARRAYS (not std::vector): because they
//   are distinct subobjects of the same object, the compiler can prove they do
//   not alias, so board reads are not re-loaded after every scratch write
//   (this is what gives Rust's borrow checker free noalias). Scratch arrays are
//   reused across playouts, so there is zero allocation on the hot path.

#include "weiqi_ai.hpp"

#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <tuple>

namespace weiqi {

constexpr int PASS_MOVE = -1;
constexpr int MAXN = 361;  // 19*19

// ---------------------------------------------------------------------------
// RNG / priors
// ---------------------------------------------------------------------------

Rng::Rng(long long seed) {
    state = static_cast<std::uint64_t>(seed) + 0x9E3779B97F4A7C15ULL;
}

std::uint64_t Rng::next_u64() {
    state += 0x9E3779B97F4A7C15ULL;
    return splitmix64(state);
}

int Rng::randint(int n) {
    return n > 0 ? static_cast<int>(next_u64() % static_cast<std::uint64_t>(n)) : 0;
}

double Rng::random() {
    return static_cast<double>(next_u64() >> 11) * (1.0 / 9007199254740992.0);
}

double move_prior(int caps, std::size_t own_libs) {
    double q = 0.5;
    if (caps >= 2) {
        q += 0.25;
    } else if (caps == 1) {
        q += 0.15;
    }
    if (own_libs == 1) q -= 0.15;
    if (q < 0.05) {
        q = 0.05;
    } else if (q > 0.9) {
        q = 0.9;
    }
    return q;
}

namespace {

// Hot return values are packed into a single 32-bit int (fits in EAX). The
// Windows x64 ABI returns aggregates larger than 8 bytes through a hidden
// pointer, which would add a memory round-trip to every probe; packing avoids
// that. Accessors below are the only readers.
//
// simulate -> ok | caps<<1 | olibs<<10      (caps: 9 bits, olibs: 5 bits)
// scan     -> nlibs | mcount<<9 | (lib0+1)<<18
// scan_lib -> nlibs | (lib0+1)<<9
inline bool pk_ok(std::uint32_t v) { return (v & 1u) != 0; }
inline int pk_caps(std::uint32_t v) { return static_cast<int>((v >> 1) & 0x1FFu); }
inline int pk_olibs(std::uint32_t v) { return static_cast<int>((v >> 10) & 0x1Fu); }
inline std::uint32_t pk_make(bool ok, int caps, int olibs) {
    return (ok ? 1u : 0u) | (static_cast<std::uint32_t>(caps) << 1) |
           (static_cast<std::uint32_t>(olibs) << 10);
}
inline int sc_nlibs(std::uint32_t v) { return static_cast<int>(v & 0x1FFu); }
inline int sc_mcount(std::uint32_t v) { return static_cast<int>((v >> 9) & 0x1FFu); }
inline int sc_lib0(std::uint32_t v) { return static_cast<int>((v >> 18) & 0x1FFu) - 1; }
inline std::uint32_t sc_make3(int nlibs, int lib0, int mcount) {
    return static_cast<std::uint32_t>(nlibs) |
           (static_cast<std::uint32_t>(mcount) << 9) |
           (static_cast<std::uint32_t>(lib0 + 1) << 18);
}
inline int sl_nlibs(std::uint32_t v) { return static_cast<int>(v & 0x1FFu); }
inline int sl_lib0(std::uint32_t v) { return static_cast<int>((v >> 9) & 0x1FFu) - 1; }
inline std::uint32_t sl_make(int nlibs, int lib0) {
    return static_cast<std::uint32_t>(nlibs) |
           (static_cast<std::uint32_t>(lib0 + 1) << 9);
}

// ---------------------------------------------------------------------------
// Scratch (fixed arrays; reuse only, never re-zeroed between playouts)
// ---------------------------------------------------------------------------

struct Scratch {
    std::uint64_t stamp[MAXN]{};
    std::uint64_t libstamp[MAXN]{};
    std::uint64_t markstamp[MAXN]{};
    std::uint64_t gen = 0;
    std::uint64_t markgen = 0;

    int stack[MAXN];
    int sp = 0;
    int members[MAXN];
    int nmem = 0;
    int saveIdx[MAXN];
    std::uint8_t saveOld[MAXN];
    int nsave = 0;
    int captured[MAXN];
    int ncap = 0;
    int cands[MAXN];
    int ncand = 0;
    int urgent[MAXN];
    int nurg = 0;
    int pts[8];
    int npts = 0;
    int local_[MAXN];
    int nlocal = 0;
    int rescue[8];
    int nrescue = 0;
    std::uint8_t nearf[MAXN];
    std::uint8_t seen[MAXN];
};

// ---------------------------------------------------------------------------
// Lightweight board PBoard
// ---------------------------------------------------------------------------

struct PBoard {
    int size = 9;
    int n2 = 81;
    int nbr[MAXN][4];
    std::uint8_t deg[MAXN];
    std::uint8_t cells[MAXN];
    std::uint8_t side = 1;
    int ko = -1;
    int passes = 0;
    bool suicide_allow = false;
    int last = -1;
    Scratch sc;

    PBoard(int size_, const std::vector<std::vector<int>>& neigh,
           const std::uint8_t* cells_, std::uint8_t side_, int ko_, int passes_,
           bool suicide_allow_) {
        size = size_;
        n2 = size_ * size_;
        for (int p = 0; p < n2; ++p) {
            const std::vector<int>& l = neigh[p];
            deg[p] = static_cast<std::uint8_t>(l.size());
            for (int k = 0; k < 4; ++k) nbr[p][k] = k < static_cast<int>(l.size()) ? l[k] : 0;
        }
        for (int p = 0; p < n2; ++p) cells[p] = cells_[p];
        side = side_;
        ko = ko_;
        passes = passes_;
        suicide_allow = suicide_allow_;
        last = -1;
    }

    // Reuse scratch: copy state from a template (stamp generations keep rising).
    inline void reset_from(const PBoard& o) {
        for (int i = 0; i < n2; ++i) cells[i] = o.cells[i];
        side = o.side;
        ko = o.ko;
        passes = o.passes;
        suicide_allow = o.suicide_allow;
        last = -1;
    }

    // Group scan -> packed (nlibs, lib0, member_count). Members into sc.members if want.
    inline std::uint32_t scan(int idx, bool want) {
        const std::uint64_t gen = ++sc.gen;
        const std::uint8_t color = cells[idx];
        int* const stk = sc.stack;
        int sp = 0;
        stk[sp++] = idx;
        sc.stamp[idx] = gen;
        int mcount = 0;
        if (want) {
            sc.members[0] = idx;
            mcount = 1;
        }
        int nlibs = 0;
        int lib0 = -1;
        while (sp > 0) {
            const int cur = stk[--sp];
            const int d = deg[cur];
            const int* nb4 = nbr[cur];
            for (int k = 0; k < d; ++k) {
                const int nb = nb4[k];
                const std::uint8_t v = cells[nb];
                if (v == 0) {
                    if (sc.libstamp[nb] != gen) {
                        sc.libstamp[nb] = gen;
                        ++nlibs;
                        if (lib0 < 0) lib0 = nb;
                    }
                } else if (v == color && sc.stamp[nb] != gen) {
                    sc.stamp[nb] = gen;
                    stk[sp++] = nb;
                    if (want) sc.members[mcount++] = nb;
                }
            }
        }
        return sc_make3(nlibs, lib0, mcount);
    }

    // Early-stop liberty count (no member list) -> packed (nlibs, lib0).
    inline std::uint32_t scan_lib(int idx, int limit) {
        const std::uint64_t gen = ++sc.gen;
        const std::uint8_t color = cells[idx];
        int* const stk = sc.stack;
        int sp = 0;
        stk[sp++] = idx;
        sc.stamp[idx] = gen;
        int nlibs = 0;
        int lib0 = -1;
        while (sp > 0) {
            const int cur = stk[--sp];
            const int d = deg[cur];
            const int* nb4 = nbr[cur];
            for (int k = 0; k < d; ++k) {
                const int nb = nb4[k];
                const std::uint8_t v = cells[nb];
                if (v == 0) {
                    if (sc.libstamp[nb] != gen) {
                        sc.libstamp[nb] = gen;
                        ++nlibs;
                        if (lib0 < 0) lib0 = nb;
                        if (nlibs >= limit) return sl_make(nlibs, lib0);
                    }
                } else if (v == color && sc.stamp[nb] != gen) {
                    sc.stamp[nb] = gen;
                    stk[sp++] = nb;
                }
            }
        }
        return sl_make(nlibs, lib0);
    }

    // Early-stop liberty count + mark visited with sc.markstamp (mg).
    inline std::uint32_t scan_lib_marked(int idx, int limit, std::uint64_t mg) {
        const std::uint64_t gen = ++sc.gen;
        const std::uint8_t color = cells[idx];
        int* const stk = sc.stack;
        int sp = 0;
        stk[sp++] = idx;
        sc.stamp[idx] = gen;
        sc.markstamp[idx] = mg;
        int nlibs = 0;
        int lib0 = -1;
        while (sp > 0) {
            const int cur = stk[--sp];
            const int d = deg[cur];
            const int* nb4 = nbr[cur];
            for (int k = 0; k < d; ++k) {
                const int nb = nb4[k];
                const std::uint8_t v = cells[nb];
                if (v == 0) {
                    if (sc.libstamp[nb] != gen) {
                        sc.libstamp[nb] = gen;
                        ++nlibs;
                        if (lib0 < 0) lib0 = nb;
                        if (nlibs >= limit) return sl_make(nlibs, lib0);
                    }
                } else if (v == color && sc.stamp[nb] != gen) {
                    sc.stamp[nb] = gen;
                    sc.markstamp[nb] = mg;
                    stk[sp++] = nb;
                }
            }
        }
        return sl_make(nlibs, lib0);
    }

    // Core transition -> packed (ok, caps, olibs). mutate=false rolls back.
    inline std::uint32_t simulate(std::uint8_t color, int p, bool mutate) {
        if (p < 0 || p >= n2) return pk_make(false, 0, 0);
        if (cells[p] != 0 || p == ko) return pk_make(false, 0, 0);
        const std::uint8_t opp = static_cast<std::uint8_t>(3 - color);

        sc.saveIdx[0] = p;
        sc.saveOld[0] = 0;
        sc.nsave = 1;
        cells[p] = color;

        sc.ncap = 0;
        const std::uint64_t mg = ++sc.markgen;

        const int npdeg = deg[p];
        const int* npnb = nbr[p];
        for (int k = 0; k < npdeg; ++k) {
            const int nb = npnb[k];
            if (cells[nb] == opp && sc.markstamp[nb] != mg) {
                bool other_empty = false;
                bool same_opp = false;
                const int d2 = deg[nb];
                const int* nb4 = nbr[nb];
                for (int j = 0; j < d2; ++j) {
                    const std::uint8_t v = cells[nb4[j]];
                    if (v == 0) {
                        other_empty = true;
                        break;
                    } else if (v == opp) {
                        same_opp = true;
                    }
                }
                if (other_empty) {
                    sc.markstamp[nb] = mg;
                    continue;
                }
                if (!same_opp) {
                    sc.markstamp[nb] = mg;
                    sc.captured[sc.ncap++] = nb;
                    continue;
                }
                const int libs0 = sl_nlibs(scan_lib_marked(nb, 1, mg));
                if (libs0 == 0) {
                    const std::uint32_t g = scan(nb, true);
                    const int mc = sc_mcount(g);
                    for (int i = 0; i < mc; ++i) sc.markstamp[sc.members[i]] = mg;
                    for (int i = 0; i < mc; ++i) sc.captured[sc.ncap++] = sc.members[i];
                }
            }
        }
        for (int i = 0; i < sc.ncap; ++i) {
            const int m = sc.captured[i];
            sc.saveIdx[sc.nsave] = m;
            sc.saveOld[sc.nsave] = opp;
            ++sc.nsave;
            cells[m] = 0;
        }

        int empties = 0;
        bool same_color_nb = false;
        for (int k = 0; k < npdeg; ++k) {
            const std::uint8_t v = cells[npnb[k]];
            if (v == 0) {
                ++empties;
            } else if (v == color) {
                same_color_nb = true;
            }
        }

        int own_size;
        int nlibs;
        int ko_new = -1;
        if (empties >= 2) {
            own_size = 1;
            nlibs = empties;  // lower bound (true value is only larger)
        } else {
            own_size = same_color_nb ? 2 : 1;
            const int nl = same_color_nb ? sl_nlibs(scan_lib(p, 2)) : empties;
            nlibs = nl;
            if (nl == 0) {
                if (!suicide_allow) {
                    for (int i = sc.nsave - 1; i >= 0; --i) cells[sc.saveIdx[i]] = sc.saveOld[i];
                    return pk_make(false, 0, 0);
                }
                const std::uint32_t g = scan(p, true);
                const int mc = sc_mcount(g);
                for (int i = 0; i < mc; ++i) {
                    const int m = sc.members[i];
                    sc.saveIdx[sc.nsave] = m;
                    sc.saveOld[sc.nsave] = color;
                    ++sc.nsave;
                    cells[m] = 0;
                }
            } else if (sc.ncap == 1 && !same_color_nb && nl == 1) {
                ko_new = sc.captured[0];
            }
        }
        (void)own_size;

        if (!mutate) {
            for (int i = sc.nsave - 1; i >= 0; --i) cells[sc.saveIdx[i]] = sc.saveOld[i];
            return pk_make(true, sc.ncap, nlibs);
        }
        ko = ko_new;
        last = p;
        passes = 0;
        side = opp;
        return pk_make(true, sc.ncap, nlibs);
    }

    inline std::uint32_t probe(std::uint8_t color, int p) { return simulate(color, p, false); }
    inline void apply(std::uint8_t color, int p) { simulate(color, p, true); }

    inline void play_pass(std::uint8_t color) {
        ko = -1;
        ++passes;
        side = static_cast<std::uint8_t>(3 - color);
        last = -1;
    }

    // Simple eye: all orthogonal neighbours are own stones (off-board ignored).
    inline bool is_eye(int p, std::uint8_t color) const {
        const int d = deg[p];
        const int* nb4 = nbr[p];
        for (int k = 0; k < d; ++k) {
            if (cells[nb4[k]] != color) return false;
        }
        return true;
    }

    // Any adjacent `color` group with exactly 1 liberty?
    bool adjacent_atari(int p, std::uint8_t color) {
        const std::uint64_t mg = ++sc.markgen;
        const int d = deg[p];
        const int* nb4 = nbr[p];
        for (int k = 0; k < d; ++k) {
            const int nb = nb4[k];
            if (cells[nb] == color && sc.markstamp[nb] != mg) {
                int empties = 0;
                const int d2 = deg[nb];
                const int* nb4b = nbr[nb];
                for (int j = 0; j < d2; ++j) {
                    if (cells[nb4b[j]] == 0) {
                        ++empties;
                        if (empties >= 2) break;
                    }
                }
                if (empties >= 2) continue;
                if (sl_nlibs(scan_lib_marked(nb, 2, mg)) == 1) return true;
            }
        }
        return false;
    }

    // Rescue moves: the single liberty of adjacent `color` groups in atari.
    void rescue_moves(std::uint8_t color) {
        sc.nrescue = 0;
        const int l = last;
        if (l < 0) return;
        const std::uint64_t mg = ++sc.markgen;
        sc.pts[0] = l;
        int npts = 1;
        const int dl = deg[l];
        const int* l4 = nbr[l];
        for (int k = 0; k < dl; ++k) sc.pts[npts++] = l4[k];
        for (int i = 0; i < npts; ++i) {
            const int nb = sc.pts[i];
            if (cells[nb] == color && sc.markstamp[nb] != mg) {
                int empties = 0;
                const int d2 = deg[nb];
                const int* nb4 = nbr[nb];
                for (int j = 0; j < d2; ++j) {
                    if (cells[nb4[j]] == 0) {
                        ++empties;
                        if (empties >= 2) break;
                    }
                }
                if (empties >= 2) continue;
                const std::uint32_t r = scan_lib_marked(nb, 2, mg);
                if (sl_nlibs(r) == 1 && sl_lib0(r) >= 0) {
                    if (sc.nrescue < 8) sc.rescue[sc.nrescue++] = sl_lib0(r);
                }
            }
        }
    }

    // Area score (all stones alive) -> (black_area, white_area).
    std::pair<int, int> area() {
        std::uint8_t* const seen = sc.seen;
        for (int i = 0; i < n2; ++i) seen[i] = 0;
        int bt = 0;
        int wt = 0;
        int* const stk = sc.stack;
        for (int start = 0; start < n2; ++start) {
            if (cells[start] != 0 || seen[start]) continue;
            int sp = 0;
            stk[sp++] = start;
            seen[start] = 1;
            int region = 1;
            std::uint8_t borders = 0;
            while (sp > 0) {
                const int cur = stk[--sp];
                const int d = deg[cur];
                const int* nb4 = nbr[cur];
                for (int k = 0; k < d; ++k) {
                    const int nb = nb4[k];
                    const std::uint8_t v = cells[nb];
                    if (v == 0) {
                        if (!seen[nb]) {
                            seen[nb] = 1;
                            stk[sp++] = nb;
                            ++region;
                        }
                    } else {
                        borders |= static_cast<std::uint8_t>(1u << v);
                    }
                }
            }
            if (borders == 0b10) {
                bt += region;
            } else if (borders == 0b100) {
                wt += region;
            }
        }
        int bs = 0;
        int ws = 0;
        for (int i = 0; i < n2; ++i) {
            if (cells[i] == 1) ++bs;
            else if (cells[i] == 2) ++ws;
        }
        return {bs + bt, ws + wt};
    }

    // Mark stone neighbourhoods at Chebyshev radius -> sc.nearf; any stone?
    bool build_near(int radius) {
        std::uint8_t* const nearf = sc.nearf;
        for (int i = 0; i < n2; ++i) nearf[i] = 0;
        bool any_stone = false;
        for (int p = 0; p < n2; ++p) {
            if (cells[p] == 0) continue;
            any_stone = true;
            const int px = p % size;
            const int py = p / size;
            const int x0 = px - radius > 0 ? px - radius : 0;
            const int x1 = px + radius < size - 1 ? px + radius : size - 1;
            const int y0 = py - radius > 0 ? py - radius : 0;
            const int y1 = py + radius < size - 1 ? py + radius : size - 1;
            for (int y = y0; y <= y1; ++y) {
                const int base = y * size;
                for (int x = x0; x <= x1; ++x) nearf[base + x] = 1;
            }
        }
        return any_stone;
    }
};

// ---------------------------------------------------------------------------
// Geometry / candidates
// ---------------------------------------------------------------------------

inline int chebyshev(int a, int b, int size) {
    const int ax = a % size;
    const int ay = a / size;
    const int bx = b % size;
    const int by = b / size;
    const int dx = ax > bx ? ax - bx : bx - ax;
    const int dy = ay > by ? ay - by : by - ay;
    return dx > dy ? dx : dy;
}

void center_zone(int size, std::vector<int>& out) {
    out.clear();
    const int lo = size / 3;
    const int hi = size - 1 - size / 3;
    for (int y = lo; y <= hi; ++y) {
        for (int x = lo; x <= hi; ++x) out.push_back(y * size + x);
    }
}

void consider(PBoard& pb, std::uint8_t color, int p, std::vector<std::tuple<int, int, int>>& out) {
    if (pb.cells[p] != 0) return;
    if (pb.is_eye(p, color) && !pb.adjacent_atari(p, static_cast<std::uint8_t>(3 - color))) return;
    const std::uint32_t r = pb.probe(color, p);
    if (pk_ok(r)) out.emplace_back(p, pk_caps(r), pk_olibs(r));
}

void candidates(PBoard& pb, std::uint8_t color, int radius,
                std::vector<std::tuple<int, int, int>>& out) {
    out.clear();
    const int n2 = pb.n2;
    if (radius <= 0) {
        for (int p = 0; p < n2; ++p) consider(pb, color, p, out);
        return;
    }
    const bool any_stone = pb.build_near(radius);
    if (!any_stone) {
        std::vector<int> zone;
        center_zone(pb.size, zone);
        for (int p : zone) consider(pb, color, p, out);
    } else {
        for (int p = 0; p < n2; ++p) {
            if (pb.sc.nearf[p]) consider(pb, color, p, out);
        }
    }
}

// ---------------------------------------------------------------------------
// Playout (hot path: zero allocation)
// ---------------------------------------------------------------------------

int playout(PBoard& pb, Rng& rng, const Profile& pr, int max_moves) {
    const double cap_bias = pr.capture_bias;
    const double pat_bias = pr.pattern_bias;
    const double large_margin = pr.mercy * pb.n2;
    int moves = 0;
    while (pb.passes < 2 && moves < max_moves) {
        const std::uint8_t color = pb.side;
        const int last = pb.last;
        pb.sc.ncand = 0;
        pb.sc.nurg = 0;

        // Local candidates: last move + its 1-neighbourhood.
        pb.sc.npts = 0;
        if (last >= 0) {
            pb.sc.pts[pb.sc.npts++] = last;
            const int dl = pb.deg[last];
            const int* l4 = pb.nbr[last];
            for (int k = 0; k < dl; ++k) pb.sc.pts[pb.sc.npts++] = l4[k];
        }
        const int npts = pb.sc.npts;
        for (int i = 0; i < npts; ++i) {
            const int p = pb.sc.pts[i];
            if (pb.cells[p] != 0 || p == pb.ko) continue;
            if (pb.is_eye(p, color) &&
                !pb.adjacent_atari(p, static_cast<std::uint8_t>(3 - color))) {
                continue;
            }
            const std::uint32_t r = pb.probe(color, p);
            if (!pk_ok(r)) continue;
            if (pk_caps(r) == 0) {
                if (pk_olibs(r) == 1) continue;
                if (pb.is_eye(p, color) &&
                    !pb.adjacent_atari(p, static_cast<std::uint8_t>(3 - color))) {
                    continue;
                }
            }
            pb.sc.cands[pb.sc.ncand++] = p;
            if (pk_caps(r) > 0) pb.sc.urgent[pb.sc.nurg++] = p;
        }

        if (pb.sc.ncand == 0) {
            for (int p = 0; p < pb.n2; ++p) {
                if (pb.cells[p] != 0 || p == pb.ko) continue;
                if (pb.is_eye(p, color) &&
                    !pb.adjacent_atari(p, static_cast<std::uint8_t>(3 - color))) {
                    continue;
                }
                const std::uint32_t r = pb.probe(color, p);
                if (!pk_ok(r)) continue;
                if (pk_caps(r) == 0) {
                    if (pk_olibs(r) == 1) continue;
                    if (pb.is_eye(p, color) &&
                        !pb.adjacent_atari(p, static_cast<std::uint8_t>(3 - color))) {
                        continue;
                    }
                }
                pb.sc.cands[pb.sc.ncand++] = p;
                if (pk_caps(r) > 0) pb.sc.urgent[pb.sc.nurg++] = p;
            }
        }

        pb.rescue_moves(color);
        for (int i = 0; i < pb.sc.nrescue; ++i) {
            const int m = pb.sc.rescue[i];
            bool in_urgent = false;
            for (int u = 0; u < pb.sc.nurg; ++u) {
                if (pb.sc.urgent[u] == m) {
                    in_urgent = true;
                    break;
                }
            }
            if (pb.cells[m] == 0 && !in_urgent) pb.sc.urgent[pb.sc.nurg++] = m;
        }

        if (pb.sc.ncand == 0) {
            pb.play_pass(color);
            ++moves;
            continue;
        }

        const double r = rng.random();
        int m;
        if (pb.sc.nurg > 0 && r < cap_bias) {
            m = pb.sc.urgent[rng.randint(pb.sc.nurg)];
        } else if (last >= 0 && rng.random() < pat_bias) {
            pb.sc.nlocal = 0;
            for (int i = 0; i < pb.sc.ncand; ++i) {
                const int p = pb.sc.cands[i];
                if (chebyshev(p, last, pb.size) <= 1) pb.sc.local_[pb.sc.nlocal++] = p;
            }
            if (pb.sc.nlocal > 0) {
                m = pb.sc.local_[rng.randint(pb.sc.nlocal)];
            } else {
                m = pb.sc.cands[rng.randint(pb.sc.ncand)];
            }
        } else {
            m = pb.sc.cands[rng.randint(pb.sc.ncand)];
        }
        pb.apply(color, m);
        ++moves;
        if (large_margin > 0.0) {
            const std::pair<int, int> ar = pb.area();
            if (static_cast<double>(ar.first - ar.second) > large_margin ||
                static_cast<double>(ar.second - ar.first) > large_margin) {
                break;
            }
        }
    }
    return moves;
}

// ---------------------------------------------------------------------------
// MCTS tree (arena)
// ---------------------------------------------------------------------------

struct Node {
    std::uint8_t to_move;
    std::vector<int> children;
    int mv;
    std::uint32_t n;
    double w;
    std::uint32_t amaf_n;
    double amaf_w;
    bool expanded;
    double prior;
};

int select(const std::vector<Node>& arena, int node, double c, double rave_k, bool rave) {
    const double logn = std::log(static_cast<double>(arena[node].n) + 1.0);
    int best = -1;
    double bestv = -1e18;
    for (int ch : arena[node].children) {
        const std::uint32_t n = arena[ch].n;
        double q = n > 0 ? arena[ch].w / static_cast<double>(n) : arena[ch].prior;
        if (rave && arena[ch].amaf_n > 0) {
            const double qa = arena[ch].amaf_w / static_cast<double>(arena[ch].amaf_n);
            const double beta =
                n > 0 ? std::sqrt(rave_k / (rave_k + 3.0 * static_cast<double>(n))) : 1.0;
            q = (1.0 - beta) * q + beta * qa;
        }
        const double val = q + c * std::sqrt(logn / (static_cast<double>(n) + 1.0));
        if (val > bestv) {
            bestv = val;
            best = ch;
        }
    }
    return best;
}

template <typename T>
void rng_shuffle(std::vector<T>& v, Rng& rng) {
    if (v.size() < 2) return;
    for (std::size_t i = v.size() - 1; i > 0; --i) {
        const int j = rng.randint(static_cast<int>(i + 1));
        std::swap(v[i], v[static_cast<std::size_t>(j)]);
    }
}

}  // namespace

GenResult genmove(const Board& board, int playouts, long long seed, const Profile& profile) {
    const Profile pr = profile;
    Rng rng(seed);
    const int size = board.size;
    const int n2 = board.n2;
    const bool suicide_allow = board.rules.suicide == Suicide::Allow;
    std::vector<int> full_legal = board.legal_moves();
    std::vector<char> legal_mask(n2, 0);
    for (int p : full_legal) legal_mask[p] = 1;

    PBoard pb0(size, *board.neigh, board.cells.data(), board.side, board.ko_point, board.passes,
               suicide_allow);
    const int radius = pr.prune_radius;

    std::vector<Node> arena;
    arena.reserve(4096);
    {
        Node root;
        root.to_move = board.side;
        root.mv = PASS_MOVE;
        root.n = 0;
        root.w = 0.0;
        root.amaf_n = 0;
        root.amaf_w = 0.0;
        root.expanded = true;
        root.prior = 0.5;
        arena.push_back(std::move(root));
    }

    std::vector<std::tuple<int, int, int>> moves;
    candidates(pb0, board.side, radius, moves);
    {
        std::vector<std::tuple<int, int, int>> keep;
        keep.reserve(moves.size());
        for (auto& mv : moves) {
            if (legal_mask[std::get<0>(mv)]) keep.push_back(mv);
        }
        moves.swap(keep);
    }
    rng_shuffle(moves, rng);
    for (auto& mv : moves) {
        Node nd;
        nd.to_move = static_cast<std::uint8_t>(3 - board.side);
        nd.mv = std::get<0>(mv);
        nd.n = 0;
        nd.w = 0.0;
        nd.amaf_n = 0;
        nd.amaf_w = 0.0;
        nd.expanded = false;
        nd.prior = move_prior(std::get<1>(mv), static_cast<std::size_t>(std::get<2>(mv)));
        arena.push_back(std::move(nd));
    }
    for (std::size_t i = 1; i < arena.size(); ++i) arena[0].children.push_back(static_cast<int>(i));
    if (arena[0].children.empty()) {
        GenResult g;
        g.kind = MoveKind::Pass;
        g.point = -1;
        g.visits = 0;
        g.winrate = 0.0;
        return g;
    }

    const int max_moves = 3 * n2;
    const double scale = pr.score_scale > 0.0 ? pr.score_scale : static_cast<double>(n2) / 2.0;
    const int sims = playouts > 1 ? playouts : 1;

    PBoard pb = pb0;

    std::vector<int> chain;
    chain.reserve(256);
    std::vector<int> kids_buf;
    kids_buf.reserve(64);
    std::vector<std::uint64_t> mv1(n2, 0);
    std::vector<std::uint64_t> mv2(n2, 0);
    std::uint64_t simgen = 0;

    for (int s = 0; s < sims; ++s) {
        ++simgen;
        pb.reset_from(pb0);
        int node = 0;
        chain.clear();
        chain.push_back(0);

        while (arena[node].expanded && !arena[node].children.empty()) {
            const int ci = select(arena, node, pr.c, pr.rave_k, pr.rave);
            const int m = arena[ci].mv;
            const std::uint8_t color = arena[node].to_move;
            if (m == PASS_MOVE) {
                pb.play_pass(color);
            } else {
                pb.apply(color, m);
                if (color == 1) {
                    mv1[static_cast<std::size_t>(m)] = simgen;
                } else {
                    mv2[static_cast<std::size_t>(m)] = simgen;
                }
            }
            node = ci;
            chain.push_back(node);
        }

        if (!arena[node].expanded) {
            const std::uint8_t tmove = arena[node].to_move;
            std::vector<std::tuple<int, int, int>> cl;
            candidates(pb, tmove, radius, cl);
            rng_shuffle(cl, rng);
            std::vector<int> idxs;
            idxs.reserve(cl.size());
            for (auto& mv : cl) {
                Node nd;
                nd.to_move = static_cast<std::uint8_t>(3 - tmove);
                nd.mv = std::get<0>(mv);
                nd.n = 0;
                nd.w = 0.0;
                nd.amaf_n = 0;
                nd.amaf_w = 0.0;
                nd.expanded = false;
                nd.prior = move_prior(std::get<1>(mv), static_cast<std::size_t>(std::get<2>(mv)));
                const int idx = static_cast<int>(arena.size());
                arena.push_back(std::move(nd));
                idxs.push_back(idx);
            }
            arena[node].children = std::move(idxs);
            arena[node].expanded = true;
        }

        const std::uint8_t leaf_to_move = arena[node].to_move;
        playout(pb, rng, pr, max_moves);
        const std::pair<int, int> ar = pb.area();
        const double diff_black = static_cast<double>(ar.first - ar.second) - board.komi;
        double sv = 0.5 + 0.5 * (diff_black / scale);
        if (sv < 0.0) {
            sv = 0.0;
        } else if (sv > 1.0) {
            sv = 1.0;
        }
        const double res_leaf = leaf_to_move == 1 ? sv : 1.0 - sv;

        for (int nd : chain) {
            const double v = arena[nd].to_move == leaf_to_move ? res_leaf : 1.0 - res_leaf;
            ++arena[nd].n;
            arena[nd].w += v;
            const std::uint8_t tmf = arena[nd].to_move;
            if (!arena[nd].children.empty()) {
                const double cv = 1.0 - v;
                const std::vector<std::uint64_t>& stamps = tmf == 1 ? mv1 : mv2;
                kids_buf.clear();
                kids_buf.insert(kids_buf.end(), arena[nd].children.begin(),
                                arena[nd].children.end());
                for (int ch : kids_buf) {
                    const int cm = arena[ch].mv;
                    if (cm != PASS_MOVE && stamps[static_cast<std::size_t>(cm)] == simgen) {
                        ++arena[ch].amaf_n;
                        arena[ch].amaf_w += cv;
                    }
                }
            }
        }
    }

    // Final selection: key = (-N, -winrate, move)
    bool have_best = false;
    int best_ch = -1;
    std::uint32_t best_n = 0;
    double best_wr = 0.0;
    int best_m = n2;
    std::uint32_t total_visits = 0;
    for (int ch : arena[0].children) {
        const std::uint32_t n = arena[ch].n;
        total_visits += n;
        const double wr = n > 0 ? arena[ch].w / static_cast<double>(n) : 0.0;
        const int m = arena[ch].mv == PASS_MOVE ? n2 : arena[ch].mv;
        bool better;
        if (!have_best) {
            better = true;
        } else if (n != best_n) {
            better = n > best_n;
        } else if (wr != best_wr) {
            better = wr > best_wr;
        } else {
            better = m < best_m;
        }
        if (better) {
            have_best = true;
            best_ch = ch;
            best_n = n;
            best_wr = wr;
            best_m = m;
        }
    }

    int best_mv = have_best ? arena[best_ch].mv : PASS_MOVE;

    // Fallback: the chosen point must be inside the full legal set.
    if (best_mv != PASS_MOVE && !legal_mask[static_cast<std::size_t>(best_mv)]) {
        bool have_alt = false;
        int alt_ch = -1;
        std::uint32_t alt_n = 0;
        double alt_wr = 0.0;
        int alt_m = n2;
        for (int ch : arena[0].children) {
            const int m = arena[ch].mv;
            if (m == PASS_MOVE || !legal_mask[static_cast<std::size_t>(m)]) continue;
            const std::uint32_t n = arena[ch].n;
            const double wr = n > 0 ? arena[ch].w / static_cast<double>(n) : 0.0;
            bool better;
            if (!have_alt) {
                better = true;
            } else if (n != alt_n) {
                better = n > alt_n;
            } else if (wr != alt_wr) {
                better = wr > alt_wr;
            } else {
                better = m < alt_m;
            }
            if (better) {
                have_alt = true;
                alt_ch = ch;
                alt_n = n;
                alt_wr = wr;
                alt_m = m;
            }
        }
        if (have_alt) {
            best_mv = arena[alt_ch].mv;
            best_n = alt_n;
            best_wr = alt_wr;
        } else {
            best_mv = PASS_MOVE;
        }
    }

    // Explicit pass rule: opponent already passed and our winrate is enough.
    if (board.passes >= 1 && best_mv != PASS_MOVE && best_wr >= pr.pass_threshold) {
        GenResult g;
        g.kind = MoveKind::Pass;
        g.point = -1;
        g.visits = static_cast<int>(best_n);
        g.winrate = best_wr;
        return g;
    }
    if (pr.resign_threshold > 0.0 &&
        total_visits >= static_cast<std::uint32_t>(pr.resign_min_visits) &&
        best_wr < pr.resign_threshold) {
        GenResult g;
        g.kind = MoveKind::Resign;
        g.point = -1;
        g.visits = static_cast<int>(best_n);
        g.winrate = best_wr;
        return g;
    }

    GenResult g;
    if (best_mv == PASS_MOVE) {
        g.kind = MoveKind::Pass;
        g.point = -1;
    } else {
        g.kind = MoveKind::Point;
        g.point = best_mv;
    }
    g.visits = static_cast<int>(best_n);
    g.winrate = best_wr;
    return g;
}

std::pair<unsigned long long, double> bench_playouts(const Board& board, int iters, long long seed) {
    const Profile pr;
    const bool suicide_allow = board.rules.suicide == Suicide::Allow;
    const int max_moves = 3 * board.n2;
    Rng rng(seed);
    unsigned long long total = 0;
    auto t0 = std::chrono::steady_clock::now();
    for (int i = 0; i < iters; ++i) {
        PBoard pb(board.size, *board.neigh, board.cells.data(), board.side, board.ko_point,
                  board.passes, suicide_allow);
        total += static_cast<unsigned long long>(playout(pb, rng, pr, max_moves));
    }
    const double secs =
        std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
    return {total, secs};
}

std::pair<unsigned long long, double> bench_probe(const Board& board, int iters) {
    const bool suicide_allow = board.rules.suicide == Suicide::Allow;
    PBoard pb(board.size, *board.neigh, board.cells.data(), board.side, board.ko_point, board.passes,
              suicide_allow);
    std::vector<int> pts;
    for (int i = 0; i < pb.n2; ++i) {
        if (pb.cells[i] == 0) pts.push_back(i);
    }
    const int np = static_cast<int>(pts.size());
    unsigned long long acc = 0;
    auto t0 = std::chrono::steady_clock::now();
    for (int it = 0; it < iters; ++it) {
        const int p = pts[static_cast<std::size_t>(it) % static_cast<std::size_t>(np)];
        const std::uint32_t r = pb.probe(board.side, p);
        acc += (pk_ok(r) ? 1ULL : 0ULL) + static_cast<unsigned long long>(pk_caps(r));
    }
    const double secs =
        std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
    return {acc, secs};
}

}  // namespace weiqi
