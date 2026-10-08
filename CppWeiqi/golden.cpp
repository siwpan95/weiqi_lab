// golden.cpp -- minimal JSON parser/serializer + golden-value runner

#include "golden.hpp"

#include <cerrno>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <sstream>
#include <stdexcept>

#if defined(_WIN32)
#include <direct.h>
#define WEIQI_GETCWD _getcwd
#else
#include <unistd.h>
#define WEIQI_GETCWD getcwd
#endif

namespace weiqi {

// ===========================================================================
// JSON parser
// ===========================================================================

namespace {

struct Parser {
    const std::string& b;
    std::size_t i = 0;
    explicit Parser(const std::string& s) : b(s) {}

    void skip_ws() {
        while (i < b.size()) {
            char c = b[i];
            if (c == ' ' || c == '\t' || c == '\n' || c == '\r') {
                ++i;
            } else {
                break;
            }
        }
    }

    [[noreturn]] void fail(const std::string& m) { throw std::runtime_error(m); }

    Json parse_value() {
        skip_ws();
        if (i >= b.size()) fail("unexpected end of input");
        char c = b[i];
        switch (c) {
            case '{': return parse_obj();
            case '[': return parse_arr();
            case '"': return Json::make_str(parse_string());
            case 't':
            case 'f':
            case 'n': return parse_lit();
            default:
                if (c == '-' || (c >= '0' && c <= '9')) return parse_number();
                fail("unexpected byte");
        }
    }

    Json parse_lit() {
        if (b.compare(i, 4, "true") == 0) {
            i += 4;
            return Json::make_bool(true);
        }
        if (b.compare(i, 5, "false") == 0) {
            i += 5;
            return Json::make_bool(false);
        }
        if (b.compare(i, 4, "null") == 0) {
            i += 4;
            return Json::make_null();
        }
        fail("bad literal");
    }

    Json parse_number() {
        std::size_t start = i;
        if (b[i] == '-') ++i;
        while (i < b.size() && b[i] >= '0' && b[i] <= '9') ++i;
        bool is_float = false;
        if (i < b.size() && b[i] == '.') {
            is_float = true;
            ++i;
            while (i < b.size() && b[i] >= '0' && b[i] <= '9') ++i;
        }
        if (i < b.size() && (b[i] == 'e' || b[i] == 'E')) {
            is_float = true;
            ++i;
            if (i < b.size() && (b[i] == '+' || b[i] == '-')) ++i;
            while (i < b.size() && b[i] >= '0' && b[i] <= '9') ++i;
        }
        std::string s = b.substr(start, i - start);
        if (is_float) {
            return Json::make_float(std::strtod(s.c_str(), nullptr));
        }
        // Integer: prefer i64, fall back to float on overflow.
        errno = 0;
        char* endp = nullptr;
        long long v = std::strtoll(s.c_str(), &endp, 10);
        if (errno == 0 && endp != nullptr && *endp == '\0') return Json::make_int(v);
        return Json::make_float(std::strtod(s.c_str(), nullptr));
    }

    std::string parse_string() {
        // current byte is '"'
        ++i;
        std::string out;
        while (true) {
            if (i >= b.size()) fail("unterminated string");
            char c = b[i];
            if (c == '"') {
                ++i;
                break;
            }
            if (c == '\\') {
                ++i;
                if (i >= b.size()) fail("bad escape");
                char e = b[i++];
                switch (e) {
                    case '"': out.push_back('"'); break;
                    case '\\': out.push_back('\\'); break;
                    case '/': out.push_back('/'); break;
                    case 'b': out.push_back('\b'); break;
                    case 'f': out.push_back('\f'); break;
                    case 'n': out.push_back('\n'); break;
                    case 'r': out.push_back('\r'); break;
                    case 't': out.push_back('\t'); break;
                    case 'u': {
                        if (i + 4 > b.size()) fail("bad \\u escape");
                        unsigned cp = 0;
                        for (int k = 0; k < 4; ++k) {
                            char h = b[i + k];
                            unsigned d;
                            if (h >= '0' && h <= '9') d = static_cast<unsigned>(h - '0');
                            else if (h >= 'a' && h <= 'f') d = static_cast<unsigned>(h - 'a' + 10);
                            else if (h >= 'A' && h <= 'F') d = static_cast<unsigned>(h - 'A' + 10);
                            else fail("bad \\u escape");
                            cp = cp * 16 + d;
                        }
                        i += 4;
                        // Encode as UTF-8 (BMP only; lone surrogates -> U+FFFD).
                        if (cp >= 0xD800 && cp <= 0xDFFF) cp = 0xFFFD;
                        if (cp < 0x80) {
                            out.push_back(static_cast<char>(cp));
                        } else if (cp < 0x800) {
                            out.push_back(static_cast<char>(0xC0 | (cp >> 6)));
                            out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
                        } else {
                            out.push_back(static_cast<char>(0xE0 | (cp >> 12)));
                            out.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
                            out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
                        }
                        break;
                    }
                    default: fail("bad escape");
                }
            } else {
                out.push_back(c);
                ++i;
            }
        }
        return out;
    }

    Json parse_arr() {
        ++i;  // '['
        std::vector<Json> out;
        skip_ws();
        if (i < b.size() && b[i] == ']') {
            ++i;
            return Json::make_arr(std::move(out));
        }
        while (true) {
            out.push_back(parse_value());
            skip_ws();
            if (i >= b.size()) fail("unterminated array");
            if (b[i] == ',') {
                ++i;
            } else if (b[i] == ']') {
                ++i;
                break;
            } else {
                fail("bad array separator");
            }
        }
        return Json::make_arr(std::move(out));
    }

    Json parse_obj() {
        ++i;  // '{'
        std::vector<std::pair<std::string, Json>> out;
        skip_ws();
        if (i < b.size() && b[i] == '}') {
            ++i;
            return Json::make_obj(std::move(out));
        }
        while (true) {
            skip_ws();
            if (i >= b.size() || b[i] != '"') fail("expected object key");
            std::string key = parse_string();
            skip_ws();
            if (i >= b.size() || b[i] != ':') fail("expected ':'");
            ++i;
            Json v = parse_value();
            out.emplace_back(std::move(key), std::move(v));
            skip_ws();
            if (i >= b.size()) fail("unterminated object");
            if (b[i] == ',') {
                ++i;
            } else if (b[i] == '}') {
                ++i;
                break;
            } else {
                fail("bad object separator");
            }
        }
        return Json::make_obj(std::move(out));
    }
};

void write_string(std::string& out, const std::string& s) {
    out.push_back('"');
    for (unsigned char ch : s) {
        switch (ch) {
            case '"': out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\n': out += "\\n"; break;
            case '\r': out += "\\r"; break;
            case '\t': out += "\\t"; break;
            case '\b': out += "\\b"; break;
            case '\f': out += "\\f"; break;
            default:
                if (ch < 0x20) {
                    char buf[8];
                    std::snprintf(buf, sizeof(buf), "\\u%04x", ch);
                    out += buf;
                } else {
                    out.push_back(static_cast<char>(ch));
                }
        }
    }
    out.push_back('"');
}

void write_json(std::string& out, const Json& j) {
    switch (j.type) {
        case Json::Null: out += "null"; break;
        case Json::Bool: out += j.b ? "true" : "false"; break;
        case Json::Int: out += std::to_string(j.i); break;
        case Json::Float: out += fmt_json_float(j.f); break;
        case Json::Str: write_string(out, j.s); break;
        case Json::Arr:
            out.push_back('[');
            for (std::size_t k = 0; k < j.arr.size(); ++k) {
                if (k) out.push_back(',');
                write_json(out, j.arr[k]);
            }
            out.push_back(']');
            break;
        case Json::Obj:
            out.push_back('{');
            for (std::size_t k = 0; k < j.obj.size(); ++k) {
                if (k) out.push_back(',');
                write_string(out, j.obj[k].first);
                out.push_back(':');
                write_json(out, j.obj[k].second);
            }
            out.push_back('}');
            break;
    }
}

bool json_equal(const Json& a, const Json& b) {
    if (a.type != b.type) return false;
    switch (a.type) {
        case Json::Null: return true;
        case Json::Bool: return a.b == b.b;
        case Json::Int: return a.i == b.i;
        case Json::Float: return a.f == b.f;
        case Json::Str: return a.s == b.s;
        case Json::Arr:
            if (a.arr.size() != b.arr.size()) return false;
            for (std::size_t k = 0; k < a.arr.size(); ++k)
                if (!json_equal(a.arr[k], b.arr[k])) return false;
            return true;
        case Json::Obj:
            if (a.obj.size() != b.obj.size()) return false;
            for (const auto& kv : a.obj) {
                const Json* o = b.get(kv.first);
                if (o == nullptr || !json_equal(kv.second, *o)) return false;
            }
            return true;
    }
    return false;
}

}  // namespace

Json jstr(const std::string& s) { return Json::make_str(s); }
Json jint(long long v) { return Json::make_int(v); }

Json jobj(std::vector<std::pair<std::string, Json>> items) {
    return Json::make_obj(std::move(items));
}

Json parse_json(const std::string& text) {
    Parser p(text);
    Json v = p.parse_value();
    p.skip_ws();
    if (p.i != text.size()) throw std::runtime_error("trailing data");
    return v;
}

std::string to_json_string(const Json& j) {
    std::string out;
    out.reserve(256);
    write_json(out, j);
    return out;
}

std::string fmt_json_float(double v) {
    if (!std::isfinite(v)) return "null";
    if (v == std::trunc(v) && std::fabs(v) < 1e16) {
        char buf[64];
        std::snprintf(buf, sizeof(buf), "%.1f", v);  // Python: 7.0 -> "7.0"
        return std::string(buf);
    }
    for (int p = 1; p <= 17; ++p) {
        char buf[64];
        std::snprintf(buf, sizeof(buf), "%.*g", p, v);
        if (std::strtod(buf, nullptr) == v) return std::string(buf);
    }
    char buf[64];
    std::snprintf(buf, sizeof(buf), "%.17g", v);
    return std::string(buf);
}

std::string json_to_strlike(const Json& v) {
    switch (v.type) {
        case Json::Str: return v.s;
        case Json::Int: return std::to_string(v.i);
        case Json::Float: return fmt_json_float(v.f);
        case Json::Bool: return v.b ? "True" : "False";
        case Json::Null: return "None";
        default: return "";
    }
}

// ===========================================================================
// golden runner
// ===========================================================================

namespace {

double num_or(const Json& v) { return v.as_f64().value_or(0.0); }

std::vector<std::pair<std::uint8_t, int>> parse_stone_list(const Json& arr, int size) {
    std::vector<std::pair<std::uint8_t, int>> out;
    const std::vector<Json>* a = arr.as_arr();
    if (a == nullptr) throw std::runtime_error("bad stones");
    for (const Json& it : *a) {
        const std::vector<Json>* pair = it.as_arr();
        if (pair == nullptr || pair->size() < 2) throw std::runtime_error("bad stone");
        std::uint8_t c = parse_color(json_to_strlike((*pair)[0]));
        int v = parse_vertex(json_to_strlike((*pair)[1]), size);
        out.emplace_back(c, v);
    }
    return out;
}

}  // namespace

Board build_board(const Json& setup) {
    long long size_ll = 9;
    if (const Json* sz = setup.get("size")) {
        if (auto v = sz->as_i64()) size_ll = *v;
    }
    if (size_ll < 2 || size_ll > 19) throw std::runtime_error("bad size");
    int size = static_cast<int>(size_ll);

    const Json* rj = setup.get("rules");
    Rules rules;
    if (rj == nullptr || rj->is_null()) {
        rules = *profile("cn");
    } else if (rj->type == Json::Str) {
        const Rules* p = profile(rj->s.c_str());
        if (p == nullptr) throw std::runtime_error("unknown rules profile: " + rj->s);
        rules = *p;
    } else if (rj->type == Json::Obj) {
        const Json* ko = rj->get("ko");
        const Json* su = rj->get("suicide");
        const Json* sc = rj->get("scoring");
        const Json* km = rj->get("komi");
        std::string kos = ko ? json_to_strlike(*ko) : std::string();
        std::string sus = su ? json_to_strlike(*su) : std::string();
        std::string scs = sc ? json_to_strlike(*sc) : std::string();
        double kmv = km ? num_or(*km) : 0.0;
        rules = rules_from_parts(ko ? &kos : nullptr, su ? &sus : nullptr,
                                 sc ? &scs : nullptr, km ? &kmv : nullptr);
    } else {
        throw std::runtime_error("bad rules");
    }

    std::optional<double> komi;
    if (const Json* km = setup.get("komi")) {
        if (auto v = km->as_f64()) komi = *v;
    }
    Board b(size, komi, rules);

    const Json* st = setup.get("stones");
    if (st != nullptr && !st->is_null()) {
        std::vector<std::pair<std::uint8_t, int>> pairs = parse_stone_list(*st, size);
        std::uint8_t side = 1;
        if (const Json* s = setup.get("side")) {
            if (!s->is_null()) side = parse_color(json_to_strlike(*s));
        }
        b.set_stones(pairs, side);
        if (const Json* kp = setup.get("ko_point")) {
            if (!kp->is_null()) {
                if (kp->type == Json::Str) {
                    b.ko_point = parse_vertex(kp->s, size);
                } else {
                    b.ko_point = static_cast<int>(kp->i);
                }
            }
        }
    }

    const Json* mv = setup.get("moves");
    if (mv != nullptr && mv->type == Json::Arr && !mv->arr.empty()) {
        for (const Json& it : mv->arr) {
            const std::vector<Json>* pair = it.as_arr();
            if (pair == nullptr || pair->size() < 2) throw std::runtime_error("bad move");
            std::uint8_t c = parse_color(json_to_strlike((*pair)[0]));
            int v = parse_vertex(json_to_strlike((*pair)[1]), size);
            PlayResult r = b.play(c, v);
            if (!r.ok) {
                throw std::runtime_error("setup move illegal: " + json_to_strlike((*pair)[0]) +
                                         " " + json_to_strlike((*pair)[1]) + " (" +
                                         (r.reason ? r.reason : "?") + ")");
            }
        }
    }
    return b;
}

Json run_case(const Json& c) {
    const Json* setup = c.get("setup");
    Json null_setup;
    Board b = build_board(setup ? *setup : null_setup);

    const Json* opj = c.get("op");
    if (opj == nullptr || opj->type != Json::Str) throw std::runtime_error("no op");
    const std::string& op = opj->s;
    const Json* args = c.get("args");
    Json null_args;
    const Json& a = args ? *args : null_args;
    int size = b.size;

    if (op == "key") {
        auto k = b.key();
        return jobj({{"key", jstr(fmt_key(k.first))},
                     {"situational", jstr(fmt_key(k.second))}});
    }
    if (op == "legal") {
        std::uint8_t color = 1;
        if (const Json* cj = a.get("color")) color = parse_color(json_to_strlike(*cj));
        const Json* vj = a.get("vertex");
        if (vj == nullptr) throw std::runtime_error("bad args");
        int v = parse_vertex(json_to_strlike(*vj), size);
        auto r = b.legal(color, v);
        if (r.first) return jobj({{"legal", Json::make_bool(true)}});
        return jobj({{"legal", Json::make_bool(false)},
                     {"reason", jstr(r.second ? r.second : "?")}});
    }
    if (op == "legal_moves") {
        std::vector<int> ms = b.legal_moves();
        std::vector<Json> out;
        out.reserve(ms.size());
        for (int p : ms) out.push_back(jstr(format_vertex(p, size)));
        return jobj({{"count", jint(static_cast<long long>(ms.size()))},
                     {"moves", Json::make_arr(std::move(out))}});
    }
    if (op == "play") {
        const Json* cj = a.get("color");
        const Json* vj = a.get("vertex");
        if (cj == nullptr || vj == nullptr) throw std::runtime_error("bad args");
        std::uint8_t color = parse_color(json_to_strlike(*cj));
        int v = parse_vertex(json_to_strlike(*vj), size);
        PlayResult r = b.play(color, v);
        if (!r.ok) {
            return jobj({{"ok", Json::make_bool(false)},
                         {"reason", jstr(r.reason ? r.reason : "?")}});
        }
        return jobj({{"ok", Json::make_bool(true)},
                     {"captures", jint(r.captures)},
                     {"self_captured", jint(r.self_captured)}});
    }
    if (op == "undo") {
        long long n = 1;
        if (const Json* nj = a.get("n")) {
            if (auto v = nj->as_i64()) n = *v;
        }
        bool ok = true;
        for (long long k = 0; k < n; ++k) {
            if (!b.undo()) ok = false;
        }
        return jobj({{"ok", Json::make_bool(ok)}});
    }
    if (op == "score") {
        std::vector<std::pair<std::uint8_t, int>> dead;
        if (const Json* dj = a.get("dead")) {
            if (!dj->is_null()) dead = parse_stone_list(*dj, size);
        }
        Score sc = b.score(dead.empty() ? nullptr : &dead);
        return jobj({{"black", jint(sc.black)},
                     {"white", jint(sc.white)},
                     {"dame", jint(sc.dame)},
                     {"result", jstr(sc.result)}});
    }
    if (op == "prisoners") {
        auto pr = b.prisoners();
        return jobj({{"black", jint(pr.first)}, {"white", jint(pr.second)}});
    }
    if (op == "over") {
        return jobj({{"over", Json::make_bool(b.is_over())}});
    }
    throw std::runtime_error("unknown op: " + op);
}

void compare(const Json& expect, const Json& got, std::vector<Json>& miss) {
    if (expect.type != Json::Obj) return;
    for (const auto& kv : expect.obj) {
        const Json* gv = got.get(kv.first);
        bool is_float = (kv.second.type == Json::Float) ||
                        (gv != nullptr && gv->type == Json::Float);
        if (is_float) {
            std::optional<double> x = kv.second.as_f64();
            std::optional<double> y = gv ? gv->as_f64() : std::nullopt;
            bool ok = x.has_value() && y.has_value() && std::fabs(*x - *y) <= 1e-9;
            if (!ok) {
                miss.push_back(Json::make_arr({jstr(kv.first), kv.second,
                                               gv ? *gv : Json::make_null()}));
            }
        } else {
            bool ok = gv != nullptr && json_equal(kv.second, *gv);
            if (!ok) {
                miss.push_back(Json::make_arr({jstr(kv.first), kv.second,
                                               gv ? *gv : Json::make_null()}));
            }
        }
    }
}

GoldenResult run_golden(const std::string& path) {
    std::ifstream in(path, std::ios::binary);
    if (!in) throw std::runtime_error("cannot read " + path);
    std::ostringstream ss;
    ss << in.rdbuf();
    std::string text = ss.str();
    Json data = parse_json(text);

    const Json* cases = data.get("cases");
    if (cases == nullptr || cases->type != Json::Arr) {
        throw std::runtime_error("no cases in golden file");
    }
    GoldenResult res;
    for (const Json& c : cases->arr) {
        const Json* idj = c.get("id");
        std::string id = (idj && idj->type == Json::Str) ? idj->s : std::string();
        try {
            Json got = run_case(c);
            const Json* exp = c.get("expect");
            Json empty_expect = Json::make_obj({});
            std::vector<Json> miss;
            compare(exp ? *exp : empty_expect, got, miss);
            if (miss.empty()) {
                ++res.passed;
            } else {
                ++res.failed;
                res.failures.push_back(jobj({{"id", jstr(id)},
                                             {"got", got},
                                             {"expect", exp ? *exp : empty_expect},
                                             {"miss", Json::make_arr(std::move(miss))}}));
            }
        } catch (const std::exception& e) {
            ++res.failed;
            res.failures.push_back(jobj({{"id", jstr(id)}, {"error", jstr(e.what())}}));
        }
    }
    res.total = res.passed + res.failed;
    return res;
}

std::optional<std::string> default_golden_path() {
    auto exists = [](const std::string& p) {
        std::ifstream f(p, std::ios::binary);
        return f.good();
    };
    // 1) Direct relative candidates (built inside <Lang>Weiqi/).
    const char* rels[] = {"spec/golden.json",      "../spec/golden.json",
                          "../../spec/golden.json", "../../../spec/golden.json",
                          "../../../../spec/golden.json"};
    for (const char* r : rels) {
        if (exists(r)) return std::string(r);
    }
    // 2) Walk up from cwd.
    char buf[4096];
    if (WEIQI_GETCWD(buf, sizeof(buf)) != nullptr) {
        std::string dir(buf);
        while (true) {
            std::string candidate = dir + "/spec/golden.json";
            if (exists(candidate)) return candidate;
            std::size_t slash = dir.find_last_of("/\\");
            if (slash == std::string::npos || slash == 0) break;
            std::string parent = dir.substr(0, slash);
            if (parent.empty() || parent == dir) break;
            dir = parent;
        }
    }
    return std::nullopt;
}

}  // namespace weiqi
