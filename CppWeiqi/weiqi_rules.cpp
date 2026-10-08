// weiqi_rules.cpp -- Go rules core (C++17 port of PyWeiqi/weiqi_rules.py)

#include "weiqi_rules.hpp"

#include <cctype>
#include <cmath>
#include <cstdio>
#include <cstdlib>

namespace weiqi {

const char* const COLS = "ABCDEFGHJKLMNOPQRST";

namespace {

const Rules CN_RULES{Ko::Positional, Suicide::Forbid, Scoring::Area, 7.5};
const Rules TT_RULES{Ko::Positional, Suicide::Allow, Scoring::Area, 7.5};
const Rules JP_RULES{Ko::Simple, Suicide::Forbid, Scoring::Territory, 6.5};

std::string lower_ascii(std::string s) {
    for (char& c : s) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
    return s;
}

}  // namespace

std::string trim_copy(const std::string& s) {
    std::size_t a = 0;
    std::size_t b = s.size();
    while (a < b) {
        char c = s[a];
        if (c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\f' || c == '\v') {
            ++a;
        } else {
            break;
        }
    }
    while (b > a) {
        char c = s[b - 1];
        if (c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\f' || c == '\v') {
            --b;
        } else {
            break;
        }
    }
    return s.substr(a, b - a);
}

std::string upper_ascii(const std::string& s) {
    std::string r = s;
    for (char& c : r) c = static_cast<char>(std::toupper(static_cast<unsigned char>(c)));
    return r;
}

std::string fmt_key(std::uint64_t k) {
    char buf[32];
    std::snprintf(buf, sizeof(buf), "0x%016llx",
                  static_cast<unsigned long long>(k));
    return std::string(buf);
}

std::string fmt_num(double v) {
    long long q = std::llround(v * 4.0);
    long long a = q < 0 ? -q : q;
    long long whole = a / 4;
    int rem = static_cast<int>(a % 4);
    const char* suf = rem == 0 ? "" : (rem == 1 ? ".25" : (rem == 2 ? ".5" : ".75"));
    char numbuf[32];
    std::snprintf(numbuf, sizeof(numbuf), "%lld", whole);
    std::string s = std::string(numbuf) + suf;
    if (q < 0) s = "-" + s;
    return s;
}

const char* ko_str(Ko k) {
    switch (k) {
        case Ko::Simple: return "simple";
        case Ko::Positional: return "positional";
        default: return "situational";
    }
}

const char* suicide_str(Suicide s) {
    return s == Suicide::Forbid ? "forbid" : "allow";
}

const char* scoring_str(Scoring s) {
    return s == Scoring::Area ? "area" : "territory";
}

const Rules* profile(const char* name) {
    if (name == nullptr) return nullptr;
    std::string n = lower_ascii(trim_copy(name));
    if (n == "cn") return &CN_RULES;
    if (n == "tt") return &TT_RULES;
    if (n == "jp") return &JP_RULES;
    return nullptr;
}

namespace {

Ko parse_ko(const std::string& v) {
    std::string t = lower_ascii(trim_copy(v));
    if (t == "simple") return Ko::Simple;
    if (t == "positional") return Ko::Positional;
    if (t == "situational") return Ko::Situational;
    throw std::runtime_error("bad ko: " + v);
}

Suicide parse_suicide(const std::string& v) {
    std::string t = lower_ascii(trim_copy(v));
    if (t == "forbid") return Suicide::Forbid;
    if (t == "allow") return Suicide::Allow;
    throw std::runtime_error("bad suicide: " + v);
}

Scoring parse_scoring(const std::string& v) {
    std::string t = lower_ascii(trim_copy(v));
    if (t == "area") return Scoring::Area;
    if (t == "territory") return Scoring::Territory;
    throw std::runtime_error("bad scoring: " + v);
}

}  // namespace

Rules rules_from_parts(const std::string* ko, const std::string* suicide,
                       const std::string* scoring, const double* komi) {
    Rules out = CN_RULES;
    if (ko) out.ko = parse_ko(*ko);
    if (suicide) out.suicide = parse_suicide(*suicide);
    if (scoring) out.scoring = parse_scoring(*scoring);
    if (komi) out.komi = *komi;
    return out;
}

int parse_vertex(const std::string& s, int size) {
    std::string t = upper_ascii(trim_copy(s));
    if (t == "PASS") return -1;
    if (t.size() < 2) throw std::runtime_error("range");
    char first = t[0];
    int col = -1;
    for (int i = 0; i < 19; ++i) {
        if (COLS[i] == first) {
            col = i;
            break;
        }
    }
    if (col < 0 || col >= size) throw std::runtime_error("range");
    // row = int(t[1:]) : optional sign then digits, non-empty.
    std::size_t i = 1;
    bool neg = false;
    if (i < t.size() && (t[i] == '+' || t[i] == '-')) {
        neg = (t[i] == '-');
        ++i;
    }
    if (i >= t.size()) throw std::runtime_error("range");
    long long row = 0;
    for (; i < t.size(); ++i) {
        char c = t[i];
        if (c < '0' || c > '9') throw std::runtime_error("range");
        row = row * 10 + (c - '0');
        if (row > 1000000000LL) throw std::runtime_error("range");
    }
    if (neg) row = -row;
    if (row < 1 || row > size) throw std::runtime_error("range");
    return static_cast<int>(row - 1) * size + col;
}

std::string format_vertex(int idx, int size) {
    if (idx < 0) return "pass";
    std::string out;
    out.push_back(COLS[idx % size]);
    out += std::to_string(idx / size + 1);
    return out;
}

std::uint8_t parse_color(const std::string& s) {
    std::string t = upper_ascii(trim_copy(s));
    if (t == "B" || t == "BLACK" || t == "1") return 1;
    if (t == "W" || t == "WHITE" || t == "2") return 2;
    throw std::runtime_error("bad color: " + s);
}

const char* color_name(std::uint8_t c) { return c == 1 ? "B" : "W"; }

const std::vector<std::vector<int>>& neighbors_of(int size) {
    static std::vector<std::vector<std::vector<int>>> cache(20);
    static std::vector<char> built(20, 0);
    if (size >= 2 && size <= 19 && !built[size]) {
        std::vector<std::vector<int>> n;
        n.reserve(static_cast<std::size_t>(size) * size);
        for (int y = 0; y < size; ++y) {
            for (int x = 0; x < size; ++x) {
                std::vector<int> lst;
                if (x > 0) lst.push_back(y * size + x - 1);
                if (x < size - 1) lst.push_back(y * size + x + 1);
                if (y > 0) lst.push_back((y - 1) * size + x);
                if (y < size - 1) lst.push_back((y + 1) * size + x);
                n.push_back(std::move(lst));
            }
        }
        cache[size] = std::move(n);
        built[size] = 1;
    }
    return cache[size];
}

// ---------------------------------------------------------------------------
// Board
// ---------------------------------------------------------------------------

Board::Board(int size_, std::optional<double> komi_, Rules rules_) {
    size = size_;
    if (size < 2 || size > 19) throw std::runtime_error("bad size");
    n2 = size * size;
    neigh = &neighbors_of(size);
    rules = rules_;
    komi = komi_.has_value() ? *komi_ : rules_.komi;
    reset();
}

void Board::reset() {
    cells.assign(n2, 0);
    side = 1;
    ko_point = -1;
    passes = 0;
    pos_key = 0;
    captures[0] = captures[1] = captures[2] = 0;
    over = false;
    stack.clear();
    hist_pos.clear();
    hist_sit.clear();
    hist_pos[0] = 1;
    hist_sit[SitKey{0, 1}] = 1;
}

Board Board::clone() const {
    Board b;
    b.size = size;
    b.n2 = n2;
    b.neigh = neigh;
    b.rules = rules;
    b.komi = komi;
    b.cells = cells;
    b.side = side;
    b.ko_point = ko_point;
    b.passes = passes;
    b.pos_key = pos_key;
    b.captures[0] = captures[0];
    b.captures[1] = captures[1];
    b.captures[2] = captures[2];
    b.over = over;
    b.stack = stack;
    b.hist_pos = hist_pos;
    b.hist_sit = hist_sit;
    return b;
}

void Board::set_stones(const std::vector<std::pair<std::uint8_t, int>>& stones,
                       std::uint8_t side_) {
    reset();
    for (const auto& pr : stones) {
        std::uint8_t color = pr.first;
        int vertex = pr.second;
        if (vertex >= 0 && vertex < n2) {
            cells[vertex] = color;
            pos_key ^= zb(color, vertex);
        }
    }
    side = side_;
    hist_pos.clear();
    hist_pos[pos_key] = 1;
    hist_sit.clear();
    hist_sit[SitKey{pos_key, side}] = 1;
}

std::pair<std::uint64_t, std::uint64_t> Board::key() const {
    std::uint64_t sit = pos_key ^ (side == 2 ? SIDEKEY_W : 0);
    return {pos_key, sit};
}

std::pair<std::vector<int>, std::vector<int>> Board::group(int idx) const {
    return group_in(idx, cells);
}

std::pair<std::vector<int>, std::vector<int>> Board::group_in(
    int idx, const std::vector<std::uint8_t>& c) const {
    std::uint8_t color = c[idx];
    const auto& nb = *neigh;
    std::vector<char> seen(n2, 0);
    std::vector<char> libseen(n2, 0);
    std::vector<int> st;
    st.push_back(idx);
    seen[idx] = 1;
    std::vector<int> members;
    members.push_back(idx);
    std::vector<int> libs;
    while (!st.empty()) {
        int cur = st.back();
        st.pop_back();
        for (int n : nb[cur]) {
            std::uint8_t v = c[n];
            if (v == 0) {
                if (!libseen[n]) {
                    libseen[n] = 1;
                    libs.push_back(n);
                }
            } else if (v == color && !seen[n]) {
                seen[n] = 1;
                st.push_back(n);
                members.push_back(n);
            }
        }
    }
    return {std::move(members), std::move(libs)};
}

PlayResult Board::err(const char* reason) const {
    PlayResult r;
    r.ok = false;
    r.reason = reason;
    r.captures = 0;
    r.self_captured = 0;
    r.key = pos_key;
    return r;
}

PlayResult Board::play(std::uint8_t color, int vertex) {
    if (over) return err("over");
    if (color != side) return err("turn");

    if (vertex == -1) {
        Rec rec;
        rec.is_pass = true;
        rec.prev_key = pos_key;
        rec.prev_side = side;
        rec.prev_ko = ko_point;
        rec.prev_passes = passes;
        side = static_cast<std::uint8_t>(3 - color);
        SitKey sk{pos_key, side};
        hist_sit[sk] += 1;
        rec.sit_key = sk;
        rec.has_sit = true;
        ko_point = -1;
        passes += 1;
        stack.push_back(std::move(rec));
        if (passes >= 2) over = true;
        PlayResult r;
        r.ok = true;
        r.reason = nullptr;
        r.captures = 0;
        r.self_captured = 0;
        r.key = pos_key;
        return r;
    }

    if (vertex < 0 || vertex >= n2) return err("range");
    if (vertex == ko_point) return err("ko");
    if (cells[vertex] != 0) return err("occupied");

    std::uint8_t opp = static_cast<std::uint8_t>(3 - color);
    const auto& nb = *neigh;
    std::vector<std::uint8_t> prev_cells = cells;
    std::uint64_t prev_key = pos_key;
    std::uint8_t prev_side = side;
    int prev_ko = ko_point;
    int prev_passes = passes;
    int prev_cap = captures[color];

    // 5) place stone
    cells[vertex] = color;
    pos_key ^= zb(color, vertex);

    // 6) capture opponent dead groups
    std::vector<int> captured;
    std::vector<char> seen_cap(n2, 0);
    for (int n : nb[vertex]) {
        if (cells[n] == opp && !seen_cap[n]) {
            auto g = group(n);
            if (g.second.empty()) {
                for (int m : g.first) seen_cap[m] = 1;
                captured.insert(captured.end(), g.first.begin(), g.first.end());
            }
        }
    }
    for (int m : captured) {
        cells[m] = 0;
        pos_key ^= zb(opp, m);
    }

    // 7) suicide (captures resolve self-atari first)
    std::vector<int> self_captured;
    if (captured.empty()) {
        auto g = group(vertex);
        if (g.second.empty()) {
            if (rules.suicide == Suicide::Forbid) {
                cells = prev_cells;
                pos_key = prev_key;
                return err("suicide");
            }
            self_captured = g.first;
            for (int m : self_captured) {
                cells[m] = 0;
                pos_key ^= zb(color, m);
            }
        }
    }

    // 8) superko (evaluated on the new position)
    std::uint64_t new_key = pos_key;
    std::uint8_t new_side = static_cast<std::uint8_t>(3 - color);
    if (rules.ko == Ko::Positional && hist_pos.count(new_key)) {
        cells = prev_cells;
        pos_key = prev_key;
        return err("superko");
    }
    if (rules.ko == Ko::Situational && hist_sit.count(SitKey{new_key, new_side})) {
        cells = prev_cells;
        pos_key = prev_key;
        return err("superko");
    }

    // 9) commit
    int ko_new = -1;
    if (captured.size() == 1) {
        auto g = group(vertex);
        if (g.first.size() == 1 && g.second.size() == 1) ko_new = captured[0];
    }
    Rec rec;
    rec.is_pass = false;
    rec.color = color;
    rec.prev_cells = std::move(prev_cells);
    rec.prev_key = prev_key;
    rec.prev_side = prev_side;
    rec.prev_ko = prev_ko;
    rec.prev_passes = prev_passes;
    rec.prev_cap = prev_cap;
    rec.pos_key = new_key;
    rec.sit_key = SitKey{new_key, new_side};
    rec.has_sit = true;

    ko_point = ko_new;
    captures[color] += static_cast<int>(captured.size());
    side = new_side;
    passes = 0;
    hist_pos[new_key] += 1;
    hist_sit[SitKey{new_key, new_side}] += 1;
    stack.push_back(std::move(rec));

    PlayResult r;
    r.ok = true;
    r.reason = nullptr;
    r.captures = static_cast<int>(captured.size());
    r.self_captured = static_cast<int>(self_captured.size());
    r.key = new_key;
    return r;
}

bool Board::undo() {
    if (stack.empty()) return false;
    Rec rec = std::move(stack.back());
    stack.pop_back();
    if (rec.is_pass) {
        if (rec.has_sit) {
            auto it = hist_sit.find(rec.sit_key);
            if (it != hist_sit.end()) {
                if (--(it->second) <= 0) hist_sit.erase(it);
            }
        }
        pos_key = rec.prev_key;
        side = rec.prev_side;
        ko_point = rec.prev_ko;
        passes = rec.prev_passes;
    } else {
        auto ip = hist_pos.find(rec.pos_key);
        if (ip != hist_pos.end()) {
            if (--(ip->second) <= 0) hist_pos.erase(ip);
        }
        auto is = hist_sit.find(rec.sit_key);
        if (is != hist_sit.end()) {
            if (--(is->second) <= 0) hist_sit.erase(is);
        }
        cells = std::move(rec.prev_cells);
        pos_key = rec.prev_key;
        captures[rec.color] = rec.prev_cap;
        side = rec.prev_side;
        ko_point = rec.prev_ko;
        passes = rec.prev_passes;
    }
    over = false;
    return true;
}

std::pair<bool, const char*> Board::legal(std::uint8_t color, int vertex) const {
    if (over) return {false, "over"};
    if (color != side) return {false, "turn"};
    if (vertex == -1) return {true, nullptr};
    if (vertex < 0 || vertex >= n2) return {false, "range"};
    if (vertex == ko_point) return {false, "ko"};
    if (cells[vertex] != 0) return {false, "occupied"};
    Board b = clone();
    PlayResult r = b.play(color, vertex);
    if (r.ok) return {true, nullptr};
    return {false, r.reason};
}

std::vector<int> Board::legal_moves() const {
    std::vector<int> out;
    for (int p = 0; p < n2; ++p) {
        if (cells[p] == 0 && legal(side, p).first) out.push_back(p);
    }
    return out;
}

std::pair<int, int> Board::prisoners() const { return {captures[1], captures[2]}; }

Score Board::score(const std::vector<std::pair<std::uint8_t, int>>* dead) const {
    const auto& nb = *neigh;
    std::vector<std::uint8_t> c = cells;
    int prisoners[3] = {0, captures[1], captures[2]};
    if (dead != nullptr) {
        for (const auto& pr : *dead) {
            std::uint8_t color = pr.first;
            int vertex = pr.second;
            if (vertex >= 0 && vertex < n2 && c[vertex] == color) {
                c[vertex] = 0;
                prisoners[3 - color] += 1;
            }
        }
    }
    std::vector<char> seen(n2, 0);
    int black_t = 0;
    int white_t = 0;
    int dame = 0;
    for (int start = 0; start < n2; ++start) {
        if (c[start] != 0 || seen[start]) continue;
        std::vector<int> st;
        st.push_back(start);
        seen[start] = 1;
        int region = 1;
        std::uint8_t borders = 0;
        while (!st.empty()) {
            int cur = st.back();
            st.pop_back();
            for (int n : nb[cur]) {
                std::uint8_t v = c[n];
                if (v == 0) {
                    if (!seen[n]) {
                        seen[n] = 1;
                        st.push_back(n);
                        ++region;
                    }
                } else {
                    borders |= static_cast<std::uint8_t>(1u << v);
                }
            }
        }
        if (borders == 0b10) {
            black_t += region;
        } else if (borders == 0b100) {
            white_t += region;
        } else {
            dame += region;
        }
    }
    int black_stones = 0;
    int white_stones = 0;
    for (std::uint8_t v : c) {
        if (v == 1) ++black_stones;
        else if (v == 2) ++white_stones;
    }
    int black;
    int white;
    if (rules.scoring == Scoring::Area) {
        black = black_stones + black_t;
        white = white_stones + white_t;
    } else {
        black = black_t + prisoners[1];
        white = white_t + prisoners[2];
    }
    double diff = static_cast<double>(black) - (static_cast<double>(white) + komi);
    std::string result;
    if (diff == 0.0) {
        result = "0";
    } else if (diff > 0.0) {
        result = "B+" + fmt_num(diff);
    } else {
        result = "W+" + fmt_num(-diff);
    }
    Score sc;
    sc.black = black;
    sc.white = white;
    sc.komi = komi;
    sc.dame = dame;
    sc.result = result;
    sc.black_territory = black_t;
    sc.white_territory = white_t;
    sc.black_stones = black_stones;
    sc.white_stones = white_stones;
    sc.prisoners_black = prisoners[1];
    sc.prisoners_white = prisoners[2];
    return sc;
}

}  // namespace weiqi
