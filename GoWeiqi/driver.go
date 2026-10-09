package main

// driver.go — JSON-stdio 驱动（协议规范 docs/PROTOCOL_SPEC.md, protocol-v1）
//
// 关键约束：响应的 result 对象**键顺序必须与 PyWeiqi 一致** —— harness/ host.mjs
// 的跨引擎差分对 result 做 JSON.stringify 字符串比对，键顺序不同即视为差异。

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"strings"
)

const (
	engineName    = "GoWeiqi"
	engineLang    = "go"
	engineVersion = "v1"
)

// ---------- 结果类型（字段顺序 = PyWeiqi dict 插入顺序） ----------

type helloResult struct {
	Name     string `json:"name"`
	Version  string `json:"version"`
	Lang     string `json:"lang"`
	Protocol int    `json:"protocol"`
}

type rulesOut struct {
	Ko      string `json:"ko"`
	Suicide string `json:"suicide"`
	Scoring string `json:"scoring"`
}

type clearResult struct {
	Size  int      `json:"size"`
	Komi  float64  `json:"komi"`
	Rules rulesOut `json:"rules"`
}

type setStonesResult struct {
	Stones int `json:"stones"`
}

type playResultOut struct {
	Captures     int    `json:"captures"`
	SelfCaptured int    `json:"self_captured"`
	Key          string `json:"key"`
}

type undoResult struct {
	Moves int `json:"moves"`
}

type keyResult struct {
	Key         string `json:"key"`
	Situational string `json:"situational"`
}

type legalResult struct {
	Legal  bool   `json:"legal"`
	Reason string `json:"reason,omitempty"`
}

type legalMovesResult struct {
	Count int      `json:"count"`
	Moves []string `json:"moves"`
}

type genmoveResult struct {
	Vertex  string  `json:"vertex"`
	Visits  int     `json:"visits"`
	Winrate float64 `json:"winrate"`
}

type prisonersResult struct {
	Black int `json:"black"`
	White int `json:"white"`
}

// CmdError 为协议级失败（带稳定 reason 者仅规则级失败）。
type CmdError struct {
	Msg    string
	Reason string
}

func (e *CmdError) Error() string { return e.Msg }

// Driver 持有当前棋盘。
type Driver struct {
	board *Board
}

func newDriver() *Driver {
	b, _ := NewBoard(9, nil, nil)
	return &Driver{board: b}
}

// ---------- 命令实现 ----------

func (d *Driver) dispatch(req map[string]interface{}) (interface{}, error) {
	cmd, _ := req["cmd"].(string)
	switch cmd {
	case "hello":
		return helloResult{Name: engineName, Version: engineVersion, Lang: engineLang, Protocol: 1}, nil
	case "clear":
		return d.cmdClear(req)
	case "set_stones":
		return d.cmdSetStones(req)
	case "play":
		return d.cmdPlay(req)
	case "undo":
		return d.cmdUndo(req)
	case "key":
		return d.cmdKey()
	case "legal":
		return d.cmdLegal(req)
	case "legal_moves":
		return d.cmdLegalMoves()
	case "genmove":
		return d.cmdGenmove(req)
	case "score":
		return d.cmdScore(req)
	case "prisoners":
		return d.cmdPrisoners()
	case "selftest":
		return d.cmdSelftest(req)
	}
	return nil, &CmdError{Msg: "unknown command"}
}

func (d *Driver) cmdClear(req map[string]interface{}) (interface{}, error) {
	size := 9
	if v, ok := req["size"]; ok && v != nil {
		if f, err := toFloat(v); err == nil {
			size = int(f)
		}
	}
	var komi *float64
	if v, ok := req["komi"]; ok && v != nil {
		f, err := toFloat(v)
		if err != nil {
			return nil, &CmdError{Msg: err.Error()}
		}
		komi = &f
	}
	b, err := NewBoard(size, komi, req["rules"])
	if err != nil {
		return nil, &CmdError{Msg: err.Error()}
	}
	d.board = b
	return clearResult{Size: b.Size, Komi: b.Komi,
		Rules: rulesOut{Ko: b.Rules.Ko, Suicide: b.Rules.Suicide, Scoring: b.Rules.Scoring}}, nil
}

func (d *Driver) cmdSetStones(req map[string]interface{}) (interface{}, error) {
	stones, _ := req["stones"].([]interface{})
	side := 1
	if s, ok := req["side"]; ok && s != nil {
		c, err := parseColor(fmt.Sprint(s))
		if err != nil {
			return nil, &CmdError{Msg: err.Error()}
		}
		side = c
	}
	pairs := []StonePair{}
	for _, it := range stones {
		arr, ok := it.([]interface{})
		if !ok || len(arr) < 2 {
			continue
		}
		c, err := parseColor(fmt.Sprint(arr[0]))
		if err != nil {
			return nil, &CmdError{Msg: err.Error()}
		}
		var v int
		if s, ok := arr[1].(string); ok {
			v, err = parseVertex(s, d.board.Size)
			if err != nil {
				return nil, &CmdError{Msg: err.Error()}
			}
		} else {
			f, err := toFloat(arr[1])
			if err != nil {
				return nil, &CmdError{Msg: "range"}
			}
			v = int(f)
		}
		pairs = append(pairs, StonePair{Color: c, Vertex: v})
	}
	d.board.SetStones(pairs, side)
	return setStonesResult{Stones: len(pairs)}, nil
}

func (d *Driver) reqColor(req map[string]interface{}) (int, error) {
	if v, ok := req["color"]; ok {
		return parseColor(fmt.Sprint(v))
	}
	return parseColor(colorName(d.board.Side))
}

func (d *Driver) reqVertex(req map[string]interface{}) (int, error) {
	v, ok := req["vertex"]
	if s, isStr := v.(string); isStr {
		return parseVertex(s, d.board.Size)
	}
	if !ok || v == nil {
		return 0, &CmdError{Msg: "range"}
	}
	f, err := toFloat(v)
	if err != nil {
		return 0, &CmdError{Msg: "range"}
	}
	return int(f), nil
}

func (d *Driver) cmdPlay(req map[string]interface{}) (interface{}, error) {
	color, err := d.reqColor(req)
	if err != nil {
		return nil, &CmdError{Msg: err.Error()}
	}
	vertex, err := d.reqVertex(req)
	if err != nil {
		return nil, err
	}
	r := d.board.Play(color, vertex)
	if !r.Ok {
		return nil, &CmdError{Msg: "illegal move", Reason: r.Reason}
	}
	return playResultOut{Captures: r.Captures, SelfCaptured: r.SelfCaptured, Key: r.Key}, nil
}

func (d *Driver) cmdUndo(req map[string]interface{}) (interface{}, error) {
	if !d.board.Undo() {
		return nil, &CmdError{Msg: "nothing to undo"}
	}
	return undoResult{Moves: len(d.board.Stack)}, nil
}

func (d *Driver) cmdKey() (interface{}, error) {
	pk, sk := d.board.Key()
	return keyResult{Key: fmtKey(pk), Situational: fmtKey(sk)}, nil
}

func (d *Driver) cmdLegal(req map[string]interface{}) (interface{}, error) {
	color, err := d.reqColor(req)
	if err != nil {
		return nil, &CmdError{Msg: err.Error()}
	}
	vertex, err := d.reqVertex(req)
	if err != nil {
		return nil, err
	}
	ok, reason := d.board.Legal(color, vertex)
	out := legalResult{Legal: ok}
	if !ok {
		out.Reason = reason
	}
	return out, nil
}

func (d *Driver) cmdLegalMoves() (interface{}, error) {
	ms := d.board.LegalMoves()
	moves := make([]string, len(ms))
	for i, p := range ms {
		moves[i] = formatVertex(p, d.board.Size)
	}
	return legalMovesResult{Count: len(ms), Moves: moves}, nil
}

func (d *Driver) cmdGenmove(req map[string]interface{}) (interface{}, error) {
	color, err := d.reqColor(req)
	if err != nil {
		return nil, &CmdError{Msg: err.Error()}
	}
	playouts := 500
	if v, ok := req["playouts"]; ok && v != nil {
		if f, err := toFloat(v); err == nil {
			playouts = int(f)
		}
	}
	seed := int64(0)
	if v, ok := req["seed"]; ok && v != nil {
		if f, err := toFloat(v); err == nil {
			seed = int64(f)
		}
	}
	var profile map[string]interface{}
	if v, ok := req["profile"].(map[string]interface{}); ok {
		profile = v
	}
	if color != d.board.Side {
		return nil, &CmdError{Msg: "genmove for wrong side", Reason: "turn"}
	}
	ai := genmove(d.board, playouts, seed, profile)
	if ai.IsResign {
		return genmoveResult{Vertex: "resign", Visits: ai.Visits, Winrate: ai.Winrate}, nil
	}
	vertex := "pass"
	mv := -1
	if !ai.IsPass {
		mv = ai.Point
		vertex = formatVertex(ai.Point, d.board.Size)
	}
	r := d.board.Play(color, mv)
	if !r.Ok {
		return nil, &CmdError{Msg: "internal: chosen move illegal", Reason: r.Reason}
	}
	return genmoveResult{Vertex: vertex, Visits: ai.Visits, Winrate: ai.Winrate}, nil
}

func (d *Driver) cmdScore(req map[string]interface{}) (interface{}, error) {
	var dead []StonePair
	if v, ok := req["dead"]; ok && v != nil {
		dead = parseDead(v, d.board.Size)
	}
	return d.board.Score(dead), nil
}

func (d *Driver) cmdPrisoners() (interface{}, error) {
	bl, wh := d.board.Prisoners()
	return prisonersResult{Black: bl, White: wh}, nil
}

func (d *Driver) cmdSelftest(req map[string]interface{}) (interface{}, error) {
	path := defaultGoldenPath()
	if v, ok := req["golden"].(string); ok && v != "" {
		path = v
	}
	res, err := runGolden(path)
	if err != nil {
		return nil, &CmdError{Msg: err.Error()}
	}
	return res, nil
}

// ---------- 主循环 ----------

type readyEvent struct {
	Event    string `json:"event"`
	Protocol int    `json:"protocol"`
	Name     string `json:"name"`
	Lang     string `json:"lang"`
	Version  string `json:"version"`
}

type response struct {
	ID     interface{} `json:"id"`
	Ok     bool        `json:"ok"`
	Result interface{} `json:"result,omitempty"`
	Error  string      `json:"error,omitempty"`
	Reason string      `json:"reason,omitempty"`
}

func writeJSON(w *bufio.Writer, v interface{}) {
	b, err := json.Marshal(v)
	if err != nil {
		return
	}
	w.Write(b)
	w.WriteByte('\n')
	w.Flush()
}

func decodeRequest(line string) (map[string]interface{}, error) {
	dec := json.NewDecoder(strings.NewReader(line))
	dec.UseNumber()
	var m map[string]interface{}
	if err := dec.Decode(&m); err != nil {
		return nil, err
	}
	return m, nil
}

func runDriver() int {
	d := newDriver()
	out := bufio.NewWriter(os.Stdout)
	writeJSON(out, readyEvent{Event: "ready", Protocol: 1, Name: engineName, Lang: engineLang, Version: engineVersion})

	sc := bufio.NewScanner(os.Stdin)
	sc.Buffer(make([]byte, 0, 1<<20), 16<<20)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" {
			continue
		}
		req, err := decodeRequest(line)
		if err != nil {
			writeJSON(out, response{ID: nil, Ok: false, Error: err.Error()})
			continue
		}
		rid := req["id"]
		if cmd, _ := req["cmd"].(string); cmd == "quit" {
			writeJSON(out, response{ID: rid, Ok: true, Result: struct{}{}})
			return 0
		}
		res, err := d.dispatch(req)
		if err != nil {
			if ce, ok := err.(*CmdError); ok {
				writeJSON(out, response{ID: rid, Ok: false, Error: ce.Msg, Reason: ce.Reason})
			} else {
				writeJSON(out, response{ID: rid, Ok: false, Error: err.Error()})
			}
			continue
		}
		writeJSON(out, response{ID: rid, Ok: true, Result: res})
	}
	return 0
}
