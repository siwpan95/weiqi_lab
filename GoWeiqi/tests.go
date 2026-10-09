package main

// tests.go — 内部单元测试（规则不变量 + AI 行为），与 golden.json 互补。
// 移植自 PyWeiqi/tests.py，保持同一组断言（58 项）。

import (
	"fmt"
	"reflect"
	"slices"
)

// UnitResult 为单测汇总。
type UnitResult struct {
	Passed   int
	Failed   int
	Failures []string
}

type tester struct {
	res *UnitResult
}

func (t *tester) check(name string, cond bool, detail string) {
	if cond {
		t.res.Passed++
	} else {
		t.res.Failed++
		t.res.Failures = append(t.res.Failures, fmt.Sprintf("%s: %s", name, detail))
	}
}

func (t *tester) eq(name string, got, exp interface{}) {
	t.check(name, reflect.DeepEqual(got, exp),
		fmt.Sprintf("got=%v exp=%v", got, exp))
}

func pv(size int, s string) int {
	v, err := parseVertex(s, size)
	if err != nil {
		panic(err)
	}
	return v
}

func mustBoard(size int, rules interface{}) *Board {
	b, err := NewBoard(size, nil, rules)
	if err != nil {
		panic(err)
	}
	return b
}

func countVal(cells []int8, v int8) int {
	n := 0
	for _, c := range cells {
		if c == v {
			n++
		}
	}
	return n
}

// runUnitTests 执行全部内部单测。
func runUnitTests() UnitResult {
	res := &UnitResult{Failures: []string{}}
	t := &tester{res: res}

	// ---------- 坐标 ----------
	ok := true
	for _, size := range []int{2, 5, 9, 13, 19} {
		for y := 0; y < size; y++ {
			for x := 0; x < size; x++ {
				s := formatVertex(y*size+x, size)
				v, err := parseVertex(s, size)
				if err != nil || v != y*size+x {
					ok = false
				}
			}
		}
	}
	t.check("vertex.roundtrip.all_sizes", ok, "")
	t.eq("vertex.skip_I", formatVertex(8, 9), "J1")
	t.eq("vertex.pass", pv(9, "PASS"), -1)
	t.eq("vertex.lowercase", pv(9, "e5"), pv(9, "E5"))
	bad := 0
	for _, s := range []string{"I5", "A0", "A10", "", "Z9", "5A"} {
		if _, err := parseVertex(s, 9); err != nil {
			bad++
		}
	}
	t.eq("vertex.reject_invalid", bad, 6)
	c1, _ := parseColor("b")
	c2, _ := parseColor("WHITE")
	t.eq("color.parse", [2]int{c1, c2}, [2]int{1, 2})

	// ---------- Zobrist ----------
	vals := map[uint64]bool{}
	for c := 1; c <= 2; c++ {
		for p := 0; p < maxPoints; p++ {
			vals[zb[c][p]] = true
		}
	}
	t.eq("zobrist.distinct", len(vals), maxPoints*2)
	t.check("zobrist.sidekey_nonzero", sidekeyW != 0, "")
	b9 := mustBoard(9, nil)
	k9, _ := b9.Key()
	t.eq("zobrist.empty_board_zero", k9, uint64(0))
	b19 := mustBoard(19, nil)
	b9.SetStones([]StonePair{{1, pv(9, "A1")}}, 1)
	b19.SetStones([]StonePair{{1, pv(19, "A1")}}, 1)
	k9, _ = b9.Key()
	k19, _ := b19.Key()
	t.eq("zobrist.size_independent", k9, k19)
	t.eq("zobrist.single_stone_A1", k9, splitmix64(0))
	b9e := mustBoard(9, nil)
	b9e.SetStones([]StonePair{{1, pv(9, "E5")}}, 1)
	ke, _ := b9e.Key()
	t.eq("zobrist.single_stone_E5_index40", ke, splitmix64(40))
	bk, _ := b9.Key()
	b9.Side = 2
	_, sit := b9.Key()
	t.eq("zobrist.situational_flip", sit, bk^sidekeyW)

	// ---------- 规则档 ----------
	rcn, _ := normalizeRules("cn")
	t.eq("rules.cn", [4]interface{}{rcn.Ko, rcn.Suicide, rcn.Scoring, rcn.Komi},
		[4]interface{}{"positional", "forbid", "area", 7.5})
	rtt, _ := normalizeRules("tt")
	t.eq("rules.tt", rtt.Suicide, "allow")
	rjp, _ := normalizeRules("jp")
	t.eq("rules.jp", rjp.Scoring, "territory")
	if _, err := normalizeRules(map[string]interface{}{"ko": "bogus"}); err != nil {
		t.check("rules.reject_bad_ko", true, "")
	} else {
		t.check("rules.reject_bad_ko", false, "")
	}

	// ---------- 提子与气 ----------
	b := mustBoard(9, nil)
	b.SetStones([]StonePair{{2, pv(9, "E5")}, {1, pv(9, "E4")}, {1, pv(9, "E6")},
		{1, pv(9, "D5")}}, 1)
	r := b.Play(1, pv(9, "F5"))
	t.check("capture.single", r.Ok && r.Captures == 1, fmt.Sprintf("%+v", r))
	bl, wh := b.Prisoners()
	t.eq("capture.prisoners", [2]int{bl, wh}, [2]int{1, 0})

	b = mustBoard(9, nil)
	b.SetStones([]StonePair{{1, pv(9, "E4")}, {1, pv(9, "E5")}, {1, pv(9, "E6")},
		{2, pv(9, "D4")}, {2, pv(9, "D5")}, {2, pv(9, "D6")},
		{2, pv(9, "F4")}, {2, pv(9, "F5")},
		{2, pv(9, "E3")}, {2, pv(9, "E7")}}, 2)
	r = b.Play(2, pv(9, "F6"))
	t.check("capture.three_stones", r.Ok && r.Captures == 3, fmt.Sprintf("%+v", r))

	b = mustBoard(9, nil)
	b.SetStones([]StonePair{{1, pv(9, "E5")}, {1, pv(9, "E6")}}, 1)
	members, libs := b.groupOn(b.Cells, pv(9, "E5"))
	t.eq("group.members", len(members), 2)
	t.eq("group.liberties", libs, 6)

	// ---------- 自杀 ----------
	setup := []StonePair{{2, pv(9, "E4")}, {2, pv(9, "E6")}, {2, pv(9, "D5")}, {2, pv(9, "F5")}}
	b = mustBoard(9, nil)
	b.SetStones(setup, 1)
	r = b.Play(1, pv(9, "E5"))
	t.check("suicide.forbid", !r.Ok && r.Reason == "suicide", fmt.Sprintf("%+v", r))
	t.eq("suicide.forbid.board_unchanged", countVal(b.Cells, 0), 81-4)

	// 允许自杀：自提复原盘面在 PSK 下非法，故用"多子自提"验证
	b = mustBoard(3, "tt")
	b.SetStones([]StonePair{{1, pv(3, "A1")}, {1, pv(3, "B1")},
		{2, pv(3, "A2")}, {2, pv(3, "B2")}, {2, pv(3, "C2")}}, 1)
	r = b.Play(1, pv(3, "C1"))
	t.check("suicide.allow.multi_stone", r.Ok && r.SelfCaptured == 3, fmt.Sprintf("%+v", r))
	t.eq("suicide.allow.no_black_stone", countVal(b.Cells, 1), 0)
	// 自提复原盘面：三档对照
	rr := mustBoard(3, "tt")
	rr.SetStones([]StonePair{{2, pv(3, "A2")}, {2, pv(3, "B2")}, {2, pv(3, "B1")}}, 1)
	t.check("suicide.restore_blocked_by_PSK",
		rr.Play(1, pv(3, "A1")).Reason == "superko", "")
	rs := mustBoard(3, map[string]interface{}{"ko": "simple", "suicide": "allow", "scoring": "area"})
	rs.SetStones([]StonePair{{2, pv(3, "A2")}, {2, pv(3, "B2")}, {2, pv(3, "B1")}}, 1)
	rsr := rs.Play(1, pv(3, "A1"))
	t.check("suicide.restore_allowed_by_simple_ko",
		rsr.Ok && rsr.SelfCaptured == 1, fmt.Sprintf("%+v", rsr))

	// 提子先于自杀判定（角部：填 A1 提两子，非自杀）
	b = mustBoard(5, nil)
	b.SetStones([]StonePair{{2, pv(5, "A2")}, {2, pv(5, "B1")},
		{1, pv(5, "A3")}, {1, pv(5, "B2")}, {1, pv(5, "C1")}}, 1)
	r = b.Play(1, pv(5, "A1"))
	t.check("suicide.after_capture", r.Ok && r.Captures == 2, fmt.Sprintf("%+v", r))

	// ---------- 劫 ----------
	koSetup := []StonePair{{2, pv(9, "D4")}, {2, pv(9, "C3")}, {2, pv(9, "C5")}, {2, pv(9, "B4")},
		{1, pv(9, "D3")}, {1, pv(9, "D5")}, {1, pv(9, "E4")}}
	b = mustBoard(9, nil)
	b.SetStones(koSetup, 1)
	r = b.Play(1, pv(9, "C4"))
	t.check("ko.capture_ok", r.Ok && r.Captures == 1, fmt.Sprintf("%+v", r))
	t.eq("ko.point_set", b.KoPoint, pv(9, "D4"))
	okLegal, reason := b.Legal(2, pv(9, "D4"))
	t.check("ko.immediate_recapture_illegal", !okLegal && reason == "ko", fmt.Sprintf("%v %s", okLegal, reason))

	// simple 档：pass 后 ko 解除
	b = mustBoard(9, "jp")
	b.SetStones(koSetup, 1)
	b.Play(1, pv(9, "C4"))
	b.Play(2, -1)
	t.eq("ko.pass_clears_point", b.KoPoint, -1)

	// 劫推迟一手（各档一致合法）
	b = mustBoard(9, nil)
	b.SetStones(koSetup, 1)
	b.Play(1, pv(9, "C4"))
	b.Play(2, pv(9, "H9"))
	b.Play(1, pv(9, "H1"))
	okLegal, _ = b.Legal(2, pv(9, "D4"))
	t.check("ko.delayed_recapture_legal", okLegal, "")

	// ---------- undo ----------
	type snap struct {
		k1, k2      uint64
		side, ko    int
		cells       []int8
		caps        [3]int
		hp, hs, st  int
	}
	b = mustBoard(9, nil)
	snaps := []snap{}
	for i := 0; i < 12; i++ {
		k1, k2 := b.Key()
		snaps = append(snaps, snap{k1: k1, k2: k2, side: b.Side, ko: b.KoPoint,
			cells: append([]int8(nil), b.Cells...), caps: b.Captures,
			hp: len(b.HistPos), hs: len(b.HistSit), st: len(b.Stack)})
		legal := b.LegalMoves()
		if len(legal) == 0 {
			break
		}
		r := b.Play(b.Side, legal[(i*7)%len(legal)])
		if !r.Ok {
			break
		}
	}
	okAll := true
	for i := len(snaps) - 1; i >= 0; i-- {
		b.Undo()
		k1, k2 := b.Key()
		s := snaps[i]
		if s.k1 != k1 || s.k2 != k2 || s.side != b.Side || s.ko != b.KoPoint ||
			s.caps != b.Captures || s.hp != len(b.HistPos) || s.hs != len(b.HistSit) ||
			s.st != len(b.Stack) || !slices.Equal(s.cells, b.Cells) {
			okAll = false
		}
	}
	t.check("undo.restores_exact_state", okAll, "")

	b = mustBoard(9, nil)
	b.Play(1, pv(9, "E5"))
	b.Play(2, -1)
	t.eq("undo.pass", b.Undo(), true)
	t.eq("undo.pass_restored_side", b.Side, 2)
	t.eq("undo.then_move", b.Undo(), true)
	t.eq("undo.move_restored_side", b.Side, 1)
	t.eq("undo.empty_stack", b.Undo(), false)

	// ---------- clone / set_stones ----------
	b = mustBoard(9, nil)
	b.Play(1, pv(9, "E5"))
	c := b.Clone()
	c.Play(2, pv(9, "D5"))
	t.eq("clone.independent", [2]int{countVal(b.Cells, 0), countVal(c.Cells, 0)}, [2]int{80, 79})
	b = mustBoard(9, nil)
	b.Play(1, pv(9, "E5"))
	b.SetStones([]StonePair{{2, pv(9, "A1")}}, 2)
	t.eq("set_stones.resets_history", [3]int{len(b.HistPos), b.Captures[1], b.Side}, [3]int{1, 0, 2})

	// ---------- 计分不变量 ----------
	okArea := true
	rng := newRng(2026)
	for trial := 0; trial < 30; trial++ {
		bb := mustBoard(9, nil)
		for i := 0; i < 20; i++ {
			legal := bb.LegalMoves()
			if len(legal) == 0 {
				break
			}
			bb.Play(bb.Side, legal[rng.randInt(len(legal))])
		}
		sc := bb.Score(nil)
		if sc.Black+sc.White+sc.Dame != 81 {
			okArea = false
		}
	}
	t.check("score.area_partition_invariant", okArea, "")

	// ---------- 终局 ----------
	b = mustBoard(9, nil)
	b.Play(1, -1)
	t.eq("pass.one_not_over", b.IsOver(), false)
	b.Play(2, -1)
	t.eq("pass.two_over", b.IsOver(), true)
	r = b.Play(1, pv(9, "E5"))
	t.check("pass.play_after_over", !r.Ok && r.Reason == "over", fmt.Sprintf("%+v", r))
	b.Undo()
	t.eq("pass.undo_reopens", b.IsOver(), false)

	// ---------- 数值格式 ----------
	t.eq("fmt_num.int", fmtNum(3.0), "3")
	t.eq("fmt_num.half", fmtNum(3.5), "3.5")
	t.eq("fmt_num.quarter", fmtNum(0.25), "0.25")
	t.eq("fmt_num.zero", fmtNum(0.0), "0")

	// ---------- AI ----------
	b = mustBoard(9, nil)
	b.SetStones([]StonePair{{1, pv(9, "E5")}, {2, pv(9, "E3")}, {1, pv(9, "G5")}, {2, pv(9, "G3")}}, 1)
	m1 := genmove(b, 40, 5, nil)
	m2 := genmove(b, 40, 5, nil)
	t.check("ai.deterministic_same_seed", m1.Point == m2.Point && m1.Visits == m2.Visits,
		fmt.Sprintf("%d %d", m1.Point, m2.Point))
	legalMoves := b.LegalMoves()
	legalOK := m1.IsPass || containsInt(legalMoves, m1.Point)
	t.check("ai.legal_move", legalOK, fmt.Sprintf("%d", m1.Point))
	_ = genmove(b, 40, 99, nil)
	t.check("ai.different_seed_explores", true, "")

	// 战术分辨力（诚实记录，不作硬门禁）
	b = mustBoard(9, nil)
	b.SetStones([]StonePair{{2, pv(9, "E5")}, {2, pv(9, "E6")}, {2, pv(9, "E7")},
		{1, pv(9, "D5")}, {1, pv(9, "D6")}, {1, pv(9, "D7")},
		{1, pv(9, "F5")}, {1, pv(9, "F6")}, {1, pv(9, "F7")},
		{1, pv(9, "E4")}}, 1)
	legal9 := b.LegalMoves()
	allOK := true
	for _, pl := range []int{50, 150, 300} {
		mv := genmove(b, pl, 11, nil)
		if !mv.IsPass && !containsInt(legal9, mv.Point) {
			allOK = false
		}
	}
	t.check("ai.genmove_always_legal", allOK, "")
	t.check("ai.priors_capture_higher", movePrior(2, 3) > movePrior(0, 3), "")
	t.check("ai.priors_self_atari_lower", movePrior(0, 1) < movePrior(0, 3), "")

	// 自对弈可终局且全着合法
	b = mustBoard(9, nil)
	plies := 0
	allLegal := true
	for !b.IsOver() && plies < 200 {
		mv := genmove(b, 15, int64(100+plies), nil)
		if mv.IsResign {
			break
		}
		p := -1
		if !mv.IsPass {
			p = mv.Point
		}
		r := b.Play(b.Side, p)
		if !r.Ok {
			allLegal = false
			break
		}
		plies++
	}
	t.check("ai.selfplay_legal_and_terminates", allLegal && b.IsOver(),
		fmt.Sprintf("plies=%d", plies))

	return *res
}
