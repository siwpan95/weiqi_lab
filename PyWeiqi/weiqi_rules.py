"""weiqi_rules.py — 围棋规则核心（权威参照实现）

规范来源：docs/RULES_SPEC.md（spec-v1）。本文件即"参考实现"，
其余语言（Js/Rust/C++/C#）必须与其在【规则操作】上逐位一致。
"""

MASK64 = (1 << 64) - 1
MAX_POINTS = 361
COLS = "ABCDEFGHJKLMNOPQRST"

PROFILES = {
    "cn": {"ko": "positional", "suicide": "forbid", "scoring": "area", "komi": 7.5},
    "tt": {"ko": "positional", "suicide": "allow", "scoring": "area", "komi": 7.5},
    "jp": {"ko": "simple", "suicide": "forbid", "scoring": "territory", "komi": 6.5},
}


def splitmix64(x):
    z = (x + 0x9E3779B97F4A7C15) & MASK64
    z = ((z ^ (z >> 30)) * 0xBF58476D1CE4E5B9) & MASK64
    z = ((z ^ (z >> 27)) * 0x94D049BB133111EB) & MASK64
    return (z ^ (z >> 31)) & MASK64


ZB = [[0] * MAX_POINTS for _ in range(3)]
for _c in (1, 2):
    for _p in range(MAX_POINTS):
        ZB[_c][_p] = splitmix64((_c - 1) * 1024 + _p)
SIDEKEY_W = splitmix64(4096)


def fmt_key(k):
    return "0x%016x" % k


def fmt_num(v):
    """数值格式：整数不带小数点，否则按 0.25 步长（.25/.5/.75）。"""
    q = int(round(v * 4))
    whole = abs(q) // 4
    rem = abs(q) % 4
    s = "%d%s" % (whole, {0: "", 1: ".25", 2: ".5", 3: ".75"}[rem])
    return ("-" + s) if q < 0 else s


_NEIGH_CACHE = {}


def neighbors_of(size):
    n = _NEIGH_CACHE.get(size)
    if n is None:
        n = []
        for y in range(size):
            for x in range(size):
                lst = []
                if x > 0:
                    lst.append(y * size + x - 1)
                if x < size - 1:
                    lst.append(y * size + x + 1)
                if y > 0:
                    lst.append((y - 1) * size + x)
                if y < size - 1:
                    lst.append((y + 1) * size + x)
                n.append(lst)
        _NEIGH_CACHE[size] = n
    return n


def parse_vertex(s, size):
    """返回点索引；pass → -1；非法 → ValueError(reason)。"""
    if s is None:
        raise ValueError("range")
    t = str(s).strip().upper()
    if t == "PASS":
        return -1
    if len(t) < 2:
        raise ValueError("range")
    col = COLS.find(t[0])
    if col < 0 or col >= size:
        raise ValueError("range")
    try:
        row = int(t[1:])
    except ValueError:
        raise ValueError("range")
    if row < 1 or row > size:
        raise ValueError("range")
    return (row - 1) * size + col


def format_vertex(idx, size):
    if idx < 0:
        return "pass"
    return COLS[idx % size] + str(idx // size + 1)


def parse_color(c):
    t = str(c).strip().upper()
    if t in ("B", "BLACK", "1"):
        return 1
    if t in ("W", "WHITE", "2"):
        return 2
    raise ValueError("bad color: %r" % (c,))


def color_name(c):
    return "B" if c == 1 else "W"


def normalize_rules(r=None):
    """→ dict(ko, suicide, scoring, komi)"""
    if r is None:
        r = "cn"
    if isinstance(r, str):
        p = PROFILES.get(r.strip().lower())
        if p is None:
            raise ValueError("unknown rules profile: %r" % (r,))
        return dict(p)
    if not isinstance(r, dict):
        raise ValueError("bad rules")
    out = dict(PROFILES["cn"])
    for k in ("ko", "suicide", "scoring"):
        v = r.get(k)
        if v is not None:
            out[k] = str(v).strip().lower()
    if r.get("komi") is not None:
        out["komi"] = float(r["komi"])
    if out["ko"] not in ("simple", "positional", "situational"):
        raise ValueError("bad ko: %r" % (out["ko"],))
    if out["suicide"] not in ("forbid", "allow"):
        raise ValueError("bad suicide: %r" % (out["suicide"],))
    if out["scoring"] not in ("area", "territory"):
        raise ValueError("bad scoring: %r" % (out["scoring"],))
    return out


class Board:
    """完整规则棋盘。所有规则操作必须与 docs/RULES_SPEC.md 完全一致。"""

    def __init__(self, size=9, komi=None, rules=None):
        self.size = int(size)
        if not (2 <= self.size <= 19):
            raise ValueError("bad size")
        self.n2 = self.size * self.size
        self.neigh = neighbors_of(self.size)
        self.rules = normalize_rules(rules)
        self.komi = float(self.rules["komi"] if komi is None else komi)
        self.reset()

    # ---------- 基础 ----------

    def reset(self):
        self.cells = [0] * self.n2
        self.side = 1
        self.ko_point = -1
        self.passes = 0
        self.pos_key = 0
        self.captures = [0, 0, 0]  # captures[c] = 黑/白方提掉的对方子数
        self.over = False
        self.stack = []
        self.hist_pos = {0: 1}             # multiset: posKey → count
        self.hist_sit = {(0, 1): 1}        # multiset: (posKey, side) → count
        return self

    def clone(self):
        b = Board.__new__(Board)
        b.size = self.size
        b.n2 = self.n2
        b.neigh = self.neigh
        b.rules = self.rules
        b.komi = self.komi
        b.cells = self.cells[:]
        b.side = self.side
        b.ko_point = self.ko_point
        b.passes = self.passes
        b.pos_key = self.pos_key
        b.captures = self.captures[:]
        b.over = self.over
        b.stack = list(self.stack)
        b.hist_pos = dict(self.hist_pos)
        b.hist_sit = dict(self.hist_sit)
        return b

    def set_stones(self, stones, side=1):
        """直接摆子（不校验合法性），历史重置为单条记录（RULES_SPEC §11）。"""
        self.reset()
        for item in stones:
            color, vertex = item[0], item[1]
            if isinstance(color, str):
                color = parse_color(color)
            if isinstance(vertex, str):
                vertex = parse_vertex(vertex, self.size)
            if 0 <= vertex < self.n2:
                self.cells[vertex] = color
                self.pos_key ^= ZB[color][vertex]
        self.side = side
        self.hist_pos = {self.pos_key: 1}
        self.hist_sit = {(self.pos_key, side): 1}
        return self

    def key(self):
        sit = self.pos_key ^ (SIDEKEY_W if self.side == 2 else 0)
        return self.pos_key, sit

    def is_over(self):
        return self.over

    # ---------- 棋块 ----------

    def group(self, idx, cells=None):
        if cells is None:
            cells = self.cells
        color = cells[idx]
        neigh = self.neigh
        stack = [idx]
        seen = {idx}
        members = [idx]
        libs = set()
        while stack:
            cur = stack.pop()
            for nb in neigh[cur]:
                v = cells[nb]
                if v == 0:
                    libs.add(nb)
                elif v == color and nb not in seen:
                    seen.add(nb)
                    stack.append(nb)
                    members.append(nb)
        return members, libs

    # ---------- 走子 ----------

    def _err(self, reason):
        return {"ok": False, "reason": reason, "captures": 0, "self_captured": 0,
                "key": fmt_key(self.pos_key)}

    def play(self, color, vertex):
        """color: 1/2；vertex: 点索引 或 -1(pass)。返回 dict。"""
        if self.over:
            return self._err("over")
        if color != self.side:
            return self._err("turn")
        if vertex == -1:
            rec = {"type": "pass", "prev_key": self.pos_key, "prev_side": self.side,
                   "prev_ko": self.ko_point, "prev_passes": self.passes,
                   "sit_key": None}
            self.side = 3 - color
            self.hist_sit[(self.pos_key, self.side)] = \
                self.hist_sit.get((self.pos_key, self.side), 0) + 1
            rec["sit_key"] = (self.pos_key, self.side)
            self.ko_point = -1
            self.passes += 1
            self.stack.append(rec)
            if self.passes >= 2:
                self.over = True
            return {"ok": True, "captures": 0, "self_captured": 0,
                    "key": fmt_key(self.pos_key)}
        if vertex < 0 or vertex >= self.n2:
            return self._err("range")
        if vertex == self.ko_point:
            return self._err("ko")
        if self.cells[vertex] != 0:
            return self._err("occupied")

        opp = 3 - color
        cells = self.cells
        prev_cells = cells[:]
        prev_key = self.pos_key
        prev_cap = self.captures[color]

        # 5) 落子
        cells[vertex] = color
        self.pos_key ^= ZB[color][vertex]

        # 6) 提对方
        captured = []
        seen_cap = set()
        for nb in self.neigh[vertex]:
            if cells[nb] == opp and nb not in seen_cap:
                members, libs = self.group(nb)
                if not libs:
                    for m in members:
                        seen_cap.add(m)
                    captured.extend(members)
        for m in captured:
            cells[m] = 0
            self.pos_key ^= ZB[opp][m]

        # 7) 自杀判定（提子后己方必有气，可跳过重扫）
        self_captured = []
        if not captured:
            members, libs = self.group(vertex)
            if not libs:
                if self.rules["suicide"] == "forbid":
                    self.cells = prev_cells
                    self.pos_key = prev_key
                    return self._err("suicide")
                self_captured = members
                for m in members:
                    cells[m] = 0
                    self.pos_key ^= ZB[color][m]

        # 8) 禁全同
        new_key = self.pos_key
        new_side = 3 - color
        if self.rules["ko"] == "positional" and new_key in self.hist_pos:
            self.cells = prev_cells
            self.pos_key = prev_key
            return self._err("superko")
        if self.rules["ko"] == "situational" and (new_key, new_side) in self.hist_sit:
            self.cells = prev_cells
            self.pos_key = prev_key
            return self._err("superko")

        # 9) 提交（先取快照，再改状态）
        ko_new = -1
        if len(captured) == 1:
            members, libs = self.group(vertex)
            if len(members) == 1 and len(libs) == 1:
                ko_new = captured[0]
        rec = {"type": "move", "color": color, "prev_cells": prev_cells,
               "prev_key": prev_key, "prev_side": self.side, "prev_ko": self.ko_point,
               "prev_passes": self.passes, "prev_cap": prev_cap,
               "pos_key": new_key, "sit_key": (new_key, new_side)}
        self.ko_point = ko_new
        self.captures[color] += len(captured)
        self.side = new_side
        self.passes = 0
        self.hist_pos[new_key] = self.hist_pos.get(new_key, 0) + 1
        self.hist_sit[(new_key, new_side)] = self.hist_sit.get((new_key, new_side), 0) + 1
        self.stack.append(rec)
        return {"ok": True, "captures": len(captured), "self_captured": len(self_captured),
                "key": fmt_key(new_key)}

    def undo(self):
        if not self.stack:
            return False
        rec = self.stack.pop()
        if rec["type"] == "pass":
            k = rec["sit_key"]
            if k is not None:
                n = self.hist_sit.get(k, 0) - 1
                if n <= 0:
                    self.hist_sit.pop(k, None)
                else:
                    self.hist_sit[k] = n
            self.pos_key = rec["prev_key"]
            self.side = rec["prev_side"]
            self.ko_point = rec["prev_ko"]
            self.passes = rec["prev_passes"]
        else:
            pk = rec["pos_key"]
            n = self.hist_pos.get(pk, 0) - 1
            if n <= 0:
                self.hist_pos.pop(pk, None)
            else:
                self.hist_pos[pk] = n
            k = rec["sit_key"]
            n = self.hist_sit.get(k, 0) - 1
            if n <= 0:
                self.hist_sit.pop(k, None)
            else:
                self.hist_sit[k] = n
            self.cells = rec["prev_cells"]
            self.pos_key = rec["prev_key"]
            self.captures[rec["color"]] = rec["prev_cap"]
            self.side = rec["prev_side"]
            self.ko_point = rec["prev_ko"]
            self.passes = rec["prev_passes"]
        self.over = False
        return True

    # ---------- 合法性与计分 ----------

    def legal(self, color, vertex):
        """→ (bool, reason or None)"""
        if self.over:
            return False, "over"
        if color != self.side:
            return False, "turn"
        if vertex == -1:
            return True, None
        if vertex < 0 or vertex >= self.n2:
            return False, "range"
        if vertex == self.ko_point:
            return False, "ko"
        if self.cells[vertex] != 0:
            return False, "occupied"
        b = self.clone()
        r = b.play(color, vertex)
        if r["ok"]:
            return True, None
        return False, r["reason"]

    def legal_moves(self):
        out = []
        for p in range(self.n2):
            if self.cells[p] == 0:
                ok, _ = self.legal(self.side, p)
                if ok:
                    out.append(p)
        return out

    def prisoners(self):
        return {"black": self.captures[1], "white": self.captures[2]}

    def score(self, dead=None):
        size = self.size
        n2 = self.n2
        neigh = self.neigh
        cells = self.cells
        prisoners = [0, self.captures[1], self.captures[2]]
        if dead:
            cells = cells[:]
            for item in dead:
                color, vertex = item[0], item[1]
                if isinstance(color, str):
                    color = parse_color(color)
                if isinstance(vertex, str):
                    vertex = parse_vertex(vertex, size)
                if 0 <= vertex < n2 and cells[vertex] == color:
                    cells[vertex] = 0
                    prisoners[3 - color] += 1
        seen = [False] * n2
        black_t = white_t = dame = 0
        for start in range(n2):
            if cells[start] != 0 or seen[start]:
                continue
            stack = [start]
            seen[start] = True
            region = [start]
            borders = set()
            while stack:
                cur = stack.pop()
                for nb in neigh[cur]:
                    v = cells[nb]
                    if v == 0:
                        if not seen[nb]:
                            seen[nb] = True
                            stack.append(nb)
                            region.append(nb)
                    else:
                        borders.add(v)
            if borders == {1}:
                black_t += len(region)
            elif borders == {2}:
                white_t += len(region)
            else:
                dame += len(region)
        black_stones = white_stones = 0
        for v in cells:
            if v == 1:
                black_stones += 1
            elif v == 2:
                white_stones += 1
        if self.rules["scoring"] == "area":
            black = black_stones + black_t
            white = white_stones + white_t
        else:
            black = black_t + prisoners[1]
            white = white_t + prisoners[2]
        diff = black - (white + self.komi)
        if diff == 0:
            result = "0"
        elif diff > 0:
            result = "B+" + fmt_num(diff)
        else:
            result = "W+" + fmt_num(-diff)
        return {
            "black": black, "white": white, "komi": self.komi, "dame": dame,
            "result": result,
            "black_territory": black_t, "white_territory": white_t,
            "black_stones": black_stones, "white_stones": white_stones,
            "prisoners_black": prisoners[1], "prisoners_white": prisoners[2],
        }
