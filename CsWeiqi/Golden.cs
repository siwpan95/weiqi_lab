// Golden.cs — 黄金值用例执行器 + JSON 模型/解析/写出（C# 移植；零第三方依赖）
//
// 本文件包含三部分：
//   1. JVal：有序 JSON 值模型（object 保序）。
//   2. Json：解析（借助 BCL 的 System.Text.Json，非第三方包）+ 写出器。
//      写出器刻意与 Python json.dumps（ensure_ascii=False，默认分隔符 ", " / ": "）逐字对齐，
//      以保证与 PyWeiqi 驱动的逐行差分测试 0 差异。
//   3. 黄金值执行器：读 spec/golden.json，按 op 构造局面并逐位比对 expect（对照 golden.py）。
//      spec/golden.json 只读，不得修改。

using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;
using System.Text.Json;

namespace CsWeiqi
{
    public enum JKind { Null, Bool, Int, Float, Str, Arr, Obj }

    /// <summary>有序 JSON 值。</summary>
    public sealed class JVal
    {
        public JKind Kind;
        public bool B;
        public long I;
        public double F;
        public string S;
        public List<JVal> A;
        public List<KeyValuePair<string, JVal>> O;

        public bool IsNull => Kind == JKind.Null;

        public static JVal Null() => new JVal { Kind = JKind.Null };
        public static JVal Bool(bool b) => new JVal { Kind = JKind.Bool, B = b };
        public static JVal Int(long i) => new JVal { Kind = JKind.Int, I = i };
        public static JVal Float(double f) => new JVal { Kind = JKind.Float, F = f };
        public static JVal Str(string s) => new JVal { Kind = JKind.Str, S = s ?? "" };
        public static JVal Arr(List<JVal> a) => new JVal { Kind = JKind.Arr, A = a };
        public static JVal Obj(List<KeyValuePair<string, JVal>> o) => new JVal { Kind = JKind.Obj, O = o };

        public JVal Get(string key)
        {
            if (Kind != JKind.Obj || O == null) return null;
            for (int i = 0; i < O.Count; i++)
            {
                if (O[i].Key == key) return O[i].Value;
            }
            return null;
        }

        public string AsString() => Kind == JKind.Str ? S : null;
        public bool AsBool() => Kind == JKind.Bool && B;

        public long? AsLong()
        {
            if (Kind == JKind.Int) return I;
            if (Kind == JKind.Float) return (long)F;
            if (Kind == JKind.Bool) return B ? 1 : 0;
            return null;
        }

        public double? AsDouble()
        {
            if (Kind == JKind.Int) return I;
            if (Kind == JKind.Float) return F;
            return null;
        }

        private static bool TryNum(JVal v, out double d)
        {
            d = 0;
            if (v == null) return false;
            if (v.Kind == JKind.Int) { d = v.I; return true; }
            if (v.Kind == JKind.Float) { d = v.F; return true; }
            return false;
        }

        public bool NumEqualsWithin(JVal other, double eps)
        {
            if (!TryNum(this, out double a) || !TryNum(other, out double b)) return false;
            return Math.Abs(a - b) <= eps;
        }

        /// <summary>结构相等（对照 Python == 语义；允许 Bool 与 0/1 互等）。</summary>
        public bool Eq(JVal o)
        {
            if (o == null) return false;
            if (Kind == JKind.Bool || o.Kind == JKind.Bool)
            {
                long? a = AsLong();
                long? b = o.AsLong();
                if (a.HasValue && b.HasValue) return a.Value == b.Value;
                return Kind == o.Kind && B == o.B;
            }
            if (Kind != o.Kind)
            {
                // 数值：Int/Float 交叉相等（Python 语义）
                if ((Kind == JKind.Int || Kind == JKind.Float) && (o.Kind == JKind.Int || o.Kind == JKind.Float))
                    return TryNum(this, out double x) && TryNum(o, out double y) && x == y;
                return false;
            }
            switch (Kind)
            {
                case JKind.Null: return true;
                case JKind.Int: return I == o.I;
                case JKind.Float: return F == o.F;
                case JKind.Str: return S == o.S;
                case JKind.Arr:
                    if (A.Count != o.A.Count) return false;
                    for (int i = 0; i < A.Count; i++) if (!A[i].Eq(o.A[i])) return false;
                    return true;
                case JKind.Obj:
                    if (O.Count != o.O.Count) return false;
                    for (int i = 0; i < O.Count; i++)
                    {
                        if (O[i].Key != o.O[i].Key) return false;
                        if (!O[i].Value.Eq(o.O[i].Value)) return false;
                    }
                    return true;
            }
            return false;
        }
    }

    /// <summary>JSON 解析/写出工具（写出与 Python json.dumps 对齐）。</summary>
    public static class Json
    {
        public static JVal Obj(params (string key, JVal val)[] items)
        {
            var o = new List<KeyValuePair<string, JVal>>(items.Length);
            for (int i = 0; i < items.Length; i++) o.Add(new KeyValuePair<string, JVal>(items[i].key, items[i].val));
            return JVal.Obj(o);
        }

        public static JVal Arr(params JVal[] items)
        {
            return JVal.Arr(new List<JVal>(items));
        }

        public static JVal Str(string s) => JVal.Str(s);
        public static JVal Int(long i) => JVal.Int(i);
        public static JVal Float(double f) => JVal.Float(f);
        public static JVal Bool(bool b) => JVal.Bool(b);
        public static JVal Null() => JVal.Null();

        public static JVal Parse(string text)
        {
            using var doc = JsonDocument.Parse(text);
            return FromElement(doc.RootElement);
        }

        public static bool TryParse(string text, out JVal val, out string error)
        {
            val = null;
            error = null;
            try
            {
                using var doc = JsonDocument.Parse(text);
                val = FromElement(doc.RootElement);
                return true;
            }
            catch (Exception e)
            {
                error = e.Message;
                return false;
            }
        }

        private static JVal FromElement(JsonElement e)
        {
            switch (e.ValueKind)
            {
                case JsonValueKind.Null:
                case JsonValueKind.Undefined:
                    return JVal.Null();
                case JsonValueKind.True:
                    return JVal.Bool(true);
                case JsonValueKind.False:
                    return JVal.Bool(false);
                case JsonValueKind.Number:
                    if (e.TryGetInt64(out long l)) return JVal.Int(l);
                    return JVal.Float(e.GetDouble());
                case JsonValueKind.String:
                    return JVal.Str(e.GetString());
                case JsonValueKind.Array:
                    {
                        var a = new List<JVal>();
                        foreach (JsonElement x in e.EnumerateArray()) a.Add(FromElement(x));
                        return JVal.Arr(a);
                    }
                case JsonValueKind.Object:
                    {
                        var o = new List<KeyValuePair<string, JVal>>();
                        foreach (JsonProperty p in e.EnumerateObject()) o.Add(new KeyValuePair<string, JVal>(p.Name, FromElement(p.Value)));
                        return JVal.Obj(o);
                    }
            }
            return JVal.Null();
        }

        /// <summary>浮点按 Python repr 风格输出（整数附加 .0）。</summary>
        internal static string PyFloat(double d)
        {
            if (double.IsNaN(d)) return "NaN";
            if (double.IsPositiveInfinity(d)) return "Infinity";
            if (double.IsNegativeInfinity(d)) return "-Infinity";
            string s = d.ToString("R", CultureInfo.InvariantCulture);
            if (s.IndexOf('.') < 0 && s.IndexOf('e') < 0 && s.IndexOf('E') < 0) s += ".0";
            return s;
        }

        private static void WriteStr(StringBuilder sb, string s)
        {
            sb.Append('"');
            for (int i = 0; i < s.Length; i++)
            {
                char ch = s[i];
                switch (ch)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    case '\b': sb.Append("\\b"); break;
                    case '\f': sb.Append("\\f"); break;
                    default:
                        if (ch < 0x20) sb.Append("\\u").Append(((int)ch).ToString("x4", CultureInfo.InvariantCulture));
                        else sb.Append(ch);
                        break;
                }
            }
            sb.Append('"');
        }

        public static void WriteTo(StringBuilder sb, JVal v)
        {
            switch (v.Kind)
            {
                case JKind.Null: sb.Append("null"); break;
                case JKind.Bool: sb.Append(v.B ? "true" : "false"); break;
                case JKind.Int: sb.Append(v.I.ToString(CultureInfo.InvariantCulture)); break;
                case JKind.Float: sb.Append(PyFloat(v.F)); break;
                case JKind.Str: WriteStr(sb, v.S); break;
                case JKind.Arr:
                    sb.Append('[');
                    for (int i = 0; i < v.A.Count; i++)
                    {
                        if (i > 0) sb.Append(", ");
                        WriteTo(sb, v.A[i]);
                    }
                    sb.Append(']');
                    break;
                case JKind.Obj:
                    sb.Append('{');
                    for (int i = 0; i < v.O.Count; i++)
                    {
                        if (i > 0) sb.Append(", ");
                        WriteStr(sb, v.O[i].Key);
                        sb.Append(": ");
                        WriteTo(sb, v.O[i].Value);
                    }
                    sb.Append('}');
                    break;
            }
        }

        public static string ToText(JVal v)
        {
            var sb = new StringBuilder(256);
            WriteTo(sb, v);
            return sb.ToString();
        }
    }

    public sealed class GoldenResult
    {
        public int Passed;
        public int Failed;
        public int Total;
        public List<JVal> Failures = new List<JVal>();
    }

    /// <summary>黄金值执行器（对照 PyWeiqi/golden.py）。</summary>
    public static class Golden
    {
        /// <summary>由 setup 构造棋盘（对照 golden.py build_board）。</summary>
        public static Board BuildBoard(JVal setup)
        {
            if (setup == null || setup.IsNull) setup = JVal.Obj(new List<KeyValuePair<string, JVal>>());
            int size = (int)(setup.Get("size")?.AsLong() ?? 9);
            if (size < 2 || size > 19) throw new WqError("bad size");

            JVal rj = setup.Get("rules");
            RuleSet rules;
            if (rj == null || rj.IsNull) rules = Wq.Profile("cn");
            else if (rj.Kind == JKind.Str) rules = Wq.Profile(rj.S);
            else if (rj.Kind == JKind.Obj)
            {
                rules = Wq.RulesFromParts(
                    rj.Get("ko")?.AsString(),
                    rj.Get("suicide")?.AsString(),
                    rj.Get("scoring")?.AsString(),
                    rj.Get("komi")?.AsDouble());
            }
            else throw new WqError("bad rules");

            double? komi = setup.Get("komi")?.AsDouble();
            var b = new Board(size, komi, rules);

            JVal st = setup.Get("stones");
            if (st != null && !st.IsNull)
            {
                var pairs = new List<(int color, int vertex)>();
                for (int i = 0; i < st.A.Count; i++)
                {
                    JVal it = st.A[i];
                    int color = Wq.ParseColor(it.A[0].AsString());
                    int vertex = Wq.ParseVertex(it.A[1].AsString(), size);
                    pairs.Add((color, vertex));
                }
                int side = 1;
                JVal sd = setup.Get("side");
                if (sd != null && !sd.IsNull) side = Wq.ParseColor(sd.AsString());
                b.SetStones(pairs, side);

                JVal kp = setup.Get("ko_point");
                if (kp != null && !kp.IsNull)
                {
                    b.KoPoint = kp.Kind == JKind.Str ? Wq.ParseVertex(kp.S, size) : (int)(kp.AsLong() ?? -1);
                }
            }

            JVal mv = setup.Get("moves");
            if (mv != null && !mv.IsNull && mv.Kind == JKind.Arr && mv.A.Count > 0)
            {
                for (int i = 0; i < mv.A.Count; i++)
                {
                    JVal it = mv.A[i];
                    int color = Wq.ParseColor(it.A[0].AsString());
                    int v = Wq.ParseVertex(it.A[1].AsString(), size);
                    PlayResult r = b.Play(color, v);
                    if (!r.Ok)
                    {
                        throw new InvalidOperationException(
                            "setup move illegal: " + it.A[0].AsString() + " " + it.A[1].AsString() + " (" + r.Reason + ")");
                    }
                }
            }
            return b;
        }

        private static List<(int color, int vertex)> ParseDead(JVal args, int size)
        {
            var outList = new List<(int color, int vertex)>();
            JVal d = args?.Get("dead");
            if (d != null && !d.IsNull)
            {
                for (int i = 0; i < d.A.Count; i++)
                {
                    JVal it = d.A[i];
                    int color = Wq.ParseColor(it.A[0].AsString());
                    int v = Wq.ParseVertex(it.A[1].AsString(), size);
                    outList.Add((color, v));
                }
            }
            return outList;
        }

        /// <summary>执行单条黄金值用例（对照 golden.py run_case）。</summary>
        public static JVal RunCase(JVal c)
        {
            Board b = BuildBoard(c.Get("setup"));
            string op = c.Get("op")?.AsString();
            JVal args = c.Get("args") ?? JVal.Obj(new List<KeyValuePair<string, JVal>>());
            int size = b.Size;

            switch (op)
            {
                case "key":
                    {
                        var (pk, sk) = b.Key();
                        return Json.Obj(
                            ("key", JVal.Str(Wq.FmtKey(pk))),
                            ("situational", JVal.Str(Wq.FmtKey(sk))));
                    }
                case "legal":
                    {
                        int color = Wq.ParseColor(args.Get("color")?.AsString() ?? "B");
                        int v = Wq.ParseVertex(args.Get("vertex")?.AsString(), size);
                        bool ok = b.Legal(color, v, out string reason);
                        if (ok) return Json.Obj(("legal", JVal.Bool(true)));
                        return Json.Obj(("legal", JVal.Bool(false)), ("reason", JVal.Str(reason)));
                    }
                case "legal_moves":
                    {
                        List<int> ms = b.LegalMoves();
                        var arr = new List<JVal>(ms.Count);
                        for (int i = 0; i < ms.Count; i++) arr.Add(JVal.Str(Wq.FormatVertex(ms[i], size)));
                        return Json.Obj(("count", JVal.Int(ms.Count)), ("moves", JVal.Arr(arr)));
                    }
                case "play":
                    {
                        int color = Wq.ParseColor(args.Get("color")?.AsString());
                        int v = Wq.ParseVertex(args.Get("vertex")?.AsString(), size);
                        PlayResult r = b.Play(color, v);
                        if (!r.Ok) return Json.Obj(("ok", JVal.Bool(false)), ("reason", JVal.Str(r.Reason)));
                        return Json.Obj(
                            ("ok", JVal.Bool(true)),
                            ("captures", JVal.Int(r.Captures)),
                            ("self_captured", JVal.Int(r.SelfCaptured)));
                    }
                case "undo":
                    {
                        int n = (int)(args.Get("n")?.AsLong() ?? 1);
                        bool ok = true;
                        for (int i = 0; i < n; i++) if (!b.Undo()) ok = false;
                        return Json.Obj(("ok", JVal.Bool(ok)));
                    }
                case "score":
                    {
                        List<(int, int)> dead = ParseDead(args, size);
                        ScoreResult sc = b.Score(dead);
                        return Json.Obj(
                            ("black", JVal.Int(sc.Black)),
                            ("white", JVal.Int(sc.White)),
                            ("dame", JVal.Int(sc.Dame)),
                            ("result", JVal.Str(sc.Result)));
                    }
                case "prisoners":
                    {
                        var (bl, wh) = b.Prisoners();
                        return Json.Obj(("black", JVal.Int(bl)), ("white", JVal.Int(wh)));
                    }
                case "over":
                    return Json.Obj(("over", JVal.Bool(b.IsOver())));
                default:
                    throw new InvalidOperationException("unknown op: " + op);
            }
        }

        /// <summary>比对 expect（对照 golden.py compare）→ 差异列表。</summary>
        public static List<JVal> Compare(JVal expect, JVal got)
        {
            var miss = new List<JVal>();
            if (expect == null || expect.Kind != JKind.Obj) return miss;
            for (int i = 0; i < expect.O.Count; i++)
            {
                string k = expect.O[i].Key;
                JVal v = expect.O[i].Value;
                JVal gv = got?.Get(k);
                bool isFloat = v.Kind == JKind.Float || (gv != null && gv.Kind == JKind.Float);
                if (isFloat)
                {
                    if (gv == null || !v.NumEqualsWithin(gv, 1e-9))
                        miss.Add(JVal.Arr(new List<JVal> { JVal.Str(k), v, gv ?? JVal.Null() }));
                }
                else if (gv == null || !v.Eq(gv))
                {
                    miss.Add(JVal.Arr(new List<JVal> { JVal.Str(k), v, gv ?? JVal.Null() }));
                }
            }
            return miss;
        }

        public static GoldenResult RunGolden(string path)
        {
            string text = File.ReadAllText(path, Encoding.UTF8);
            JVal data = Json.Parse(text);
            JVal cases = data.Get("cases");
            var result = new GoldenResult();
            if (cases == null || cases.Kind != JKind.Arr) throw new InvalidOperationException("no cases in golden file");
            for (int ci = 0; ci < cases.A.Count; ci++)
            {
                JVal c = cases.A[ci];
                string id = c.Get("id")?.AsString() ?? "";
                try
                {
                    JVal got = RunCase(c);
                    JVal expect = c.Get("expect") ?? JVal.Obj(new List<KeyValuePair<string, JVal>>());
                    List<JVal> miss = Compare(expect, got);
                    if (miss.Count == 0)
                    {
                        result.Passed++;
                    }
                    else
                    {
                        result.Failed++;
                        result.Failures.Add(Json.Obj(
                            ("id", JVal.Str(id)),
                            ("got", got),
                            ("expect", expect),
                            ("miss", JVal.Arr(miss))));
                    }
                }
                catch (Exception e)
                {
                    result.Failed++;
                    result.Failures.Add(Json.Obj(("id", JVal.Str(id)), ("error", JVal.Str(e.Message))));
                }
            }
            result.Total = result.Passed + result.Failed;
            return result;
        }

        /// <summary>默认黄金值路径：环境变量 WEIQI_GOLDEN，或从可执行目录/当前目录逐级向上找 spec/golden.json。</summary>
        public static string DefaultGoldenPath()
        {
            string env = Environment.GetEnvironmentVariable("WEIQI_GOLDEN");
            if (!string.IsNullOrEmpty(env) && File.Exists(env)) return env;

            var roots = new List<string>();
            try { roots.Add(AppContext.BaseDirectory); } catch { }
            try { roots.Add(Environment.CurrentDirectory); } catch { }

            foreach (string root in roots)
            {
                if (string.IsNullOrEmpty(root)) continue;
                DirectoryInfo dir = new DirectoryInfo(root);
                while (dir != null)
                {
                    string candidate = Path.Combine(dir.FullName, "spec", "golden.json");
                    if (File.Exists(candidate)) return candidate;
                    dir = dir.Parent;
                }
            }
            return null;
        }
    }
}
