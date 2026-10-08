// weiqi_rules.hpp -- Go rules core (C++17 port of PyWeiqi/weiqi_rules.py)
//
// Spec source: docs/RULES_SPEC.md (spec-v1). Reference impl: PyWeiqi/.
// Rule operations must be bit-for-bit identical to the Python reference:
// coordinates, play/capture/suicide, three ko variants, Zobrist keys,
// both scoring variants, result-string formatting.
//
// Zero third-party dependencies. All 64-bit arithmetic is unsigned (mod 2^64).

#pragma once

#include <cstdint>
#include <optional>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

namespace weiqi {

// ---------------------------------------------------------------------------
// Constants / Zobrist (RULES_SPEC section 6)
// ---------------------------------------------------------------------------

constexpr std::uint64_t MASK64 = ~static_cast<std::uint64_t>(0);
constexpr int MAX_POINTS = 361;

// Column letters: skip 'I' (19 letters). x maps to the x-th character.
extern const char* const COLS;  // "ABCDEFGHJKLMNOPQRST"

// splitmix64 -- strictly per RULES_SPEC section 6 (unsigned, wrapping).
constexpr std::uint64_t splitmix64(std::uint64_t x) {
    std::uint64_t z = x + 0x9E3779B97F4A7C15ULL;
    z = (z ^ (z >> 30)) * 0xBF58476D1CE4E5B9ULL;
    z = (z ^ (z >> 27)) * 0x94D049BB133111EBULL;
    return z ^ (z >> 31);
}

struct ZbTable {
    std::uint64_t v[3][MAX_POINTS];
};

constexpr ZbTable build_zb() {
    ZbTable t{};
    for (int c = 1; c <= 2; ++c) {
        for (int p = 0; p < MAX_POINTS; ++p) {
            t.v[c][p] = splitmix64(static_cast<std::uint64_t>((c - 1) * 1024 + p));
        }
    }
    return t;
}

inline constexpr ZbTable ZB_TABLE = build_zb();
inline constexpr std::uint64_t SIDEKEY_W = splitmix64(4096);

// ZB(c, p) = splitmix64((c-1)*1024 + p), c in {1,2}, p in [0,361)
inline std::uint64_t zb(std::uint8_t c, int p) { return ZB_TABLE.v[c][p]; }

// "0x" + 16 lowercase hex digits.
std::string fmt_key(std::uint64_t k);

// Integer without decimal point, else 0.25-grid (.25/.5/.75).
std::string fmt_num(double v);

// ---------------------------------------------------------------------------
// Rule configuration
// ---------------------------------------------------------------------------

enum class Ko { Simple, Positional, Situational };
enum class Suicide { Forbid, Allow };
enum class Scoring { Area, Territory };

const char* ko_str(Ko k);
const char* suicide_str(Suicide s);
const char* scoring_str(Scoring s);

struct Rules {
    Ko ko = Ko::Positional;
    Suicide suicide = Suicide::Forbid;
    Scoring scoring = Scoring::Area;
    double komi = 7.5;
};

// Profile name -> rules ("cn" default, "tt", "jp"). Unknown -> nullptr.
const Rules* profile(const char* name);

// Normalize optional parts (unspecified items default to profile "cn").
Rules rules_from_parts(const std::string* ko, const std::string* suicide,
                       const std::string* scoring, const double* komi);

// ---------------------------------------------------------------------------
// Coordinates
// ---------------------------------------------------------------------------

// Vertex string -> point index; "pass" -> -1; invalid -> throws reason "range".
int parse_vertex(const std::string& s, int size);

// Point index -> vertex string; negative -> "pass".
std::string format_vertex(int idx, int size);

// Color string -> 1/2; invalid -> throws "bad color: ...".
std::uint8_t parse_color(const std::string& s);

const char* color_name(std::uint8_t c);

// Cached 4-neighbour table (order: left, right, down, up -- as in Python).
const std::vector<std::vector<int>>& neighbors_of(int size);

// ---------------------------------------------------------------------------
// Board
// ---------------------------------------------------------------------------

struct PlayResult {
    bool ok = false;
    const char* reason = nullptr;  // stable machine-readable id
    int captures = 0;
    int self_captured = 0;
    std::uint64_t key = 0;
};

struct Score {
    int black = 0;
    int white = 0;
    double komi = 0.0;
    int dame = 0;
    std::string result;
    int black_territory = 0;
    int white_territory = 0;
    int black_stones = 0;
    int white_stones = 0;
    int prisoners_black = 0;
    int prisoners_white = 0;
};

// (posKey, side) situational key.
struct SitKey {
    std::uint64_t k = 0;
    std::uint8_t s = 0;
    bool operator==(const SitKey& o) const { return k == o.k && s == o.s; }
};

struct SitKeyHash {
    std::size_t operator()(const SitKey& x) const {
        std::uint64_t h = x.k ^ (static_cast<std::uint64_t>(x.s) * 0x9E3779B97F4A7C15ULL);
        h ^= h >> 33;
        h *= 0xFF51AFD7ED558CCDULL;
        h ^= h >> 33;
        return static_cast<std::size_t>(h);
    }
};

class Board {
public:
    // --- state (public for tests / driver, mirrors Python attributes) ---
    int size = 9;
    int n2 = 81;
    const std::vector<std::vector<int>>* neigh = nullptr;
    Rules rules;
    double komi = 7.5;
    std::vector<std::uint8_t> cells;
    std::uint8_t side = 1;
    int ko_point = -1;
    int passes = 0;
    std::uint64_t pos_key = 0;
    int captures[3] = {0, 0, 0};  // captures[c] = stones captured BY color c
    bool over = false;

    struct Rec {
        bool is_pass = false;
        std::uint8_t color = 0;
        std::vector<std::uint8_t> prev_cells;
        std::uint64_t prev_key = 0;
        std::uint8_t prev_side = 1;
        int prev_ko = -1;
        int prev_passes = 0;
        int prev_cap = 0;
        std::uint64_t pos_key = 0;
        SitKey sit_key;
        bool has_sit = false;
    };

    std::vector<Rec> stack;
    std::unordered_map<std::uint64_t, int> hist_pos;              // multiset posKey
    std::unordered_map<SitKey, int, SitKeyHash> hist_sit;         // multiset (posKey, side)

    Board() = default;
    Board(int size, std::optional<double> komi, Rules rules);

    void reset();
    Board clone() const;

    // Place stones directly, no legality check; history -> single record (section 11).
    void set_stones(const std::vector<std::pair<std::uint8_t, int>>& stones, std::uint8_t side);

    // -> (posKey, sitKey)
    std::pair<std::uint64_t, std::uint64_t> key() const;
    bool is_over() const { return over; }

    // -> (members, libs)
    std::pair<std::vector<int>, std::vector<int>> group(int idx) const;

    PlayResult play(std::uint8_t color, int vertex);
    bool undo();

    std::pair<bool, const char*> legal(std::uint8_t color, int vertex) const;
    std::vector<int> legal_moves() const;

    std::pair<int, int> prisoners() const;  // (black captured white, white captured black)

    Score score(const std::vector<std::pair<std::uint8_t, int>>* dead) const;

private:
    std::pair<std::vector<int>, std::vector<int>> group_in(int idx,
                                                           const std::vector<std::uint8_t>& c) const;
    PlayResult err(const char* reason) const;
};

// Helpers reused by driver / golden.
std::string trim_copy(const std::string& s);
std::string upper_ascii(const std::string& s);

}  // namespace weiqi
