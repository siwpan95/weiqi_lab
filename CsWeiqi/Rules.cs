// Rules.cs — 围棋规则核心（C# 移植；零第三方依赖）
//
// 唯一真相来源：docs/RULES_SPEC.md（spec-v1）；参考实现：PyWeiqi/weiqi_rules.py。
// 本模块在【规则操作】上与 Python 参考实现逐位一致：
//   坐标、走子/提子/自杀、三档禁全同、Zobrist 键、两套计分、结果串格式。
//
// 注意：
//   * 64 位算术全程置于 unchecked（溢出即 mod 2^64）；ulong 的 >> 为逻辑右移。
//   * Zobrist 表固定按 361 点生成，与棋盘尺寸无关（RULES_SPEC §6）。
//   * 输出格式：posKey/sitKey 为 "0x" + 16 位小写十六进制。

using System;
using System.Collections.Generic;
using System.Globalization;

namespace CsWeiqi
{
    /// <summary>携带稳定 reason 标识的规则异常。</summary>
    public sealed class WqError : Exception
    {
        public string Reason;
        public WqError(string reason) : base(reason) { Reason = reason; }
    }

    /// <summary>归一化后的规则档（ko / suicide / scoring / komi）。</summary>
    public sealed class RuleSet
    {
        public string Ko = "positional";
        public string Suicide = "forbid";
        public string Scoring = "area";
        public double Komi = 7.5;

        public RuleSet Copy()
        {
            return new RuleSet { Ko = Ko, Suicide = Suicide, Scoring = Scoring, Komi = Komi };
        }
    }

    /// <summary>规则核心自由函数（静态工具集）。</summary>
    public static class Wq
    {
        /// <summary>列字母：跳过 I，共 19 个（RULES_SPEC §1）。</summary>
        public const string COLS = "ABCDEFGHJKLMNOPQRST";
        public const int MAX_POINTS = 361;

        /// <summary>splitmix64（严格按 RULES_SPEC §6，全程无符号 64 位，溢出回绕）。</summary>
        [System.Runtime.CompilerServices.MethodImpl(System.Runtime.CompilerServices.MethodImplOptions.AggressiveInlining)]
        public static ulong SplitMix64(ulong x)
        {
            unchecked
            {
                ulong z = x + 0x9E3779B97F4A7C15UL;
                z = (z ^ (z >> 30)) * 0xBF58476D1CE4E5B9UL;
                z = (z ^ (z >> 27)) * 0x94D049BB133111EBUL;
                return z ^ (z >> 31);
            }
        }

        /// <summary>ZB[c][p] = splitmix64((c-1)*1024 + p)，c∈{1,2}，p∈[0,361)。</summary>
        public static readonly ulong[,] ZB = new ulong[3, MAX_POINTS];
        /// <summary>SIDEKEY_W = splitmix64(4096)。</summary>
        public static readonly ulong SIDEKEY_W;

        static Wq()
        {
            unchecked
            {
                for (int c = 1; c <= 2; c++)
                {
                    for (int p = 0; p < MAX_POINTS; p++)
                    {
                        ZB[c, p] = SplitMix64(((ulong)(c - 1) * 1024UL) + (ulong)p);
                    }
                }
                SIDEKEY_W = SplitMix64(4096UL);
            }
        }

        /// <summary>键输出格式：0x + 16 位小写十六进制（RULES_SPEC §6）。</summary>
        public static string FmtKey(ulong k)
        {
            return "0x" + k.ToString("x16", CultureInfo.InvariantCulture);
        }

        /// <summary>数值格式：整数不带小数点，否则按 0.25 步长（.25/.5/.75）。</summary>
        public static string FmtNum(double v)
        {
            // Python 的 round() 使用银行家舍入；与 int(round(v*4)) 对齐。
            long q = (long)Math.Round(v * 4.0, MidpointRounding.ToEven);
            long a = q < 0 ? -q : q;
            long whole = a / 4;
            long rem = a % 4;
            string suf = rem == 0 ? "" : rem == 1 ? ".25" : rem == 2 ? ".5" : ".75";
            string s = whole.ToString(CultureInfo.InvariantCulture) + suf;
            return q < 0 ? "-" + s : s;
        }

        /// <summary>邻点表（4 邻域，顺序：左、右、下、上，与 Python 一致）。</summary>
        public static int[][] NeighborsOf(int size)
        {
            var n = new int[size * size][];
            for (int y = 0; y < size; y++)
            {
                for (int x = 0; x < size; x++)
                {
                    var l = new List<int>(4);
                    if (x > 0) l.Add(y * size + x - 1);
                    if (x < size - 1) l.Add(y * size + x + 1);
                    if (y > 0) l.Add((y - 1) * size + x);
                    if (y < size - 1) l.Add((y + 1) * size + x);
                    n[y * size + x] = l.ToArray();
                }
            }
            return n;
        }

        /// <summary>顶点串 → 点索引；"pass" → -1；非法 → WqError("range")。</summary>
        public static int ParseVertex(string s, int size)
        {
            if (s == null) throw new WqError("range");
            string t = s.Trim().ToUpperInvariant();
            if (t == "PASS") return -1;
            if (t.Length < 2) throw new WqError("range");
            int col = COLS.IndexOf(t[0]);
            if (col < 0 || col >= size) throw new WqError("range");
            if (!int.TryParse(t.Substring(1), NumberStyles.AllowLeadingSign,
                              CultureInfo.InvariantCulture, out int row))
            {
                throw new WqError("range");
            }
            if (row < 1 || row > size) throw new WqError("range");
            return (row - 1) * size + col;
        }

        /// <summary>点索引 → 顶点串；负值 → "pass"。</summary>
        public static string FormatVertex(int idx, int size)
        {
            if (idx < 0) return "pass";
            return COLS[idx % size].ToString() + (idx / size + 1).ToString(CultureInfo.InvariantCulture);
        }

        /// <summary>颜色串 → 1(黑)/2(白)；非法 → 异常。</summary>
        public static int ParseColor(object c)
        {
            string t = Convert.ToString(c, CultureInfo.InvariantCulture);
            t = (t ?? "").Trim().ToUpperInvariant();
            if (t == "B" || t == "BLACK" || t == "1") return 1;
            if (t == "W" || t == "WHITE" || t == "2") return 2;
            throw new WqError("bad color: " + PyRepr(c));
        }

        /// <summary>
        /// 近似 Python 的 repr()（用于对齐参考实现的 %r 错误消息）。
        /// 覆盖 None/bool/int/float/str；str 采用 Python 的引号选择与转义规则。
        /// </summary>
        public static string PyRepr(object v)
        {
            if (v == null) return "None";
            if (v is bool b) return b ? "True" : "False";
            if (v is string s) return PyReprStr(s);
            if (v is sbyte || v is byte || v is short || v is ushort ||
                v is int || v is uint || v is long)
                return Convert.ToInt64(v, CultureInfo.InvariantCulture).ToString(CultureInfo.InvariantCulture);
            if (v is ulong ul) return ul.ToString(CultureInfo.InvariantCulture);
            if (v is double d) return Json.PyFloat(d);
            if (v is float f) return Json.PyFloat(f);
            return PyReprStr(v.ToString());
        }

        /// <summary>Python str repr：'...'（若含单引号且不含双引号则用 "..."）。</summary>
        public static string PyReprStr(string s)
        {
            char quote = '\'';
            if (s.IndexOf('\'') >= 0 && s.IndexOf('"') < 0) quote = '"';
            var sb = new System.Text.StringBuilder(s.Length + 2);
            sb.Append(quote);
            foreach (char ch in s)
            {
                if (ch == '\\') sb.Append("\\\\");
                else if (ch == quote) { sb.Append('\\'); sb.Append(ch); }
                else if (ch == '\n') sb.Append("\\n");
                else if (ch == '\r') sb.Append("\\r");
                else if (ch == '\t') sb.Append("\\t");
                else if (ch < 0x20 || ch == 0x7f) sb.Append("\\x").Append(((int)ch).ToString("x2", CultureInfo.InvariantCulture));
                else sb.Append(ch);
            }
            sb.Append(quote);
            return sb.ToString();
        }

        public static string ColorName(int c)
        {
            return c == 1 ? "B" : "W";
        }

        /// <summary>档名 → 规则（RULES_SPEC §10）。未知档抛异常。</summary>
        public static RuleSet Profile(string name)
        {
            switch ((name ?? "").Trim().ToLowerInvariant())
            {
                case "cn":
                    return new RuleSet { Ko = "positional", Suicide = "forbid", Scoring = "area", Komi = 7.5 };
                case "tt":
                    return new RuleSet { Ko = "positional", Suicide = "allow", Scoring = "area", Komi = 7.5 };
                case "jp":
                    return new RuleSet { Ko = "simple", Suicide = "forbid", Scoring = "territory", Komi = 6.5 };
                default:
                    throw new WqError("unknown rules profile: " + PyRepr(name));
            }
        }

        /// <summary>
        /// 由三个可选字符串 + 可选 komi 归一化出规则（未指定项取 cn 档默认）。
        /// 对应 Python normalize_rules 的对象分支。
        /// </summary>
        public static RuleSet RulesFromParts(string ko, string suicide, string scoring, double? komi)
        {
            RuleSet outR = Profile("cn");
            if (ko != null)
            {
                string v = ko.Trim().ToLowerInvariant();
                if (v != "simple" && v != "positional" && v != "situational")
                    throw new WqError("bad ko: " + PyRepr(v));
                outR.Ko = v;
            }
            if (suicide != null)
            {
                string v = suicide.Trim().ToLowerInvariant();
                if (v != "forbid" && v != "allow")
                    throw new WqError("bad suicide: " + PyRepr(v));
                outR.Suicide = v;
            }
            if (scoring != null)
            {
                string v = scoring.Trim().ToLowerInvariant();
                if (v != "area" && v != "territory")
                    throw new WqError("bad scoring: " + PyRepr(v));
                outR.Scoring = v;
            }
            if (komi.HasValue) outR.Komi = komi.Value;
            return outR;
        }
    }

    /// <summary>走子记录（供 undo 使用）。Type: 0=pass，1=move。</summary>
    public sealed class Rec
    {
        public int Type;
        public int Color;
        public byte[] PrevCells;
        public ulong PrevKey;
        public int PrevSide;
        public int PrevKo;
        public int PrevPasses;
        public int PrevCap;
        public ulong PosKey;                       // move: 走子后的新盘面键
        public (ulong key, byte side) SitKey;      // move/pass: 追加到 hist_sit 的键
    }

    public struct PlayResult
    {
        public bool Ok;
        public string Reason;
        public int Captures;
        public int SelfCaptured;
        public ulong Key;
    }

    public sealed class ScoreResult
    {
        public int Black;
        public int White;
        public double Komi;
        public int Dame;
        public string Result;
        public int BlackTerritory;
        public int WhiteTerritory;
        public int BlackStones;
        public int WhiteStones;
        public int PrisonersBlack;
        public int PrisonersWhite;
    }

    /// <summary>完整规则棋盘。所有规则操作必须与 docs/RULES_SPEC.md 完全一致。</summary>
    public sealed class Board
    {
        public int Size;
        public int N2;
        public int[][] Neigh;
        public RuleSet Rules;
        public double Komi;
        public byte[] Cells;
        public int Side;
        public int KoPoint;
        public int Passes;
        public ulong PosKey;
        public int[] Captures;   // Captures[c] = c 方提掉的对方子数
        public bool Over;
        public List<Rec> Stack;
        public Dictionary<ulong, int> HistPos;
        public Dictionary<(ulong, byte), int> HistSit;

        public Board(int size, double? komi, RuleSet rules)
        {
            Size = size;
            if (size < 2 || size > 19) throw new WqError("bad size");
            N2 = size * size;
            Neigh = Wq.NeighborsOf(size);
            Rules = rules ?? Wq.Profile("cn");
            Komi = komi ?? Rules.Komi;
            Reset();
        }

        public void Reset()
        {
            Cells = new byte[N2];
            Side = 1;
            KoPoint = -1;
            Passes = 0;
            PosKey = 0;
            Captures = new int[3];
            Over = false;
            Stack = new List<Rec>();
            HistPos = new Dictionary<ulong, int> { { 0UL, 1 } };
            HistSit = new Dictionary<(ulong, byte), int> { { (0UL, (byte)1), 1 } };
        }

        public Board Clone()
        {
            var b = (Board)MemberwiseClone();
            b.Cells = (byte[])Cells.Clone();
            b.Captures = (int[])Captures.Clone();
            b.Stack = new List<Rec>(Stack);
            b.HistPos = new Dictionary<ulong, int>(HistPos);
            b.HistSit = new Dictionary<(ulong, byte), int>(HistSit);
            return b;
        }

        /// <summary>直接摆子（不校验合法性），历史重置为单条记录（RULES_SPEC §11）。</summary>
        public void SetStones(IReadOnlyList<(int color, int vertex)> stones, int side)
        {
            Reset();
            for (int i = 0; i < stones.Count; i++)
            {
                int color = stones[i].color;
                int vertex = stones[i].vertex;
                if (vertex >= 0 && vertex < N2)
                {
                    Cells[vertex] = (byte)color;
                    PosKey ^= Wq.ZB[color, vertex];
                }
            }
            Side = side;
            HistPos = new Dictionary<ulong, int> { { PosKey, 1 } };
            HistSit = new Dictionary<(ulong, byte), int> { { (PosKey, (byte)side), 1 } };
        }

        /// <summary>→ (posKey, sitKey)</summary>
        public (ulong posKey, ulong sitKey) Key()
        {
            ulong sit = PosKey ^ (Side == 2 ? Wq.SIDEKEY_W : 0UL);
            return (PosKey, sit);
        }

        public bool IsOver()
        {
            return Over;
        }

        // ---------- 棋块 ----------

        /// <summary>→ (members, libs)。libs 为去重后的空点集合。</summary>
        public (List<int> members, HashSet<int> libs) Group(int idx, byte[] cells = null)
        {
            if (cells == null) cells = Cells;
            int color = cells[idx];
            var stack = new List<int> { idx };
            var seen = new HashSet<int> { idx };
            var members = new List<int> { idx };
            var libs = new HashSet<int>();
            while (stack.Count > 0)
            {
                int cur = stack[stack.Count - 1];
                stack.RemoveAt(stack.Count - 1);
                int[] nb = Neigh[cur];
                for (int k = 0; k < nb.Length; k++)
                {
                    int v = cells[nb[k]];
                    if (v == 0)
                    {
                        libs.Add(nb[k]);
                    }
                    else if (v == color && !seen.Contains(nb[k]))
                    {
                        seen.Add(nb[k]);
                        stack.Add(nb[k]);
                        members.Add(nb[k]);
                    }
                }
            }
            return (members, libs);
        }

        // ---------- 走子 ----------

        private PlayResult Err(string reason)
        {
            return new PlayResult { Ok = false, Reason = reason, Captures = 0, SelfCaptured = 0, Key = PosKey };
        }

        /// <summary>走子。color: 1/2；vertex: 点索引 或 -1(pass)。</summary>
        public PlayResult Play(int color, int vertex)
        {
            if (Over) return Err("over");
            if (color != Side) return Err("turn");

            if (vertex == -1)
            {
                var rec = new Rec
                {
                    Type = 0,
                    PrevKey = PosKey,
                    PrevSide = Side,
                    PrevKo = KoPoint,
                    PrevPasses = Passes,
                };
                Side = 3 - color;
                var sitKey = (PosKey, (byte)Side);
                HistSit.TryGetValue(sitKey, out int sc);
                HistSit[sitKey] = sc + 1;
                rec.SitKey = sitKey;
                KoPoint = -1;
                Passes += 1;
                Stack.Add(rec);
                if (Passes >= 2) Over = true;
                return new PlayResult { Ok = true, Captures = 0, SelfCaptured = 0, Key = PosKey };
            }

            if (vertex < 0 || vertex >= N2) return Err("range");
            if (vertex == KoPoint) return Err("ko");
            if (Cells[vertex] != 0) return Err("occupied");

            int opp = 3 - color;
            byte[] cells = Cells;
            byte[] prevCells = (byte[])cells.Clone();
            ulong prevKey = PosKey;
            int prevCap = Captures[color];

            // 5) 落子
            cells[vertex] = (byte)color;
            PosKey ^= Wq.ZB[color, vertex];

            // 6) 提对方无气棋块
            var captured = new List<int>();
            var seenCap = new HashSet<int>();
            int[] vnb = Neigh[vertex];
            for (int k = 0; k < vnb.Length; k++)
            {
                int nb = vnb[k];
                if (cells[nb] == opp && !seenCap.Contains(nb))
                {
                    var (members, libs) = Group(nb, cells);
                    if (libs.Count == 0)
                    {
                        for (int i = 0; i < members.Count; i++) seenCap.Add(members[i]);
                        captured.AddRange(members);
                    }
                }
            }
            for (int i = 0; i < captured.Count; i++)
            {
                int m = captured[i];
                cells[m] = 0;
                PosKey ^= Wq.ZB[opp, m];
            }

            // 7) 自杀判定（提子后己方必有气，可跳过重扫）
            var selfCaptured = new List<int>();
            if (captured.Count == 0)
            {
                var (members, libs) = Group(vertex, cells);
                if (libs.Count == 0)
                {
                    if (Rules.Suicide == "forbid")
                    {
                        Cells = prevCells;
                        PosKey = prevKey;
                        return Err("suicide");
                    }
                    selfCaptured = members;
                    for (int i = 0; i < members.Count; i++)
                    {
                        int m = members[i];
                        cells[m] = 0;
                        PosKey ^= Wq.ZB[color, m];
                    }
                }
            }

            // 8) 禁全同（新盘面上判定）
            ulong newKey = PosKey;
            int newSide = 3 - color;
            if (Rules.Ko == "positional" && HistPos.ContainsKey(newKey))
            {
                Cells = prevCells;
                PosKey = prevKey;
                return Err("superko");
            }
            if (Rules.Ko == "situational" && HistSit.ContainsKey((newKey, (byte)newSide)))
            {
                Cells = prevCells;
                PosKey = prevKey;
                return Err("superko");
            }

            // 9) 提交（先取 koPoint 快照，再改状态）
            int koNew = -1;
            if (captured.Count == 1)
            {
                var (members, libs) = Group(vertex, cells);
                if (members.Count == 1 && libs.Count == 1) koNew = captured[0];
            }
            var rec2 = new Rec
            {
                Type = 1,
                Color = color,
                PrevCells = prevCells,
                PrevKey = prevKey,
                PrevSide = Side,
                PrevKo = KoPoint,
                PrevPasses = Passes,
                PrevCap = prevCap,
                PosKey = newKey,
                SitKey = (newKey, (byte)newSide),
            };
            KoPoint = koNew;
            Captures[color] += captured.Count;
            Side = newSide;
            Passes = 0;
            HistPos.TryGetValue(newKey, out int hp);
            HistPos[newKey] = hp + 1;
            var sk = (newKey, (byte)newSide);
            HistSit.TryGetValue(sk, out int hs);
            HistSit[sk] = hs + 1;
            Stack.Add(rec2);
            return new PlayResult { Ok = true, Captures = captured.Count, SelfCaptured = selfCaptured.Count, Key = newKey };
        }

        public bool Undo()
        {
            if (Stack.Count == 0) return false;
            Rec rec = Stack[Stack.Count - 1];
            Stack.RemoveAt(Stack.Count - 1);

            if (rec.Type == 0)
            {
                var k = rec.SitKey;
                if (HistSit.TryGetValue(k, out int n))
                {
                    if (n - 1 <= 0) HistSit.Remove(k); else HistSit[k] = n - 1;
                }
                PosKey = rec.PrevKey;
                Side = rec.PrevSide;
                KoPoint = rec.PrevKo;
                Passes = rec.PrevPasses;
            }
            else
            {
                ulong pk = rec.PosKey;
                if (HistPos.TryGetValue(pk, out int np))
                {
                    if (np - 1 <= 0) HistPos.Remove(pk); else HistPos[pk] = np - 1;
                }
                var k = rec.SitKey;
                if (HistSit.TryGetValue(k, out int ns))
                {
                    if (ns - 1 <= 0) HistSit.Remove(k); else HistSit[k] = ns - 1;
                }
                Cells = rec.PrevCells;
                PosKey = rec.PrevKey;
                Captures[rec.Color] = rec.PrevCap;
                Side = rec.PrevSide;
                KoPoint = rec.PrevKo;
                Passes = rec.PrevPasses;
            }
            Over = false;
            return true;
        }

        // ---------- 合法性与计分 ----------

        /// <summary>单点合法性 → (ok, reason or null)。</summary>
        public bool Legal(int color, int vertex, out string reason)
        {
            reason = null;
            if (Over) { reason = "over"; return false; }
            if (color != Side) { reason = "turn"; return false; }
            if (vertex == -1) return true;
            if (vertex < 0 || vertex >= N2) { reason = "range"; return false; }
            if (vertex == KoPoint) { reason = "ko"; return false; }
            if (Cells[vertex] != 0) { reason = "occupied"; return false; }
            Board b = Clone();
            PlayResult r = b.Play(color, vertex);
            if (r.Ok) return true;
            reason = r.Reason;
            return false;
        }

        /// <summary>当前轮次方全部合法点（升序，不含 pass）。</summary>
        public List<int> LegalMoves()
        {
            var outList = new List<int>();
            for (int p = 0; p < N2; p++)
            {
                if (Cells[p] == 0 && Legal(Side, p, out _)) outList.Add(p);
            }
            return outList;
        }

        /// <summary>→ (黑方提子数, 白方提子数)</summary>
        public (int black, int white) Prisoners()
        {
            return (Captures[1], Captures[2]);
        }

        /// <summary>计分（RULES_SPEC §9）。dead 为显式死子列表（territory 档使用）。</summary>
        public ScoreResult Score(IReadOnlyList<(int color, int vertex)> dead)
        {
            byte[] cells = Cells;
            int[] prisoners = { 0, Captures[1], Captures[2] };
            if (dead != null && dead.Count > 0)
            {
                cells = (byte[])Cells.Clone();
                for (int i = 0; i < dead.Count; i++)
                {
                    int color = dead[i].color;
                    int vertex = dead[i].vertex;
                    if (vertex >= 0 && vertex < N2 && cells[vertex] == color)
                    {
                        cells[vertex] = 0;
                        prisoners[3 - color] += 1;
                    }
                }
            }

            var seen = new bool[N2];
            int blackT = 0, whiteT = 0, dame = 0;
            var stack = new List<int>();
            for (int start = 0; start < N2; start++)
            {
                if (cells[start] != 0 || seen[start]) continue;
                stack.Clear();
                stack.Add(start);
                seen[start] = true;
                int regionSize = 1;
                int borders = 0;
                while (stack.Count > 0)
                {
                    int cur = stack[stack.Count - 1];
                    stack.RemoveAt(stack.Count - 1);
                    int[] nb = Neigh[cur];
                    for (int k = 0; k < nb.Length; k++)
                    {
                        int v = cells[nb[k]];
                        if (v == 0)
                        {
                            if (!seen[nb[k]])
                            {
                                seen[nb[k]] = true;
                                stack.Add(nb[k]);
                                regionSize++;
                            }
                        }
                        else
                        {
                            borders |= 1 << v;
                        }
                    }
                }
                if (borders == 0b10) blackT += regionSize;
                else if (borders == 0b100) whiteT += regionSize;
                else dame += regionSize;
            }

            int blackStones = 0, whiteStones = 0;
            for (int i = 0; i < cells.Length; i++)
            {
                if (cells[i] == 1) blackStones++;
                else if (cells[i] == 2) whiteStones++;
            }

            int black, white;
            if (Rules.Scoring == "area")
            {
                black = blackStones + blackT;
                white = whiteStones + whiteT;
            }
            else
            {
                black = blackT + prisoners[1];
                white = whiteT + prisoners[2];
            }

            double diff = black - (white + Komi);
            string result;
            if (diff == 0.0) result = "0";
            else if (diff > 0.0) result = "B+" + Wq.FmtNum(diff);
            else result = "W+" + Wq.FmtNum(-diff);

            return new ScoreResult
            {
                Black = black,
                White = white,
                Komi = Komi,
                Dame = dame,
                Result = result,
                BlackTerritory = blackT,
                WhiteTerritory = whiteT,
                BlackStones = blackStones,
                WhiteStones = whiteStones,
                PrisonersBlack = prisoners[1],
                PrisonersWhite = prisoners[2],
            };
        }
    }
}
