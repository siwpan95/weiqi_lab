// Driver.cs — JSON-stdio 驱动（docs/PROTOCOL_SPEC.md, protocol-v1）
//
// 对照 PyWeiqi/driver.py。引擎启动后先输出 ready 事件，再进入请求-响应循环；
// 单条响应必须在下一请求前完整输出（同步语义）。输出为紧凑 UTF-8 JSON（LF，无 BOM），
// 格式与 Python json.dumps(ensure_ascii=False) 逐字对齐。

using System;
using System.Collections.Generic;
using System.IO;
using System.Text;

namespace CsWeiqi
{
    internal sealed class CmdError : Exception
    {
        public string Msg;
        public string Reason;
        public CmdError(string msg, string reason = null) : base(msg)
        {
            Msg = msg;
            Reason = reason;
        }
    }

    public sealed class Driver
    {
        public const string NAME = "CsWeiqi";
        public const string LANG = "cs";
        public const string VERSION = "v1";
        public const int PROTOCOL = 1;

        private Board _board;

        public Driver()
        {
            _board = new Board(9, null, Wq.Profile("cn"));
        }

        private static CmdError BadArgs() => new CmdError("bad args");

        // ---------- 参数辅助 ----------

        private static RuleSet ParseRules(JVal jv)
        {
            if (jv == null || jv.IsNull) return Wq.Profile("cn");
            if (jv.Kind == JKind.Str) return Wq.Profile(jv.S);
            if (jv.Kind == JKind.Obj)
            {
                return Wq.RulesFromParts(
                    PyStr(jv.Get("ko")),
                    PyStr(jv.Get("suicide")),
                    PyStr(jv.Get("scoring")),
                    jv.Get("komi")?.AsDouble());
            }
            throw new WqError("bad rules");
        }

        /// <summary>近似 Python str(v)（None 返回 null，表示该项未指定）。</summary>
        private static string PyStr(JVal jv)
        {
            if (jv == null || jv.IsNull) return null;
            switch (jv.Kind)
            {
                case JKind.Str: return jv.S;
                case JKind.Bool: return jv.B ? "True" : "False";
                case JKind.Int: return jv.I.ToString(System.Globalization.CultureInfo.InvariantCulture);
                case JKind.Float: return Json.PyFloat(jv.F);
                default: return jv.S;
            }
        }

        private static Profile BuildProfile(JVal jv)
        {
            var p = new Profile();
            if (jv == null || jv.Kind != JKind.Obj) return p;
            for (int i = 0; i < jv.O.Count; i++)
            {
                string k = jv.O[i].Key;
                JVal v = jv.O[i].Value;
                if (v == null || v.IsNull) continue;
                switch (k)
                {
                    case "c": p.C = v.AsDouble() ?? p.C; break;
                    case "rave": if (v.Kind == JKind.Bool) p.Rave = v.B; break;
                    case "rave_k": p.RaveK = v.AsDouble() ?? p.RaveK; break;
                    case "capture_bias": p.CaptureBias = v.AsDouble() ?? p.CaptureBias; break;
                    case "pattern_bias": p.PatternBias = v.AsDouble() ?? p.PatternBias; break;
                    case "prune_radius": p.PruneRadius = (int)(v.AsLong() ?? p.PruneRadius); break;
                    case "pass_bias": p.PassBias = v.AsDouble() ?? p.PassBias; break;
                    case "resign_threshold": p.ResignThreshold = v.AsDouble() ?? p.ResignThreshold; break;
                    case "resign_min_visits": p.ResignMinVisits = (int)(v.AsLong() ?? p.ResignMinVisits); break;
                    case "mercy": p.Mercy = v.AsDouble() ?? p.Mercy; break;
                    case "pass_threshold": p.PassThreshold = v.AsDouble() ?? p.PassThreshold; break;
                    case "score_scale": p.ScoreScale = v.AsDouble() ?? p.ScoreScale; break;
                }
            }
            return p;
        }

        /// <summary>
        /// 对齐 Python 的 req.get(key, default)：键缺失才用 default；
        /// 键存在（即使是 null）一律交给 parse_color（null → "bad color: None"）。
        /// </summary>
        private static int ParseColorOr(JVal req, string key, int fallback)
        {
            JVal jv = req.Get(key);
            if (jv == null) return fallback;
            return Wq.ParseColor(PyArg(jv));
        }

        /// <summary>取 JVal 的原始 Python 值（用于颜色解析与其 %r 错误消息）。</summary>
        private static object PyArg(JVal jv)
        {
            if (jv == null || jv.IsNull) return null;
            switch (jv.Kind)
            {
                case JKind.Str: return jv.S;
                case JKind.Int: return jv.I;
                case JKind.Float: return jv.F;
                case JKind.Bool: return jv.B;
                default: return jv.S;
            }
        }

        private static int ParseVertexArg(JVal jv, int size)
        {
            if (jv == null || jv.IsNull) return -1;
            if (jv.Kind == JKind.Str) return Wq.ParseVertex(jv.S, size);
            if (jv.Kind == JKind.Int) return (int)jv.I;
            if (jv.Kind == JKind.Float) return (int)jv.F;
            throw BadArgs();
        }

        // ---------- 命令实现 ----------

        private JVal CmdHello(JVal req)
        {
            return Json.Obj(
                ("name", JVal.Str(NAME)),
                ("version", JVal.Str(VERSION)),
                ("lang", JVal.Str(LANG)),
                ("protocol", JVal.Int(PROTOCOL)));
        }

        private JVal CmdClear(JVal req)
        {
            long? sizeOpt = req.Get("size")?.AsLong();
            int size = sizeOpt.HasValue ? (int)sizeOpt.Value : 9;
            if (size < 2 || size > 19) throw new CmdError("bad size");
            RuleSet rd = ParseRules(req.Get("rules"));
            double? komi = req.Get("komi")?.AsDouble();
            _board = new Board(size, komi, rd);
            return Json.Obj(
                ("size", JVal.Int(size)),
                ("komi", JVal.Float(_board.Komi)),
                ("rules", Json.Obj(
                    ("ko", JVal.Str(rd.Ko)),
                    ("suicide", JVal.Str(rd.Suicide)),
                    ("scoring", JVal.Str(rd.Scoring)))));
        }

        private JVal CmdSetStones(JVal req)
        {
            int side = 1; // Python: req.get("side", "B")
            JVal sd = req.Get("side");
            if (sd != null) side = Wq.ParseColor(PyArg(sd));

            var pairs = new List<(int color, int vertex)>();
            JVal stones = req.Get("stones");
            if (stones != null && stones.Kind == JKind.Arr)
            {
                for (int i = 0; i < stones.A.Count; i++)
                {
                    JVal it = stones.A[i];
                    if (it == null || it.Kind != JKind.Arr || it.A.Count < 2) throw BadArgs();
                    int c = Wq.ParseColor(PyArg(it.A[0]));
                    int v;
                    if (it.A[1].Kind == JKind.Str) v = Wq.ParseVertex(it.A[1].S, _board.Size);
                    else if (it.A[1].Kind == JKind.Int) v = (int)it.A[1].I;
                    else if (it.A[1].Kind == JKind.Float) v = (int)it.A[1].F;
                    else throw BadArgs();
                    pairs.Add((c, v));
                }
            }
            _board.SetStones(pairs, side);
            return Json.Obj(("stones", JVal.Int(pairs.Count)));
        }

        private JVal CmdPlay(JVal req)
        {
            int color = ParseColorOr(req, "color", _board.Side);
            JVal vj = req.Get("vertex");
            if (vj == null || vj.IsNull) throw BadArgs();
            int vertex = ParseVertexArg(vj, _board.Size);
            PlayResult r = _board.Play(color, vertex);
            if (!r.Ok) throw new CmdError("illegal move", r.Reason);
            return Json.Obj(
                ("captures", JVal.Int(r.Captures)),
                ("self_captured", JVal.Int(r.SelfCaptured)),
                ("key", JVal.Str(Wq.FmtKey(r.Key))));
        }

        private JVal CmdUndo(JVal req)
        {
            if (!_board.Undo()) throw new CmdError("nothing to undo");
            return Json.Obj(("moves", JVal.Int(_board.Stack.Count)));
        }

        private JVal CmdKey(JVal req)
        {
            var (pk, sk) = _board.Key();
            return Json.Obj(("key", JVal.Str(Wq.FmtKey(pk))), ("situational", JVal.Str(Wq.FmtKey(sk))));
        }

        private JVal CmdLegal(JVal req)
        {
            int color = ParseColorOr(req, "color", _board.Side);
            JVal vj = req.Get("vertex");
            if (vj == null || vj.IsNull) throw BadArgs();
            int vertex = ParseVertexArg(vj, _board.Size);
            bool ok = _board.Legal(color, vertex, out string reason);
            if (ok) return Json.Obj(("legal", JVal.Bool(true)));
            return Json.Obj(("legal", JVal.Bool(false)), ("reason", JVal.Str(reason)));
        }

        private JVal CmdLegalMoves(JVal req)
        {
            List<int> ms = _board.LegalMoves();
            var arr = new List<JVal>(ms.Count);
            for (int i = 0; i < ms.Count; i++) arr.Add(JVal.Str(Wq.FormatVertex(ms[i], _board.Size)));
            return Json.Obj(("count", JVal.Int(ms.Count)), ("moves", JVal.Arr(arr)));
        }

        private JVal CmdGenmove(JVal req)
        {
            int color = ParseColorOr(req, "color", _board.Side);
            int playouts = (int)(req.Get("playouts")?.AsLong() ?? 500);
            long seed = req.Get("seed")?.AsLong() ?? 0;
            Profile pr = BuildProfile(req.Get("profile"));
            if (color != _board.Side) throw new CmdError("genmove for wrong side", "turn");

            GenResult g = Ai.GenMove(_board, playouts, seed, pr);
            if (g.Move == Ai.RESIGN)
            {
                return Json.Obj(
                    ("vertex", JVal.Str("resign")),
                    ("visits", JVal.Int(g.Visits)),
                    ("winrate", JVal.Float(g.Winrate)));
            }
            string vertex = g.Move == Ai.PASS ? "pass" : Wq.FormatVertex(g.Move, _board.Size);
            PlayResult r = _board.Play(color, g.Move);
            if (!r.Ok) throw new CmdError("internal: chosen move illegal", r.Reason);
            return Json.Obj(
                ("vertex", JVal.Str(vertex)),
                ("visits", JVal.Int(g.Visits)),
                ("winrate", JVal.Float(g.Winrate)));
        }

        private JVal CmdScore(JVal req)
        {
            var dead = new List<(int color, int vertex)>();
            JVal d = req.Get("dead");
            if (d != null && !d.IsNull && d.Kind == JKind.Arr)
            {
                for (int i = 0; i < d.A.Count; i++)
                {
                    JVal it = d.A[i];
                    if (it == null || it.Kind != JKind.Arr || it.A.Count < 2) throw BadArgs();
                    int c = Wq.ParseColor(PyArg(it.A[0]));
                    int v = Wq.ParseVertex(it.A[1].AsString(), _board.Size);
                    dead.Add((c, v));
                }
            }
            ScoreResult sc = _board.Score(dead);
            return Json.Obj(
                ("black", JVal.Int(sc.Black)),
                ("white", JVal.Int(sc.White)),
                ("komi", JVal.Float(sc.Komi)),
                ("dame", JVal.Int(sc.Dame)),
                ("result", JVal.Str(sc.Result)),
                ("black_territory", JVal.Int(sc.BlackTerritory)),
                ("white_territory", JVal.Int(sc.WhiteTerritory)),
                ("black_stones", JVal.Int(sc.BlackStones)),
                ("white_stones", JVal.Int(sc.WhiteStones)),
                ("prisoners_black", JVal.Int(sc.PrisonersBlack)),
                ("prisoners_white", JVal.Int(sc.PrisonersWhite)));
        }

        private JVal CmdPrisoners(JVal req)
        {
            var (bl, wh) = _board.Prisoners();
            return Json.Obj(("black", JVal.Int(bl)), ("white", JVal.Int(wh)));
        }

        private JVal CmdSelftest(JVal req)
        {
            string path = req.Get("golden")?.AsString();
            if (string.IsNullOrEmpty(path)) path = Golden.DefaultGoldenPath();
            if (string.IsNullOrEmpty(path)) throw new CmdError("golden path not found");
            GoldenResult r = Golden.RunGolden(path);
            return Json.Obj(
                ("passed", JVal.Int(r.Passed)),
                ("failed", JVal.Int(r.Failed)),
                ("total", JVal.Int(r.Total)),
                ("failures", JVal.Arr(r.Failures)));
        }

        private JVal Dispatch(JVal req)
        {
            string cmd = req.Get("cmd")?.AsString();
            switch (cmd)
            {
                case "hello": return CmdHello(req);
                case "clear": return CmdClear(req);
                case "set_stones": return CmdSetStones(req);
                case "play": return CmdPlay(req);
                case "undo": return CmdUndo(req);
                case "key": return CmdKey(req);
                case "legal": return CmdLegal(req);
                case "legal_moves": return CmdLegalMoves(req);
                case "genmove": return CmdGenmove(req);
                case "score": return CmdScore(req);
                case "prisoners": return CmdPrisoners(req);
                case "selftest": return CmdSelftest(req);
                default: throw new CmdError("unknown command");
            }
        }

        // ---------- 主循环 ----------

        private static JVal OkResp(JVal id, JVal res)
        {
            return Json.Obj(("id", id), ("ok", JVal.Bool(true)), ("result", res));
        }

        private static JVal ErrResp(JVal id, string error, string reason)
        {
            if (reason == null) return Json.Obj(("id", id), ("ok", JVal.Bool(false)), ("error", JVal.Str(error)));
            return Json.Obj(("id", id), ("ok", JVal.Bool(false)), ("error", JVal.Str(error)), ("reason", JVal.Str(reason)));
        }

        public static int Run()
        {
            var utf8 = new UTF8Encoding(false);
            var stdinStream = Console.OpenStandardInput();
            var reader = new StreamReader(stdinStream, utf8, true, 1 << 16);
            var stdoutStream = Console.OpenStandardOutput();
            var writer = new StreamWriter(stdoutStream, utf8, 1 << 16) { AutoFlush = false, NewLine = "\n" };

            // ready 事件（协议 §1）
            JVal ready = Json.Obj(
                ("event", JVal.Str("ready")),
                ("protocol", JVal.Int(PROTOCOL)),
                ("name", JVal.Str(NAME)),
                ("lang", JVal.Str(LANG)),
                ("version", JVal.Str(VERSION)));
            writer.Write(Json.ToText(ready));
            writer.Write('\n');
            writer.Flush();

            var drv = new Driver();
            var emptyObj = JVal.Obj(new List<KeyValuePair<string, JVal>>());

            string line;
            while ((line = reader.ReadLine()) != null)
            {
                line = line.Trim();
                if (line.Length == 0) continue;

                JVal id = JVal.Null();
                string outLine;
                try
                {
                    JVal req = Json.Parse(line);
                    id = req.Get("id") ?? JVal.Null();
                    if (req.Get("cmd")?.AsString() == "quit")
                    {
                        writer.Write(Json.ToText(OkResp(id, emptyObj)));
                        writer.Write('\n');
                        writer.Flush();
                        return 0;
                    }
                    JVal res = drv.Dispatch(req);
                    outLine = Json.ToText(OkResp(id, res));
                }
                catch (CmdError e)
                {
                    outLine = Json.ToText(ErrResp(id, e.Msg, e.Reason));
                }
                catch (Exception e)
                {
                    outLine = Json.ToText(ErrResp(id, e.Message, null));
                }
                writer.Write(outLine);
                writer.Write('\n');
                writer.Flush();
            }
            return 0;
        }
    }
}
