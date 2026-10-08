//! rules.rs — 围棋规则核心（Rust 移植）
//!
//! 规范来源：docs/RULES_SPEC.md（spec-v1）；参考实现：PyWeiqi/weiqi_rules.py。
//! 本模块在【规则操作】上与 Python 参考实现逐位一致：
//! 坐标、走子/提子/自杀、三档禁全同、Zobrist 键、两套计分、结果串格式。
//!
//! 注意：64 位算术全程使用 `wrapping_add` / `wrapping_mul`（溢出即 mod 2^64）。

use std::collections::HashMap;
use std::rc::Rc;

/// 列字母：跳过 I，共 19 个（RULES_SPEC §1）。
pub const COLS: &str = "ABCDEFGHJKLMNOPQRST";
/// Zobrist 表固定按 361 点生成，与棋盘尺寸无关（RULES_SPEC §6）。
pub const MAX_POINTS: usize = 361;

/// splitmix64（严格按 RULES_SPEC §6，全程无符号 64 位）。
#[inline]
pub const fn splitmix64(x: u64) -> u64 {
    let mut z = x.wrapping_add(0x9E37_79B9_7F4A_7C15);
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}

const fn build_zb() -> [[u64; MAX_POINTS]; 3] {
    let mut t = [[0u64; MAX_POINTS]; 3];
    let mut c = 1usize;
    while c <= 2 {
        let mut p = 0usize;
        while p < MAX_POINTS {
            t[c][p] = splitmix64(((c as u64 - 1) * 1024) + p as u64);
            p += 1;
        }
        c += 1;
    }
    t
}

/// ZB[c][p] = splitmix64((c-1)*1024 + p)，c∈{1,2}，p∈[0,361)。
pub static ZB: [[u64; MAX_POINTS]; 3] = build_zb();
/// SIDEKEY_W = splitmix64(4096)。
pub static SIDEKEY_W: u64 = splitmix64(4096);

/// 取 Zobrist 值（颜色 1=黑 / 2=白）。
#[inline]
pub fn zb(color: u8, p: usize) -> u64 {
    ZB[color as usize][p]
}

/// 键输出格式：`0x` + 16 位小写十六进制（RULES_SPEC §6）。
pub fn fmt_key(k: u64) -> String {
    format!("0x{:016x}", k)
}

/// 数值格式：整数不带小数点，否则按 0.25 步长（.25/.5/.75）。
pub fn fmt_num(v: f64) -> String {
    let q = (v * 4.0).round() as i64;
    let a = q.abs();
    let whole = a / 4;
    let rem = a % 4;
    let suf = match rem {
        0 => "",
        1 => ".25",
        2 => ".5",
        _ => ".75",
    };
    let s = format!("{}{}", whole, suf);
    if q < 0 {
        format!("-{}", s)
    } else {
        s
    }
}

// ---------------------------------------------------------------------------
// 规则配置
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Ko {
    Simple,
    Positional,
    Situational,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Suicide {
    Forbid,
    Allow,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Scoring {
    Area,
    Territory,
}

impl Ko {
    pub fn as_str(self) -> &'static str {
        match self {
            Ko::Simple => "simple",
            Ko::Positional => "positional",
            Ko::Situational => "situational",
        }
    }
    pub fn parse(s: &str) -> Result<Ko, String> {
        match s.trim().to_ascii_lowercase().as_str() {
            "simple" => Ok(Ko::Simple),
            "positional" => Ok(Ko::Positional),
            "situational" => Ok(Ko::Situational),
            other => Err(format!("bad ko: {:?}", other)),
        }
    }
}

impl Suicide {
    pub fn as_str(self) -> &'static str {
        match self {
            Suicide::Forbid => "forbid",
            Suicide::Allow => "allow",
        }
    }
    pub fn parse(s: &str) -> Result<Suicide, String> {
        match s.trim().to_ascii_lowercase().as_str() {
            "forbid" => Ok(Suicide::Forbid),
            "allow" => Ok(Suicide::Allow),
            other => Err(format!("bad suicide: {:?}", other)),
        }
    }
}

impl Scoring {
    pub fn as_str(self) -> &'static str {
        match self {
            Scoring::Area => "area",
            Scoring::Territory => "territory",
        }
    }
    pub fn parse(s: &str) -> Result<Scoring, String> {
        match s.trim().to_ascii_lowercase().as_str() {
            "area" => Ok(Scoring::Area),
            "territory" => Ok(Scoring::Territory),
            other => Err(format!("bad scoring: {:?}", other)),
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Rules {
    pub ko: Ko,
    pub suicide: Suicide,
    pub scoring: Scoring,
    pub komi: f64,
}

/// 档名 → 规则（RULES_SPEC §10）。未知档返回 None。
pub fn profile(name: &str) -> Option<Rules> {
    match name.trim().to_ascii_lowercase().as_str() {
        "cn" => Some(Rules {
            ko: Ko::Positional,
            suicide: Suicide::Forbid,
            scoring: Scoring::Area,
            komi: 7.5,
        }),
        "tt" => Some(Rules {
            ko: Ko::Positional,
            suicide: Suicide::Allow,
            scoring: Scoring::Area,
            komi: 7.5,
        }),
        "jp" => Some(Rules {
            ko: Ko::Simple,
            suicide: Suicide::Forbid,
            scoring: Scoring::Territory,
            komi: 6.5,
        }),
        _ => None,
    }
}

/// 由三个可选字符串 + 可选 komi 归一化出规则（未指定项取 cn 档默认）。
/// 对应 Python `normalize_rules` 的对象分支。
pub fn rules_from_parts(
    ko: Option<&str>,
    suicide: Option<&str>,
    scoring: Option<&str>,
    komi: Option<f64>,
) -> Result<Rules, String> {
    let mut out = profile("cn").unwrap();
    if let Some(v) = ko {
        out.ko = Ko::parse(v)?;
    }
    if let Some(v) = suicide {
        out.suicide = Suicide::parse(v)?;
    }
    if let Some(v) = scoring {
        out.scoring = Scoring::parse(v)?;
    }
    if let Some(v) = komi {
        out.komi = v;
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// 坐标
// ---------------------------------------------------------------------------

/// 顶点串 → 点索引；"pass" → -1；非法 → Err(reason)。
pub fn parse_vertex(s: &str, size: usize) -> Result<isize, &'static str> {
    let t = s.trim().to_ascii_uppercase();
    if t == "PASS" {
        return Ok(-1);
    }
    let bytes = t.as_bytes();
    if bytes.len() < 2 {
        return Err("range");
    }
    let first = bytes[0] as char;
    let col = match COLS.find(first) {
        Some(c) => c,
        None => return Err("range"),
    };
    if col >= size {
        return Err("range");
    }
    let row: i64 = match t[1..].parse::<i64>() {
        Ok(r) => r,
        Err(_) => return Err("range"),
    };
    if row < 1 || row > size as i64 {
        return Err("range");
    }
    Ok(((row - 1) as isize) * size as isize + col as isize)
}

/// 点索引 → 顶点串；负值 → "pass"。
pub fn format_vertex(idx: isize, size: usize) -> String {
    if idx < 0 {
        return "pass".to_string();
    }
    let i = idx as usize;
    let col = COLS.as_bytes()[i % size] as char;
    format!("{}{}", col, i / size + 1)
}

pub fn parse_color(s: &str) -> Result<u8, String> {
    match s.trim().to_ascii_uppercase().as_str() {
        "B" | "BLACK" | "1" => Ok(1),
        "W" | "WHITE" | "2" => Ok(2),
        other => Err(format!("bad color: {:?}", other)),
    }
}

pub fn color_name(c: u8) -> &'static str {
    if c == 1 {
        "B"
    } else {
        "W"
    }
}

/// 邻点表（4 邻域，顺序：左、右、下、上，与 Python 一致）。
pub fn neighbors_of(size: usize) -> Vec<Vec<usize>> {
    let mut n = Vec::with_capacity(size * size);
    for y in 0..size {
        for x in 0..size {
            let mut l = Vec::with_capacity(4);
            if x > 0 {
                l.push(y * size + x - 1);
            }
            if x + 1 < size {
                l.push(y * size + x + 1);
            }
            if y > 0 {
                l.push((y - 1) * size + x);
            }
            if y + 1 < size {
                l.push((y + 1) * size + x);
            }
            n.push(l);
        }
    }
    n
}

// ---------------------------------------------------------------------------
// 走子记录（用于 undo）
// ---------------------------------------------------------------------------

#[derive(Clone, Debug)]
pub enum Rec {
    Pass {
        prev_key: u64,
        prev_side: u8,
        prev_ko: isize,
        prev_passes: i32,
        sit_key: Option<(u64, u8)>,
    },
    Move {
        color: u8,
        prev_cells: Vec<u8>,
        prev_key: u64,
        prev_side: u8,
        prev_ko: isize,
        prev_passes: i32,
        prev_cap: i32,
        pos_key: u64,
        sit_key: (u64, u8),
    },
}

#[derive(Clone, Debug)]
pub struct PlayResult {
    pub ok: bool,
    pub reason: Option<&'static str>,
    pub captures: i32,
    pub self_captured: i32,
    pub key: u64,
}

#[derive(Clone, Debug)]
pub struct Score {
    pub black: i32,
    pub white: i32,
    pub komi: f64,
    pub dame: i32,
    pub result: String,
    pub black_territory: i32,
    pub white_territory: i32,
    pub black_stones: i32,
    pub white_stones: i32,
    pub prisoners_black: i32,
    pub prisoners_white: i32,
}

// ---------------------------------------------------------------------------
// 棋盘
// ---------------------------------------------------------------------------

#[derive(Clone)]
pub struct Board {
    pub size: usize,
    pub n2: usize,
    pub neigh: Rc<Vec<Vec<usize>>>,
    pub rules: Rules,
    pub komi: f64,
    pub cells: Vec<u8>,
    pub side: u8,
    pub ko_point: isize,
    pub passes: i32,
    pub pos_key: u64,
    pub captures: [i32; 3], // captures[1] = 黑方提子数；captures[2] = 白方提子数
    pub over: bool,
    pub stack: Vec<Rc<Rec>>,
    pub hist_pos: HashMap<u64, i32>,
    pub hist_sit: HashMap<(u64, u8), i32>,
}

impl Board {
    pub fn new(size: usize, komi: Option<f64>, rules: Rules) -> Board {
        let n2 = size * size;
        let mut b = Board {
            size,
            n2,
            neigh: Rc::new(neighbors_of(size)),
            rules,
            komi: komi.unwrap_or(rules.komi),
            cells: vec![0u8; n2],
            side: 1,
            ko_point: -1,
            passes: 0,
            pos_key: 0,
            captures: [0; 3],
            over: false,
            stack: Vec::new(),
            hist_pos: HashMap::new(),
            hist_sit: HashMap::new(),
        };
        b.reset();
        b
    }

    pub fn reset(&mut self) {
        for c in self.cells.iter_mut() {
            *c = 0;
        }
        self.side = 1;
        self.ko_point = -1;
        self.passes = 0;
        self.pos_key = 0;
        self.captures = [0; 3];
        self.over = false;
        self.stack.clear();
        self.hist_pos.clear();
        self.hist_sit.clear();
        self.hist_pos.insert(0, 1);
        self.hist_sit.insert((0, 1), 1);
    }

    /// 直接摆子（不校验合法性），历史重置为单条记录（RULES_SPEC §11）。
    pub fn set_stones(&mut self, stones: &[(u8, isize)], side: u8) {
        self.reset();
        for &(color, vertex) in stones {
            if vertex >= 0 && (vertex as usize) < self.n2 {
                let v = vertex as usize;
                self.cells[v] = color;
                self.pos_key ^= zb(color, v);
            }
        }
        self.side = side;
        self.hist_pos.clear();
        self.hist_pos.insert(self.pos_key, 1);
        self.hist_sit.clear();
        self.hist_sit.insert((self.pos_key, side), 1);
    }

    /// → (posKey, sitKey)
    pub fn key(&self) -> (u64, u64) {
        let sit = self.pos_key
            ^ (if self.side == 2 { SIDEKEY_W } else { 0 });
        (self.pos_key, sit)
    }

    pub fn is_over(&self) -> bool {
        self.over
    }

    // ---------- 棋块 ----------

    /// → (members, libs)。libs 为去重后的空点索引。
    pub fn group(&self, idx: usize) -> (Vec<usize>, Vec<usize>) {
        self.group_in(idx, &self.cells)
    }

    fn group_in(&self, idx: usize, cells: &[u8]) -> (Vec<usize>, Vec<usize>) {
        let color = cells[idx];
        let n2 = self.n2;
        let mut seen = vec![false; n2];
        let mut libseen = vec![false; n2];
        let mut stack = vec![idx];
        seen[idx] = true;
        let mut members = vec![idx];
        let mut libs: Vec<usize> = Vec::new();
        while let Some(cur) = stack.pop() {
            for k in 0..self.neigh[cur].len() {
                let nb = self.neigh[cur][k];
                let v = cells[nb];
                if v == 0 {
                    if !libseen[nb] {
                        libseen[nb] = true;
                        libs.push(nb);
                    }
                } else if v == color && !seen[nb] {
                    seen[nb] = true;
                    stack.push(nb);
                    members.push(nb);
                }
            }
        }
        (members, libs)
    }

    // ---------- 走子 ----------

    fn err(&self, reason: &'static str) -> PlayResult {
        PlayResult {
            ok: false,
            reason: Some(reason),
            captures: 0,
            self_captured: 0,
            key: self.pos_key,
        }
    }

    /// 走子。color: 1/2；vertex: 点索引 或 -1(pass)。
    pub fn play(&mut self, color: u8, vertex: isize) -> PlayResult {
        if self.over {
            return self.err("over");
        }
        if color != self.side {
            return self.err("turn");
        }
        if vertex == -1 {
            // pass：koPoint = -1；history 追加；side 翻转；consecutivePasses += 1
            let prev_key = self.pos_key;
            let prev_side = self.side;
            let prev_ko = self.ko_point;
            let prev_passes = self.passes;
            self.side = 3 - color;
            let sit_key = (self.pos_key, self.side);
            *self.hist_sit.entry(sit_key).or_insert(0) += 1;
            self.ko_point = -1;
            self.passes += 1;
            self.stack.push(Rc::new(Rec::Pass {
                prev_key,
                prev_side,
                prev_ko,
                prev_passes,
                sit_key: Some(sit_key),
            }));
            if self.passes >= 2 {
                self.over = true;
            }
            return PlayResult {
                ok: true,
                reason: None,
                captures: 0,
                self_captured: 0,
                key: self.pos_key,
            };
        }
        if vertex < 0 || vertex as usize >= self.n2 {
            return self.err("range");
        }
        let vtx = vertex as usize;
        if self.ko_point == vertex {
            return self.err("ko");
        }
        if self.cells[vtx] != 0 {
            return self.err("occupied");
        }

        let opp = 3 - color;
        let prev_cells = self.cells.clone();
        let prev_key = self.pos_key;
        let prev_side = self.side;
        let prev_ko = self.ko_point;
        let prev_passes = self.passes;
        let prev_cap = self.captures[color as usize];

        // 5) 落子
        self.cells[vtx] = color;
        self.pos_key ^= zb(color, vtx);

        // 6) 提对方无气棋块
        let mut captured: Vec<usize> = Vec::new();
        let mut seen_cap = vec![false; self.n2];
        for k in 0..self.neigh[vtx].len() {
            let nb = self.neigh[vtx][k];
            if self.cells[nb] == opp && !seen_cap[nb] {
                let (members, libs) = self.group(nb);
                if libs.is_empty() {
                    for &m in &members {
                        seen_cap[m] = true;
                    }
                    captured.extend_from_slice(&members);
                }
            }
        }
        for i in 0..captured.len() {
            let m = captured[i];
            self.cells[m] = 0;
            self.pos_key ^= zb(opp, m);
        }

        // 7) 自杀判定（提子后己方必有气，可跳过重扫）
        let mut self_captured: Vec<usize> = Vec::new();
        if captured.is_empty() {
            let (members, libs) = self.group(vtx);
            if libs.is_empty() {
                if self.rules.suicide == Suicide::Forbid {
                    self.cells = prev_cells;
                    self.pos_key = prev_key;
                    return self.err("suicide");
                }
                self_captured = members;
                for i in 0..self_captured.len() {
                    let m = self_captured[i];
                    self.cells[m] = 0;
                    self.pos_key ^= zb(color, m);
                }
            }
        }

        // 8) 禁全同（新盘面上判定）
        let new_key = self.pos_key;
        let new_side = 3 - color;
        if self.rules.ko == Ko::Positional && self.hist_pos.contains_key(&new_key) {
            self.cells = prev_cells;
            self.pos_key = prev_key;
            return self.err("superko");
        }
        if self.rules.ko == Ko::Situational && self.hist_sit.contains_key(&(new_key, new_side)) {
            self.cells = prev_cells;
            self.pos_key = prev_key;
            return self.err("superko");
        }

        // 9) 提交（先算 koPoint 快照，再改状态）
        let mut ko_new: isize = -1;
        if captured.len() == 1 {
            let (members, libs) = self.group(vtx);
            if members.len() == 1 && libs.len() == 1 {
                ko_new = captured[0] as isize;
            }
        }
        self.ko_point = ko_new;
        self.captures[color as usize] += captured.len() as i32;
        self.side = new_side;
        self.passes = 0;
        *self.hist_pos.entry(new_key).or_insert(0) += 1;
        *self.hist_sit.entry((new_key, new_side)).or_insert(0) += 1;
        self.stack.push(Rc::new(Rec::Move {
            color,
            prev_cells,
            prev_key,
            prev_side,
            prev_ko,
            prev_passes,
            prev_cap,
            pos_key: new_key,
            sit_key: (new_key, new_side),
        }));
        PlayResult {
            ok: true,
            reason: None,
            captures: captured.len() as i32,
            self_captured: self_captured.len() as i32,
            key: new_key,
        }
    }

    pub fn undo(&mut self) -> bool {
        let rec = match self.stack.pop() {
            Some(r) => r,
            None => return false,
        };
        match &*rec {
            Rec::Pass {
                prev_key,
                prev_side,
                prev_ko,
                prev_passes,
                sit_key,
            } => {
                if let Some(k) = sit_key {
                    let drop = match self.hist_sit.get_mut(k) {
                        Some(n) => {
                            *n -= 1;
                            *n <= 0
                        }
                        None => false,
                    };
                    if drop {
                        self.hist_sit.remove(k);
                    }
                }
                self.pos_key = *prev_key;
                self.side = *prev_side;
                self.ko_point = *prev_ko;
                self.passes = *prev_passes;
            }
            Rec::Move {
                color,
                prev_cells,
                prev_key,
                prev_side,
                prev_ko,
                prev_passes,
                prev_cap,
                pos_key,
                sit_key,
            } => {
                let drop_p = match self.hist_pos.get_mut(pos_key) {
                    Some(n) => {
                        *n -= 1;
                        *n <= 0
                    }
                    None => false,
                };
                if drop_p {
                    self.hist_pos.remove(pos_key);
                }
                let drop_s = match self.hist_sit.get_mut(sit_key) {
                    Some(n) => {
                        *n -= 1;
                        *n <= 0
                    }
                    None => false,
                };
                if drop_s {
                    self.hist_sit.remove(sit_key);
                }
                self.cells = prev_cells.clone();
                self.pos_key = *prev_key;
                self.captures[*color as usize] = *prev_cap;
                self.side = *prev_side;
                self.ko_point = *prev_ko;
                self.passes = *prev_passes;
            }
        }
        self.over = false;
        true
    }

    // ---------- 合法性与计分 ----------

    pub fn legal(&self, color: u8, vertex: isize) -> (bool, Option<&'static str>) {
        if self.over {
            return (false, Some("over"));
        }
        if color != self.side {
            return (false, Some("turn"));
        }
        if vertex == -1 {
            return (true, None);
        }
        if vertex < 0 || vertex as usize >= self.n2 {
            return (false, Some("range"));
        }
        if self.ko_point == vertex {
            return (false, Some("ko"));
        }
        if self.cells[vertex as usize] != 0 {
            return (false, Some("occupied"));
        }
        let mut b = self.clone();
        let r = b.play(color, vertex);
        if r.ok {
            (true, None)
        } else {
            (false, r.reason)
        }
    }

    /// 当前轮次方全部合法点（升序，不含 pass）。
    pub fn legal_moves(&self) -> Vec<usize> {
        let mut out = Vec::new();
        for p in 0..self.n2 {
            if self.cells[p] == 0 && self.legal(self.side, p as isize).0 {
                out.push(p);
            }
        }
        out
    }

    /// → (黑方提子数, 白方提子数)
    pub fn prisoners(&self) -> (i32, i32) {
        (self.captures[1], self.captures[2])
    }

    /// 计分（RULES_SPEC §9）。dead 为显式死子列表（仅 territory 档使用）。
    pub fn score(&self, dead: Option<&[(u8, isize)]>) -> Score {
        let mut cells = self.cells.clone();
        let mut prisoners = [0i32; 3];
        prisoners[1] = self.captures[1];
        prisoners[2] = self.captures[2];
        if let Some(dl) = dead {
            for &(color, vertex) in dl {
                if vertex >= 0 && (vertex as usize) < self.n2 {
                    let v = vertex as usize;
                    if cells[v] == color {
                        cells[v] = 0;
                        prisoners[(3 - color) as usize] += 1;
                    }
                }
            }
        }
        let mut seen = vec![false; self.n2];
        let mut black_t = 0i32;
        let mut white_t = 0i32;
        let mut dame = 0i32;
        for start in 0..self.n2 {
            if cells[start] != 0 || seen[start] {
                continue;
            }
            let mut stack = vec![start];
            seen[start] = true;
            let mut region_size = 1i32;
            let mut borders: u8 = 0;
            while let Some(cur) = stack.pop() {
                for k in 0..self.neigh[cur].len() {
                    let nb = self.neigh[cur][k];
                    let v = cells[nb];
                    if v == 0 {
                        if !seen[nb] {
                            seen[nb] = true;
                            stack.push(nb);
                            region_size += 1;
                        }
                    } else {
                        borders |= 1u8 << v;
                    }
                }
            }
            if borders == 0b10 {
                black_t += region_size;
            } else if borders == 0b100 {
                white_t += region_size;
            } else {
                dame += region_size;
            }
        }
        let mut black_stones = 0i32;
        let mut white_stones = 0i32;
        for &v in &cells {
            if v == 1 {
                black_stones += 1;
            } else if v == 2 {
                white_stones += 1;
            }
        }
        let (black, white) = if self.rules.scoring == Scoring::Area {
            (black_stones + black_t, white_stones + white_t)
        } else {
            (black_t + prisoners[1], white_t + prisoners[2])
        };
        let diff = black as f64 - (white as f64 + self.komi);
        let result = if diff == 0.0 {
            "0".to_string()
        } else if diff > 0.0 {
            format!("B+{}", fmt_num(diff))
        } else {
            format!("W+{}", fmt_num(-diff))
        };
        Score {
            black,
            white,
            komi: self.komi,
            dame,
            result,
            black_territory: black_t,
            white_territory: white_t,
            black_stones,
            white_stones,
            prisoners_black: prisoners[1],
            prisoners_white: prisoners[2],
        }
    }
}
