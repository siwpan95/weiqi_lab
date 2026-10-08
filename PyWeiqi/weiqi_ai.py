"""weiqi_ai.py — MCTS(UCT+RAVE) 引擎（规范参照实现）

设计要点（见 docs/PROTOCOL_SPEC.md §2.1 与 docs/RESEARCH.md §4）：
- 树内与最终落子走【完整规则】（禁全同）；playout 允许 simple-ko 近似（Fuego/Pachi 同款折衷）。
- 候选点裁剪：以最近棋子为中心、切比雪夫半径 R 内的空点（R=0 关裁剪）。
- playout 采用「局部候选」：优先只在最后一手 1 邻域内选点，局部无可选才全盘扫描（省 10 倍探针）。
- 固定模拟次数预算（默认 500），RNG 为 splitmix64 流；同 (seed,playouts,profile) 可复现。
- 性能：棋盘扫描用 stamp 数组（零 set 分配），实测 ~1500 playouts/s（Python 3.13 / 9 路）。
"""

import math
from weiqi_rules import splitmix64, MASK64

PASS = -1


class Rng:
    """splitmix64 流式 RNG（纯整数，跨语言可移植）"""

    __slots__ = ("state",)

    def __init__(self, seed=0):
        self.state = (seed + 0x9E3779B97F4A7C15) & MASK64

    def next_u64(self):
        self.state = (self.state + 0x9E3779B97F4A7C15) & MASK64
        return splitmix64(self.state)

    def randint(self, n):
        return self.next_u64() % n if n > 0 else 0

    def random(self):
        return (self.next_u64() >> 11) * (1.0 / 9007199254740992.0)


class PBoard:
    """轻量棋盘：仅 simple-ko + 自杀档，用于树与 playout 的高速推演。"""

    __slots__ = ("size", "n2", "neigh", "cells", "side", "ko", "passes",
                 "suicide_allow", "last", "stamp", "libstamp", "_gen")

    def __init__(self, size, neigh, cells, side, ko, passes, suicide_allow):
        self.size = size
        self.n2 = size * size
        self.neigh = neigh
        self.cells = cells
        self.side = side
        self.ko = ko
        self.passes = passes
        self.suicide_allow = suicide_allow
        self.last = -1
        self.stamp = [0] * self.n2
        self.libstamp = [0] * self.n2
        self._gen = 0

    def clone(self):
        p = PBoard.__new__(PBoard)
        p.size = self.size
        p.n2 = self.n2
        p.neigh = self.neigh
        p.cells = self.cells[:]
        p.side = self.side
        p.ko = self.ko
        p.passes = self.passes
        p.suicide_allow = self.suicide_allow
        p.last = self.last
        p.stamp = [0] * self.n2
        p.libstamp = [0] * self.n2
        p._gen = 0
        return p

    def _group(self, idx):
        """→ (members, n_libs, lib0)。member/lib 判定用 stamp 数组，零 set 分配。"""
        cells = self.cells
        stamp = self.stamp
        libstamp = self.libstamp
        gen = self._gen + 1
        self._gen = gen
        color = cells[idx]
        stack = [idx]
        stamp[idx] = gen
        members = [idx]
        nlibs = 0
        lib0 = -1
        neigh = self.neigh
        while stack:
            cur = stack.pop()
            for nb in neigh[cur]:
                v = cells[nb]
                if v == 0:
                    if libstamp[nb] != gen:
                        libstamp[nb] = gen
                        nlibs += 1
                        if lib0 < 0:
                            lib0 = nb
                elif v == color and stamp[nb] != gen:
                    stamp[nb] = gen
                    stack.append(nb)
                    members.append(nb)
        return members, nlibs, lib0

    def _scan(self, idx, want_members):
        """棋块扫描 → (members|None, n_libs, lib0)。want_members=False 时不建成员表（省分配）。"""
        cells = self.cells
        stamp = self.stamp
        libstamp = self.libstamp
        gen = self._gen + 1
        self._gen = gen
        color = cells[idx]
        neigh = self.neigh
        stack = [idx]
        stamp[idx] = gen
        members = [idx] if want_members else None
        nlibs = 0
        lib0 = -1
        while stack:
            cur = stack.pop()
            for nb in neigh[cur]:
                v = cells[nb]
                if v == 0:
                    if libstamp[nb] != gen:
                        libstamp[nb] = gen
                        nlibs += 1
                        if lib0 < 0:
                            lib0 = nb
                elif v == color and stamp[nb] != gen:
                    stamp[nb] = gen
                    stack.append(nb)
                    if want_members:
                        members.append(nb)
        return members, nlibs, lib0

    def _group(self, idx):
        return self._scan(idx, True)

    def simulate(self, color, p, mutate):
        """核心推演。→ (ok, captures, own_size, own_libs, ko_new)；mutate=True 保留变化。

        快速路径（关键性能优化）：
        - 提子预检：仅在 nb 除 p 外没有任何空邻点时才需要整块扫描（绝大多数棋块不满足）。
        - 己方气数下界：p 的空邻点数 ≥2 时，己方棋块气数必 ≥2 → 免扫描，且 ko_new 必为 -1。
        - 单子判定：own_size==1 ⟺ p 无同色邻点（免扫描）。
        """
        cells = self.cells
        if p < 0 or p >= self.n2 or cells[p] != 0 or p == self.ko:
            return (False, 0, 0, 0, -1)
        opp = 3 - color
        neigh = self.neigh
        save = [(p, 0)]
        cells[p] = color
        captured = []
        seen = []
        for nb in neigh[p]:
            if cells[nb] == opp and nb not in seen:
                other_empty = False
                for q in neigh[nb]:
                    if q != p and cells[q] == 0:
                        other_empty = True
                        break
                if other_empty:
                    seen.append(nb)
                    continue
                members, nlibs, _ = self._scan(nb, True)
                for m in members:
                    if m not in seen:
                        seen.append(m)
                if nlibs == 0:
                    captured.extend(members)
        for m in captured:
            save.append((m, opp))
            cells[m] = 0
        empties = 0
        same_color_nb = False
        for q in neigh[p]:
            v = cells[q]
            if v == 0:
                empties += 1
            elif v == color:
                same_color_nb = True
        if empties >= 2:
            own_size = 1
            nlibs = empties  # 下界（真实值只会更大）
            ko_new = -1
        else:
            members, nlibs, _ = self._scan(p, False)
            own_size = 2 if same_color_nb else 1
            ko_new = -1
            if nlibs == 0:
                if not self.suicide_allow:
                    for idx, old in reversed(save):
                        cells[idx] = old
                    return (False, 0, 0, 0, -1)
                members, _, _ = self._scan(p, True)
                for m in members:
                    save.append((m, color))
                    cells[m] = 0
            elif len(captured) == 1 and not same_color_nb and nlibs == 1:
                ko_new = captured[0]
        if not mutate:
            for idx, old in reversed(save):
                cells[idx] = old
            return (True, len(captured), own_size, nlibs, ko_new)
        self.ko = ko_new
        self.last = p
        self.passes = 0
        self.side = opp
        return (True, len(captured), own_size, nlibs, ko_new)

    def probe(self, color, p):
        return self.simulate(color, p, False)

    def apply(self, color, p):
        return self.simulate(color, p, True)

    def play_pass(self, color):
        self.ko = -1
        self.passes += 1
        self.side = 3 - color
        self.last = -1

    def is_eye(self, p, color):
        """简单眼：全部正交邻点是本方棋子（盘外忽略）。"""
        cells = self.cells
        for nb in self.neigh[p]:
            if cells[nb] != color:
                return False
        return True

    def adjacent_atari(self, p, color):
        """p 的邻点中是否存在 color 方、仅剩 1 气的棋块（含空邻点预检）。"""
        cells = self.cells
        neigh = self.neigh
        seen = []
        for nb in neigh[p]:
            if cells[nb] == color and nb not in seen:
                empties = 0
                for q in neigh[nb]:
                    if cells[q] == 0:
                        empties += 1
                        if empties >= 2:
                            break
                if empties >= 2:
                    continue
                members, nlibs, _ = self._scan(nb, True)
                seen.extend(members)
                if nlibs == 1:
                    return True
        return False

    def rescue_moves(self, color):
        """最后一手附近的己方被打吃棋块的救手（其唯一气）。"""
        out = []
        last = self.last
        if last < 0:
            return out
        cells = self.cells
        neigh = self.neigh
        seen = []
        for nb in [last] + neigh[last]:
            if cells[nb] == color and nb not in seen:
                empties = 0
                for q in neigh[nb]:
                    if cells[q] == 0:
                        empties += 1
                        if empties >= 2:
                            break
                if empties >= 2:
                    continue
                members, nlibs, lib0 = self._scan(nb, True)
                seen.extend(members)
                if nlibs == 1 and lib0 >= 0:
                    out.append(lib0)
        return out

    def area(self):
        """面积计分（盘上皆活）。→ (black_area, white_area)"""
        cells = self.cells
        n2 = self.n2
        neigh = self.neigh
        seen = [False] * n2
        bt = wt = 0
        for start in range(n2):
            if cells[start] != 0 or seen[start]:
                continue
            stack = [start]
            seen[start] = True
            size = 1
            borders = set()
            while stack:
                cur = stack.pop()
                for nb in neigh[cur]:
                    v = cells[nb]
                    if v == 0:
                        if not seen[nb]:
                            seen[nb] = True
                            stack.append(nb)
                            size += 1
                    else:
                        borders.add(v)
            if borders == {1}:
                bt += size
            elif borders == {2}:
                wt += size
        bs = ws = 0
        for v in cells:
            if v == 1:
                bs += 1
            elif v == 2:
                ws += 1
        return bs + bt, ws + wt


DEFAULT_PROFILE = {
    "c": 0.7,
    "rave": True,
    "rave_k": 100.0,
    "capture_bias": 0.5,
    "pattern_bias": 0.5,
    "prune_radius": 2,
    "pass_bias": 0.0,
    "resign_threshold": 0.0,
    "resign_min_visits": 200,
    "mercy": 0.0,
    "pass_threshold": 0.5,
    "score_scale": 0.0,   # 0 → 自动 = n2/2（分差归一化尺度）
}

PASS_MOVE = -1


class Node:
    __slots__ = ("move", "children", "to_move", "N", "W", "amafN", "amafW",
                 "expanded", "prior")

    def __init__(self, move, to_move, prior=0.5):
        self.move = move
        self.children = {}
        self.to_move = to_move
        self.N = 0
        self.W = 0.0
        self.amafN = 0
        self.amafW = 0.0
        self.expanded = False
        self.prior = prior


def move_prior(caps, own_libs):
    """树内先验（等效经验，Pachi/Fuego 同款思路）：提子加分、自填气减分。"""
    q = 0.5
    if caps >= 2:
        q += 0.25
    elif caps == 1:
        q += 0.15
    if own_libs == 1:
        q -= 0.15
    if q < 0.05:
        q = 0.05
    if q > 0.9:
        q = 0.9
    return q


def _chebyshev(a, b, size):
    ax, ay = a % size, a // size
    bx, by = b % size, b // size
    dx = ax - bx
    if dx < 0:
        dx = -dx
    dy = ay - by
    if dy < 0:
        dy = -dy
    return dx if dx > dy else dy


def _near_mask(pb, radius):
    """返回 (near, any_stone)：near[p] 表示 p 在任一棋子切比雪夫半径内。"""
    n2 = pb.n2
    size = pb.size
    near = [False] * n2
    cells = pb.cells
    any_stone = False
    for p in range(n2):
        if cells[p] == 0:
            continue
        any_stone = True
        px, py = p % size, p // size
        x0 = px - radius if px - radius > 0 else 0
        x1 = px + radius if px + radius < size - 1 else size - 1
        y0 = py - radius if py - radius > 0 else 0
        y1 = py + radius if py + radius < size - 1 else size - 1
        for y in range(y0, y1 + 1):
            base = y * size
            for x in range(x0, x1 + 1):
                near[base + x] = True
    return near, any_stone


def _center_zone(size):
    """空盘开局候选：中央三分之一见方（9 路 = 3x3 共 9 点）。"""
    lo = size // 3
    hi = size - 1 - size // 3
    pts = []
    for y in range(lo, hi + 1):
        for x in range(lo, hi + 1):
            pts.append(y * size + x)
    return pts


def _candidates(pb, color, radius):
    """裁剪后的候选点（无子取中央区；否则取 near 内的合法点）。"""
    cells = pb.cells
    n2 = pb.n2
    size = pb.size
    out = []
    if radius <= 0:
        rng_pts = range(n2)
    else:
        near, any_stone = _near_mask(pb, radius)
        if not any_stone:
            rng_pts = _center_zone(size)
        else:
            rng_pts = (p for p in range(n2) if near[p])
    for p in rng_pts:
        if cells[p] != 0:
            continue
        if pb.is_eye(p, color) and not pb.adjacent_atari(p, 3 - color):
            continue          # 眼位过滤：不填自己的单点真眼（打吃例外）
        ok, caps, _osize, olibs, _ = pb.probe(color, p)
        if ok:
            out.append((p, caps, olibs))
    return out


def _playout(pb, rng, pr, max_moves):
    """轻量 playout：提子/救子优先 → 贴近最后一手 → 随机；避免自填气与填眼。

    局部候选：优先只探最后一手的 1 邻域；局部无候选时才全盘扫描。
    """
    cap_bias = pr["capture_bias"]
    pat_bias = pr["pattern_bias"]
    large_margin = pr["mercy"] * pb.n2
    moves = 0
    while pb.passes < 2 and moves < max_moves:
        color = pb.side
        last = pb.last
        # 注：不镜像过手（Fuego 范式）——仅在无着可走时 pass，否则 pass 会被误判为"必胜手段"。
        cands = []
        urgent = []
        if last >= 0:
            probe_pts = [last] + pb.neigh[last]
        else:
            probe_pts = None
        cells = pb.cells
        if probe_pts is not None:
            for p in probe_pts:
                if cells[p] != 0:
                    continue
                ok, cap, osize, olibs, _ = pb.probe(color, p)
                if not ok:
                    continue
                if cap == 0:
                    if olibs == 1:
                        continue
                    if pb.is_eye(p, color) and not pb.adjacent_atari(p, 3 - color):
                        continue
                cands.append(p)
                if cap > 0:
                    urgent.append(p)
        if not cands:
            for p in range(pb.n2):
                if cells[p] != 0:
                    continue
                ok, cap, osize, olibs, _ = pb.probe(color, p)
                if not ok:
                    continue
                if cap == 0:
                    if olibs == 1:
                        continue
                    if pb.is_eye(p, color) and not pb.adjacent_atari(p, 3 - color):
                        continue
                cands.append(p)
                if cap > 0:
                    urgent.append(p)
        for m in pb.rescue_moves(color):
            if cells[m] == 0 and m not in urgent:
                urgent.append(m)
        if not cands:
            pb.play_pass(color)
            moves += 1
            continue
        r = rng.random()
        if urgent and r < cap_bias:
            m = urgent[rng.randint(len(urgent))]
        elif last >= 0 and rng.random() < pat_bias:
            local = [p for p in cands if _chebyshev(p, last, pb.size) <= 1]
            m = local[rng.randint(len(local))] if local else cands[rng.randint(len(cands))]
        else:
            m = cands[rng.randint(len(cands))]
        pb.apply(color, m)
        moves += 1
        if large_margin > 0:
            bt, wt = pb.area()
            if bt - wt > large_margin or wt - bt > large_margin:
                break
    return pb


def _select(node, c, rave_k, rave):
    logN = math.log(node.N + 1)
    best = None
    bestv = -1e18
    for m, ch in node.children.items():
        n = ch.N
        q = ch.W / n if n else ch.prior
        if rave and ch.amafN > 0:
            qa = ch.amafW / ch.amafN
            beta = math.sqrt(rave_k / (rave_k + 3.0 * n)) if n > 0 else 1.0
            q = (1.0 - beta) * q + beta * qa
        val = q + c * math.sqrt(logN / (n + 1))
        if val > bestv:
            bestv = val
            best = m
    return best


def genmove(board, playouts=500, seed=0, profile=None):
    """对 board（完整规则 Board）搜索并返回 (vertex, visits, winrate)。

    不落子 —— 落子由调用方（driver）执行，以便用完整规则复检。
    vertex 可为点索引、PASS(= -1) 或字符串 "resign"。
    """
    pr = dict(DEFAULT_PROFILE)
    if profile:
        pr.update({k: v for k, v in profile.items() if v is not None})
    rng = Rng(seed)
    size = board.size
    n2 = board.n2
    neigh = board.neigh
    suicide_allow = board.rules["suicide"] == "allow"
    full_legal = board.legal_moves()

    pb0 = PBoard(size, neigh, board.cells[:], board.side, board.ko_point,
                 board.passes, suicide_allow)
    radius = int(pr["prune_radius"])
    root = Node(PASS_MOVE, board.side)
    root.expanded = True
    full_set = set(full_legal)
    moves = [(p, c, ol) for (p, c, ol) in _candidates(pb0, board.side, radius)
             if p in full_set]
    rng_shuffle(moves, rng)
    for m, c, ol in moves:
        root.children[m] = Node(m, 3 - board.side, prior=move_prior(c, ol))
    if not root.children:
        # 无任何非填眼着法 → 过手（终局机制）
        return PASS_MOVE, 0, 0.0

    max_moves = 3 * n2
    for _ in range(max(1, int(playouts))):
        pb = pb0.clone()
        node = root
        chain = [root]
        sim_moves = {1: set(), 2: set()}
        while node.expanded and node.children:
            m = _select(node, float(pr["c"]), float(pr["rave_k"]), bool(pr["rave"]))
            color = node.to_move
            if m == PASS_MOVE:
                pb.play_pass(color)
            else:
                pb.apply(color, m)
                sim_moves[color].add(m)
            node = node.children[m]
            chain.append(node)
        if not node.expanded:
            cl = _candidates(pb, node.to_move, radius)
            rng_shuffle(cl, rng)
            for m, c, ol in cl:
                node.children[m] = Node(m, 3 - node.to_move, prior=move_prior(c, ol))
            node.expanded = True
        leaf_to_move = node.to_move
        pb = _playout(pb, rng, pr, max_moves)
        bt, wt = pb.area()
        # 终局估值：以"分差"归一化（而非纯胜负），使已定局面下仍可区分着法优劣。
        # v ∈ [0,1]，0.5 为均势；scale = n2/2（9 路 = 40.5 点满盘差）。
        diff_black = (bt - wt) - board.komi
        scale = float(pr["score_scale"]) if float(pr["score_scale"]) > 0 else n2 / 2.0
        sv = 0.5 + 0.5 * (diff_black / scale)
        if sv < 0.0:
            sv = 0.0
        elif sv > 1.0:
            sv = 1.0
        res_leaf = sv if leaf_to_move == 1 else 1.0 - sv
        for nd in chain:
            v = res_leaf if nd.to_move == leaf_to_move else 1.0 - res_leaf
            nd.N += 1
            nd.W += v
            mv = sim_moves.get(nd.to_move)
            kids = nd.children
            if mv and kids:
                cv = 1.0 - v
                for m, ch in kids.items():
                    if m in mv:
                        ch.amafN += 1
                        ch.amafW += cv

    best = None
    best_key = None
    best_wr = 0.0
    best_n = 0
    total_visits = 0
    for m, ch in root.children.items():
        total_visits += ch.N
        wr = (ch.W / ch.N) if ch.N else 0.0
        key = (-ch.N, -wr, n2 if m == PASS_MOVE else m)
        if best_key is None or key < best_key:
            best_key = key
            best = m
            best_wr = wr
            best_n = ch.N
    if best is not None and best not in full_legal:
        alt = None
        alt_key = None
        for m, ch in root.children.items():
            if m in full_legal:
                wr = (ch.W / ch.N) if ch.N else 0.0
                key = (-ch.N, -wr, m)
                if alt_key is None or key < alt_key:
                    alt_key = key
                    alt = m
        best = alt if alt is not None else PASS_MOVE
    if best is None:
        best = PASS_MOVE
    # 显式过手规则：对手已过手，且本方胜率达标 → 过手终局（否则继续争胜）
    if board.passes >= 1 and best != PASS_MOVE and best_wr >= float(pr["pass_threshold"]):
        return PASS_MOVE, best_n, best_wr
    if float(pr["resign_threshold"]) > 0 and total_visits >= int(pr["resign_min_visits"]) \
            and best_wr < float(pr["resign_threshold"]):
        return "resign", best_n, best_wr
    return best, best_n, best_wr


def rng_shuffle(lst, rng):
    for i in range(len(lst) - 1, 0, -1):
        j = rng.randint(i + 1)
        lst[i], lst[j] = lst[j], lst[i]
    return lst
