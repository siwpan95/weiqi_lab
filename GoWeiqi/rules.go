package main

// rules.go — 围棋规则核心（Go 移植，与 docs/RULES_SPEC.md spec-v1 逐位一致）
//
// 真相来源：docs/RULES_SPEC.md（规则）+ docs/PROTOCOL_SPEC.md（协议）+ PyWeiqi/（参考实现）。

import (
	"errors"
	"fmt"
	"math"
	"strconv"
	"strings"
)

const (
	maxPoints = 361
	cols      = "ABCDEFGHJKLMNOPQRST"
)

// Rules 为规则档（ko/suicide/scoring + komi）。
type Rules struct {
	Ko      string
	Suicide string
	Scoring string
	Komi    float64
}

// Profiles 为 §10 的三档规则组合。
var Profiles = map[string]Rules{
	"cn": {Ko: "positional", Suicide: "forbid", Scoring: "area", Komi: 7.5},
	"tt": {Ko: "positional", Suicide: "allow", Scoring: "area", Komi: 7.5},
	"jp": {Ko: "simple", Suicide: "forbid", Scoring: "territory", Komi: 6.5},
}

var (
	zb        [3][maxPoints]uint64
	sidekeyW  uint64
	neighCache = map[int][][]int{}
)

func init() {
	for c := 1; c <= 2; c++ {
		for p := 0; p < maxPoints; p++ {
			zb[c][p] = splitmix64(uint64((c-1)*1024 + p))
		}
	}
	sidekeyW = splitmix64(4096)
}

// splitmix64 严格按 RULES_SPEC §6；Go 的无符号 64 位运算溢出即 mod 2^64。
func splitmix64(x uint64) uint64 {
	z := x + 0x9E3779B97F4A7C15
	z = (z ^ (z >> 30)) * 0xBF58476D1CE4E5B9
	z = (z ^ (z >> 27)) * 0x94D049BB133111EB
	return z ^ (z >> 31)
}

func fmtKey(k uint64) string { return fmt.Sprintf("0x%016x", k) }

// fmtNum 数值格式：整数不带小数点，否则按 0.25 步长（.25/.5/.75）。
func fmtNum(v float64) string {
	q := int(math.Round(v * 4))
	a := q
	if a < 0 {
		a = -a
	}
	whole := a / 4
	rem := a % 4
	suf := [4]string{"", ".25", ".5", ".75"}[rem]
	s := strconv.Itoa(whole) + suf
	if q < 0 {
		return "-" + s
	}
	return s
}

func neighborsOf(size int) [][]int {
	if n, ok := neighCache[size]; ok {
		return n
	}
	n := make([][]int, size*size)
	for y := 0; y < size; y++ {
		for x := 0; x < size; x++ {
			idx := y*size + x
			lst := make([]int, 0, 4)
			if x > 0 {
				lst = append(lst, y*size+x-1)
			}
			if x < size-1 {
				lst = append(lst, y*size+x+1)
			}
			if y > 0 {
				lst = append(lst, (y-1)*size+x)
			}
			if y < size-1 {
				lst = append(lst, (y+1)*size+x)
			}
			n[idx] = lst
		}
	}
	neighCache[size] = n
	return n
}

// parseVertex 返回点索引；"pass" → -1；非法 → error(reason="range")。
func parseVertex(s string, size int) (int, error) {
	t := strings.ToUpper(strings.TrimSpace(s))
	if t == "PASS" {
		return -1, nil
	}
	if len(t) < 2 {
		return 0, errors.New("range")
	}
	col := strings.IndexByte(cols, t[0])
	if col < 0 || col >= size {
		return 0, errors.New("range")
	}
	row, err := strconv.Atoi(t[1:])
	if err != nil {
		return 0, errors.New("range")
	}
	if row < 1 || row > size {
		return 0, errors.New("range")
	}
	return (row-1)*size + col, nil
}

func formatVertex(idx, size int) string {
	if idx < 0 {
		return "pass"
	}
	return string(cols[idx%size]) + strconv.Itoa(idx/size+1)
}

func parseColor(c string) (int, error) {
	t := strings.ToUpper(strings.TrimSpace(c))
	switch t {
	case "B", "BLACK", "1":
		return 1, nil
	case "W", "WHITE", "2":
		return 2, nil
	}
	return 0, fmt.Errorf("bad color: %s", c)
}

func colorName(c int) string {
	if c == 1 {
		return "B"
	}
	return "W"
}

func toFloat(v interface{}) (float64, error) {
	switch t := v.(type) {
	case float64:
		return t, nil
	case float32:
		return float64(t), nil
	case int:
		return float64(t), nil
	case int64:
		return float64(t), nil
	case jsonNumberer:
		return t.Float64()
	case string:
		return strconv.ParseFloat(strings.TrimSpace(t), 64)
	}
	return 0, fmt.Errorf("bad number: %v", v)
}

// jsonNumberer 抽掉对 encoding/json 的直接依赖（rules.go 保持零外部符号）。
type jsonNumberer interface {
	Float64() (float64, error)
}

// normalizeRules 接收 string / map[string]interface{} / nil，输出 Rules。
func normalizeRules(r interface{}) (Rules, error) {
	if r == nil {
		return Profiles["cn"], nil
	}
	switch v := r.(type) {
	case Rules:
		return v, nil
	case string:
		p, ok := Profiles[strings.ToLower(strings.TrimSpace(v))]
		if !ok {
			return Rules{}, fmt.Errorf("unknown rules profile: %s", v)
		}
		return p, nil
	case map[string]interface{}:
		out := Profiles["cn"]
		for _, k := range []string{"ko", "suicide", "scoring"} {
			if raw, ok := v[k]; ok && raw != nil {
				s := strings.ToLower(strings.TrimSpace(fmt.Sprint(raw)))
				switch k {
				case "ko":
					out.Ko = s
				case "suicide":
					out.Suicide = s
				case "scoring":
					out.Scoring = s
				}
			}
		}
		if raw, ok := v["komi"]; ok && raw != nil {
			f, err := toFloat(raw)
			if err != nil {
				return Rules{}, err
			}
			out.Komi = f
		}
		if out.Ko != "simple" && out.Ko != "positional" && out.Ko != "situational" {
			return Rules{}, fmt.Errorf("bad ko: %s", out.Ko)
		}
		if out.Suicide != "forbid" && out.Suicide != "allow" {
			return Rules{}, fmt.Errorf("bad suicide: %s", out.Suicide)
		}
		if out.Scoring != "area" && out.Scoring != "territory" {
			return Rules{}, fmt.Errorf("bad scoring: %s", out.Scoring)
		}
		return out, nil
	}
	return Rules{}, errors.New("bad rules")
}

// SitKey 为情境键 (posKey, side)。
type SitKey struct {
	Key  uint64
	Side int
}

// Rec 为 undo 栈记录。
type Rec struct {
	IsPass     bool
	Color      int
	PrevCells  []int8
	PrevKey    uint64
	PrevSide   int
	PrevKo     int
	PrevPasses int
	PrevCap    int
	PosKey     uint64
	Sit        SitKey
}

// StonePair 为 (颜色, 点索引)。
type StonePair struct {
	Color  int
	Vertex int
}

// PlayResult 为走子结果。
type PlayResult struct {
	Ok           bool
	Reason       string
	Captures     int
	SelfCaptured int
	Key          string
}

// ScoreResult 字段顺序与 PyWeiqi 完全一致（跨语言差分要求）。
type ScoreResult struct {
	Black          int     `json:"black"`
	White          int     `json:"white"`
	Komi           float64 `json:"komi"`
	Dame           int     `json:"dame"`
	Result         string  `json:"result"`
	BlackTerritory int     `json:"black_territory"`
	WhiteTerritory int     `json:"white_territory"`
	BlackStones    int     `json:"black_stones"`
	WhiteStones    int     `json:"white_stones"`
	PrisonersBlack int     `json:"prisoners_black"`
	PrisonersWhite int     `json:"prisoners_white"`
}

// Board 为完整规则棋盘。
type Board struct {
	Size     int
	N2       int
	Neigh    [][]int
	Rules    Rules
	Komi     float64
	Cells    []int8
	Side     int
	KoPoint  int
	Passes   int
	PosKey   uint64
	Captures [3]int
	Over     bool
	Stack    []Rec
	HistPos  map[uint64]int
	HistSit  map[SitKey]int
}

// NewBoard 构造棋盘；komi 为 nil 时取规则档默认值。
func NewBoard(size int, komi *float64, rules interface{}) (*Board, error) {
	if size < 2 || size > 19 {
		return nil, errors.New("bad size")
	}
	rd, err := normalizeRules(rules)
	if err != nil {
		return nil, err
	}
	b := &Board{Size: size, N2: size * size, Neigh: neighborsOf(size), Rules: rd}
	if komi == nil {
		b.Komi = rd.Komi
	} else {
		b.Komi = *komi
	}
	b.Reset()
	return b, nil
}

func (b *Board) Reset() {
	b.Cells = make([]int8, b.N2)
	b.Side = 1
	b.KoPoint = -1
	b.Passes = 0
	b.PosKey = 0
	b.Captures = [3]int{}
	b.Over = false
	b.Stack = nil
	b.HistPos = map[uint64]int{0: 1}
	b.HistSit = map[SitKey]int{{Key: 0, Side: 1}: 1}
}

// Clone 深拷贝棋盘（历史与栈独立）。
func (b *Board) Clone() *Board {
	nb := *b
	nb.Cells = append([]int8(nil), b.Cells...)
	nb.Stack = append([]Rec(nil), b.Stack...)
	nb.HistPos = make(map[uint64]int, len(b.HistPos))
	for k, v := range b.HistPos {
		nb.HistPos[k] = v
	}
	nb.HistSit = make(map[SitKey]int, len(b.HistSit))
	for k, v := range b.HistSit {
		nb.HistSit[k] = v
	}
	return &nb
}

// SetStones 直接摆子（不校验合法性），历史重置为单条记录（RULES_SPEC §11）。
// 键按 PyWeiqi 的【增量 XOR】累加（同一落点重复摆放会相互抵消，cells 取最后一次），
// 以保证跨语言逐位一致（harness 生成的摆子列表可能存在重复点）。
func (b *Board) SetStones(stones []StonePair, side int) {
	b.Reset()
	for _, sp := range stones {
		if sp.Vertex >= 0 && sp.Vertex < b.N2 {
			b.Cells[sp.Vertex] = int8(sp.Color)
			b.PosKey ^= zb[sp.Color][sp.Vertex]
		}
	}
	b.Side = side
	b.HistPos = map[uint64]int{b.PosKey: 1}
	b.HistSit = map[SitKey]int{{Key: b.PosKey, Side: side}: 1}
}

// Key 返回 (posKey, sitKey)。
func (b *Board) Key() (uint64, uint64) {
	sit := b.PosKey
	if b.Side == 2 {
		sit ^= sidekeyW
	}
	return b.PosKey, sit
}

func (b *Board) groupOn(cells []int8, idx int) ([]int, int) {
	color := cells[idx]
	seen := make([]bool, b.N2)
	libSeen := make([]bool, b.N2)
	stack := []int{idx}
	seen[idx] = true
	members := []int{idx}
	nlibs := 0
	for len(stack) > 0 {
		cur := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		for _, nb := range b.Neigh[cur] {
			v := cells[nb]
			if v == 0 {
				if !libSeen[nb] {
					libSeen[nb] = true
					nlibs++
				}
			} else if v == color && !seen[nb] {
				seen[nb] = true
				stack = append(stack, nb)
				members = append(members, nb)
			}
		}
	}
	return members, nlibs
}

// placeAndResolve 在 cells 上落子并解算提子/自杀（RULES_SPEC §2 步骤 5–7）。
func (b *Board) placeAndResolve(cells []int8, color, vertex int) (captured []int, selfCap []int, ok bool) {
	opp := 3 - color
	cells[vertex] = int8(color)
	seenCap := make([]bool, b.N2)
	for _, nb := range b.Neigh[vertex] {
		if cells[nb] == int8(opp) && !seenCap[nb] {
			members, nlibs := b.groupOn(cells, nb)
			if nlibs == 0 {
				for _, m := range members {
					seenCap[m] = true
				}
				captured = append(captured, members...)
			}
		}
	}
	for _, m := range captured {
		cells[m] = 0
	}
	if len(captured) == 0 {
		members, nlibs := b.groupOn(cells, vertex)
		if nlibs == 0 {
			if b.Rules.Suicide == "forbid" {
				return nil, nil, false
			}
			selfCap = members
			for _, m := range members {
				cells[m] = 0
			}
		}
	}
	return captured, selfCap, true
}

func (b *Board) err(reason string) PlayResult {
	return PlayResult{Ok: false, Reason: reason, Key: fmtKey(b.PosKey)}
}

// Play 走子（RULES_SPEC §2）。
func (b *Board) Play(color, vertex int) PlayResult {
	if b.Over {
		return b.err("over")
	}
	if color != b.Side {
		return b.err("turn")
	}
	if vertex == -1 {
		rec := Rec{IsPass: true, PrevKey: b.PosKey, PrevSide: b.Side,
			PrevKo: b.KoPoint, PrevPasses: b.Passes}
		b.Side = 3 - color
		rec.Sit = SitKey{Key: b.PosKey, Side: b.Side}
		b.HistSit[rec.Sit]++
		b.KoPoint = -1
		b.Passes++
		b.Stack = append(b.Stack, rec)
		if b.Passes >= 2 {
			b.Over = true
		}
		return PlayResult{Ok: true, Key: fmtKey(b.PosKey)}
	}
	if vertex < 0 || vertex >= b.N2 {
		return b.err("range")
	}
	if vertex == b.KoPoint {
		return b.err("ko")
	}
	if b.Cells[vertex] != 0 {
		return b.err("occupied")
	}

	work := make([]int8, b.N2)
	copy(work, b.Cells)
	captured, selfCap, ok := b.placeAndResolve(work, color, vertex)
	if !ok {
		return b.err("suicide")
	}
	// 键按 PyWeiqi 的【增量 XOR】更新（与 put/capture/self-capture 同步），
	// 保证即使 set_stones 造成键与盘面不一致，跨语言仍逐位一致。
	newKey := b.PosKey ^ zb[color][vertex]
	for _, m := range captured {
		newKey ^= zb[3-color][m]
	}
	for _, m := range selfCap {
		newKey ^= zb[color][m]
	}
	newSide := 3 - color
	if b.Rules.Ko == "positional" {
		if _, exists := b.HistPos[newKey]; exists {
			return b.err("superko")
		}
	}
	if b.Rules.Ko == "situational" {
		if _, exists := b.HistSit[SitKey{Key: newKey, Side: newSide}]; exists {
			return b.err("superko")
		}
	}

	koNew := -1
	if len(captured) == 1 {
		members, nlibs := b.groupOn(work, vertex)
		if len(members) == 1 && nlibs == 1 {
			koNew = captured[0]
		}
	}
	rec := Rec{Color: color, PrevCells: b.Cells, PrevKey: b.PosKey, PrevSide: b.Side,
		PrevKo: b.KoPoint, PrevPasses: b.Passes, PrevCap: b.Captures[color],
		PosKey: newKey, Sit: SitKey{Key: newKey, Side: newSide}}
	b.Cells = work
	b.PosKey = newKey
	b.KoPoint = koNew
	b.Captures[color] += len(captured)
	b.Side = newSide
	b.Passes = 0
	b.HistPos[newKey]++
	b.HistSit[rec.Sit]++
	b.Stack = append(b.Stack, rec)
	return PlayResult{Ok: true, Captures: len(captured), SelfCaptured: len(selfCap),
		Key: fmtKey(newKey)}
}

func decr[K comparable](m map[K]int, k K) {
	n := m[k] - 1
	if n <= 0 {
		delete(m, k)
	} else {
		m[k] = n
	}
}

// Undo 撤销最后一手（含 pass）。
func (b *Board) Undo() bool {
	n := len(b.Stack)
	if n == 0 {
		return false
	}
	rec := b.Stack[n-1]
	b.Stack = b.Stack[:n-1]
	if rec.IsPass {
		decr(b.HistSit, rec.Sit)
		b.PosKey = rec.PrevKey
		b.Side = rec.PrevSide
		b.KoPoint = rec.PrevKo
		b.Passes = rec.PrevPasses
	} else {
		decr(b.HistPos, rec.PosKey)
		decr(b.HistSit, rec.Sit)
		b.Cells = rec.PrevCells
		b.PosKey = rec.PrevKey
		b.Captures[rec.Color] = rec.PrevCap
		b.Side = rec.PrevSide
		b.KoPoint = rec.PrevKo
		b.Passes = rec.PrevPasses
	}
	b.Over = false
	return true
}

// Legal 单点合法性 → (bool, reason or "")。
func (b *Board) Legal(color, vertex int) (bool, string) {
	if b.Over {
		return false, "over"
	}
	if color != b.Side {
		return false, "turn"
	}
	if vertex == -1 {
		return true, ""
	}
	if vertex < 0 || vertex >= b.N2 {
		return false, "range"
	}
	if vertex == b.KoPoint {
		return false, "ko"
	}
	if b.Cells[vertex] != 0 {
		return false, "occupied"
	}
	work := make([]int8, b.N2)
	copy(work, b.Cells)
	captured, selfCap, ok := b.placeAndResolve(work, color, vertex)
	if !ok {
		return false, "suicide"
	}
	newKey := b.PosKey ^ zb[color][vertex]
	for _, m := range captured {
		newKey ^= zb[3-color][m]
	}
	for _, m := range selfCap {
		newKey ^= zb[color][m]
	}
	newSide := 3 - color
	if b.Rules.Ko == "positional" {
		if _, exists := b.HistPos[newKey]; exists {
			return false, "superko"
		}
	}
	if b.Rules.Ko == "situational" {
		if _, exists := b.HistSit[SitKey{Key: newKey, Side: newSide}]; exists {
			return false, "superko"
		}
	}
	return true, ""
}

// LegalMoves 当前轮次方全部合法点（升序，不含 pass）。
func (b *Board) LegalMoves() []int {
	out := []int{}
	for p := 0; p < b.N2; p++ {
		if b.Cells[p] == 0 {
			if ok, _ := b.Legal(b.Side, p); ok {
				out = append(out, p)
			}
		}
	}
	return out
}

func (b *Board) IsOver() bool { return b.Over }

// Prisoners 返回 (黑提子数, 白提子数)。
func (b *Board) Prisoners() (int, int) { return b.Captures[1], b.Captures[2] }

// Score 计分（RULES_SPEC §9）；dead 为显式死子。
func (b *Board) Score(dead []StonePair) ScoreResult {
	cells := b.Cells
	prisoners := [3]int{0, b.Captures[1], b.Captures[2]}
	if dead != nil {
		cells = make([]int8, b.N2)
		copy(cells, b.Cells)
		for _, d := range dead {
			if d.Vertex >= 0 && d.Vertex < b.N2 && int(cells[d.Vertex]) == d.Color {
				cells[d.Vertex] = 0
				prisoners[3-d.Color]++
			}
		}
	}
	seen := make([]bool, b.N2)
	blackT, whiteT, dame := 0, 0, 0
	for start := 0; start < b.N2; start++ {
		if cells[start] != 0 || seen[start] {
			continue
		}
		stack := []int{start}
		seen[start] = true
		region := 1
		hasB, hasW := false, false
		for len(stack) > 0 {
			cur := stack[len(stack)-1]
			stack = stack[:len(stack)-1]
			for _, nb := range b.Neigh[cur] {
				v := cells[nb]
				if v == 0 {
					if !seen[nb] {
						seen[nb] = true
						stack = append(stack, nb)
						region++
					}
				} else if v == 1 {
					hasB = true
				} else if v == 2 {
					hasW = true
				}
			}
		}
		if hasB && !hasW {
			blackT += region
		} else if hasW && !hasB {
			whiteT += region
		} else {
			dame += region
		}
	}
	bs, ws := 0, 0
	for _, v := range cells {
		if v == 1 {
			bs++
		} else if v == 2 {
			ws++
		}
	}
	var black, white int
	if b.Rules.Scoring == "area" {
		black = bs + blackT
		white = ws + whiteT
	} else {
		black = blackT + prisoners[1]
		white = whiteT + prisoners[2]
	}
	diff := float64(black) - (float64(white) + b.Komi)
	var result string
	if diff == 0 {
		result = "0"
	} else if diff > 0 {
		result = "B+" + fmtNum(diff)
	} else {
		result = "W+" + fmtNum(-diff)
	}
	return ScoreResult{
		Black: black, White: white, Komi: b.Komi, Dame: dame, Result: result,
		BlackTerritory: blackT, WhiteTerritory: whiteT,
		BlackStones: bs, WhiteStones: ws,
		PrisonersBlack: prisoners[1], PrisonersWhite: prisoners[2],
	}
}
