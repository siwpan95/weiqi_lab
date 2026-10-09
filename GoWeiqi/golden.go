package main

// golden.go — 黄金值用例执行器（数据源 spec/golden.json，只读）。

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
)

type goldenFile struct {
	Cases []goldenCase `json:"cases"`
}

type goldenCase struct {
	ID     string                 `json:"id"`
	Op     string                 `json:"op"`
	Setup  setupSpec              `json:"setup"`
	Args   map[string]interface{} `json:"args"`
	Expect map[string]interface{} `json:"expect"`
}

type setupSpec struct {
	Size    *int            `json:"size"`
	Komi    *float64        `json:"komi"`
	Rules   interface{}     `json:"rules"`
	Stones  [][]interface{} `json:"stones"`
	Moves   [][]interface{} `json:"moves"`
	Side    string          `json:"side"`
	KoPoint interface{}     `json:"ko_point"`
	Dead    [][]interface{} `json:"dead"`
}

// GoldenResult 字段顺序与 PyWeiqi 一致。
type GoldenResult struct {
	Passed   int           `json:"passed"`
	Failed   int           `json:"failed"`
	Total    int           `json:"total"`
	Failures []interface{} `json:"failures"`
}

func stonesFromPairs(pairs [][]interface{}, size int) ([]StonePair, error) {
	out := []StonePair{}
	for _, it := range pairs {
		if len(it) < 2 {
			continue
		}
		c, err := parseColor(fmt.Sprint(it[0]))
		if err != nil {
			return nil, err
		}
		v, err := parseVertex(fmt.Sprint(it[1]), size)
		if err != nil {
			return nil, err
		}
		out = append(out, StonePair{Color: c, Vertex: v})
	}
	return out, nil
}

func buildBoard(setup setupSpec) (*Board, error) {
	size := 9
	if setup.Size != nil {
		size = *setup.Size
	}
	b, err := NewBoard(size, setup.Komi, setup.Rules)
	if err != nil {
		return nil, err
	}
	if setup.Stones != nil {
		pairs, err := stonesFromPairs(setup.Stones, size)
		if err != nil {
			return nil, err
		}
		side := 1
		if setup.Side != "" {
			side, err = parseColor(setup.Side)
			if err != nil {
				return nil, err
			}
		}
		b.SetStones(pairs, side)
		if setup.KoPoint != nil {
			if s, ok := setup.KoPoint.(string); ok {
				v, err := parseVertex(s, size)
				if err != nil {
					return nil, err
				}
				b.KoPoint = v
			} else {
				f, err := toFloat(setup.KoPoint)
				if err != nil {
					return nil, err
				}
				b.KoPoint = int(f)
			}
		}
	}
	for _, item := range setup.Moves {
		if len(item) < 2 {
			continue
		}
		c, err := parseColor(fmt.Sprint(item[0]))
		if err != nil {
			return nil, err
		}
		v, err := parseVertex(fmt.Sprint(item[1]), size)
		if err != nil {
			return nil, err
		}
		r := b.Play(c, v)
		if !r.Ok {
			return nil, fmt.Errorf("setup move illegal: %v %v (%s)", item[0], item[1], r.Reason)
		}
	}
	return b, nil
}

func argColor(args map[string]interface{}, def string) (int, error) {
	v, ok := args["color"]
	if !ok || v == nil {
		return parseColor(def)
	}
	return parseColor(fmt.Sprint(v))
}

func runCase(c goldenCase) (map[string]interface{}, error) {
	b, err := buildBoard(c.Setup)
	if err != nil {
		return nil, err
	}
	args := c.Args
	switch c.Op {
	case "key":
		pk, sk := b.Key()
		return map[string]interface{}{"key": fmtKey(pk), "situational": fmtKey(sk)}, nil
	case "legal":
		color, err := argColor(args, "B")
		if err != nil {
			return nil, err
		}
		vertex, err := parseVertex(fmt.Sprint(args["vertex"]), b.Size)
		if err != nil {
			return nil, err
		}
		ok, reason := b.Legal(color, vertex)
		out := map[string]interface{}{"legal": ok}
		if !ok {
			out["reason"] = reason
		}
		return out, nil
	case "legal_moves":
		ms := b.LegalMoves()
		moves := make([]string, len(ms))
		for i, p := range ms {
			moves[i] = formatVertex(p, b.Size)
		}
		return map[string]interface{}{"count": len(ms), "moves": moves}, nil
	case "play":
		color, err := argColor(args, "B")
		if err != nil {
			return nil, err
		}
		vertex, err := parseVertex(fmt.Sprint(args["vertex"]), b.Size)
		if err != nil {
			return nil, err
		}
		r := b.Play(color, vertex)
		if !r.Ok {
			return map[string]interface{}{"ok": false, "reason": r.Reason}, nil
		}
		return map[string]interface{}{"ok": true, "captures": r.Captures,
			"self_captured": r.SelfCaptured}, nil
	case "undo":
		n := 1
		if v, ok := args["n"]; ok && v != nil {
			if f, err := toFloat(v); err == nil {
				n = int(f)
			}
		}
		ok := true
		for i := 0; i < n; i++ {
			if !b.Undo() {
				ok = false
			}
		}
		return map[string]interface{}{"ok": ok}, nil
	case "score":
		dead := parseDead(args["dead"], b.Size)
		sc := b.Score(dead)
		return map[string]interface{}{"black": sc.Black, "white": sc.White,
			"dame": sc.Dame, "result": sc.Result}, nil
	case "prisoners":
		bl, wh := b.Prisoners()
		return map[string]interface{}{"black": bl, "white": wh}, nil
	case "over":
		return map[string]interface{}{"over": b.IsOver()}, nil
	}
	return nil, fmt.Errorf("unknown op: %s", c.Op)
}

func parseDead(v interface{}, size int) []StonePair {
	arr, ok := v.([]interface{})
	if !ok {
		return nil
	}
	out := []StonePair{}
	for _, e := range arr {
		pair, ok := e.([]interface{})
		if !ok || len(pair) < 2 {
			continue
		}
		c, err1 := parseColor(fmt.Sprint(pair[0]))
		vertex, err2 := parseVertex(fmt.Sprint(pair[1]), size)
		if err1 != nil || err2 != nil {
			continue
		}
		out = append(out, StonePair{Color: c, Vertex: vertex})
	}
	return out
}

func asSlice(v interface{}) ([]interface{}, bool) {
	switch t := v.(type) {
	case []interface{}:
		return t, true
	case []string:
		out := make([]interface{}, len(t))
		for i, s := range t {
			out[i] = s
		}
		return out, true
	}
	return nil, false
}

func numOf(v interface{}) (float64, bool) {
	switch t := v.(type) {
	case float64:
		return t, true
	case float32:
		return float64(t), true
	case int:
		return float64(t), true
	case int64:
		return float64(t), true
	case json.Number:
		f, err := t.Float64()
		if err != nil {
			return 0, false
		}
		return f, true
	}
	return 0, false
}

// jsonEq 跨类型 JSON 值比较（数值按 float 比较；数组逐元素）。
func jsonEq(a, b interface{}) bool {
	if af, ok := numOf(a); ok {
		bf, ok2 := numOf(b)
		return ok2 && af == bf
	}
	if as, ok := asSlice(a); ok {
		bs, ok2 := asSlice(b)
		if !ok2 || len(as) != len(bs) {
			return false
		}
		for i := range as {
			if !jsonEq(as[i], bs[i]) {
				return false
			}
		}
		return true
	}
	switch av := a.(type) {
	case string:
		bv, ok := b.(string)
		return ok && av == bv
	case bool:
		bv, ok := b.(bool)
		return ok && av == bv
	case nil:
		return b == nil
	case map[string]interface{}:
		bv, ok := b.(map[string]interface{})
		if !ok || len(av) != len(bv) {
			return false
		}
		for k, v := range av {
			if !jsonEq(v, bv[k]) {
				return false
			}
		}
		return true
	}
	return reflect.DeepEqual(a, b)
}

func compare(expect, got map[string]interface{}) []interface{} {
	miss := []interface{}{}
	for k, v := range expect {
		gv, ok := got[k]
		if !ok {
			miss = append(miss, []interface{}{k, v, nil})
			continue
		}
		if !jsonEq(v, gv) {
			miss = append(miss, []interface{}{k, v, gv})
		}
	}
	return miss
}

func runGolden(path string) (GoldenResult, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return GoldenResult{}, err
	}
	var gf goldenFile
	if err := json.Unmarshal(data, &gf); err != nil {
		return GoldenResult{}, err
	}
	res := GoldenResult{Failures: []interface{}{}}
	for _, c := range gf.Cases {
		got, err := runCase(c)
		if err != nil {
			res.Failed++
			res.Failures = append(res.Failures, map[string]interface{}{"id": c.ID, "error": err.Error()})
			continue
		}
		miss := compare(c.Expect, got)
		if len(miss) > 0 {
			res.Failed++
			res.Failures = append(res.Failures, map[string]interface{}{
				"id": c.ID, "got": got, "expect": c.Expect, "miss": miss})
		} else {
			res.Passed++
		}
	}
	res.Total = res.Passed + res.Failed
	return res, nil
}

// defaultGoldenPath 依次尝试：WEIQI_GOLDEN → exe/../spec → cwd/../spec → cwd/spec。
func defaultGoldenPath() string {
	if p := os.Getenv("WEIQI_GOLDEN"); p != "" {
		return p
	}
	cands := []string{}
	if exe, err := os.Executable(); err == nil {
		cands = append(cands, filepath.Join(filepath.Dir(exe), "..", "spec", "golden.json"))
	}
	wd, err := os.Getwd()
	if err == nil {
		cands = append(cands, filepath.Join(wd, "..", "spec", "golden.json"))
		cands = append(cands, filepath.Join(wd, "spec", "golden.json"))
	}
	for _, c := range cands {
		if info, err := os.Stat(c); err == nil && !info.IsDir() {
			return c
		}
	}
	if len(cands) > 0 {
		return cands[0]
	}
	return "spec/golden.json"
}
