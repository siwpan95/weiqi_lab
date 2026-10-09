package main

// ai.go — MCTS(UCT+RAVE) 引擎（Go 移植，结构等价 PyWeiqi/weiqi_ai.py）
//
// 要点（见 docs/PROTOCOL_SPEC.md §2.1 与 PORTING.md §4）：
//   - 树内与最终落子走完整规则（禁全同）；playout 允许 simple-ko 近似。
//   - 候选裁剪：切比雪夫半径；眼位过滤；空盘取中央三分之一见方。
//   - playout：局部候选（最后一手 1 邻域）+ 提子/救子优先 + 避自填气与填眼。
//   - 树内先验（提子 +、自填气 −）；分差归一化估值 v=0.5+0.5·clip(diff/scale)。
//   - 子节点用有序切片保存插入顺序，保证同 (局面, playouts, seed, profile) 可复现。
//
// 性能（PORTING §5，对齐 RustWeiqi 的做法，热路径零分配）：
//   1) 扁平邻点表 nbr[]uint16 + deg[]uint8（连续内存，免指针追逐）；
//   2) stamp 代际标记（零 set 分配）；标记与遍历用两套代际（markstamp/stamp）；
//   3) 提子预检：邻子除落点外还有空邻点则其气 ≥1；单子邻块免扫描直接提；
//   4) scan_lib 早停数气（只需 0/1/≥2 三态）；单子棋块气数 == 空邻点数；
//   5) 全部推演缓冲复用（reset_from），每次 playout 零堆分配。

import "math"

const passMove = -1

// ---------- RNG（splitmix64 流，跨语言可移植） ----------

type Rng struct{ state uint64 }

func newRng(seed int64) *Rng {
	return &Rng{state: uint64(seed) + 0x9E3779B97F4A7C15}
}

func (r *Rng) nextU64() uint64 {
	r.state += 0x9E3779B97F4A7C15
	return splitmix64(r.state)
}

func (r *Rng) randInt(n int) int {
	if n <= 0 {
		return 0
	}
	return int(r.nextU64() % uint64(n))
}

func (r *Rng) random() float64 {
	return float64(r.nextU64()>>11) * (1.0 / 9007199254740992.0)
}

// ---------- scratch：推演缓冲（复用，热路径零分配） ----------

type scratch struct {
	stamp     []int64
	libstamp  []int64
	gen       int64
	markstamp []int64
	markgen   int64
	stack     []int
	members   []int
	saveIdx   []int
	saveOld   []int8
	capBuf    []int
	near      []bool
	cands     []int
	urgent    []int
	pts       []int
	local     []int
	rescue    []int
}

func newScratch(n2 int) *scratch {
	return &scratch{
		stamp:     make([]int64, n2),
		libstamp:  make([]int64, n2),
		markstamp: make([]int64, n2),
		stack:     make([]int, 0, n2),
		members:   make([]int, 0, n2),
		saveIdx:   make([]int, 0, n2),
		saveOld:   make([]int8, 0, n2),
		capBuf:    make([]int, 0, n2),
		near:      make([]bool, n2),
		cands:     make([]int, 0, n2),
		urgent:    make([]int, 0, 64),
		pts:       make([]int, 0, 8),
		local:     make([]int, 0, 64),
		rescue:    make([]int, 0, 64),
	}
}

// ---------- 轻量棋盘（树与 playout 的高速推演） ----------

type PBoard struct {
	size         int
	n2           int
	nbr          []uint16 // 扁平邻点表：每点固定 4 槽
	deg          []uint8
	cells        []int8
	side         int
	ko           int
	passes       int
	suicideAllow bool
	last         int
	sc           *scratch
}

func newPBoard(size int, neigh [][]int, cells []int8, side, ko, passes int, suicideAllow bool) *PBoard {
	n2 := size * size
	nbr := make([]uint16, n2*4)
	deg := make([]uint8, n2)
	for p := 0; p < n2; p++ {
		l := neigh[p]
		deg[p] = uint8(len(l))
		for k, v := range l {
			nbr[p*4+k] = uint16(v)
		}
	}
	return &PBoard{
		size: size, n2: n2, nbr: nbr, deg: deg, cells: cells, side: side,
		ko: ko, passes: passes, suicideAllow: suicideAllow, last: -1,
		sc: newScratch(n2),
	}
}

// resetFrom 复用本对象的缓冲，从模板复制状态（stamp 代际单调递增，无需清零）。
func (pb *PBoard) resetFrom(other *PBoard) {
	copy(pb.cells, other.cells)
	pb.side = other.side
	pb.ko = other.ko
	pb.passes = other.passes
	pb.suicideAllow = other.suicideAllow
	pb.last = -1
}

// scan 棋块扫描 → (n_libs, lib0, member_count)；want=true 时成员写入 sc.members。
func (pb *PBoard) scan(idx int, want bool) (int, int, int) {
	sc := pb.sc
	nbr := pb.nbr
	deg := pb.deg
	cells := pb.cells
	stamp := sc.stamp
	libstamp := sc.libstamp
	stack := sc.stack
	sc.gen++
	gen := sc.gen
	color := cells[idx]
	stack = stack[:0]
	stack = append(stack, idx)
	stamp[idx] = gen
	mcount := 0
	members := sc.members
	if want {
		members = members[:0]
		members = append(members, idx)
		mcount = 1
	}
	nlibs := 0
	lib0 := -1
	for len(stack) > 0 {
		cur := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		d := int(deg[cur])
		base := cur * 4
		for k := 0; k < d; k++ {
			nb := int(nbr[base+k])
			v := cells[nb]
			if v == 0 {
				if libstamp[nb] != gen {
					libstamp[nb] = gen
					nlibs++
					if lib0 < 0 {
						lib0 = nb
					}
				}
			} else if v == color && stamp[nb] != gen {
				stamp[nb] = gen
				stack = append(stack, nb)
				if want {
					members = append(members, nb)
					mcount++
				}
			}
		}
	}
	sc.stack = stack
	if want {
		sc.members = members
	}
	return nlibs, lib0, mcount
}

// scanLib 早停数气：气数达 limit 立即返回（不建成员表）。
func (pb *PBoard) scanLib(idx, limit int) (int, int) {
	sc := pb.sc
	nbr := pb.nbr
	deg := pb.deg
	cells := pb.cells
	stamp := sc.stamp
	libstamp := sc.libstamp
	stack := sc.stack
	sc.gen++
	gen := sc.gen
	color := cells[idx]
	stack = stack[:0]
	stack = append(stack, idx)
	stamp[idx] = gen
	nlibs := 0
	lib0 := -1
	for len(stack) > 0 {
		cur := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		d := int(deg[cur])
		base := cur * 4
		for k := 0; k < d; k++ {
			nb := int(nbr[base+k])
			v := cells[nb]
			if v == 0 {
				if libstamp[nb] != gen {
					libstamp[nb] = gen
					nlibs++
					if lib0 < 0 {
						lib0 = nb
					}
					if nlibs >= limit {
						sc.stack = stack
						return nlibs, lib0
					}
				}
			} else if v == color && stamp[nb] != gen {
				stamp[nb] = gen
				stack = append(stack, nb)
			}
		}
	}
	sc.stack = stack
	return nlibs, lib0
}

// scanLibMarked 早停数气 + 用 markstamp（代际 mg）标记已访问点（跨棋块去重）。
// 遍历用独立的全新代际 stamp；markstamp 仅作跨调去重标记。
func (pb *PBoard) scanLibMarked(idx, limit int, mg int64) (int, int) {
	sc := pb.sc
	nbr := pb.nbr
	deg := pb.deg
	cells := pb.cells
	stamp := sc.stamp
	libstamp := sc.libstamp
	markstamp := sc.markstamp
	stack := sc.stack
	sc.gen++
	gen := sc.gen
	color := cells[idx]
	stack = stack[:0]
	stack = append(stack, idx)
	stamp[idx] = gen
	markstamp[idx] = mg
	nlibs := 0
	lib0 := -1
	for len(stack) > 0 {
		cur := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		d := int(deg[cur])
		base := cur * 4
		for k := 0; k < d; k++ {
			nb := int(nbr[base+k])
			v := cells[nb]
			if v == 0 {
				if libstamp[nb] != gen {
					libstamp[nb] = gen
					nlibs++
					if lib0 < 0 {
						lib0 = nb
					}
					if nlibs >= limit {
						sc.stack = stack
						return nlibs, lib0
					}
				}
			} else if v == color && stamp[nb] != gen {
				stamp[nb] = gen
				markstamp[nb] = mg
				stack = append(stack, nb)
			}
		}
	}
	sc.stack = stack
	return nlibs, lib0
}

// simulate 核心推演 → (ok, captures, own_size, own_libs, ko_new)；mutate=True 保留变化。
func (pb *PBoard) simulate(color, p int, mutate bool) (bool, int, int, int, int) {
	if p < 0 || p >= pb.n2 {
		return false, 0, 0, 0, -1
	}
	cells := pb.cells
	if cells[p] != 0 || p == pb.ko {
		return false, 0, 0, 0, -1
	}
	nbr := pb.nbr
	deg := pb.deg
	sc := pb.sc
	opp := int8(3 - color)
	sc.saveIdx = sc.saveIdx[:0]
	sc.saveOld = sc.saveOld[:0]
	sc.saveIdx = append(sc.saveIdx, p)
	sc.saveOld = append(sc.saveOld, 0)
	cells[p] = int8(color)

	sc.capBuf = sc.capBuf[:0]
	sc.markgen++
	mg := sc.markgen
	markstamp := sc.markstamp

	npdeg := int(deg[p])
	npbase := p * 4
	for k := 0; k < npdeg; k++ {
		nb := int(nbr[npbase+k])
		if cells[nb] != opp || markstamp[nb] == mg {
			continue
		}
		otherEmpty := false
		sameOpp := false
		d2 := int(deg[nb])
		b2 := nb * 4
		for j := 0; j < d2; j++ {
			q := int(nbr[b2+j])
			v := cells[q]
			if v == 0 {
				otherEmpty = true
				break
			} else if v == opp {
				sameOpp = true
			}
		}
		if otherEmpty {
			markstamp[nb] = mg
			continue
		}
		if !sameOpp {
			// 单子且除落点外无空邻 → 必被提（等价于整块扫描 nlibs==0）
			markstamp[nb] = mg
			sc.capBuf = append(sc.capBuf, nb)
			continue
		}
		// 早停：仅需判断「是否有气」
		nlibs, _ := pb.scanLibMarked(nb, 1, mg)
		if nlibs == 0 {
			_, _, mcount := pb.scan(nb, true)
			for i := 0; i < mcount; i++ {
				markstamp[sc.members[i]] = mg
			}
			for i := 0; i < mcount; i++ {
				sc.capBuf = append(sc.capBuf, sc.members[i])
			}
		}
	}
	for i := 0; i < len(sc.capBuf); i++ {
		m := sc.capBuf[i]
		sc.saveIdx = append(sc.saveIdx, m)
		sc.saveOld = append(sc.saveOld, opp)
		cells[m] = 0
	}

	empties := 0
	sameColorNb := false
	for k := 0; k < npdeg; k++ {
		v := cells[nbr[npbase+k]]
		if v == 0 {
			empties++
		} else if v == int8(color) {
			sameColorNb = true
		}
	}

	ownSize := 1
	nlibs := 0
	koNew := -1
	if empties >= 2 {
		ownSize = 1
		nlibs = empties // 下界（真实值只会更大）
	} else {
		if sameColorNb {
			ownSize = 2
		} else {
			ownSize = 1
		}
		var nl int
		if sameColorNb {
			nl, _ = pb.scanLib(p, 2)
		} else {
			nl = empties // 单子棋块：气数 == 空邻点数
		}
		nlibs = nl
		if nl == 0 {
			if !pb.suicideAllow {
				for i := len(sc.saveIdx) - 1; i >= 0; i-- {
					cells[sc.saveIdx[i]] = sc.saveOld[i]
				}
				return false, 0, 0, 0, -1
			}
			_, _, mc2 := pb.scan(p, true)
			for i := 0; i < mc2; i++ {
				m := sc.members[i]
				sc.saveIdx = append(sc.saveIdx, m)
				sc.saveOld = append(sc.saveOld, int8(color))
				cells[m] = 0
			}
		} else if len(sc.capBuf) == 1 && !sameColorNb && nl == 1 {
			koNew = sc.capBuf[0]
		}
	}

	ncap := len(sc.capBuf)
	if !mutate {
		for i := len(sc.saveIdx) - 1; i >= 0; i-- {
			cells[sc.saveIdx[i]] = sc.saveOld[i]
		}
		return true, ncap, ownSize, nlibs, koNew
	}
	pb.ko = koNew
	pb.last = p
	pb.passes = 0
	pb.side = 3 - color
	return true, ncap, ownSize, nlibs, koNew
}

func (pb *PBoard) probe(color, p int) (bool, int, int, int, int) { return pb.simulate(color, p, false) }
func (pb *PBoard) apply(color, p int) (bool, int, int, int, int) { return pb.simulate(color, p, true) }

func (pb *PBoard) playPass(color int) {
	pb.ko = -1
	pb.passes++
	pb.side = 3 - color
	pb.last = -1
}

func (pb *PBoard) isEye(p, color int) bool {
	cells := pb.cells
	nbr := pb.nbr
	d := int(pb.deg[p])
	base := p * 4
	for k := 0; k < d; k++ {
		if cells[nbr[base+k]] != int8(color) {
			return false
		}
	}
	return true
}

// adjacentAtari p 的邻点中是否存在 color 方、仅剩 1 气的棋块。
func (pb *PBoard) adjacentAtari(p, color int) bool {
	sc := pb.sc
	sc.markgen++
	mg := sc.markgen
	d := int(pb.deg[p])
	base := p * 4
	for k := 0; k < d; k++ {
		nb := int(pb.nbr[base+k])
		if pb.cells[nb] != int8(color) || sc.markstamp[nb] == mg {
			continue
		}
		empties := 0
		d2 := int(pb.deg[nb])
		b2 := nb * 4
		for j := 0; j < d2; j++ {
			if pb.cells[pb.nbr[b2+j]] == 0 {
				empties++
				if empties >= 2 {
					break
				}
			}
		}
		if empties >= 2 {
			continue
		}
		nlibs, _ := pb.scanLibMarked(nb, 2, mg)
		if nlibs == 1 {
			return true
		}
	}
	return false
}

// rescueMovesInto 最后一手附近己方被打吃棋块的救手（其唯一气），写入 sc.rescue。
func (pb *PBoard) rescueMoves(color int) []int {
	sc := pb.sc
	sc.rescue = sc.rescue[:0]
	last := pb.last
	if last < 0 {
		return sc.rescue
	}
	sc.markgen++
	mg := sc.markgen
	sc.pts = sc.pts[:0]
	sc.pts = append(sc.pts, last)
	dl := int(pb.deg[last])
	lbase := last * 4
	for k := 0; k < dl; k++ {
		sc.pts = append(sc.pts, int(pb.nbr[lbase+k]))
	}
	for i := 0; i < len(sc.pts); i++ {
		nb := sc.pts[i]
		if pb.cells[nb] != int8(color) || sc.markstamp[nb] == mg {
			continue
		}
		empties := 0
		d2 := int(pb.deg[nb])
		b2 := nb * 4
		for j := 0; j < d2; j++ {
			if pb.cells[pb.nbr[b2+j]] == 0 {
				empties++
				if empties >= 2 {
					break
				}
			}
		}
		if empties >= 2 {
			continue
		}
		nlibs, lib0 := pb.scanLibMarked(nb, 2, mg)
		if nlibs == 1 && lib0 >= 0 {
			sc.rescue = append(sc.rescue, lib0)
		}
	}
	return sc.rescue
}

// area 面积计分（盘上皆活）→ (black_area, white_area)。
func (pb *PBoard) area() (int, int) {
	sc := pb.sc
	seen := sc.near // 复用 near 作为 seen 标记
	for i := range seen {
		seen[i] = false
	}
	bt, wt := 0, 0
	for start := 0; start < pb.n2; start++ {
		if pb.cells[start] != 0 || seen[start] {
			continue
		}
		sc.stack = sc.stack[:0]
		sc.stack = append(sc.stack, start)
		seen[start] = true
		size := 1
		borders := uint8(0)
		for len(sc.stack) > 0 {
			cur := sc.stack[len(sc.stack)-1]
			sc.stack = sc.stack[:len(sc.stack)-1]
			d := int(pb.deg[cur])
			base := cur * 4
			for k := 0; k < d; k++ {
				nb := int(pb.nbr[base+k])
				v := pb.cells[nb]
				if v == 0 {
					if !seen[nb] {
						seen[nb] = true
						sc.stack = append(sc.stack, nb)
						size++
					}
				} else {
					borders |= 1 << uint(v)
				}
			}
		}
		if borders == 0b10 {
			bt += size
		} else if borders == 0b100 {
			wt += size
		}
	}
	bs, ws := 0, 0
	for _, v := range pb.cells {
		if v == 1 {
			bs++
		} else if v == 2 {
			ws++
		}
	}
	return bs + bt, ws + wt
}

// buildNear 以切比雪夫半径 radius 标记棋子邻域 → 写入 sc.near，返回是否有子。
func (pb *PBoard) buildNear(radius int) bool {
	sc := pb.sc
	for i := range sc.near {
		sc.near[i] = false
	}
	size := pb.size
	anyStone := false
	for p := 0; p < pb.n2; p++ {
		if pb.cells[p] == 0 {
			continue
		}
		anyStone = true
		px, py := p%size, p/size
		x0 := px - radius
		if x0 < 0 {
			x0 = 0
		}
		x1 := px + radius
		if x1 > size-1 {
			x1 = size - 1
		}
		y0 := py - radius
		if y0 < 0 {
			y0 = 0
		}
		y1 := py + radius
		if y1 > size-1 {
			y1 = size - 1
		}
		for y := y0; y <= y1; y++ {
			base := y * size
			for x := x0; x <= x1; x++ {
				sc.near[base+x] = true
			}
		}
	}
	return anyStone
}

func containsInt(sl []int, x int) bool {
	for _, v := range sl {
		if v == x {
			return true
		}
	}
	return false
}

// ---------- 搜索档 ----------

type Profile struct {
	C               float64
	Rave            bool
	RaveK           float64
	CaptureBias     float64
	PatternBias     float64
	PruneRadius     int
	PassBias        float64
	ResignThreshold float64
	ResignMinVisits int
	Mercy           float64
	PassThreshold   float64
	ScoreScale      float64
}

func defaultProfile() Profile {
	return Profile{
		C: 0.7, Rave: true, RaveK: 100.0, CaptureBias: 0.5, PatternBias: 0.5,
		PruneRadius: 2, PassBias: 0.0, ResignThreshold: 0.0, ResignMinVisits: 200,
		Mercy: 0.0, PassThreshold: 0.5, ScoreScale: 0.0,
	}
}

func (p *Profile) applyOverrides(m map[string]interface{}) {
	for k, v := range m {
		if v == nil {
			continue
		}
		f := 0.0
		if k != "rave" {
			var err error
			f, err = toFloat(v)
			if err != nil {
				continue
			}
		}
		switch k {
		case "c":
			p.C = f
		case "rave":
			p.Rave = toBool(v)
		case "rave_k":
			p.RaveK = f
		case "capture_bias":
			p.CaptureBias = f
		case "pattern_bias":
			p.PatternBias = f
		case "prune_radius":
			p.PruneRadius = int(f)
		case "pass_bias":
			p.PassBias = f
		case "resign_threshold":
			p.ResignThreshold = f
		case "resign_min_visits":
			p.ResignMinVisits = int(f)
		case "mercy":
			p.Mercy = f
		case "pass_threshold":
			p.PassThreshold = f
		case "score_scale":
			p.ScoreScale = f
		}
	}
}

func toBool(v interface{}) bool {
	switch t := v.(type) {
	case bool:
		return t
	case float64:
		return t != 0
	case string:
		return t == "true" || t == "1"
	}
	return false
}

// Node 树节点；children 为有序切片（保 insertion order，保证可复现）。
type Node struct {
	move     int
	children []*Node
	toMove   int
	N        int
	W        float64
	amafN    int
	amafW    float64
	expanded bool
	prior    float64
}

func newNode(move, toMove int, prior float64) *Node {
	return &Node{move: move, toMove: toMove, prior: prior}
}

func (n *Node) child(m int) *Node {
	for _, c := range n.children {
		if c.move == m {
			return c
		}
	}
	return nil
}

// movePrior 树内先验（等效经验）：提子加分、自填气减分。
func movePrior(caps, ownLibs int) float64 {
	q := 0.5
	if caps >= 2 {
		q += 0.25
	} else if caps == 1 {
		q += 0.15
	}
	if ownLibs == 1 {
		q -= 0.15
	}
	if q < 0.05 {
		q = 0.05
	}
	if q > 0.9 {
		q = 0.9
	}
	return q
}

func chebyshev(a, b, size int) int {
	ax, ay := a%size, a/size
	bx, by := b%size, b/size
	dx := ax - bx
	if dx < 0 {
		dx = -dx
	}
	dy := ay - by
	if dy < 0 {
		dy = -dy
	}
	if dx > dy {
		return dx
	}
	return dy
}

// centerZone 空盘开局候选：中央三分之一见方。
func centerZone(size int) []int {
	lo := size / 3
	hi := size - 1 - size/3
	pts := []int{}
	for y := lo; y <= hi; y++ {
		for x := lo; x <= hi; x++ {
			pts = append(pts, y*size+x)
		}
	}
	return pts
}

type cand struct {
	p    int
	caps int
	libs int
}

func consider(pb *PBoard, color, p int, out []cand) []cand {
	if pb.cells[p] != 0 {
		return out
	}
	if pb.isEye(p, color) && !pb.adjacentAtari(p, 3-color) {
		return out // 眼位过滤：不填自己的单点真眼（打吃例外）
	}
	ok, caps, _, olibs, _ := pb.probe(color, p)
	if ok {
		out = append(out, cand{p: p, caps: caps, libs: olibs})
	}
	return out
}

// candidates 裁剪后的候选点（无子取中央区；否则取 near 内的合法点）。
func candidates(pb *PBoard, color, radius int) []cand {
	out := []cand{}
	if radius <= 0 {
		for p := 0; p < pb.n2; p++ {
			out = consider(pb, color, p, out)
		}
		return out
	}
	if !pb.buildNear(radius) {
		for _, p := range centerZone(pb.size) {
			out = consider(pb, color, p, out)
		}
		return out
	}
	for p := 0; p < pb.n2; p++ {
		if pb.sc.near[p] {
			out = consider(pb, color, p, out)
		}
	}
	return out
}

// playout 轻量 playout：提子/救子优先 → 贴近最后一手 → 随机；避免自填气与填眼。
// 返回实际着数（供 bench 统计）。热路径零分配（缓冲取自 pb.sc）。
func playout(pb *PBoard, rng *Rng, pr Profile, maxMoves int) int {
	sc := pb.sc
	capBias := pr.CaptureBias
	patBias := pr.PatternBias
	largeMargin := pr.Mercy * float64(pb.n2)
	moves := 0
	for pb.passes < 2 && moves < maxMoves {
		color := pb.side
		last := pb.last
		cands := sc.cands[:0]
		urgent := sc.urgent[:0]

		// 局部候选：最后一手 + 其 1 邻域
		sc.pts = sc.pts[:0]
		if last >= 0 {
			sc.pts = append(sc.pts, last)
			dl := int(pb.deg[last])
			lbase := last * 4
			for k := 0; k < dl; k++ {
				sc.pts = append(sc.pts, int(pb.nbr[lbase+k]))
			}
		}
		for i := 0; i < len(sc.pts); i++ {
			p := sc.pts[i]
			if pb.cells[p] != 0 || p == pb.ko {
				continue
			}
			// 眼点必无提子（cap==0）；若无邻近敌方打吃，可直接剔除而免去 probe。
			// 下方 probe 不改盘面，故此处结果对 cap==0 分支仍然有效（无需重复计算）。
			eye := pb.isEye(p, color)
			if eye && !pb.adjacentAtari(p, 3-color) {
				continue
			}
			ok, cap, _, olibs, _ := pb.probe(color, p)
			if !ok {
				continue
			}
			if cap == 0 {
				if olibs == 1 {
					continue
				}
				if eye && !pb.adjacentAtari(p, 3-color) {
					continue
				}
			}
			cands = append(cands, p)
			if cap > 0 {
				urgent = append(urgent, p)
			}
		}
		if len(cands) == 0 {
			for p := 0; p < pb.n2; p++ {
				if pb.cells[p] != 0 || p == pb.ko {
					continue
				}
				eye := pb.isEye(p, color)
				if eye && !pb.adjacentAtari(p, 3-color) {
					continue
				}
				ok, cap, _, olibs, _ := pb.probe(color, p)
				if !ok {
					continue
				}
				if cap == 0 {
					if olibs == 1 {
						continue
					}
					if eye && !pb.adjacentAtari(p, 3-color) {
						continue
					}
				}
				cands = append(cands, p)
				if cap > 0 {
					urgent = append(urgent, p)
				}
			}
		}
		rescue := pb.rescueMoves(color)
		for _, m := range rescue {
			if pb.cells[m] == 0 && !containsInt(urgent, m) {
				urgent = append(urgent, m)
			}
		}
		if len(cands) == 0 {
			pb.playPass(color)
			moves++
			continue
		}
		r := rng.random()
		var m int
		if len(urgent) > 0 && r < capBias {
			m = urgent[rng.randInt(len(urgent))]
		} else if last >= 0 && rng.random() < patBias {
			local := sc.local[:0]
			for _, p := range cands {
				if chebyshev(p, last, pb.size) <= 1 {
					local = append(local, p)
				}
			}
			if len(local) > 0 {
				m = local[rng.randInt(len(local))]
			} else {
				m = cands[rng.randInt(len(cands))]
			}
		} else {
			m = cands[rng.randInt(len(cands))]
		}
		pb.apply(color, m)
		moves++
		if largeMargin > 0 {
			bt, wt := pb.area()
			if float64(bt-wt) > largeMargin || float64(wt-bt) > largeMargin {
				break
			}
		}
	}
	return moves
}

// selectMove UCT + RAVE 选择。
func selectMove(node *Node, c, raveK float64, rave bool) int {
	logN := math.Log(float64(node.N) + 1)
	best := passMove
	bestv := -1e18
	for _, ch := range node.children {
		n := ch.N
		var q float64
		if n > 0 {
			q = ch.W / float64(n)
		} else {
			q = ch.prior
		}
		if rave && ch.amafN > 0 {
			qa := ch.amafW / float64(ch.amafN)
			var beta float64
			if n > 0 {
				beta = math.Sqrt(raveK / (raveK + 3.0*float64(n)))
			} else {
				beta = 1.0
			}
			q = (1.0-beta)*q + beta*qa
		}
		val := q + c*math.Sqrt(logN/float64(n+1))
		if val > bestv {
			bestv = val
			best = ch.move
		}
	}
	return best
}

func rngShuffle(lst []cand, rng *Rng) {
	for i := len(lst) - 1; i > 0; i-- {
		j := rng.randInt(i + 1)
		lst[i], lst[j] = lst[j], lst[i]
	}
}

func keyLess(a, b [3]float64) bool {
	for i := 0; i < 3; i++ {
		if a[i] < b[i] {
			return true
		}
		if a[i] > b[i] {
			return false
		}
	}
	return false
}

// AIMove 搜索结果：点 / 过手 / 认输。
type AIMove struct {
	IsResign bool
	IsPass   bool
	Point    int
	Visits   int
	Winrate  float64
}

// genmove 对 board 搜索并返回着法（不落子，由调用方用完整规则复检）。
func genmove(board *Board, playouts int, seed int64, profile map[string]interface{}) AIMove {
	pr := defaultProfile()
	if profile != nil {
		pr.applyOverrides(profile)
	}
	rng := newRng(seed)
	n2 := board.N2
	suicideAllow := board.Rules.Suicide == "allow"
	fullLegal := board.LegalMoves()
	cells0 := make([]int8, board.N2)
	copy(cells0, board.Cells)
	pb0 := newPBoard(board.Size, board.Neigh, cells0, board.Side, board.KoPoint, board.Passes, suicideAllow)
	radius := pr.PruneRadius
	root := newNode(passMove, board.Side, 0.5)
	root.expanded = true
	fullSet := make(map[int]bool, len(fullLegal))
	for _, p := range fullLegal {
		fullSet[p] = true
	}
	cl := candidates(pb0, board.Side, radius)
	moves := make([]cand, 0, len(cl))
	for _, c := range cl {
		if fullSet[c.p] {
			moves = append(moves, c)
		}
	}
	rngShuffle(moves, rng)
	for _, c := range moves {
		root.children = append(root.children, newNode(c.p, 3-board.Side, movePrior(c.caps, c.libs)))
	}
	if len(root.children) == 0 {
		return AIMove{IsPass: true, Visits: 0, Winrate: 0.0}
	}

	maxMoves := 3 * n2
	if playouts < 1 {
		playouts = 1
	}
	work := newPBoard(board.Size, board.Neigh, make([]int8, board.N2), board.Side,
		board.KoPoint, board.Passes, suicideAllow)
	simMoves := map[int]map[int]bool{1: {}, 2: {}}
	for it := 0; it < playouts; it++ {
		work.resetFrom(pb0)
		node := root
		chain := []*Node{root}
		simMoves[1] = clearSet(simMoves[1])
		simMoves[2] = clearSet(simMoves[2])
		for node.expanded && len(node.children) > 0 {
			m := selectMove(node, pr.C, pr.RaveK, pr.Rave)
			color := node.toMove
			if m == passMove {
				work.playPass(color)
			} else {
				work.apply(color, m)
				simMoves[color][m] = true
			}
			node = node.child(m)
			chain = append(chain, node)
		}
		if !node.expanded {
			cl := candidates(work, node.toMove, radius)
			rngShuffle(cl, rng)
			for _, c := range cl {
				node.children = append(node.children, newNode(c.p, 3-node.toMove, movePrior(c.caps, c.libs)))
			}
			node.expanded = true
		}
		leafToMove := node.toMove
		playout(work, rng, pr, maxMoves)
		bt, wt := work.area()
		// 分差归一化估值（非纯胜负），使已定局面下仍可区分着法优劣。
		diffBlack := float64(bt-wt) - board.Komi
		scale := pr.ScoreScale
		if scale <= 0 {
			scale = float64(n2) / 2.0
		}
		sv := 0.5 + 0.5*(diffBlack/scale)
		if sv < 0.0 {
			sv = 0.0
		} else if sv > 1.0 {
			sv = 1.0
		}
		resLeaf := sv
		if leafToMove != 1 {
			resLeaf = 1.0 - sv
		}
		for _, nd := range chain {
			v := 1.0 - resLeaf
			if nd.toMove == leafToMove {
				v = resLeaf
			}
			nd.N++
			nd.W += v
			mv := simMoves[nd.toMove]
			if len(mv) > 0 && len(nd.children) > 0 {
				cv := 1.0 - v
				for _, ch := range nd.children {
					if mv[ch.move] {
						ch.amafN++
						ch.amafW += cv
					}
				}
			}
		}
	}

	best := passMove
	bestSet := false
	var bestKey [3]float64
	bestWr := 0.0
	bestN := 0
	totalVisits := 0
	for _, ch := range root.children {
		totalVisits += ch.N
		wr := 0.0
		if ch.N > 0 {
			wr = ch.W / float64(ch.N)
		}
		idx := ch.move
		if ch.move == passMove {
			idx = n2
		}
		key := [3]float64{-float64(ch.N), -wr, float64(idx)}
		if !bestSet || keyLess(key, bestKey) {
			bestSet = true
			bestKey = key
			best = ch.move
			bestWr = wr
			bestN = ch.N
		}
	}
	if !bestSet {
		best = passMove
	}
	if best != passMove && !fullSet[best] {
		alt := passMove
		altSet := false
		var altKey [3]float64
		for _, ch := range root.children {
			if fullSet[ch.move] {
				wr := 0.0
				if ch.N > 0 {
					wr = ch.W / float64(ch.N)
				}
				key := [3]float64{-float64(ch.N), -wr, float64(ch.move)}
				if !altSet || keyLess(key, altKey) {
					altSet = true
					altKey = key
					alt = ch.move
				}
			}
		}
		if altSet {
			best = alt
		} else {
			best = passMove
		}
	}
	// 显式过手规则：对手已过手且本方估值达标 → 过手终局。
	if board.Passes >= 1 && best != passMove && bestWr >= pr.PassThreshold {
		return AIMove{IsPass: true, Visits: bestN, Winrate: bestWr}
	}
	if pr.ResignThreshold > 0 && totalVisits >= pr.ResignMinVisits && bestWr < pr.ResignThreshold {
		return AIMove{IsResign: true, Visits: bestN, Winrate: bestWr}
	}
	if best == passMove {
		return AIMove{IsPass: true, Visits: bestN, Winrate: bestWr}
	}
	return AIMove{Point: best, Visits: bestN, Winrate: bestWr}
}

func clearSet(m map[int]bool) map[int]bool {
	for k := range m {
		delete(m, k)
	}
	return m
}

// benchPlayouts 纯 playout 吞吐基准 → (总着数, 秒数)。
func benchPlayouts(board *Board, iters int, seed int64) (int, float64) {
	pr := defaultProfile()
	rng := newRng(seed)
	cells0 := make([]int8, board.N2)
	copy(cells0, board.Cells)
	base := newPBoard(board.Size, board.Neigh, cells0, board.Side, board.KoPoint,
		board.Passes, board.Rules.Suicide == "allow")
	work := newPBoard(board.Size, board.Neigh, make([]int8, board.N2), board.Side,
		board.KoPoint, board.Passes, board.Rules.Suicide == "allow")
	totalMoves := 0
	start := nowSeconds()
	for i := 0; i < iters; i++ {
		work.resetFrom(base)
		totalMoves += playout(work, rng, pr, 3*board.N2)
	}
	return totalMoves, nowSeconds() - start
}
