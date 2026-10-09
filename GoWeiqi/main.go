package main

// main.go — GoWeiqi CLI
//
// 用法：
//     goweiqi test        # 黄金值 + 内部单测（验收门）
//     goweiqi selftest    # 仅黄金值
//     goweiqi driver      # JSON-stdio 驱动模式（harness/tournament 用）
//     goweiqi selfplay N  # 自对弈 N 手（冒烟）
//     goweiqi bench [N]   # 开发基准：genmove + 纯 playout 吞吐

import (
	"encoding/json"
	"fmt"
	"os"
	"strconv"
	"time"
)

func nowSeconds() float64 { return float64(time.Now().UnixNano()) / 1e9 }

func main() {
	args := os.Args[1:]
	mode := "test"
	if len(args) > 0 {
		mode = args[0]
	}
	switch mode {
	case "driver":
		os.Exit(runDriver())
	case "test", "selftest":
		os.Exit(runSelftest(mode == "test"))
	case "selfplay":
		os.Exit(runSelfplay(args))
	case "bench":
		os.Exit(runBench(args))
	default:
		fmt.Println("usage: goweiqi test|selftest|driver|selfplay [n] [playouts]|bench [playouts]")
		os.Exit(2)
	}
}

func runSelftest(includeUnit bool) int {
	t0 := nowSeconds()
	g, err := runGolden(defaultGoldenPath())
	if err != nil {
		fmt.Printf("FAIL: %v\n", err)
		return 1
	}
	up, uf := 0, 0
	var unitFailures []string
	if includeUnit {
		u := runUnitTests()
		up, uf = u.Passed, u.Failed
		unitFailures = u.Failures
	}
	gp, gf := g.Passed, g.Failed
	total := gp + gf + up + uf
	for i, f := range g.Failures {
		if i >= 10 {
			break
		}
		b, _ := json.Marshal(f)
		fmt.Printf("  GOLDEN FAIL %s\n", string(b))
	}
	for i, f := range unitFailures {
		if i >= 10 {
			break
		}
		fmt.Printf("  UNIT   FAIL %s\n", f)
	}
	ok := gf == 0 && uf == 0
	status := "FAIL"
	if ok {
		status = "PASS"
	}
	fmt.Printf("%s: %d passed, %d failed (golden %d/%d, unit %d/%d) %.2fs\n",
		status, total-gf-uf, gf+uf, gp, gp+gf, up, up+uf, nowSeconds()-t0)
	if ok {
		return 0
	}
	return 1
}

func runSelfplay(args []string) int {
	n := 60
	if len(args) > 1 {
		if v, err := strconv.Atoi(args[1]); err == nil {
			n = v
		}
	}
	playouts := 30
	if len(args) > 2 {
		if v, err := strconv.Atoi(args[2]); err == nil {
			playouts = v
		}
	}
	b, _ := NewBoard(9, nil, nil)
	t0 := nowSeconds()
	played := 0
	for !b.IsOver() && played < n {
		g := genmove(b, playouts, int64(played*17+1), nil)
		if g.IsResign {
			fmt.Printf("ply %d: resign\n", played)
			break
		}
		mv := -1
		if !g.IsPass {
			mv = g.Point
		}
		r := b.Play(b.Side, mv)
		if !r.Ok {
			fmt.Printf("illegal pick: %s\n", r.Reason)
			return 1
		}
		played++
	}
	sc := b.Score(nil)
	fmt.Printf("selfplay plies=%d over=%v result=%s black=%d white=%d dame=%d %.1fs\n",
		played, b.IsOver(), sc.Result, sc.Black, sc.White, sc.Dame, nowSeconds()-t0)
	return 0
}

func runBench(args []string) int {
	playouts := 20000
	if len(args) > 1 {
		if v, err := strconv.Atoi(args[1]); err == nil {
			playouts = v
		}
	}
	// 9 路中盘局面（与 Rust bench 同型）
	b, _ := NewBoard(9, nil, nil)
	setup := []struct {
		c int
		v string
	}{
		{1, "D4"}, {1, "F4"}, {1, "E3"}, {2, "F6"}, {2, "E6"},
		{1, "G7"}, {2, "D7"}, {1, "C6"}, {2, "H3"},
	}
	pairs := []StonePair{}
	for _, s := range setup {
		v, _ := parseVertex(s.v, 9)
		pairs = append(pairs, StonePair{Color: s.c, Vertex: v})
	}
	b.SetStones(pairs, 1)

	t0 := nowSeconds()
	g := genmove(b, playouts, 1, nil)
	el := nowSeconds() - t0
	fmt.Printf("bench genmove playouts=%d %.3fs  %.0f playouts/s  (visits=%d)\n",
		playouts, el, float64(playouts)/el, g.Visits)

	iters := 20000
	if len(args) > 2 {
		if v, err := strconv.Atoi(args[2]); err == nil {
			iters = v
		}
	}
	moves, secs := benchPlayouts(b, iters, 1)
	fmt.Printf("bench playout iters=%d moves=%d %.3fs  %.0f playouts/s  %.1f M moves/s\n",
		iters, moves, secs, float64(iters)/secs, float64(moves)/secs/1e6)
	return 0
}
