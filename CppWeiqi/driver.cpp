// driver.cpp -- JSON-stdio driver (docs/PROTOCOL_SPEC.md, protocol-v1)
//
// Mirrors PyWeiqi/driver.py. On start a ready event is emitted, then the engine
// enters a synchronous request/response loop. All stdout output is compact JSON;
// logs (if any) go to stderr.

#include "driver.hpp"

#include <iostream>
#include <optional>
#include <stdexcept>
#include <string>
#include <vector>

#include "golden.hpp"
#include "weiqi_ai.hpp"
#include "weiqi_rules.hpp"

namespace weiqi {

namespace {

const char* NAME = "CppWeiqi";
const char* LANG = "cpp";
const char* VERSION = "v1";
constexpr long long PROTOCOL = 1;

struct CmdError {
    std::string msg;
    std::optional<std::string> reason;
    CmdError(std::string m) : msg(std::move(m)) {}
    CmdError(std::string m, std::string r) : msg(std::move(m)), reason(std::move(r)) {}
};

CmdError bad_args() { return CmdError("bad args"); }

Json jf(double v) { return Json::make_float(v); }
Json jb(bool v) { return Json::make_bool(v); }
Json jo(std::vector<std::pair<std::string, Json>> items) { return Json::make_obj(std::move(items)); }

Profile build_profile(const Json* jv) {
    Profile p;
    if (jv == nullptr || jv->type != Json::Obj) return p;
    for (const auto& kv : jv->obj) {
        const std::string& k = kv.first;
        const Json& v = kv.second;
        if (v.is_null()) continue;
        if (k == "c") {
            if (auto x = v.as_f64()) p.c = *x;
        } else if (k == "rave") {
            if (auto x = v.as_bool()) p.rave = *x;
        } else if (k == "rave_k") {
            if (auto x = v.as_f64()) p.rave_k = *x;
        } else if (k == "capture_bias") {
            if (auto x = v.as_f64()) p.capture_bias = *x;
        } else if (k == "pattern_bias") {
            if (auto x = v.as_f64()) p.pattern_bias = *x;
        } else if (k == "prune_radius") {
            if (auto x = v.as_i64()) p.prune_radius = static_cast<int>(*x);
        } else if (k == "pass_bias") {
            if (auto x = v.as_f64()) p.pass_bias = *x;
        } else if (k == "resign_threshold") {
            if (auto x = v.as_f64()) p.resign_threshold = *x;
        } else if (k == "resign_min_visits") {
            if (auto x = v.as_i64()) p.resign_min_visits = static_cast<int>(*x);
        } else if (k == "mercy") {
            if (auto x = v.as_f64()) p.mercy = *x;
        } else if (k == "pass_threshold") {
            if (auto x = v.as_f64()) p.pass_threshold = *x;
        } else if (k == "score_scale") {
            if (auto x = v.as_f64()) p.score_scale = *x;
        }
    }
    return p;
}

Rules parse_rules(const Json* jv) {
    if (jv == nullptr || jv->is_null()) return *profile("cn");
    if (jv->type == Json::Str) {
        const Rules* p = profile(jv->s.c_str());
        if (p == nullptr) throw CmdError("bad rules");
        return *p;
    }
    if (jv->type == Json::Obj) {
        const Json* ko = jv->get("ko");
        const Json* su = jv->get("suicide");
        const Json* sc = jv->get("scoring");
        const Json* km = jv->get("komi");
        std::string kos = ko ? json_to_strlike(*ko) : std::string();
        std::string sus = su ? json_to_strlike(*su) : std::string();
        std::string scs = sc ? json_to_strlike(*sc) : std::string();
        double kmv = km ? km->as_f64().value_or(0.0) : 0.0;
        try {
            return rules_from_parts(ko ? &kos : nullptr, su ? &sus : nullptr, sc ? &scs : nullptr,
                                    km ? &kmv : nullptr);
        } catch (const std::exception& e) {
            throw CmdError(e.what());
        }
    }
    throw CmdError("bad rules");
}

class Driver {
public:
    Driver() : board_(9, std::nullopt, *profile("cn")) {}

    Json dispatch(const Json& req) {
        const Json* cmdj = req.get("cmd");
        if (cmdj == nullptr || cmdj->type != Json::Str) throw CmdError("unknown command");
        const std::string& cmd = cmdj->s;
        if (cmd == "hello") return cmd_hello();
        if (cmd == "clear") return cmd_clear(req);
        if (cmd == "set_stones") return cmd_set_stones(req);
        if (cmd == "play") return cmd_play(req);
        if (cmd == "undo") return cmd_undo();
        if (cmd == "key") return cmd_key();
        if (cmd == "legal") return cmd_legal(req);
        if (cmd == "legal_moves") return cmd_legal_moves();
        if (cmd == "genmove") return cmd_genmove(req);
        if (cmd == "score") return cmd_score(req);
        if (cmd == "prisoners") return cmd_prisoners();
        if (cmd == "selftest") return cmd_selftest(req);
        throw CmdError("unknown command");
    }

private:
    Board board_;

    Json cmd_hello() {
        return jo({{"name", jstr(NAME)},
                   {"version", jstr(VERSION)},
                   {"lang", jstr(LANG)},
                   {"protocol", jint(PROTOCOL)}});
    }

    Json cmd_clear(const Json& req) {
        long long size = 9;
        if (const Json* sj = req.get("size")) {
            if (auto v = sj->as_i64()) size = *v;
        }
        if (size < 2 || size > 19) throw CmdError("bad size");
        Rules rules = parse_rules(req.get("rules"));
        std::optional<double> komi;
        if (const Json* kj = req.get("komi")) {
            if (auto v = kj->as_f64()) komi = *v;
        }
        board_ = Board(static_cast<int>(size), komi, rules);
        return jo({{"size", jint(size)},
                   {"komi", jf(board_.komi)},
                   {"rules", jo({{"ko", jstr(ko_str(rules.ko))},
                                 {"suicide", jstr(suicide_str(rules.suicide))},
                                 {"scoring", jstr(scoring_str(rules.scoring))}})}});
    }

    Json cmd_set_stones(const Json& req) {
        std::uint8_t side = 1;
        if (const Json* sj = req.get("side")) {
            if (!sj->is_null()) {
                try {
                    side = parse_color(json_to_strlike(*sj));
                } catch (const std::exception& e) {
                    // Mirror Python: a parse failure surfaces as error text, no reason.
                    throw CmdError(e.what());
                }
            }
        }
        std::vector<std::pair<std::uint8_t, int>> pairs;
        if (const Json* stones = req.get("stones")) {
            if (const std::vector<Json>* arr = stones->as_arr()) {
                for (const Json& it : *arr) {
                    const std::vector<Json>* a = it.as_arr();
                    if (a == nullptr || a->size() < 2) throw bad_args();
                    std::uint8_t c;
                    try {
                        c = parse_color(json_to_strlike((*a)[0]));
                    } catch (const std::exception& e) {
                        throw CmdError(e.what());
                    }
                    int v;
                    if ((*a)[1].type == Json::Str) {
                        try {
                            v = parse_vertex((*a)[1].s, board_.size);
                        } catch (const std::exception& e) {
                            throw CmdError(e.what());
                        }
                    } else if ((*a)[1].type == Json::Int) {
                        v = static_cast<int>((*a)[1].i);
                    } else {
                        throw bad_args();
                    }
                    pairs.emplace_back(c, v);
                }
            }
        }
        board_.set_stones(pairs, side);
        return jo({{"stones", jint(static_cast<long long>(pairs.size()))}});
    }

    // Python: parse_vertex(v,size) if isinstance(v,str) else int(v).
    int parse_vertex_arg(const Json& vj) {
        if (vj.type == Json::Str) {
            try {
                return parse_vertex(vj.s, board_.size);
            } catch (const std::exception& e) {
                throw CmdError(e.what());
            }
        }
        if (vj.type == Json::Int) return static_cast<int>(vj.i);
        throw bad_args();
    }

    // Python: parse_color(req.get("color", color_name(side))).
    std::uint8_t color_arg(const Json* cj) {
        if (cj == nullptr) return board_.side;
        try {
            return parse_color(json_to_strlike(*cj));
        } catch (const std::exception& e) {
            throw CmdError(e.what());
        }
    }

    Json cmd_play(const Json& req) {
        std::uint8_t color = color_arg(req.get("color"));
        const Json* vj = req.get("vertex");
        if (vj == nullptr) throw bad_args();
        int vertex = parse_vertex_arg(*vj);
        PlayResult r = board_.play(color, vertex);
        if (!r.ok) throw CmdError("illegal move", r.reason ? r.reason : "?");
        return jo({{"captures", jint(r.captures)},
                   {"self_captured", jint(r.self_captured)},
                   {"key", jstr(fmt_key(r.key))}});
    }

    Json cmd_undo() {
        if (!board_.undo()) throw CmdError("nothing to undo");
        return jo({{"moves", jint(static_cast<long long>(board_.stack.size()))}});
    }

    Json cmd_key() {
        auto k = board_.key();
        return jo({{"key", jstr(fmt_key(k.first))}, {"situational", jstr(fmt_key(k.second))}});
    }

    Json cmd_legal(const Json& req) {
        std::uint8_t color = color_arg(req.get("color"));
        const Json* vj = req.get("vertex");
        if (vj == nullptr) throw bad_args();
        int vertex = parse_vertex_arg(*vj);
        auto r = board_.legal(color, vertex);
        if (r.first) return jo({{"legal", jb(true)}});
        return jo({{"legal", jb(false)}, {"reason", jstr(r.second ? r.second : "?")}});
    }

    Json cmd_legal_moves() {
        std::vector<int> ms = board_.legal_moves();
        std::vector<Json> out;
        out.reserve(ms.size());
        for (int p : ms) out.push_back(jstr(format_vertex(p, board_.size)));
        return jo({{"count", jint(static_cast<long long>(ms.size()))},
                   {"moves", Json::make_arr(std::move(out))}});
    }

    Json cmd_genmove(const Json& req) {
        std::uint8_t color = color_arg(req.get("color"));
        long long playouts = 500;
        if (const Json* pj = req.get("playouts")) {
            if (auto v = pj->as_i64()) playouts = *v;
        }
        long long seed = 0;
        if (const Json* sj = req.get("seed")) {
            if (auto v = sj->as_i64()) seed = *v;
        }
        Profile pr = build_profile(req.get("profile"));
        if (color != board_.side) throw CmdError("genmove for wrong side", "turn");

        GenResult g = genmove(board_, static_cast<int>(playouts), seed, pr);
        if (g.kind == MoveKind::Resign) {
            return jo({{"vertex", jstr("resign")},
                       {"visits", jint(g.visits)},
                       {"winrate", jf(g.winrate)}});
        }
        int mv_idx = g.kind == MoveKind::Pass ? -1 : g.point;
        std::string vertex = mv_idx == -1 ? std::string("pass") : format_vertex(mv_idx, board_.size);
        PlayResult r = board_.play(color, mv_idx);
        if (!r.ok) throw CmdError("internal: chosen move illegal", r.reason ? r.reason : "?");
        return jo({{"vertex", jstr(vertex)},
                   {"visits", jint(g.visits)},
                   {"winrate", jf(g.winrate)}});
    }

    Json cmd_score(const Json& req) {
        std::vector<std::pair<std::uint8_t, int>> dead;
        if (const Json* dj = req.get("dead")) {
            if (const std::vector<Json>* arr = dj->as_arr()) {
                for (const Json& it : *arr) {
                    const std::vector<Json>* a = it.as_arr();
                    if (a == nullptr || a->size() < 2) throw bad_args();
                    std::uint8_t c;
                    try {
                        c = parse_color(json_to_strlike((*a)[0]));
                    } catch (const std::exception& e) {
                        throw CmdError(e.what());
                    }
                    int v;
                    try {
                        v = parse_vertex(json_to_strlike((*a)[1]), board_.size);
                    } catch (const std::exception& e) {
                        throw CmdError(e.what());
                    }
                    dead.emplace_back(c, v);
                }
            }
        }
        Score sc = board_.score(dead.empty() ? nullptr : &dead);
        return jo({{"black", jint(sc.black)},
                   {"white", jint(sc.white)},
                   {"komi", jf(sc.komi)},
                   {"dame", jint(sc.dame)},
                   {"result", jstr(sc.result)},
                   {"black_territory", jint(sc.black_territory)},
                   {"white_territory", jint(sc.white_territory)},
                   {"black_stones", jint(sc.black_stones)},
                   {"white_stones", jint(sc.white_stones)},
                   {"prisoners_black", jint(sc.prisoners_black)},
                   {"prisoners_white", jint(sc.prisoners_white)}});
    }

    Json cmd_prisoners() {
        auto pr = board_.prisoners();
        return jo({{"black", jint(pr.first)}, {"white", jint(pr.second)}});
    }

    Json cmd_selftest(const Json& req) {
        std::optional<std::string> path;
        if (const Json* gj = req.get("golden")) {
            if (auto s = gj->as_str()) path = *s;
        }
        if (!path.has_value()) path = default_golden_path();
        if (!path.has_value()) throw CmdError("golden path not found");
        GoldenResult r;
        try {
            r = run_golden(*path);
        } catch (const std::exception& e) {
            throw CmdError(e.what());
        }
        return jo({{"passed", jint(r.passed)},
                   {"failed", jint(r.failed)},
                   {"total", jint(r.total)},
                   {"failures", Json::make_arr(std::move(r.failures))}});
    }
};

Json ok_resp(const Json& id, Json res) {
    return jo({{"id", id}, {"ok", jb(true)}, {"result", std::move(res)}});
}

Json err_resp(const Json& id, const CmdError& e) {
    std::vector<std::pair<std::string, Json>> items;
    items.emplace_back("id", id);
    items.emplace_back("ok", jb(false));
    items.emplace_back("error", jstr(e.msg));
    if (e.reason.has_value()) items.emplace_back("reason", jstr(*e.reason));
    return jo(std::move(items));
}

}  // namespace

int run_driver() {
    Json ready = jo({{"event", jstr("ready")},
                     {"protocol", jint(PROTOCOL)},
                     {"name", jstr(NAME)},
                     {"lang", jstr(LANG)},
                     {"version", jstr(VERSION)}});
    std::cout << to_json_string(ready) << "\n";
    std::cout.flush();

    Driver drv;
    std::string line;
    while (std::getline(std::cin, line)) {
        // trim
        std::size_t a = 0, b = line.size();
        while (a < b && (line[a] == ' ' || line[a] == '\t' || line[a] == '\r' || line[a] == '\n'))
            ++a;
        while (b > a && (line[b - 1] == ' ' || line[b - 1] == '\t' || line[b - 1] == '\r' ||
                         line[b - 1] == '\n'))
            --b;
        if (a == b) continue;
        std::string trimmed = line.substr(a, b - a);

        Json req;
        try {
            req = parse_json(trimmed);
        } catch (const std::exception& e) {
            Json resp = err_resp(Json::make_null(), CmdError(std::string("bad json: ") + e.what()));
            std::cout << to_json_string(resp) << "\n";
            std::cout.flush();
            continue;
        }
        const Json* idj = req.get("id");
        Json id = idj ? *idj : Json::make_null();
        const Json* cmdj = req.get("cmd");
        if (cmdj != nullptr && cmdj->type == Json::Str && cmdj->s == "quit") {
            std::cout << to_json_string(ok_resp(id, Json::make_obj({}))) << "\n";
            std::cout.flush();
            return 0;
        }
        try {
            Json res = drv.dispatch(req);
            std::cout << to_json_string(ok_resp(id, std::move(res))) << "\n";
        } catch (const CmdError& e) {
            std::cout << to_json_string(err_resp(id, e)) << "\n";
        } catch (const std::exception& e) {
            std::cout << to_json_string(err_resp(id, CmdError(e.what()))) << "\n";
        }
        std::cout.flush();
    }
    return 0;
}

}  // namespace weiqi
