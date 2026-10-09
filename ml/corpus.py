#!/usr/bin/env python
# ml/corpus.py —— 语料读取 + 逐局 replay + 样本/特征构造（Tier 3 / CNN 路线）
#
# 依赖：仅 numpy（本目录破例引入；引擎与 tools/ 保持零依赖）。
#
# 坐标口径与引擎 / tournament/referee.mjs **完全一致**：
#   vertex = (row - 1) * size + col，COLS = "ABCDEFGHJKLMNOPQRST"（无 I），
#   y（row）自下而上：vertex 越小越靠下。盘外/非法用 -1（pass）。
#   语料每行：{"size", "komi", "black", "white", "result", "plies", "broken",
#              "moves": ["BE5", "WF3", ..., "Bpass"]}
#
# 样本定义（与 tools/train_markov.mjs 的 loadCorpus 一致）：
#   对每一局逐手 replay；当某手 v>=0 且存在上一手 last>=0 且轮到该方时，
#   记一条样本 (盘面=落子前的 cells, 应手方=toMove, 最后一手=last, 目标=next=v)。
#   pass 手不作为样本（与 Markov 评测口径一致）。
#
# 特征（C_IN 个 (size,size) 平面，y 行优先）：
#   0 己方子(toMove)   1 对方子   2 空点   3 最后一手(one-hot)   4 应手方(常数平面)   5 线位(到边距离)

import glob
import numpy as np

COLS = "ABCDEFGHJKLMNOPQRST"
C_IN = 6


def parse_vertex(s, size):
    """引擎风格顶点串 → 索引；非法抛 ValueError。"""
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
    row = int(t[1:])
    if row < 1 or row > size:
        raise ValueError("range")
    return (row - 1) * size + col


def format_vertex(i, size):
    if i < 0:
        return "pass"
    return COLS[i % size] + str(i // size + 1)


# ------------------------------------------------------------------ 规则复演
# 忠实镜像 tournament/referee.mjs 的 cn 档案：positional ko / forbid suicide / area 计分。
# 复演只为得到正确的盘面（用于特征），并校验语料手数的合法性。
class Board:
    def __init__(self, size):
        self.size = int(size)
        self.n2 = self.size * self.size
        self.cells = [0] * self.n2
        self.side = 1
        self.ko = -1
        self.passes = 0
        self.over = False
        self._key_set = set()
        self._key_set.add(self._key())

    def _key(self):
        return "".join(map(str, self.cells))

    def _neighbors(self, i):
        size = self.size
        x = i % size
        y = i // size
        out = []
        if x > 0:
            out.append(i - 1)
        if x < size - 1:
            out.append(i + 1)
        if y > 0:
            out.append(i - size)
        if y < size - 1:
            out.append(i + size)
        return out

    def _group(self, idx, cells):
        c = cells[idx]
        members = [idx]
        seen = {idx}
        stack = [idx]
        libs = set()
        while stack:
            cur = stack.pop()
            for nb in self._neighbors(cur):
                v = cells[nb]
                if v == 0:
                    libs.add(nb)
                elif v == c and nb not in seen:
                    seen.add(nb)
                    stack.append(nb)
                    members.append(nb)
        return members, libs

    def play(self, color, vertex):
        """返回 {ok, reason?, pass?, captures?}；与 referee.play 语义一致。"""
        if self.over:
            return {"ok": False, "reason": "over"}
        if color != self.side:
            return {"ok": False, "reason": "turn"}
        if vertex == -1:
            self.side = 3 - color
            self.ko = -1
            self.passes += 1
            if self.passes >= 2:
                self.over = True
            return {"ok": True, "pass": True, "captures": 0}
        if vertex < 0 or vertex >= self.n2:
            return {"ok": False, "reason": "range"}
        if vertex == self.ko:
            return {"ok": False, "reason": "ko"}
        if self.cells[vertex] != 0:
            return {"ok": False, "reason": "occupied"}
        opp = 3 - color
        cells = self.cells[:]
        cells[vertex] = color
        captured = []
        seen = set()
        for nb in self._neighbors(vertex):
            if cells[nb] == opp and nb not in seen:
                members, libs = self._group(nb, cells)
                seen.update(members)
                if not libs:
                    captured.extend(members)
        for m in captured:
            cells[m] = 0
        own_members, own_libs = self._group(vertex, cells)
        if not own_libs:
            return {"ok": False, "reason": "suicide"}  # cn：禁止自杀
        key = "".join(map(str, cells))
        if key in self._key_set:  # positional superko（禁全同）
            return {"ok": False, "reason": "superko"}
        ko_new = -1
        if len(captured) == 1:
            g2m, g2l = self._group(vertex, cells)
            if len(g2m) == 1 and len(g2l) == 1:
                ko_new = captured[0]
        self.cells = cells
        self._key_set.add(key)
        self.ko = ko_new
        self.passes = 0
        self.side = 3 - color
        return {"ok": True, "captures": len(captured)}


# ------------------------------------------------------------------ 语料读取
def read_games(path, size=None):
    """读单个 jsonl → 局列表；games[i] = {size, komi, moves:[(color 1/2, vertex)]}。"""
    games = []
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            g = _json_loads(line)
            if size is not None and int(g.get("size", size)) != int(size):
                continue
            moves = []
            for s in g["moves"]:
                color = 1 if s[0] == "B" else 2
                vertex = parse_vertex(s[1:], int(g["size"]))
                moves.append((color, vertex))
            games.append({
                "size": int(g["size"]), "komi": g.get("komi"),
                "black": g.get("black"), "white": g.get("white"),
                "result": g.get("result"), "broken": g.get("broken"),
                "moves": moves,
            })
    return games


def _json_loads(line):
    import json
    return json.loads(line)


def resolve_corpus(arg):
    """--corpus 支持：单文件 / 逗号分隔 / glob（如 spec/games/human-*.jsonl）。"""
    pats = [p.strip() for p in str(arg).split(",") if p.strip()]
    out = []
    for p in pats:
        hits = sorted(glob.glob(p)) if any(c in p for c in "*?[") else [p]
        out.extend(h for h in hits if h)
    return out


# ------------------------------------------------------------------ 样本抽取
def game_samples(moves, size, strict=False):
    """逐手 replay → 样本列表 [(cells_before(list), toMove, last, next), ...]。
    strict=True 时遇非法手抛错（用于校验语料）。用法与 train_markov.loadCorpus 对齐。"""
    board = Board(size)
    samples = []
    last = -1
    for color, vertex in moves:
        if board.over:
            break
        if board.side != color:
            if strict:
                raise ValueError(f"turn mismatch: expect side {board.side}, got {color}")
            break
        if vertex >= 0 and last >= 0:
            samples.append((board.cells, color, last, vertex))
        r = board.play(color, vertex)
        if not r.get("ok"):
            if strict:
                raise ValueError(f"illegal move color={color} v={vertex}: {r.get('reason')}")
            break
        last = vertex
    return samples


def _line_plane(size):
    """线位平面：到最近边的距离 +1（0 起）。"""
    idx = np.arange(size)
    dist = np.minimum(idx, size - 1 - idx)  # (size,)
    line = np.minimum(dist[:, None], dist[None, :])  # [y,x]
    return (line + 1).astype(np.uint8)


def make_planes(cells_flat, size, toMove, last, line_plane):
    """(C_IN, size, size) uint8 平面。cells_flat 为长度 size*size 的 0/1/2 列表。"""
    cells = np.asarray(cells_flat, dtype=np.uint8).reshape(size, size)  # [y,x]
    P = np.empty((C_IN, size, size), dtype=np.uint8)
    P[0] = (cells == toMove)
    P[1] = (cells == (3 - toMove))
    P[2] = (cells == 0)
    P[3] = 0
    if last >= 0:
        ly, lx = divmod(last, size)
        P[3, ly, lx] = 1
    P[4] = 1 if toMove == 1 else 0
    P[5] = line_plane
    return P


class Dataset:
    """打包好的数据集：X(N,C,H,W uint8) / Y(N,) / game(N,) + 按局划分索引。"""

    def __init__(self, X, Y, game, num_games, cut, size, sources):
        self.X = X
        self.Y = Y
        self.game = game
        self.num_games = num_games
        self.cut = cut          # 训练 = game < cut；留出 = game >= cut
        self.size = size
        self.sources = sources

    def split(self, val_frac=0.2):
        cut = int(np.floor(self.num_games * (1.0 - val_frac)))
        cut = max(1, min(cut, max(1, self.num_games - 1))) if self.num_games > 1 else self.num_games
        train = np.where(self.game < cut)[0]
        val = np.where(self.game >= cut)[0]
        return train, val, cut

    def stats(self):
        return {
            "size": self.size, "num_games": self.num_games,
            "num_samples": int(self.X.shape[0]),
            "sources": self.sources,
        }


def build_dataset(corpus_arg, size, max_games=None, max_positions=None, strict_replay=False):
    """读取语料 → Dataset。max_games/max_positions 控制规模（早停）。
    strict_replay=False（默认）：遇同色/非法手即停该局并跳过（个别脏记录，如 PGD 首手为白）。"""
    paths = resolve_corpus(corpus_arg)
    if not paths:
        raise FileNotFoundError(f"未找到语料文件: {corpus_arg}")
    line_plane = _line_plane(size)
    Xs, Ys, Gs = [], [], []
    n = 0
    gid = 0
    used_games = 0
    for path in paths:
        games = read_games(path, size=size)
        for g in games:
            if max_games is not None and used_games >= max_games:
                break
            if max_positions is not None and n >= max_positions:
                break
            samples = game_samples(g["moves"], size, strict=strict_replay)
            if not samples:
                continue
            for (cells, toMove, last, nxt) in samples:
                if max_positions is not None and n >= max_positions:
                    break
                Xs.append(make_planes(cells, size, toMove, last, line_plane))
                Ys.append(nxt)
                Gs.append(gid)
                n += 1
            gid += 1
            used_games += 1
        if (max_games is not None and used_games >= max_games) or (
                max_positions is not None and n >= max_positions):
            break
    if n == 0:
        raise ValueError("语料为空（size 过滤后无样本）")
    X = np.stack(Xs).astype(np.uint8)
    Y = np.asarray(Ys, dtype=np.int64)
    G = np.asarray(Gs, dtype=np.int64)
    ds = Dataset(X, Y, G, gid, int(np.floor(gid * 0.8)), size, paths)
    return ds


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser(description="ml/corpus.py 自检：语料 → 样本统计")
    ap.add_argument("--corpus", required=True)
    ap.add_argument("--size", type=int, required=True)
    ap.add_argument("--max-games", type=int, default=None)
    ap.add_argument("--max-positions", type=int, default=None)
    a = ap.parse_args()
    ds = build_dataset(a.corpus, a.size, a.max_games, a.max_positions)
    tr, va, cut = ds.split()
    print("dataset:", ds.stats())
    print(f"训练样本 {len(tr)} / 留出样本 {len(va)}（cut game={cut}）")
    print("特征 shape:", ds.X.shape, "dtype", ds.X.dtype)
    print("首样本占用点:", int((ds.X[0, 2] == 0).sum()), "/", a.size * a.size)
