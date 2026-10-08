//! driver.rs — JSON-stdio 驱动（docs/PROTOCOL_SPEC.md, protocol-v1）
//!
//! 对照 PyWeiqi/driver.py。引擎启动后先输出 ready 事件，再进入请求-响应循环；
//! 单条响应必须在下一请求前完整输出（同步语义）。所有输出为紧凑 UTF-8 JSON。

use crate::ai::{self, Move, Profile};
use crate::golden::{default_golden_path, parse_json, to_json_string, Json};
use crate::rules::{
    color_name, fmt_key, format_vertex, parse_color, parse_vertex, profile, rules_from_parts,
    Board,
};

use std::io::{BufRead, Write};

pub const NAME: &str = "RustWeiqi";
pub const LANG: &str = "rs";
pub const VERSION: &str = "v1";
pub const PROTOCOL: i64 = 1;

struct CmdError {
    msg: String,
    reason: Option<String>,
}

impl CmdError {
    fn new(msg: &str) -> CmdError {
        CmdError {
            msg: msg.to_string(),
            reason: None,
        }
    }
    fn with(msg: &str, reason: &str) -> CmdError {
        CmdError {
            msg: msg.to_string(),
            reason: Some(reason.to_string()),
        }
    }
}

fn bad_args() -> CmdError {
    CmdError::new("bad args")
}

fn j(s: &str) -> Json {
    Json::Str(s.to_string())
}
fn ji(v: i64) -> Json {
    Json::Int(v)
}
fn jf(v: f64) -> Json {
    Json::Float(v)
}
fn jb(v: bool) -> Json {
    Json::Bool(v)
}
fn jo(items: Vec<(&str, Json)>) -> Json {
    Json::Obj(items.into_iter().map(|(k, v)| (k.to_string(), v)).collect())
}

fn build_profile(jv: Option<&Json>) -> Profile {
    let mut p = Profile::default();
    if let Some(Json::Obj(o)) = jv {
        for (k, v) in o {
            if v.is_null() {
                continue;
            }
            match k.as_str() {
                "c" => {
                    if let Some(x) = v.as_f64() {
                        p.c = x;
                    }
                }
                "rave" => {
                    if let Some(x) = v.as_bool() {
                        p.rave = x;
                    }
                }
                "rave_k" => {
                    if let Some(x) = v.as_f64() {
                        p.rave_k = x;
                    }
                }
                "capture_bias" => {
                    if let Some(x) = v.as_f64() {
                        p.capture_bias = x;
                    }
                }
                "pattern_bias" => {
                    if let Some(x) = v.as_f64() {
                        p.pattern_bias = x;
                    }
                }
                "prune_radius" => {
                    if let Some(x) = v.as_i64() {
                        p.prune_radius = x as i32;
                    }
                }
                "pass_bias" => {
                    if let Some(x) = v.as_f64() {
                        p.pass_bias = x;
                    }
                }
                "resign_threshold" => {
                    if let Some(x) = v.as_f64() {
                        p.resign_threshold = x;
                    }
                }
                "resign_min_visits" => {
                    if let Some(x) = v.as_i64() {
                        p.resign_min_visits = x as i32;
                    }
                }
                "mercy" => {
                    if let Some(x) = v.as_f64() {
                        p.mercy = x;
                    }
                }
                "pass_threshold" => {
                    if let Some(x) = v.as_f64() {
                        p.pass_threshold = x;
                    }
                }
                "score_scale" => {
                    if let Some(x) = v.as_f64() {
                        p.score_scale = x;
                    }
                }
                _ => {}
            }
        }
    }
    p
}

/// rules 参数（档名或对象）→ 规则。
fn parse_rules(jv: Option<&Json>) -> Result<crate::rules::Rules, CmdError> {
    match jv {
        None | Some(Json::Null) => Ok(profile("cn").unwrap()),
        Some(Json::Str(s)) => profile(s).ok_or_else(|| CmdError::new("bad rules")),
        Some(Json::Obj(_)) => {
            let obj = jv.unwrap();
            let ko = obj.get("ko").and_then(|v| v.as_str());
            let sui = obj.get("suicide").and_then(|v| v.as_str());
            let sco = obj.get("scoring").and_then(|v| v.as_str());
            let km = obj.get("komi").and_then(|v| v.as_f64());
            rules_from_parts(ko, sui, sco, km).map_err(|e| CmdError::new(&e))
        }
        Some(_) => Err(CmdError::new("bad rules")),
    }
}

pub struct Driver {
    board: Board,
}

impl Driver {
    pub fn new() -> Driver {
        Driver {
            board: Board::new(9, None, profile("cn").unwrap()),
        }
    }

    fn dispatch(&mut self, req: &Json) -> Result<Json, CmdError> {
        let cmd = req
            .get("cmd")
            .and_then(|v| v.as_str())
            .ok_or_else(bad_args)?;
        match cmd {
            "hello" => Ok(self.cmd_hello()),
            "clear" => self.cmd_clear(req),
            "set_stones" => self.cmd_set_stones(req),
            "play" => self.cmd_play(req),
            "undo" => self.cmd_undo(),
            "key" => self.cmd_key(),
            "legal" => self.cmd_legal(req),
            "legal_moves" => self.cmd_legal_moves(),
            "genmove" => self.cmd_genmove(req),
            "score" => self.cmd_score(req),
            "prisoners" => self.cmd_prisoners(),
            "selftest" => self.cmd_selftest(req),
            _ => Err(CmdError::new("unknown command")),
        }
    }

    fn cmd_hello(&self) -> Json {
        jo(vec![
            ("name", j(NAME)),
            ("version", j(VERSION)),
            ("lang", j(LANG)),
            ("protocol", ji(PROTOCOL)),
        ])
    }

    fn cmd_clear(&mut self, req: &Json) -> Result<Json, CmdError> {
        let size = req.get("size").and_then(|v| v.as_i64()).unwrap_or(9);
        if !(2..=19).contains(&size) {
            return Err(CmdError::new("bad size"));
        }
        let rules = parse_rules(req.get("rules"))?;
        let komi = req.get("komi").and_then(|v| v.as_f64());
        self.board = Board::new(size as usize, komi, rules);
        Ok(jo(vec![
            ("size", ji(size)),
            ("komi", jf(self.board.komi)),
            (
                "rules",
                jo(vec![
                    ("ko", j(rules.ko.as_str())),
                    ("suicide", j(rules.suicide.as_str())),
                    ("scoring", j(rules.scoring.as_str())),
                ]),
            ),
        ]))
    }

    fn cmd_set_stones(&mut self, req: &Json) -> Result<Json, CmdError> {
        let side = match req.get("side").and_then(|v| v.as_str()) {
            Some(s) => parse_color(s).map_err(|_| bad_args())?,
            None => 1,
        };
        let mut pairs: Vec<(u8, isize)> = Vec::new();
        if let Some(arr) = req.get("stones").and_then(|v| v.as_arr()) {
            for it in arr {
                let a = it.as_arr().ok_or_else(bad_args)?;
                if a.len() < 2 {
                    return Err(bad_args());
                }
                let c = parse_color(a[0].as_str().ok_or_else(bad_args)?)
                    .map_err(|_| bad_args())?;
                let v = match &a[1] {
                    Json::Str(s) => parse_vertex(s, self.board.size)
                        .map_err(|e| CmdError::with(e, e))?,
                    Json::Int(n) => *n as isize,
                    _ => return Err(bad_args()),
                };
                pairs.push((c, v));
            }
        }
        self.board.set_stones(&pairs, side);
        Ok(jo(vec![("stones", ji(pairs.len() as i64))]))
    }

    fn cmd_play(&mut self, req: &Json) -> Result<Json, CmdError> {
        let color = match req.get("color").and_then(|v| v.as_str()) {
            Some(s) => parse_color(s).map_err(|_| bad_args())?,
            None => parse_color(color_name(self.board.side)).unwrap(),
        };
        let vj = req.get("vertex").ok_or_else(bad_args)?;
        let vertex = match vj {
            Json::Str(s) => {
                parse_vertex(s, self.board.size).map_err(|e| CmdError::with(e, e))?
            }
            Json::Int(n) => *n as isize,
            _ => return Err(bad_args()),
        };
        let r = self.board.play(color, vertex);
        if !r.ok {
            return Err(CmdError::with("illegal move", r.reason.unwrap_or("?")));
        }
        Ok(jo(vec![
            ("captures", ji(r.captures as i64)),
            ("self_captured", ji(r.self_captured as i64)),
            ("key", j(&fmt_key(r.key))),
        ]))
    }

    fn cmd_undo(&mut self) -> Result<Json, CmdError> {
        if !self.board.undo() {
            return Err(CmdError::new("nothing to undo"));
        }
        Ok(jo(vec![("moves", ji(self.board.stack.len() as i64))]))
    }

    fn cmd_key(&self) -> Result<Json, CmdError> {
        let (pk, sk) = self.board.key();
        Ok(jo(vec![
            ("key", j(&fmt_key(pk))),
            ("situational", j(&fmt_key(sk))),
        ]))
    }

    fn cmd_legal(&self, req: &Json) -> Result<Json, CmdError> {
        let color = match req.get("color").and_then(|v| v.as_str()) {
            Some(s) => parse_color(s).map_err(|_| bad_args())?,
            None => parse_color(color_name(self.board.side)).unwrap(),
        };
        let vj = req.get("vertex").ok_or_else(bad_args)?;
        let vertex = match vj {
            Json::Str(s) => {
                parse_vertex(s, self.board.size).map_err(|e| CmdError::with(e, e))?
            }
            Json::Int(n) => *n as isize,
            _ => return Err(bad_args()),
        };
        let (ok, reason) = self.board.legal(color, vertex);
        if ok {
            Ok(jo(vec![("legal", jb(true))]))
        } else {
            Ok(jo(vec![
                ("legal", jb(false)),
                ("reason", j(reason.unwrap_or("?"))),
            ]))
        }
    }

    fn cmd_legal_moves(&self) -> Result<Json, CmdError> {
        let ms = self.board.legal_moves();
        let moves: Vec<Json> = ms
            .iter()
            .map(|&p| j(&format_vertex(p as isize, self.board.size)))
            .collect();
        Ok(jo(vec![
            ("count", ji(ms.len() as i64)),
            ("moves", Json::Arr(moves)),
        ]))
    }

    fn cmd_genmove(&mut self, req: &Json) -> Result<Json, CmdError> {
        let color = match req.get("color").and_then(|v| v.as_str()) {
            Some(s) => parse_color(s).map_err(|_| bad_args())?,
            None => parse_color(color_name(self.board.side)).unwrap(),
        };
        let playouts = req.get("playouts").and_then(|v| v.as_i64()).unwrap_or(500) as i32;
        let seed = req.get("seed").and_then(|v| v.as_i64()).unwrap_or(0);
        let pr = build_profile(req.get("profile"));
        if color != self.board.side {
            return Err(CmdError::with("genmove for wrong side", "turn"));
        }
        let g = ai::genmove(&self.board, playouts, seed, &pr);
        if g.mv == Move::Resign {
            return Ok(jo(vec![
                ("vertex", j("resign")),
                ("visits", ji(g.visits as i64)),
                ("winrate", jf(g.winrate)),
            ]));
        }
        let mv_idx: isize = match g.mv {
            Move::Point(p) => p as isize,
            Move::Pass => -1,
            Move::Resign => -2,
        };
        let vertex = if mv_idx == -1 {
            "pass".to_string()
        } else {
            format_vertex(mv_idx, self.board.size)
        };
        let r = self.board.play(color, mv_idx);
        if !r.ok {
            return Err(CmdError::with(
                "internal: chosen move illegal",
                r.reason.unwrap_or("?"),
            ));
        }
        Ok(jo(vec![
            ("vertex", j(&vertex)),
            ("visits", ji(g.visits as i64)),
            ("winrate", jf(g.winrate)),
        ]))
    }

    fn cmd_score(&mut self, req: &Json) -> Result<Json, CmdError> {
        let dead = rep_dead(req.get("dead"), self.board.size)?;
        let sc = self.board.score(if dead.is_empty() { None } else { Some(&dead) });
        Ok(jo(vec![
            ("black", ji(sc.black as i64)),
            ("white", ji(sc.white as i64)),
            ("komi", jf(sc.komi)),
            ("dame", ji(sc.dame as i64)),
            ("result", j(&sc.result)),
            ("black_territory", ji(sc.black_territory as i64)),
            ("white_territory", ji(sc.white_territory as i64)),
            ("black_stones", ji(sc.black_stones as i64)),
            ("white_stones", ji(sc.white_stones as i64)),
            ("prisoners_black", ji(sc.prisoners_black as i64)),
            ("prisoners_white", ji(sc.prisoners_white as i64)),
        ]))
    }

    fn cmd_prisoners(&self) -> Result<Json, CmdError> {
        let (bl, wh) = self.board.prisoners();
        Ok(jo(vec![("black", ji(bl as i64)), ("white", ji(wh as i64))]))
    }

    fn cmd_selftest(&self, req: &Json) -> Result<Json, CmdError> {
        let path = match req.get("golden").and_then(|v| v.as_str()) {
            Some(s) => Some(s.to_string()),
            None => default_golden_path(),
        }
        .ok_or_else(|| CmdError::new("golden path not found"))?;
        let r = crate::golden::run_golden(&path).map_err(|e| CmdError::new(&e))?;
        Ok(jo(vec![
            ("passed", ji(r.passed as i64)),
            ("failed", ji(r.failed as i64)),
            ("total", ji(r.total as i64)),
            ("failures", Json::Arr(r.failures)),
        ]))
    }
}

/// 按棋盘尺寸解析死子列表。
fn rep_dead(jv: Option<&Json>, size: usize) -> Result<Vec<(u8, isize)>, CmdError> {
    let mut out = Vec::new();
    if let Some(Json::Arr(a)) = jv {
        for it in a {
            let pair = it.as_arr().ok_or_else(bad_args)?;
            if pair.len() < 2 {
                return Err(bad_args());
            }
            let c = parse_color(pair[0].as_str().ok_or_else(bad_args)?)
                .map_err(|_| bad_args())?;
            let v = parse_vertex(pair[1].as_str().ok_or_else(bad_args)?, size)
                .map_err(|e| CmdError::with(e, e))?;
            out.push((c, v));
        }
    }
    Ok(out)
}

fn ok_resp(id: &Json, res: Json) -> Json {
    jo(vec![("id", id.clone()), ("ok", jb(true)), ("result", res)])
}

fn err_resp(id: &Json, e: &CmdError) -> Json {
    let mut items: Vec<(&str, Json)> = vec![
        ("id", id.clone()),
        ("ok", jb(false)),
        ("error", j(&e.msg)),
    ];
    if let Some(r) = &e.reason {
        items.push(("reason", j(r)));
    }
    jo(items)
}

pub fn run_driver() -> i32 {
    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    let mut out = stdout.lock();

    // ready 事件（协议 §1）
    let ready = jo(vec![
        ("event", j("ready")),
        ("protocol", ji(PROTOCOL)),
        ("name", j(NAME)),
        ("lang", j(LANG)),
        ("version", j(VERSION)),
    ]);
    let _ = writeln!(out, "{}", to_json_string(&ready));
    let _ = out.flush();

    let mut drv = Driver::new();
    let lock = stdin.lock();
    for line in lock.lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => break,
        };
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let req = match parse_json(line) {
            Ok(v) => v,
            Err(e) => {
                let resp = err_resp(&Json::Null, &CmdError::new(&format!("bad json: {}", e)));
                let _ = writeln!(out, "{}", to_json_string(&resp));
                let _ = out.flush();
                continue;
            }
        };
        let id = req.get("id").cloned().unwrap_or(Json::Null);
        if req.get("cmd").and_then(|v| v.as_str()) == Some("quit") {
            let resp = ok_resp(&id, Json::Obj(Vec::new()));
            let _ = writeln!(out, "{}", to_json_string(&resp));
            let _ = out.flush();
            return 0;
        }
        let resp = match drv.dispatch(&req) {
            Ok(res) => ok_resp(&id, res),
            Err(e) => err_resp(&id, &e),
        };
        let _ = writeln!(out, "{}", to_json_string(&resp));
        let _ = out.flush();
    }
    0
}
