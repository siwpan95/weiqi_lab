//! ai.rs — MCTS(UCT+RAVE) 引擎（Rust 移植）
//!
//! 对照 PyWeiqi/weiqi_ai.py。设计要点：
//! - 树内与最终落子走【完整规则】（禁全同）；playout 允许 simple-ko 近似。
//! - 候选点裁剪：以最近棋子为中心、切比雪夫半径 R 内的空点（R=0 关裁剪）。
//! - playout 采用「局部候选」：优先只在最后一手 1 邻域内选点，局部无可选才全盘扫描。
//! - RNG 为 splitmix64 流；同 (局面, playouts, seed, profile) 可复现。
//! - 性能关键（PORTING §5）：stamp 数组代际标记（零 set 分配）、提子预检、
//!   己方气数下界、单子判定、**全部推演缓冲复用**（playout 热路径零分配）。

use crate::rules::{splitmix64, Board, Suicide};

pub const PASS: isize = -1;

// ---------------------------------------------------------------------------
// RNG：splitmix64 流式
// ---------------------------------------------------------------------------

pub struct Rng {
    state: u64,
}

impl Rng {
    pub fn new(seed: i64) -> Rng {
        Rng {
            state: (seed as u64).wrapping_add(0x9E37_79B9_7F4A_7C15),
        }
    }
    #[inline]
    pub fn next_u64(&mut self) -> u64 {
        self.state = self.state.wrapping_add(0x9E37_79B9_7F4A_7C15);
        splitmix64(self.state)
    }
    #[inline]
    pub fn randint(&mut self, n: usize) -> usize {
        if n > 0 {
            (self.next_u64() % n as u64) as usize
        } else {
            0
        }
    }
    #[inline]
    pub fn random(&mut self) -> f64 {
        (self.next_u64() >> 11) as f64 * (1.0 / 9007199254740992.0)
    }
}

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug)]
pub struct Profile {
    pub c: f64,
    pub rave: bool,
    pub rave_k: f64,
    pub capture_bias: f64,
    pub pattern_bias: f64,
    pub prune_radius: i32,
    pub pass_bias: f64,
    pub resign_threshold: f64,
    pub resign_min_visits: i32,
    pub mercy: f64,
    pub pass_threshold: f64,
    pub score_scale: f64,
}

impl Default for Profile {
    fn default() -> Profile {
        Profile {
            c: 0.7,
            // 与参考实现一致（PROTOCOL_SPEC §2.1 表把默认记为 1000，见交付报告说明）
            rave_k: 100.0,
            rave: true,
            capture_bias: 0.5,
            pattern_bias: 0.5,
            prune_radius: 2,
            pass_bias: 0.0,
            resign_threshold: 0.0,
            resign_min_visits: 200,
            mercy: 0.0,
            pass_threshold: 0.5,
            score_scale: 0.0,
        }
    }
}

// ---------------------------------------------------------------------------
// 推演缓冲（复用，避免热路径分配）
// ---------------------------------------------------------------------------

struct Scratch {
    stamp: Vec<u64>,
    libstamp: Vec<u64>,
    gen: u64,
    markstamp: Vec<u64>,
    markgen: u64,
    stack: Vec<usize>,
    members: Vec<usize>,
    save: Vec<(usize, u8)>,
    captured: Vec<usize>,
    near: Vec<bool>,
    cands: Vec<usize>,
    urgent: Vec<usize>,
    pts: Vec<usize>,
    local: Vec<usize>,
    rescue: Vec<usize>,
}

impl Scratch {
    fn new(n2: usize) -> Scratch {
        Scratch {
            stamp: vec![0u64; n2],
            libstamp: vec![0u64; n2],
            gen: 0,
            markstamp: vec![0u64; n2],
            markgen: 0,
            stack: Vec::with_capacity(n2),
            members: Vec::with_capacity(n2),
            save: Vec::with_capacity(n2),
            captured: Vec::with_capacity(n2),
            near: vec![false; n2],
            cands: Vec::with_capacity(n2),
            urgent: Vec::with_capacity(64),
            pts: Vec::with_capacity(8),
            local: Vec::with_capacity(64),
            rescue: Vec::with_capacity(64),
        }
    }
}

// ---------------------------------------------------------------------------
// 轻量棋盘 PBoard
// ---------------------------------------------------------------------------

pub struct PBoard {
    pub size: usize,
    pub n2: usize,
    /// 扁平化邻点表（每点固定 4 槽 + 度数）：连续内存，缓存友好。
    pub nbr: Vec<[u16; 4]>,
    pub deg: Vec<u8>,
    pub cells: Vec<u8>,
    pub side: u8,
    pub ko: isize,
    pub passes: i32,
    pub suicide_allow: bool,
    pub last: isize,
    sc: Scratch,
}

impl PBoard {
    pub fn new(
        size: usize,
        neigh: &[Vec<usize>],
        cells: Vec<u8>,
        side: u8,
        ko: isize,
        passes: i32,
        suicide_allow: bool,
    ) -> PBoard {
        let n2 = size * size;
        let mut nbr = vec![[0u16; 4]; n2];
        let mut deg = vec![0u8; n2];
        for p in 0..n2 {
            let l = &neigh[p];
            deg[p] = l.len() as u8;
            for (k, &v) in l.iter().enumerate() {
                nbr[p][k] = v as u16;
            }
        }
        PBoard {
            size,
            n2,
            nbr,
            deg,
            cells,
            side,
            ko,
            passes,
            suicide_allow,
            last: -1,
            sc: Scratch::new(n2),
        }
    }

    /// 复用缓冲：从模板复制状态（stamp 代际单调递增，无需清零）。
    #[inline]
    pub fn reset_from(&mut self, other: &PBoard) {
        self.cells.copy_from_slice(&other.cells);
        self.side = other.side;
        self.ko = other.ko;
        self.passes = other.passes;
        self.suicide_allow = other.suicide_allow;
        self.last = -1;
    }

    /// 棋块扫描 → (n_libs, lib0, member_count)。want_members 时成员写入 `sc.members`。
    #[inline]
    fn scan(&mut self, idx: usize, want: bool) -> (usize, isize, usize) {        self.sc.gen += 1;
        let gen = self.sc.gen;
        let color = self.cells[idx];
        self.sc.stack.clear();
        self.sc.stack.push(idx);
        self.sc.stamp[idx] = gen;
        let mut mcount = 0usize;
        if want {
            self.sc.members.clear();
            self.sc.members.push(idx);
            mcount = 1;
        }
        let mut nlibs = 0usize;
        let mut lib0: isize = -1;
        while let Some(cur) = self.sc.stack.pop() {
            let d = self.deg[cur] as usize;
            let nb4 = self.nbr[cur];
            for k in 0..d {
                let nb = nb4[k] as usize;
                let v = self.cells[nb];
                if v == 0 {
                    if self.sc.libstamp[nb] != gen {
                        self.sc.libstamp[nb] = gen;
                        nlibs += 1;
                        if lib0 < 0 {
                            lib0 = nb as isize;
                        }
                    }
                } else if v == color && self.sc.stamp[nb] != gen {
                    self.sc.stamp[nb] = gen;
                    self.sc.stack.push(nb);
                    if want {
                        self.sc.members.push(nb);
                        mcount += 1;
                    }
                }
            }
        }
        (nlibs, lib0, mcount)
    }

    /// 早停「数气」扫描：气数达 limit 立即返回（不建成员表）。
    /// 调用方只区分 0 / 1 / ≥2 气，故与完整扫描结果等价。
    #[inline]
    fn scan_lib(&mut self, idx: usize, limit: usize) -> (usize, isize) {
        self.sc.gen += 1;
        let gen = self.sc.gen;
        let color = self.cells[idx];
        self.sc.stack.clear();
        self.sc.stack.push(idx);
        self.sc.stamp[idx] = gen;
        let mut nlibs = 0usize;
        let mut lib0: isize = -1;
        while let Some(cur) = self.sc.stack.pop() {
            let d = self.deg[cur] as usize;
            let nb4 = self.nbr[cur];
            for k in 0..d {
                let nb = nb4[k] as usize;
                let v = self.cells[nb];
                if v == 0 {
                    if self.sc.libstamp[nb] != gen {
                        self.sc.libstamp[nb] = gen;
                        nlibs += 1;
                        if lib0 < 0 {
                            lib0 = nb as isize;
                        }
                        if nlibs >= limit {
                            return (nlibs, lib0);
                        }
                    }
                } else if v == color && self.sc.stamp[nb] != gen {
                    self.sc.stamp[nb] = gen;
                    self.sc.stack.push(nb);
                }
            }
        }
        (nlibs, lib0)
    }

    /// 早停数气 + 用 `sc.markstamp`（代际 mg）标记已访问点（跨棋块去重）。
    ///
    /// 关键：**遍历用独立的全新代际 `sc.stamp`**，`markstamp` 仅作跨调去重标记。
    /// 若二者混用，同组棋块被前一次早停部分标记后，再从别的成员重扫时遍历会被
    /// 已标记成员截断，导致漏数气（产生假救手/假提子）。
    #[inline]
    fn scan_lib_marked(&mut self, idx: usize, limit: usize, mg: u64) -> (usize, isize) {
        self.sc.gen += 1;
        let gen = self.sc.gen;
        let color = self.cells[idx];
        self.sc.stack.clear();
        self.sc.stack.push(idx);
        self.sc.stamp[idx] = gen;
        self.sc.markstamp[idx] = mg;
        let mut nlibs = 0usize;
        let mut lib0: isize = -1;
        while let Some(cur) = self.sc.stack.pop() {
            let d = self.deg[cur] as usize;
            let nb4 = self.nbr[cur];
            for k in 0..d {
                let nb = nb4[k] as usize;
                let v = self.cells[nb];
                if v == 0 {
                    if self.sc.libstamp[nb] != gen {
                        self.sc.libstamp[nb] = gen;
                        nlibs += 1;
                        if lib0 < 0 {
                            lib0 = nb as isize;
                        }
                        if nlibs >= limit {
                            return (nlibs, lib0);
                        }
                    }
                } else if v == color && self.sc.stamp[nb] != gen {
                    self.sc.stamp[nb] = gen;
                    self.sc.markstamp[nb] = mg;
                    self.sc.stack.push(nb);
                }
            }
        }
        (nlibs, lib0)
    }
    /// 核心推演 → (ok, captures, own_size, own_libs, ko_new)；mutate=True 保留变化。
    #[inline]
    fn simulate(&mut self, color: u8, p: isize, mutate: bool) -> (bool, i32, usize, usize, isize) {
        if p < 0 || p as usize >= self.n2 {
            return (false, 0, 0, 0, -1);
        }
        let np = p as usize;
        if self.cells[np] != 0 || p == self.ko {
            return (false, 0, 0, 0, -1);
        }
        let opp = 3 - color;

        self.sc.save.clear();
        self.sc.save.push((np, 0));
        self.cells[np] = color;

        self.sc.captured.clear();
        self.sc.markgen += 1;
        let mg = self.sc.markgen;

        let npdeg = self.deg[np] as usize;
        let npnb = self.nbr[np];
        for k in 0..npdeg {
            let nb = npnb[k] as usize;
            if self.cells[nb] == opp && self.sc.markstamp[nb] != mg {
                // 提子预检：邻子除 p 外还有空邻点时，其棋块气数必 ≥1；顺带判定是否单子。
                let mut other_empty = false;
                let mut same_opp = false;
                let d2 = self.deg[nb] as usize;
                let nb4 = self.nbr[nb];
                for j in 0..d2 {
                    let q = nb4[j] as usize;
                    let v = self.cells[q];
                    if v == 0 {
                        other_empty = true;
                        break;
                    } else if v == opp {
                        same_opp = true;
                    }
                }
                if other_empty {
                    self.sc.markstamp[nb] = mg;
                    continue;
                }
                if !same_opp {
                    // 快速路径：单子且除落点外无空邻 → 必被提（等价于整块扫描 nlibs==0）。
                    self.sc.markstamp[nb] = mg;
                    self.sc.captured.push(nb);
                    continue;
                }
                // 早停：仅需判断「是否有气（≥1）」。无气才需要完整成员表用于提子。
                let (nlibs, _lib0) = self.scan_lib_marked(nb, 1, mg);
                if nlibs == 0 {
                    let (_nl, _lo, mcount) = self.scan(nb, true);
                    for i in 0..mcount {
                        let m = self.sc.members[i];
                        self.sc.markstamp[m] = mg;
                    }
                    for i in 0..mcount {
                        let m = self.sc.members[i];
                        self.sc.captured.push(m);
                    }
                }
            }
        }
        for i in 0..self.sc.captured.len() {
            let m = self.sc.captured[i];
            self.sc.save.push((m, opp));
            self.cells[m] = 0;
        }

        let mut empties = 0usize;
        let mut same_color_nb = false;
        for k in 0..npdeg {
            let q = npnb[k] as usize;
            let v = self.cells[q];
            if v == 0 {
                empties += 1;
            } else if v == color {
                same_color_nb = true;
            }
        }

        let own_size: usize;
        let nlibs: usize;
        let mut ko_new: isize = -1;
        if empties >= 2 {
            own_size = 1;
            nlibs = empties; // 下界（真实值只会更大）
        } else {
            own_size = if same_color_nb { 2 } else { 1 };
            // 单子棋块（无同色邻点）免扫描：气数 == 空邻点数（与 _scan 结果一致）；
            // 多子棋块用早停数气（只需 0 / 1 / ≥2 三态）。
            let nl = if same_color_nb {
                self.scan_lib(np, 2).0
            } else {
                empties
            };
            nlibs = nl;
            if nl == 0 {
                if !self.suicide_allow {
                    for i in (0..self.sc.save.len()).rev() {
                        let (idx, old) = self.sc.save[i];
                        self.cells[idx] = old;
                    }
                    return (false, 0, 0, 0, -1);
                }
                let (_nl2, _l, mc2) = self.scan(np, true);
                for i in 0..mc2 {
                    let m = self.sc.members[i];
                    self.sc.save.push((m, color));
                    self.cells[m] = 0;
                }
            } else if self.sc.captured.len() == 1 && !same_color_nb && nl == 1 {
                ko_new = self.sc.captured[0] as isize;
            }
        }

        let ncap = self.sc.captured.len() as i32;
        if !mutate {
            for i in (0..self.sc.save.len()).rev() {
                let (idx, old) = self.sc.save[i];
                self.cells[idx] = old;
            }
            return (true, ncap, own_size, nlibs, ko_new);
        }
        self.ko = ko_new;
        self.last = p;
        self.passes = 0;
        self.side = opp;
        (true, ncap, own_size, nlibs, ko_new)
    }

    #[inline]
    pub fn probe(&mut self, color: u8, p: isize) -> (bool, i32, usize, usize, isize) {
        self.simulate(color, p, false)
    }
    #[inline]
    pub fn apply(&mut self, color: u8, p: isize) -> (bool, i32, usize, usize, isize) {
        self.simulate(color, p, true)
    }

    #[inline]
    pub fn play_pass(&mut self, color: u8) {
        self.ko = -1;
        self.passes += 1;
        self.side = 3 - color;
        self.last = -1;
    }

    /// 简单眼：全部正交邻点是本方棋子（盘外忽略）。
    #[inline]
    pub fn is_eye(&self, p: usize, color: u8) -> bool {
        let d = self.deg[p] as usize;
        let nb4 = self.nbr[p];
        for k in 0..d {
            if self.cells[nb4[k] as usize] != color {
                return false;
            }
        }
        true
    }

    /// p 的邻点中是否存在 color 方、仅剩 1 气的棋块。
    pub fn adjacent_atari(&mut self, p: usize, color: u8) -> bool {
        self.sc.markgen += 1;
        let mg = self.sc.markgen;
        let d = self.deg[p] as usize;
        let nb4 = self.nbr[p];
        for k in 0..d {
            let nb = nb4[k] as usize;
            if self.cells[nb] == color && self.sc.markstamp[nb] != mg {
                let mut empties = 0;
                let d2 = self.deg[nb] as usize;
                let nb4b = self.nbr[nb];
                for j in 0..d2 {
                    if self.cells[nb4b[j] as usize] == 0 {
                        empties += 1;
                        if empties >= 2 {
                            break;
                        }
                    }
                }
                if empties >= 2 {
                    continue;
                }
                // 早停：仅需区分「恰好 1 气」与其余
                let (nlibs, _lib0) = self.scan_lib_marked(nb, 2, mg);
                if nlibs == 1 {
                    return true;
                }
            }
        }
        false
    }

    /// 最后一手附近的己方被打吃棋块的救手（其唯一气）→ 写入 `sc.rescue`。
    pub fn rescue_moves(&mut self, color: u8) {
        self.sc.rescue.clear();
        let last = self.last;
        if last < 0 {
            return;
        }
        self.sc.markgen += 1;
        let mg = self.sc.markgen;
        let lu = last as usize;
        self.sc.pts.clear();
        self.sc.pts.push(lu);
        let dl = self.deg[lu] as usize;
        let l4 = self.nbr[lu];
        for k in 0..dl {
            self.sc.pts.push(l4[k] as usize);
        }
        let npts = self.sc.pts.len();
        for i in 0..npts {
            let nb = self.sc.pts[i];
            if self.cells[nb] == color && self.sc.markstamp[nb] != mg {
                let mut empties = 0;
                let d2 = self.deg[nb] as usize;
                let nb4 = self.nbr[nb];
                for j in 0..d2 {
                    if self.cells[nb4[j] as usize] == 0 {
                        empties += 1;
                        if empties >= 2 {
                            break;
                        }
                    }
                }
                if empties >= 2 {
                    continue;
                }
                // 早停：仅需区分「恰好 1 气」与其余；恰 1 气时 lib0 即唯一气
                let (nlibs, lib0) = self.scan_lib_marked(nb, 2, mg);
                if nlibs == 1 && lib0 >= 0 {
                    self.sc.rescue.push(lib0 as usize);
                }
            }
        }
    }

    /// 面积计分（盘上皆活）→ (black_area, white_area)。
    pub fn area(&mut self) -> (i32, i32) {
        let n2 = self.n2;
        let seen = &mut self.sc.near; // 复用 near 作为 seen 标记
        for s in seen.iter_mut() {
            *s = false;
        }
        let mut bt = 0i32;
        let mut wt = 0i32;
        for start in 0..n2 {
            if self.cells[start] != 0 || seen[start] {
                continue;
            }
            self.sc.stack.clear();
            self.sc.stack.push(start);
            seen[start] = true;
            let mut size = 1i32;
            let mut borders: u8 = 0;
            while let Some(cur) = self.sc.stack.pop() {
                let d = self.deg[cur] as usize;
                let nb4 = self.nbr[cur];
                for k in 0..d {
                    let nb = nb4[k] as usize;
                    let v = self.cells[nb];
                    if v == 0 {
                        if !seen[nb] {
                            seen[nb] = true;
                            self.sc.stack.push(nb);
                            size += 1;
                        }
                    } else {
                        borders |= 1u8 << v;
                    }
                }
            }
            if borders == 0b10 {
                bt += size;
            } else if borders == 0b100 {
                wt += size;
            }
        }
        let mut bs = 0i32;
        let mut ws = 0i32;
        for &v in &self.cells {
            if v == 1 {
                bs += 1;
            } else if v == 2 {
                ws += 1;
            }
        }
        (bs + bt, ws + wt)
    }

    /// 以切比雪夫半径 radius 标记棋子邻域 → 写入 `sc.near`，返回 whether any stone。
    fn build_near(&mut self, radius: i32) -> bool {
        for s in self.sc.near.iter_mut() {
            *s = false;
        }
        let size = self.size as i32;
        let mut any_stone = false;
        for p in 0..self.n2 {
            if self.cells[p] == 0 {
                continue;
            }
            any_stone = true;
            let px = (p % self.size) as i32;
            let py = (p / self.size) as i32;
            let x0 = if px - radius > 0 { px - radius } else { 0 };
            let x1 = if px + radius < size - 1 { px + radius } else { size - 1 };
            let y0 = if py - radius > 0 { py - radius } else { 0 };
            let y1 = if py + radius < size - 1 { py + radius } else { size - 1 };
            for y in y0..=y1 {
                let base = y as usize * self.size;
                for x in x0..=x1 {
                    self.sc.near[base + x as usize] = true;
                }
            }
        }
        any_stone
    }
}

// ---------------------------------------------------------------------------
// 先验 / 几何辅助
// ---------------------------------------------------------------------------

/// 树内先验（等效经验）：提子加分、自填气减分。
pub fn move_prior(caps: i32, own_libs: usize) -> f64 {
    let mut q = 0.5;
    if caps >= 2 {
        q += 0.25;
    } else if caps == 1 {
        q += 0.15;
    }
    if own_libs == 1 {
        q -= 0.15;
    }
    if q < 0.05 {
        0.05
    } else if q > 0.9 {
        0.9
    } else {
        q
    }
}

#[inline]
fn chebyshev(a: usize, b: usize, size: usize) -> usize {
    let (ax, ay) = (a % size, a / size);
    let (bx, by) = (b % size, b / size);
    let dx = if ax > bx { ax - bx } else { bx - ax };
    let dy = if ay > by { ay - by } else { by - ay };
    if dx > dy {
        dx
    } else {
        dy
    }
}

/// 空盘开局候选：中央三分之一见方（9 路 = 3x3 共 9 点）。
fn center_zone(size: usize) -> Vec<usize> {
    let lo = size / 3;
    let hi = size - 1 - size / 3;
    let mut pts = Vec::new();
    for y in lo..=hi {
        for x in lo..=hi {
            pts.push(y * size + x);
        }
    }
    pts
}

/// 单点候选过滤（眼位过滤 + 合法性 probe）。
fn consider(pb: &mut PBoard, color: u8, p: usize, out: &mut Vec<(usize, i32, usize)>) {
    if pb.cells[p] != 0 {
        return;
    }
    if pb.is_eye(p, color) && !pb.adjacent_atari(p, 3 - color) {
        return;
    }
    let (ok, caps, _osize, olibs, _) = pb.probe(color, p as isize);
    if ok {
        out.push((p, caps, olibs));
    }
}

/// 裁剪后的候选点 → Vec<(point, captures, own_libs)>。
fn candidates(pb: &mut PBoard, color: u8, radius: i32) -> Vec<(usize, i32, usize)> {
    let n2 = pb.n2;
    let mut out = Vec::new();
    if radius <= 0 {
        for p in 0..n2 {
            consider(pb, color, p, &mut out);
        }
        return out;
    }
    let any_stone = pb.build_near(radius);
    if !any_stone {
        for p in center_zone(pb.size) {
            consider(pb, color, p, &mut out);
        }
    } else {
        for p in 0..n2 {
            if pb.sc.near[p] {
                consider(pb, color, p, &mut out);
            }
        }
    }
    out
}

// ---------------------------------------------------------------------------
// playout（热路径：零分配）
// ---------------------------------------------------------------------------

fn playout(pb: &mut PBoard, rng: &mut Rng, pr: &Profile, max_moves: i32) -> i32 {
    let cap_bias = pr.capture_bias;
    let pat_bias = pr.pattern_bias;
    let large_margin = pr.mercy * pb.n2 as f64;
    let mut moves = 0i32;
    while pb.passes < 2 && moves < max_moves {
        let color = pb.side;
        let last = pb.last;
        pb.sc.cands.clear();
        pb.sc.urgent.clear();

        // 局部候选：最后一手 + 其 1 邻域
        pb.sc.pts.clear();
        if last >= 0 {
            let lu = last as usize;
            pb.sc.pts.push(lu);
            let dl = pb.deg[lu] as usize;
            let l4 = pb.nbr[lu];
            for k in 0..dl {
                pb.sc.pts.push(l4[k] as usize);
            }
        }
        let npts = pb.sc.pts.len();
        for i in 0..npts {
            let p = pb.sc.pts[i];
            if pb.cells[p] != 0 || p as isize == pb.ko {
                continue;
            }
            // 眼点必无提子（cap==0）；若无邻近敌方打吃，可直接剔除而免去 probe。
            if pb.is_eye(p, color) && !pb.adjacent_atari(p, 3 - color) {
                continue;
            }
            let (ok, cap, _osize, olibs, _) = pb.probe(color, p as isize);
            if !ok {
                continue;
            }
            if cap == 0 {
                if olibs == 1 {
                    continue;
                }
                if pb.is_eye(p, color) && !pb.adjacent_atari(p, 3 - color) {
                    continue;
                }
            }
            pb.sc.cands.push(p);
            if cap > 0 {
                pb.sc.urgent.push(p);
            }
        }

        if pb.sc.cands.is_empty() {
            for p in 0..pb.n2 {
                if pb.cells[p] != 0 || p as isize == pb.ko {
                    continue;
                }
                if pb.is_eye(p, color) && !pb.adjacent_atari(p, 3 - color) {
                    continue;
                }
                let (ok, cap, _osize, olibs, _) = pb.probe(color, p as isize);
                if !ok {
                    continue;
                }
                if cap == 0 {
                    if olibs == 1 {
                        continue;
                    }
                    if pb.is_eye(p, color) && !pb.adjacent_atari(p, 3 - color) {
                        continue;
                    }
                }
                pb.sc.cands.push(p);
                if cap > 0 {
                    pb.sc.urgent.push(p);
                }
            }
        }

        pb.rescue_moves(color);
        for i in 0..pb.sc.rescue.len() {
            let m = pb.sc.rescue[i];
            if pb.cells[m] == 0 && !pb.sc.urgent.contains(&m) {
                pb.sc.urgent.push(m);
            }
        }

        if pb.sc.cands.is_empty() {
            pb.play_pass(color);
            moves += 1;
            continue;
        }

        let r = rng.random();
        let m: usize;
        if !pb.sc.urgent.is_empty() && r < cap_bias {
            m = pb.sc.urgent[rng.randint(pb.sc.urgent.len())];
        } else if last >= 0 && rng.random() < pat_bias {
            pb.sc.local.clear();
            for i in 0..pb.sc.cands.len() {
                let p = pb.sc.cands[i];
                if chebyshev(p, last as usize, pb.size) <= 1 {
                    pb.sc.local.push(p);
                }
            }
            if !pb.sc.local.is_empty() {
                m = pb.sc.local[rng.randint(pb.sc.local.len())];
            } else {
                m = pb.sc.cands[rng.randint(pb.sc.cands.len())];
            }
        } else {
            m = pb.sc.cands[rng.randint(pb.sc.cands.len())];
        }
        pb.apply(color, m as isize);
        moves += 1;
        if large_margin > 0.0 {
            let (bt, wt) = pb.area();
            if (bt - wt) as f64 > large_margin || (wt - bt) as f64 > large_margin {
                break;
            }
        }
    }
    moves
}

/// 【开发基准】在给定局面上重复纯 playout，返回 (总步数, 秒数)。
/// 用于稳定测量「每次 playout 的真实开销」（不受 MCTS 树形/搜索动力学干扰）。
pub fn bench_playouts(board: &Board, iters: i32, seed: i64) -> (u64, f64) {    let pr = Profile::default();
    let suicide_allow = board.rules.suicide == Suicide::Allow;
    let max_moves = 3 * board.n2 as i32;
    let mut rng = Rng::new(seed);
    let mut total: u64 = 0;
    let t0 = std::time::Instant::now();
    for _ in 0..iters {
        let mut pb = PBoard::new(
            board.size,
            &board.neigh,
            board.cells.clone(),
            board.side,
            board.ko_point,
            board.passes,
            suicide_allow,
        );
        total += playout(&mut pb, &mut rng, &pr, max_moves) as u64;
    }
    (total, t0.elapsed().as_secs_f64())
}

/// 【开发基准】对若干空点反复 probe，返回 (探测次数, 秒数)，用于测单次 simulate 开销。
pub fn bench_probe(board: &Board, iters: i32) -> (u64, f64) {
    let suicide_allow = board.rules.suicide == Suicide::Allow;
    let mut pb = PBoard::new(
        board.size,
        &board.neigh,
        board.cells.clone(),
        board.side,
        board.ko_point,
        board.passes,
        suicide_allow,
    );
    let mut pts: Vec<usize> = Vec::new();
    for i in 0..pb.n2 {
        if pb.cells[i] == 0 {
            pts.push(i);
        }
    }
    let np = pts.len();
    let mut acc: u64 = 0;
    let t0 = std::time::Instant::now();
    for it in 0..iters {
        let p = pts[(it as usize) % np];
        let (ok, cap, _os, _ol, _ko) = pb.probe(board.side, p as isize);
        acc += ok as u64 + cap as u64;
    }
    (acc, t0.elapsed().as_secs_f64())
}

// ---------------------------------------------------------------------------
// 树（arena）
// ---------------------------------------------------------------------------

struct Node {
    to_move: u8,
    children: Vec<usize>,
    mv: isize,
    n: u32,
    w: f64,
    amaf_n: u32,
    amaf_w: f64,
    expanded: bool,
    prior: f64,
}

impl Node {
    fn new(to_move: u8, mv: isize, prior: f64, expanded: bool) -> Node {
        Node {
            to_move,
            children: Vec::new(),
            mv,
            n: 0,
            w: 0.0,
            amaf_n: 0,
            amaf_w: 0.0,
            expanded,
            prior,
        }
    }
}

fn select(arena: &[Node], node: usize, c: f64, rave_k: f64, rave: bool) -> usize {
    let logn = (arena[node].n as f64 + 1.0).ln();
    let mut best = usize::MAX;
    let mut bestv = -1e18;
    for &ch in &arena[node].children {
        let n = arena[ch].n;
        let mut q = if n > 0 {
            arena[ch].w / n as f64
        } else {
            arena[ch].prior
        };
        if rave && arena[ch].amaf_n > 0 {
            let qa = arena[ch].amaf_w / arena[ch].amaf_n as f64;
            let beta = if n > 0 {
                (rave_k / (rave_k + 3.0 * n as f64)).sqrt()
            } else {
                1.0
            };
            q = (1.0 - beta) * q + beta * qa;
        }
        let val = q + c * (logn / (n as f64 + 1.0)).sqrt();
        if val > bestv {
            bestv = val;
            best = ch;
        }
    }
    best
}

fn rng_shuffle<T>(v: &mut Vec<T>, rng: &mut Rng) {
    if v.len() < 2 {
        return;
    }
    let mut i = v.len() - 1;
    while i > 0 {
        let j = rng.randint(i + 1);
        v.swap(i, j);
        i -= 1;
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Move {
    Point(usize),
    Pass,
    Resign,
}

#[derive(Clone, Copy, Debug)]
pub struct GenResult {
    pub mv: Move,
    pub visits: u32,
    pub winrate: f64,
}

/// 对 board（完整规则 Board）搜索 → GenResult。不落子 —— 由调用方复检。
pub fn genmove(board: &Board, playouts: i32, seed: i64, profile: &Profile) -> GenResult {
    let pr = *profile;
    let mut rng = Rng::new(seed);
    let size = board.size;
    let n2 = board.n2;
    let suicide_allow = board.rules.suicide == Suicide::Allow;
    let full_legal = board.legal_moves();
    let mut legal_mask = vec![false; n2];
    for &p in &full_legal {
        legal_mask[p] = true;
    }

    let mut pb0 = PBoard::new(
        size,
        &board.neigh,
        board.cells.clone(),
        board.side,
        board.ko_point,
        board.passes,
        suicide_allow,
    );
    let radius = pr.prune_radius;

    let mut arena: Vec<Node> = Vec::with_capacity(4096);
    arena.push(Node::new(board.side, PASS, 0.5, true));

    // probe 不修改 cells，pb0 之后仍可作为模板
    let mut moves = candidates(&mut pb0, board.side, radius);
    moves.retain(|&(p, _, _)| legal_mask[p]);
    rng_shuffle(&mut moves, &mut rng);
    for &(m, c, ol) in &moves {
        arena.push(Node::new(3 - board.side, m as isize, move_prior(c, ol), false));
    }
    arena[0].children = (1..arena.len()).collect();
    if arena[0].children.is_empty() {
        return GenResult {
            mv: Move::Pass,
            visits: 0,
            winrate: 0.0,
        };
    }

    let max_moves = 3 * n2 as i32;
    let scale = if pr.score_scale > 0.0 {
        pr.score_scale
    } else {
        n2 as f64 / 2.0
    };
    let sims = playouts.max(1);

    let mut pb = PBoard::new(
        size,
        &board.neigh,
        pb0.cells.clone(),
        pb0.side,
        pb0.ko,
        pb0.passes,
        pb0.suicide_allow,
    );

    // 复用的回溯缓冲
    let mut chain: Vec<usize> = Vec::with_capacity(256);
    let mut kids_buf: Vec<usize> = Vec::with_capacity(64);
    let mut mv1: Vec<u64> = vec![0u64; n2]; // AMAF：color 1 在某次模拟中走过的点
    let mut mv2: Vec<u64> = vec![0u64; n2]; // AMAF：color 2
    let mut simgen: u64 = 0;

    for _ in 0..sims {
        simgen += 1;
        pb.reset_from(&pb0);
        let mut node = 0usize;
        chain.clear();
        chain.push(0);

        while arena[node].expanded && !arena[node].children.is_empty() {
            let ci = select(&arena, node, pr.c, pr.rave_k, pr.rave);
            let m = arena[ci].mv;
            let color = arena[node].to_move;
            if m == PASS {
                pb.play_pass(color);
            } else {
                pb.apply(color, m);
                let mm = m as usize;
                if color == 1 {
                    mv1[mm] = simgen;
                } else {
                    mv2[mm] = simgen;
                }
            }
            node = ci;
            chain.push(node);
        }

        if !arena[node].expanded {
            let tmove = arena[node].to_move;
            let mut cl = candidates(&mut pb, tmove, radius);
            rng_shuffle(&mut cl, &mut rng);
            let mut idxs: Vec<usize> = Vec::with_capacity(cl.len());
            for &(m, c, ol) in &cl {
                let i = arena.len();
                arena.push(Node::new(3 - tmove, m as isize, move_prior(c, ol), false));
                idxs.push(i);
            }
            arena[node].children = idxs;
            arena[node].expanded = true;
        }

        let leaf_to_move = arena[node].to_move;
        playout(&mut pb, &mut rng, &pr, max_moves);
        let (bt, wt) = pb.area();
        let diff_black = (bt - wt) as f64 - board.komi;
        let mut sv = 0.5 + 0.5 * (diff_black / scale);
        if sv < 0.0 {
            sv = 0.0;
        } else if sv > 1.0 {
            sv = 1.0;
        }
        let res_leaf = if leaf_to_move == 1 { sv } else { 1.0 - sv };

        for &nd in &chain {
            let v = if arena[nd].to_move == leaf_to_move {
                res_leaf
            } else {
                1.0 - res_leaf
            };
            arena[nd].n += 1;
            arena[nd].w += v;
            let tmf = arena[nd].to_move;
            let has_kids = !arena[nd].children.is_empty();
            if has_kids {
                let cv = 1.0 - v;
                let stamps = if tmf == 1 { &mv1 } else { &mv2 };
                kids_buf.clear();
                kids_buf.extend_from_slice(&arena[nd].children);
                for i in 0..kids_buf.len() {
                    let ch = kids_buf[i];
                    let cm = arena[ch].mv;
                    if cm != PASS && stamps[cm as usize] == simgen {
                        arena[ch].amaf_n += 1;
                        arena[ch].amaf_w += cv;
                    }
                }
            }
        }
    }

    // 最终选择：key = (-N, -winrate, move)
    let mut best: Option<usize> = None;
    let mut best_n = 0u32;
    let mut best_wr = 0.0f64;
    let mut best_m = n2;
    let mut total_visits = 0u32;
    for &ch in &arena[0].children {
        let n = arena[ch].n;
        total_visits += n;
        let wr = if n > 0 {
            arena[ch].w / n as f64
        } else {
            0.0
        };
        let m = if arena[ch].mv == PASS {
            n2
        } else {
            arena[ch].mv as usize
        };
        let better = match best {
            None => true,
            Some(_) => {
                if n != best_n {
                    n > best_n
                } else if wr != best_wr {
                    wr > best_wr
                } else {
                    m < best_m
                }
            }
        };
        if better {
            best = Some(ch);
            best_n = n;
            best_wr = wr;
            best_m = m;
        }
    }

    let mut best_mv = match best {
        Some(ch) => arena[ch].mv,
        None => PASS,
    };

    // 兜底：选中点必须在完整规则合法集内（候选裁剪不应越界）
    if best_mv != PASS && !legal_mask[best_mv as usize] {
        let mut alt: Option<usize> = None;
        let mut alt_n = 0u32;
        let mut alt_wr = 0.0f64;
        let mut alt_m = n2;
        for &ch in &arena[0].children {
            let m = arena[ch].mv;
            if m == PASS || !legal_mask[m as usize] {
                continue;
            }
            let n = arena[ch].n;
            let wr = if n > 0 {
                arena[ch].w / n as f64
            } else {
                0.0
            };
            let mm = m as usize;
            let better = match alt {
                None => true,
                Some(_) => {
                    if n != alt_n {
                        n > alt_n
                    } else if wr != alt_wr {
                        wr > alt_wr
                    } else {
                        mm < alt_m
                    }
                }
            };
            if better {
                alt = Some(ch);
                alt_n = n;
                alt_wr = wr;
                alt_m = mm;
            }
        }
        match alt {
            Some(ch) => {
                best_mv = arena[ch].mv;
                best_n = alt_n;
                best_wr = alt_wr;
            }
            None => best_mv = PASS,
        }
    }

    // 显式过手规则：对手已过手，且本方胜率达标 → 过手终局
    if board.passes >= 1 && best_mv != PASS && best_wr >= pr.pass_threshold {
        return GenResult {
            mv: Move::Pass,
            visits: best_n,
            winrate: best_wr,
        };
    }
    if pr.resign_threshold > 0.0
        && total_visits >= pr.resign_min_visits as u32
        && best_wr < pr.resign_threshold
    {
        return GenResult {
            mv: Move::Resign,
            visits: best_n,
            winrate: best_wr,
        };
    }

    GenResult {
        mv: if best_mv == PASS {
            Move::Pass
        } else {
            Move::Point(best_mv as usize)
        },
        visits: best_n,
        winrate: best_wr,
    }
}
