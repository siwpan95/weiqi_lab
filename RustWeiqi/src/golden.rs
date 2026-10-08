//! golden.rs — 黄金值用例执行器 + 最小 JSON 实现
//!
//! 本文件包含两部分：
//! 1. **最小 JSON 解析器/序列化器**（零第三方依赖 —— 不引入 serde）：
//!    支持 object/array/string/number(int|float)/bool/null、常见转义与 \uXXXX。
//! 2. **黄金值执行器**：读 `spec/golden.json`，按 op 构造局面并逐位比对 expect
//!    （对照 PyWeiqi/golden.py）。`spec/golden.json` 只读，不得修改。

use crate::rules::{
    fmt_key, format_vertex, parse_color, parse_vertex, profile, rules_from_parts, Board,
};

use std::env;
use std::fs;
use std::path::PathBuf;

// ===========================================================================
// 最小 JSON
// ===========================================================================

#[derive(Clone, Debug, PartialEq)]
pub enum Json {
    Null,
    Bool(bool),
    Int(i64),
    Float(f64),
    Str(String),
    Arr(Vec<Json>),
    Obj(Vec<(String, Json)>),
}

impl Json {
    pub fn get(&self, key: &str) -> Option<&Json> {
        if let Json::Obj(o) = self {
            o.iter().find(|(k, _)| k == key).map(|(_, v)| v)
        } else {
            None
        }
    }
    pub fn as_str(&self) -> Option<&str> {
        if let Json::Str(s) = self {
            Some(s.as_str())
        } else {
            None
        }
    }
    pub fn as_i64(&self) -> Option<i64> {
        match self {
            Json::Int(v) => Some(*v),
            _ => None,
        }
    }
    pub fn as_f64(&self) -> Option<f64> {
        match self {
            Json::Int(v) => Some(*v as f64),
            Json::Float(v) => Some(*v),
            _ => None,
        }
    }
    pub fn as_bool(&self) -> Option<bool> {
        if let Json::Bool(b) = self {
            Some(*b)
        } else {
            None
        }
    }
    pub fn as_arr(&self) -> Option<&Vec<Json>> {
        if let Json::Arr(a) = self {
            Some(a)
        } else {
            None
        }
    }
    pub fn is_null(&self) -> bool {
        matches!(self, Json::Null)
    }
}

pub fn jstr(s: &str) -> Json {
    Json::Str(s.to_string())
}
pub fn jint(v: i64) -> Json {
    Json::Int(v)
}
pub fn jobj(items: Vec<(&str, Json)>) -> Json {
    Json::Obj(items.into_iter().map(|(k, v)| (k.to_string(), v)).collect())
}

struct Parser<'a> {
    b: &'a [u8],
    i: usize,
}

impl<'a> Parser<'a> {
    fn new(b: &'a [u8]) -> Parser<'a> {
        Parser { b, i: 0 }
    }

    fn skip_ws(&mut self) {
        while self.i < self.b.len() {
            match self.b[self.i] {
                b' ' | b'\t' | b'\n' | b'\r' => self.i += 1,
                _ => break,
            }
        }
    }

    fn parse_value(&mut self) -> Result<Json, String> {
        self.skip_ws();
        if self.i >= self.b.len() {
            return Err("unexpected end of input".to_string());
        }
        match self.b[self.i] {
            b'{' => self.parse_obj(),
            b'[' => self.parse_arr(),
            b'"' => Ok(Json::Str(self.parse_string()?)),
            b't' | b'f' | b'n' => self.parse_lit(),
            b'-' | b'0'..=b'9' => self.parse_number(),
            c => Err(format!("unexpected byte 0x{:02x}", c)),
        }
    }

    fn parse_lit(&mut self) -> Result<Json, String> {
        if self.b[self.i..].starts_with(b"true") {
            self.i += 4;
            Ok(Json::Bool(true))
        } else if self.b[self.i..].starts_with(b"false") {
            self.i += 5;
            Ok(Json::Bool(false))
        } else if self.b[self.i..].starts_with(b"null") {
            self.i += 4;
            Ok(Json::Null)
        } else {
            Err("bad literal".to_string())
        }
    }

    fn parse_number(&mut self) -> Result<Json, String> {
        let start = self.i;
        if self.b[self.i] == b'-' {
            self.i += 1;
        }
        while self.i < self.b.len() && self.b[self.i].is_ascii_digit() {
            self.i += 1;
        }
        let mut is_float = false;
        if self.i < self.b.len() && self.b[self.i] == b'.' {
            is_float = true;
            self.i += 1;
            while self.i < self.b.len() && self.b[self.i].is_ascii_digit() {
                self.i += 1;
            }
        }
        if self.i < self.b.len() && (self.b[self.i] == b'e' || self.b[self.i] == b'E') {
            is_float = true;
            self.i += 1;
            if self.i < self.b.len() && (self.b[self.i] == b'+' || self.b[self.i] == b'-') {
                self.i += 1;
            }
            while self.i < self.b.len() && self.b[self.i].is_ascii_digit() {
                self.i += 1;
            }
        }
        let s = std::str::from_utf8(&self.b[start..self.i]).map_err(|e| e.to_string())?;
        if is_float {
            s.parse::<f64>()
                .map(Json::Float)
                .map_err(|_| format!("bad number {:?}", s))
        } else {
            match s.parse::<i64>() {
                Ok(v) => Ok(Json::Int(v)),
                Err(_) => s
                    .parse::<f64>()
                    .map(Json::Float)
                    .map_err(|_| format!("bad number {:?}", s)),
            }
        }
    }

    fn parse_string(&mut self) -> Result<String, String> {
        // 假定当前字节为 '"'
        self.i += 1;
        let mut bytes: Vec<u8> = Vec::new();
        loop {
            if self.i >= self.b.len() {
                return Err("unterminated string".to_string());
            }
            let c = self.b[self.i];
            if c == b'"' {
                self.i += 1;
                break;
            }
            if c == b'\\' {
                self.i += 1;
                if self.i >= self.b.len() {
                    return Err("bad escape".to_string());
                }
                let e = self.b[self.i];
                self.i += 1;
                match e {
                    b'"' => bytes.push(b'"'),
                    b'\\' => bytes.push(b'\\'),
                    b'/' => bytes.push(b'/'),
                    b'b' => bytes.push(0x08),
                    b'f' => bytes.push(0x0c),
                    b'n' => bytes.push(b'\n'),
                    b'r' => bytes.push(b'\r'),
                    b't' => bytes.push(b'\t'),
                    b'u' => {
                        if self.i + 4 > self.b.len() {
                            return Err("bad \\u escape".to_string());
                        }
                        let hex = std::str::from_utf8(&self.b[self.i..self.i + 4])
                            .map_err(|_| "bad \\u escape".to_string())?;
                        let cp = u32::from_str_radix(hex, 16)
                            .map_err(|_| "bad \\u escape".to_string())?;
                        self.i += 4;
                        let ch = char::from_u32(cp).unwrap_or('\u{FFFD}');
                        let mut buf = [0u8; 4];
                        bytes.extend_from_slice(ch.encode_utf8(&mut buf).as_bytes());
                    }
                    _ => return Err("bad escape".to_string()),
                }
            } else {
                bytes.push(c);
                self.i += 1;
            }
        }
        String::from_utf8(bytes).map_err(|e| e.to_string())
    }

    fn parse_arr(&mut self) -> Result<Json, String> {
        self.i += 1; // '['
        let mut out = Vec::new();
        self.skip_ws();
        if self.i < self.b.len() && self.b[self.i] == b']' {
            self.i += 1;
            return Ok(Json::Arr(out));
        }
        loop {
            let v = self.parse_value()?;
            out.push(v);
            self.skip_ws();
            if self.i >= self.b.len() {
                return Err("unterminated array".to_string());
            }
            match self.b[self.i] {
                b',' => {
                    self.i += 1;
                }
                b']' => {
                    self.i += 1;
                    break;
                }
                _ => return Err("bad array separator".to_string()),
            }
        }
        Ok(Json::Arr(out))
    }

    fn parse_obj(&mut self) -> Result<Json, String> {
        self.i += 1; // '{'
        let mut out: Vec<(String, Json)> = Vec::new();
        self.skip_ws();
        if self.i < self.b.len() && self.b[self.i] == b'}' {
            self.i += 1;
            return Ok(Json::Obj(out));
        }
        loop {
            self.skip_ws();
            if self.i >= self.b.len() || self.b[self.i] != b'"' {
                return Err("expected object key".to_string());
            }
            let key = self.parse_string()?;
            self.skip_ws();
            if self.i >= self.b.len() || self.b[self.i] != b':' {
                return Err("expected ':'".to_string());
            }
            self.i += 1;
            let v = self.parse_value()?;
            out.push((key, v));
            self.skip_ws();
            if self.i >= self.b.len() {
                return Err("unterminated object".to_string());
            }
            match self.b[self.i] {
                b',' => {
                    self.i += 1;
                }
                b'}' => {
                    self.i += 1;
                    break;
                }
                _ => return Err("bad object separator".to_string()),
            }
        }
        Ok(Json::Obj(out))
    }
}

/// 解析一段 JSON 文本（允许首尾空白）。
pub fn parse_json(text: &str) -> Result<Json, String> {
    let mut p = Parser::new(text.as_bytes());
    let v = p.parse_value()?;
    p.skip_ws();
    if p.i != p.b.len() {
        return Err("trailing data".to_string());
    }
    Ok(v)
}

fn fmt_float(v: f64) -> String {
    if !v.is_finite() {
        return "null".to_string();
    }
    if v == v.trunc() && v.abs() < 1e15 {
        format!("{:.1}", v) // 与 Python json.dumps(0.0) → "0.0" 对齐
    } else {
        format!("{}", v)
    }
}

fn write_json_string(out: &mut String, s: &str) {
    out.push('"');
    for ch in s.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0c}' => out.push_str("\\f"),
            c if (c as u32) < 0x20 => {
                out.push_str(&format!("\\u{:04x}", c as u32));
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

pub fn write_json(out: &mut String, j: &Json) {
    match j {
        Json::Null => out.push_str("null"),
        Json::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Json::Int(v) => out.push_str(&v.to_string()),
        Json::Float(v) => out.push_str(&fmt_float(*v)),
        Json::Str(s) => write_json_string(out, s),
        Json::Arr(a) => {
            out.push('[');
            for (i, x) in a.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_json(out, x);
            }
            out.push(']');
        }
        Json::Obj(o) => {
            out.push('{');
            for (i, (k, v)) in o.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_json_string(out, k);
                out.push(':');
                write_json(out, v);
            }
            out.push('}');
        }
    }
}

/// 紧凑序列化（无多余空白）。
pub fn to_json_string(j: &Json) -> String {
    let mut s = String::new();
    write_json(&mut s, j);
    s
}

// ===========================================================================
// 黄金值执行器
// ===========================================================================

pub struct GoldenResult {
    pub passed: i32,
    pub failed: i32,
    pub total: i32,
    pub failures: Vec<Json>,
}

/// 由 `setup` 构造棋盘（对照 golden.py `build_board`）。
pub fn build_board(setup: &Json) -> Result<Board, String> {
    let size = setup.get("size").and_then(|v| v.as_i64()).unwrap_or(9);
    if !(2..=19).contains(&size) {
        return Err("bad size".to_string());
    }
    let size = size as usize;

    let rules = match setup.get("rules") {
        None => profile("cn").unwrap(),
        Some(Json::Null) => profile("cn").unwrap(),
        Some(Json::Str(s)) => profile(s).ok_or_else(|| format!("unknown rules profile: {:?}", s))?,
        Some(Json::Obj(_)) => {
            let rj = setup.get("rules").unwrap();
            let ko = rj.get("ko").and_then(|v| v.as_str());
            let sui = rj.get("suicide").and_then(|v| v.as_str());
            let sco = rj.get("scoring").and_then(|v| v.as_str());
            let km = rj.get("komi").and_then(|v| v.as_f64());
            rules_from_parts(ko, sui, sco, km)?
        }
        Some(_) => return Err("bad rules".to_string()),
    };
    let komi = setup.get("komi").and_then(|v| v.as_f64());
    let mut b = Board::new(size, komi, rules);

    if let Some(st) = setup.get("stones") {
        if !st.is_null() {
            let arr = st.as_arr().ok_or("bad stones")?;
            let mut pairs: Vec<(u8, isize)> = Vec::with_capacity(arr.len());
            for it in arr {
                let a = it.as_arr().ok_or("bad stone")?;
                if a.len() < 2 {
                    return Err("bad stone".to_string());
                }
                let color = parse_color(a[0].as_str().ok_or("bad stone color")?)?;
                let vs = a[1].as_str().ok_or("bad stone vertex")?;
                let v = parse_vertex(vs, size).map_err(|e| e.to_string())?;
                pairs.push((color, v));
            }
            let side = match setup.get("side") {
                None => 1,
                Some(Json::Null) => 1,
                Some(s) => parse_color(s.as_str().ok_or("bad side")?)?,
            };
            b.set_stones(&pairs, side);
            if let Some(kp) = setup.get("ko_point") {
                if !kp.is_null() {
                    b.ko_point = match kp {
                        Json::Str(s) => parse_vertex(s, size).map_err(|e| e.to_string())?,
                        Json::Int(n) => *n as isize,
                        _ => return Err("bad ko_point".to_string()),
                    };
                }
            }
        }
    }

    if let Some(mv) = setup.get("moves") {
        if let Some(arr) = mv.as_arr() {
            if !arr.is_empty() {
                for it in arr {
                    let a = it.as_arr().ok_or("bad move")?;
                    if a.len() < 2 {
                        return Err("bad move".to_string());
                    }
                    let color = parse_color(a[0].as_str().ok_or("bad move color")?)?;
                    let v = parse_vertex(a[1].as_str().ok_or("bad move vertex")?, size)
                        .map_err(|e| e.to_string())?;
                    let r = b.play(color, v);
                    if !r.ok {
                        return Err(format!(
                            "setup move illegal: {} {} ({})",
                            a[0].as_str().unwrap_or("?"),
                            a[1].as_str().unwrap_or("?"),
                            r.reason.unwrap_or("?")
                        ));
                    }
                }
            }
        }
    }
    Ok(b)
}

fn parse_dead(args: &Json, size: usize) -> Result<Vec<(u8, isize)>, String> {
    let mut out = Vec::new();
    if let Some(d) = args.get("dead") {
        if !d.is_null() {
            for it in d.as_arr().ok_or("bad dead")? {
                let a = it.as_arr().ok_or("bad dead item")?;
                if a.len() < 2 {
                    return Err("bad dead item".to_string());
                }
                let color = parse_color(a[0].as_str().ok_or("bad dead color")?)?;
                let v = parse_vertex(a[1].as_str().ok_or("bad dead vertex")?, size)
                    .map_err(|e| e.to_string())?;
                out.push((color, v));
            }
        }
    }
    Ok(out)
}

/// 执行单条黄金值用例（对照 golden.py `run_case`）。
pub fn run_case(case: &Json) -> Result<Json, String> {
    let setup = match case.get("setup") {
        Some(s) => s.clone(),
        None => Json::Null,
    };
    let mut b = build_board(&setup)?;
    let op = case.get("op").and_then(|v| v.as_str()).ok_or("no op")?;
    let args = case.get("args").cloned().unwrap_or(Json::Null);
    let size = b.size;

    match op {
        "key" => {
            let (pk, sk) = b.key();
            Ok(jobj(vec![
                ("key", jstr(&fmt_key(pk))),
                ("situational", jstr(&fmt_key(sk))),
            ]))
        }
        "legal" => {
            let color = parse_color(args.get("color").and_then(|v| v.as_str()).unwrap_or("B"))?;
            let vs = args.get("vertex").and_then(|v| v.as_str()).ok_or("bad args")?;
            let v = parse_vertex(vs, size).map_err(|e| e.to_string())?;
            let (ok, reason) = b.legal(color, v);
            if ok {
                Ok(jobj(vec![("legal", Json::Bool(true))]))
            } else {
                Ok(jobj(vec![
                    ("legal", Json::Bool(false)),
                    ("reason", jstr(reason.unwrap_or("?"))),
                ]))
            }
        }
        "legal_moves" => {
            let ms = b.legal_moves();
            let moves: Vec<Json> = ms.iter().map(|&p| jstr(&format_vertex(p as isize, size))).collect();
            Ok(jobj(vec![
                ("count", jint(ms.len() as i64)),
                ("moves", Json::Arr(moves)),
            ]))
        }
        "play" => {
            let color = parse_color(args.get("color").and_then(|v| v.as_str()).ok_or("bad args")?)?;
            let vs = args.get("vertex").and_then(|v| v.as_str()).ok_or("bad args")?;
            let v = parse_vertex(vs, size).map_err(|e| e.to_string())?;
            let r = b.play(color, v);
            if !r.ok {
                Ok(jobj(vec![
                    ("ok", Json::Bool(false)),
                    ("reason", jstr(r.reason.unwrap_or("?"))),
                ]))
            } else {
                Ok(jobj(vec![
                    ("ok", Json::Bool(true)),
                    ("captures", jint(r.captures as i64)),
                    ("self_captured", jint(r.self_captured as i64)),
                ]))
            }
        }
        "undo" => {
            let n = args.get("n").and_then(|v| v.as_i64()).unwrap_or(1);
            let mut ok = true;
            for _ in 0..n {
                if !b.undo() {
                    ok = false;
                }
            }
            Ok(jobj(vec![("ok", Json::Bool(ok))]))
        }
        "score" => {
            let dead = parse_dead(&args, size)?;
            let sc = b.score(if dead.is_empty() { None } else { Some(&dead) });
            Ok(jobj(vec![
                ("black", jint(sc.black as i64)),
                ("white", jint(sc.white as i64)),
                ("dame", jint(sc.dame as i64)),
                ("result", jstr(&sc.result)),
            ]))
        }
        "prisoners" => {
            let (bl, wh) = b.prisoners();
            Ok(jobj(vec![
                ("black", jint(bl as i64)),
                ("white", jint(wh as i64)),
            ]))
        }
        "over" => Ok(jobj(vec![("over", Json::Bool(b.is_over()))])),
        other => Err(format!("unknown op: {}", other)),
    }
}

/// 比对 expect（对照 golden.py `compare`）。
pub fn compare(expect: &Json, got: &Json, miss: &mut Vec<Json>) {
    if let Json::Obj(o) = expect {
        for (k, v) in o {
            let gv = got.get(k);
            match gv {
                None => miss.push(Json::Arr(vec![jstr(k), v.clone(), Json::Null])),
                Some(g) => {
                    let is_float = matches!(v, Json::Float(_)) || matches!(g, Json::Float(_));
                    if is_float {
                        let a = v.as_f64();
                        let bq = g.as_f64();
                        let ok = match (a, bq) {
                            (Some(x), Some(y)) => (x - y).abs() <= 1e-9,
                            _ => false,
                        };
                        if !ok {
                            miss.push(Json::Arr(vec![jstr(k), v.clone(), g.clone()]));
                        }
                    } else if v != g {
                        miss.push(Json::Arr(vec![jstr(k), v.clone(), g.clone()]));
                    }
                }
            }
        }
    }
}

pub fn run_golden(path: &str) -> Result<GoldenResult, String> {
    let text = fs::read_to_string(path).map_err(|e| format!("cannot read {}: {}", path, e))?;
    let data = parse_json(&text)?;
    let cases = data
        .get("cases")
        .and_then(|c| c.as_arr())
        .ok_or("no cases in golden file")?
        .clone();
    let mut passed = 0i32;
    let mut failed = 0i32;
    let mut failures: Vec<Json> = Vec::new();
    for case in &cases {
        let id = case.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
        match run_case(case) {
            Ok(got) => {
                let expect = case.get("expect").cloned().unwrap_or(Json::Obj(vec![]));
                let mut miss: Vec<Json> = Vec::new();
                compare(&expect, &got, &mut miss);
                if miss.is_empty() {
                    passed += 1;
                } else {
                    failed += 1;
                    failures.push(jobj(vec![
                        ("id", jstr(&id)),
                        ("got", got),
                        ("expect", expect),
                        ("miss", Json::Arr(miss)),
                    ]));
                }
            }
            Err(e) => {
                failed += 1;
                failures.push(jobj(vec![("id", jstr(&id)), ("error", jstr(&e))]));
            }
        }
    }
    Ok(GoldenResult {
        passed,
        failed,
        total: passed + failed,
        failures,
    })
}

/// 默认黄金值路径：从可执行文件目录 / 当前目录逐级向上找 `spec/golden.json`。
pub fn default_golden_path() -> Option<String> {
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Ok(exe) = env::current_exe() {
        if let Some(dir) = exe.parent() {
            roots.push(dir.to_path_buf());
        }
    }
    if let Ok(cwd) = env::current_dir() {
        roots.push(cwd);
    }
    for root in roots {
        let mut cur: Option<&std::path::Path> = Some(root.as_path());
        while let Some(dir) = cur {
            let candidate = dir.join("spec").join("golden.json");
            if candidate.is_file() {
                return Some(candidate.to_string_lossy().to_string());
            }
            cur = dir.parent();
        }
    }
    None
}
