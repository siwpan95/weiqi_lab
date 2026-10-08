// golden.hpp -- minimal JSON parser/serializer + golden-value runner
//
// Part 1: a zero-dependency JSON implementation (no nlohmann/json etc.),
//         supporting object/array/string/number(int|float)/bool/null and
//         common escapes incl. \uXXXX.  Mirrors the Rust port's approach.
// Part 2: golden runner -- reads spec/golden.json, builds a board per `setup`,
//         runs the `op`, and compares `expect` field by field.
//         `spec/golden.json` is READ-ONLY.

#pragma once

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

#include "weiqi_rules.hpp"

namespace weiqi {

// ---------------------------------------------------------------------------
// Minimal JSON
// ---------------------------------------------------------------------------

struct Json {
    enum Type { Null, Bool, Int, Float, Str, Arr, Obj };
    Type type = Null;
    bool b = false;
    long long i = 0;
    double f = 0.0;
    std::string s;
    std::vector<Json> arr;
    std::vector<std::pair<std::string, Json>> obj;

    Json() = default;

    static Json make_null() { return Json(); }
    static Json make_bool(bool v) {
        Json j;
        j.type = Bool;
        j.b = v;
        return j;
    }
    static Json make_int(long long v) {
        Json j;
        j.type = Int;
        j.i = v;
        return j;
    }
    static Json make_float(double v) {
        Json j;
        j.type = Float;
        j.f = v;
        return j;
    }
    static Json make_str(std::string v) {
        Json j;
        j.type = Str;
        j.s = std::move(v);
        return j;
    }
    static Json make_arr(std::vector<Json> v) {
        Json j;
        j.type = Arr;
        j.arr = std::move(v);
        return j;
    }
    static Json make_obj(std::vector<std::pair<std::string, Json>> v) {
        Json j;
        j.type = Obj;
        j.obj = std::move(v);
        return j;
    }

    const Json* get(const std::string& k) const {
        if (type != Obj) return nullptr;
        for (const auto& kv : obj) {
            if (kv.first == k) return &kv.second;
        }
        return nullptr;
    }
    bool is_null() const { return type == Null; }
    const std::string* as_str() const { return type == Str ? &s : nullptr; }
    std::optional<long long> as_i64() const {
        if (type == Int) return i;
        return std::nullopt;
    }
    std::optional<double> as_f64() const {
        if (type == Int) return static_cast<double>(i);
        if (type == Float) return f;
        return std::nullopt;
    }
    std::optional<bool> as_bool() const {
        if (type == Bool) return b;
        return std::nullopt;
    }
    const std::vector<Json>* as_arr() const { return type == Arr ? &arr : nullptr; }
};

// Convenience builders.
Json jstr(const std::string& s);
Json jint(long long v);
Json jobj(std::vector<std::pair<std::string, Json>> items);

// Parse a JSON text (leading/trailing whitespace allowed). Throws on error.
Json parse_json(const std::string& text);

// Compact serialization (no extraneous whitespace).
std::string to_json_string(const Json& j);

// Format a float like Python's json.dumps: integral -> "7.0"; else shortest
// decimal that round-trips. Non-finite -> "null".
std::string fmt_json_float(double v);

// ---------------------------------------------------------------------------
// golden runner
// ---------------------------------------------------------------------------

struct GoldenResult {
    int passed = 0;
    int failed = 0;
    int total = 0;
    std::vector<Json> failures;
};

// Build a board from a `setup` object (mirrors golden.py build_board).
Board build_board(const Json& setup);

// Run one case (mirrors golden.py run_case). Throws on error.
Json run_case(const Json& c);

// Compare expect vs got; append mismatches to `miss` (mirrors golden.py compare).
void compare(const Json& expect, const Json& got, std::vector<Json>& miss);

GoldenResult run_golden(const std::string& path);

// Locate spec/golden.json by walking up from cwd / executable dir.
std::optional<std::string> default_golden_path();

// Stringify a JSON-ish scalar to feed parse_color/parse_vertex (Python accepts
// numbers there via str()).
std::string json_to_strlike(const Json& v);

}  // namespace weiqi
