// Program.cs — CsWeiqi CLI + 内部单元测试
//
// 用法：
//     dotnet run -c Release -- test        # 黄金值 + 内部单测（验收门）
//     dotnet run -c Release -- selftest    # 仅黄金值
//     dotnet run -c Release -- driver      # JSON-stdio 驱动模式（harness/tournament 用）
//     dotnet run -c Release -- selfplay N [playouts]
//     dotnet run -c Release -- bench [iters]   # 开发基准：MCTS 模拟速率 / 纯 playout 吞吐

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;

namespace CsWeiqi
{
    public static class Program
    {
        public static int Main(string[] args)
        {
            string mode = args.Length > 0 ? args[0] : "test";
            switch (mode)
            {
                case "driver": return Driver.Run();
                case "test": return RunSelftest(true);
                case "selftest": return RunSelftest(false);
                case "selfplay": return RunSelfplay(args);
                case "bench": return RunBench(args);
                default:
                    Console.WriteLine("usage: CsWeiqi test|selftest|driver|selfplay [n] [playouts]|bench [iters]");
                    return 2;
            }
        }

        private static int RunSelftest(bool includeUnit)
        {
            var sw = Stopwatch.StartNew();
            string path = Golden.DefaultGoldenPath();
            if (string.IsNullOrEmpty(path))
            {
                Console.WriteLine("FAIL: cannot locate spec/golden.json");
                return 1;
            }
            GoldenResult g;
            try
            {
                g = Golden.RunGolden(path);
            }
            catch (Exception e)
            {
                Console.WriteLine("FAIL: " + e.Message);
                return 1;
            }
            UnitResult u = includeUnit ? UnitTests.Run() : UnitResult.Empty();

            int gp = g.Passed, gf = g.Failed;
            int up = u.Passed, uf = u.Failed;
            int total = gp + gf + up + uf;

            for (int i = 0; i < g.Failures.Count && i < 10; i++)
            {
                JVal f = g.Failures[i];
                JVal detail = f.Get("miss") ?? f.Get("error");
                Console.WriteLine("  GOLDEN FAIL " + (f.Get("id")?.AsString() ?? "?") + ": " + Json.ToText(detail ?? JVal.Null()));
            }
            for (int i = 0; i < u.Failures.Count && i < 10; i++)
            {
                Console.WriteLine("  UNIT   FAIL " + u.Failures[i].name + ": " + u.Failures[i].detail);
            }

            bool ok = gf == 0 && uf == 0;
            Console.WriteLine(string.Format(CultureInfo.InvariantCulture,
                "{0}: {1} passed, {2} failed (golden {3}/{4}, unit {5}/{6}) {7:F2}s",
                ok ? "PASS" : "FAIL", total - gf - uf, gf + uf,
                gp, gp + gf, up, up + uf, sw.Elapsed.TotalSeconds));
            return ok ? 0 : 1;
        }

        private static int RunSelfplay(string[] args)
        {
            int n = args.Length > 1 && int.TryParse(args[1], out int nn) ? nn : 60;
            int playouts = args.Length > 2 && int.TryParse(args[2], out int pp) ? pp : 30;
            var b = new Board(9, null, Wq.Profile("cn"));
            var sw = Stopwatch.StartNew();
            int played = 0;
            while (!b.IsOver() && played < n)
            {
                GenResult g = Ai.GenMove(b, playouts, played * 17 + 1, new Profile());
                if (g.Move == Ai.RESIGN)
                {
                    Console.WriteLine("ply " + played + ": resign");
                    break;
                }
                PlayResult r = b.Play(b.Side, g.Move);
                if (!r.Ok)
                {
                    Console.WriteLine("illegal pick: " + r.Reason);
                    return 1;
                }
                played++;
            }
            ScoreResult sc = b.Score(null);
            Console.WriteLine(string.Format(CultureInfo.InvariantCulture,
                "selfplay plies={0} over={1} result={2} black={3} white={4} dame={5} {6:F1}s",
                played, b.IsOver(), sc.Result, sc.Black, sc.White, sc.Dame, sw.Elapsed.TotalSeconds));
            return 0;
        }

        private static int RunBench(string[] args)
        {
            int iters = args.Length > 1 && int.TryParse(args[1], out int nn) ? nn : 2000;
            // 9 路中盘局面
            var b = new Board(9, null, Wq.Profile("cn"));
            string[] setup = { "D4", "F4", "E3", "F6", "E6", "G7", "D7", "C6", "H3" };
            int[] colors = { 1, 1, 1, 2, 2, 1, 2, 1, 2 };
            var stones = new List<(int, int)>();
            for (int i = 0; i < setup.Length; i++) stones.Add((colors[i], Wq.ParseVertex(setup[i], 9)));
            b.SetStones(stones, 1);

            var pr = new Profile();
            // 预热
            Ai.GenMove(b, 200, 1, pr);

            var sw = Stopwatch.StartNew();
            GenResult g = Ai.GenMove(b, iters, 1, pr);
            sw.Stop();
            double secs = sw.Elapsed.TotalSeconds;
            Console.WriteLine(string.Format(CultureInfo.InvariantCulture,
                "bench genmove playouts={0} {1:F3}s  {2:F0} playouts/s  (vertex={3} visits={4} winrate={5:F4})",
                iters, secs, iters / secs,
                g.Move == Ai.PASS ? "pass" : Wq.FormatVertex(g.Move, 9), g.Visits, g.Winrate));

            var (moves, secs2) = Ai.BenchPlayouts(b, Math.Max(1, iters / 4), 1);
            int rawIters = Math.Max(1, iters / 4);
            Console.WriteLine(string.Format(CultureInfo.InvariantCulture,
                "bench raw-playout iters={0} moves={1} {2:F3}s  {3:F0} playouts/s  {4:F2} M moves/s",
                rawIters, moves, secs2, rawIters / secs2, moves / secs2 / 1e6));

            double nsPerProbe = Ai.BenchProbe(b, 20000000);
            Console.WriteLine(string.Format(CultureInfo.InvariantCulture,
                "bench probe {0:F1} ns/probe", nsPerProbe));
            return 0;
        }
    }

    public sealed class UnitResult
    {
        public int Passed;
        public int Failed;
        public List<(string name, string detail)> Failures = new List<(string, string)>();
        public static UnitResult Empty() => new UnitResult();
    }

    /// <summary>内部单元测试（对照 PyWeiqi/tests.py，规则不变量 + AI 行为）。</summary>
    public static class UnitTests
    {
        private sealed class T
        {
            public int Passed;
            public int Failed;
            public List<(string, string)> Failures = new List<(string, string)>();

            public void Check(string name, bool cond, object detail = null)
            {
                if (cond) Passed++;
                else { Failed++; Failures.Add((name, detail == null ? "" : detail.ToString())); }
            }

            public void Eq(string name, object got, object exp)
            {
                Check(name, EqualsObj(got, exp), "got=" + Show(got) + " exp=" + Show(exp));
            }
        }

        private static string Show(object o)
        {
            if (o == null) return "null";
            if (o is int[] ia) return "[" + string.Join(",", ia) + "]";
            return o.ToString();
        }

        private static bool EqualsObj(object a, object b)
        {
            if (a == null && b == null) return true;
            if (a == null || b == null) return false;
            if (a is int[] xa && b is int[] xb)
            {
                if (xa.Length != xb.Length) return false;
                for (int i = 0; i < xa.Length; i++) if (xa[i] != xb[i]) return false;
                return true;
            }
            return a.Equals(b);
        }

        private static int P(int size, string s) => Wq.ParseVertex(s, size);

        private static int ZeroCount(byte[] cells)
        {
            int n = 0;
            for (int i = 0; i < cells.Length; i++) if (cells[i] == 0) n++;
            return n;
        }

        public static UnitResult Run()
        {
            var t = new T();

            // ---------- 坐标 ----------
            bool ok = true;
            foreach (int size in new[] { 2, 5, 9, 13, 19 })
            {
                for (int y = 0; y < size; y++)
                {
                    for (int x = 0; x < size; x++)
                    {
                        string s = Wq.FormatVertex(y * size + x, size);
                        if (Wq.ParseVertex(s, size) != y * size + x) ok = false;
                    }
                }
            }
            t.Check("vertex.roundtrip.all_sizes", ok);
            t.Eq("vertex.skip_I", Wq.FormatVertex(8, 9), "J1");
            t.Eq("vertex.pass", P(9, "PASS"), -1);
            t.Eq("vertex.lowercase", P(9, "e5"), P(9, "E5"));
            int bad = 0;
            foreach (string s in new[] { "I5", "A0", "A10", "", "Z9", "5A" })
            {
                try { Wq.ParseVertex(s, 9); }
                catch (Exception) { bad++; }
            }
            t.Eq("vertex.reject_invalid", bad, 6);
            t.Eq("color.parse", (Wq.ParseColor("b"), Wq.ParseColor("WHITE")), (1, 2));

            // ---------- Zobrist ----------
            var vals = new HashSet<ulong>();
            for (int zc = 1; zc <= 2; zc++)
                for (int p = 0; p < Wq.MAX_POINTS; p++)
                    vals.Add(Wq.ZB[zc, p]);
            t.Eq("zobrist.distinct", vals.Count, Wq.MAX_POINTS * 2);
            t.Check("zobrist.sidekey_nonzero", Wq.SIDEKEY_W != 0);
            var b9 = new Board(9, null, null);
            t.Eq("zobrist.empty_board_zero", b9.Key().posKey, 0UL);
            var b19 = new Board(19, null, null);
            b9.SetStones(new List<(int, int)> { (1, P(9, "A1")) }, 1);
            b19.SetStones(new List<(int, int)> { (1, P(19, "A1")) }, 1);
            t.Eq("zobrist.size_independent", b9.Key().posKey, b19.Key().posKey);
            t.Eq("zobrist.single_stone_A1", b9.Key().posKey, Wq.SplitMix64(0));
            var b9e = new Board(9, null, null);
            b9e.SetStones(new List<(int, int)> { (1, P(9, "E5")) }, 1);
            t.Eq("zobrist.single_stone_E5_index40", b9e.Key().posKey, Wq.SplitMix64(40));
            ulong bk = b9.Key().posKey;
            b9.Side = 2;
            t.Eq("zobrist.situational_flip", b9.Key().sitKey, bk ^ Wq.SIDEKEY_W);

            // ---------- 规则档 ----------
            RuleSet cn = Wq.Profile("cn");
            t.Check("rules.cn", cn.Ko == "positional" && cn.Suicide == "forbid" && cn.Scoring == "area" && cn.Komi == 7.5, cn.Ko);
            t.Eq("rules.tt", Wq.Profile("tt").Suicide, "allow");
            t.Eq("rules.jp", Wq.Profile("jp").Scoring, "territory");
            bool rejected = false;
            try { Wq.RulesFromParts("bogus", null, null, null); }
            catch (Exception) { rejected = true; }
            t.Check("rules.reject_bad_ko", rejected);

            // ---------- 提子与气 ----------
            var b = new Board(9, null, null);
            b.SetStones(new List<(int, int)> {
                (2, P(9, "E5")), (1, P(9, "E4")), (1, P(9, "E6")), (1, P(9, "D5")) }, 1);
            PlayResult r = b.Play(1, P(9, "F5"));
            t.Check("capture.single", r.Ok && r.Captures == 1, r.Captures);
            t.Eq("capture.prisoners", b.Prisoners(), (1, 0));

            b = new Board(9, null, null);
            b.SetStones(new List<(int, int)> {
                (1, P(9, "E4")), (1, P(9, "E5")), (1, P(9, "E6")),
                (2, P(9, "D4")), (2, P(9, "D5")), (2, P(9, "D6")),
                (2, P(9, "F4")), (2, P(9, "F5")),
                (2, P(9, "E3")), (2, P(9, "E7")) }, 2);
            r = b.Play(2, P(9, "F6"));
            t.Check("capture.three_stones", r.Ok && r.Captures == 3, r.Captures);

            b = new Board(9, null, null);
            b.SetStones(new List<(int, int)> { (1, P(9, "E5")), (1, P(9, "E6")) }, 1);
            var grp = b.Group(P(9, "E5"));
            t.Eq("group.members", grp.members.Count, 2);
            t.Eq("group.liberties", grp.libs.Count, 6);

            // ---------- 自杀 ----------
            var setupSui = new List<(int, int)> {
                (2, P(9, "E4")), (2, P(9, "E6")), (2, P(9, "D5")), (2, P(9, "F5")) };
            b = new Board(9, null, null);
            b.SetStones(setupSui, 1);
            r = b.Play(1, P(9, "E5"));
            t.Check("suicide.forbid", !r.Ok && r.Reason == "suicide", r.Reason);
            t.Eq("suicide.forbid.board_unchanged", ZeroCount(b.Cells), 81 - 4);

            b = new Board(3, null, Wq.Profile("tt"));
            b.SetStones(new List<(int, int)> {
                (1, P(3, "A1")), (1, P(3, "B1")),
                (2, P(3, "A2")), (2, P(3, "B2")), (2, P(3, "C2")) }, 1);
            r = b.Play(1, P(3, "C1"));
            t.Check("suicide.allow.multi_stone", r.Ok && r.SelfCaptured == 3, r.SelfCaptured);
            {
                int blacks = 0;
                for (int i = 0; i < b.Cells.Length; i++) if (b.Cells[i] == 1) blacks++;
                t.Eq("suicide.allow.no_black_stone", blacks, 0);
            }

            var rr = new Board(3, null, Wq.Profile("tt"));
            rr.SetStones(new List<(int, int)> { (2, P(3, "A2")), (2, P(3, "B2")), (2, P(3, "B1")) }, 1);
            t.Check("suicide.restore_blocked_by_PSK", rr.Play(1, P(3, "A1")).Reason == "superko");

            rr = new Board(3, null, Wq.RulesFromParts("simple", "allow", "area", null));
            rr.SetStones(new List<(int, int)> { (2, P(3, "A2")), (2, P(3, "B2")), (2, P(3, "B1")) }, 1);
            PlayResult rrs = rr.Play(1, P(3, "A1"));
            t.Check("suicide.restore_allowed_by_simple_ko", rrs.Ok && rrs.SelfCaptured == 1, rrs.SelfCaptured);

            b = new Board(5, null, null);
            b.SetStones(new List<(int, int)> {
                (2, P(5, "A2")), (2, P(5, "B1")),
                (1, P(5, "A3")), (1, P(5, "B2")), (1, P(5, "C1")) }, 1);
            r = b.Play(1, P(5, "A1"));
            t.Check("suicide.after_capture", r.Ok && r.Captures == 2, r.Captures);

            // ---------- 劫 ----------
            var koSetup = new List<(int, int)> {
                (2, P(9, "D4")), (2, P(9, "C3")), (2, P(9, "C5")), (2, P(9, "B4")),
                (1, P(9, "D3")), (1, P(9, "D5")), (1, P(9, "E4")) };
            b = new Board(9, null, null);
            b.SetStones(koSetup, 1);
            r = b.Play(1, P(9, "C4"));
            t.Check("ko.capture_ok", r.Ok && r.Captures == 1, r.Captures);
            t.Eq("ko.point_set", b.KoPoint, P(9, "D4"));
            bool okk = b.Legal(2, P(9, "D4"), out string kr);
            t.Check("ko.immediate_recapture_illegal", !okk && kr == "ko", kr);

            b = new Board(9, null, Wq.Profile("jp"));
            b.SetStones(koSetup, 1);
            b.Play(1, P(9, "C4"));
            b.Play(2, -1);
            t.Eq("ko.pass_clears_point", b.KoPoint, -1);

            b = new Board(9, null, null);
            b.SetStones(koSetup, 1);
            b.Play(1, P(9, "C4"));
            b.Play(2, P(9, "H9"));
            b.Play(1, P(9, "H1"));
            bool okk2 = b.Legal(2, P(9, "D4"), out string kr2);
            t.Check("ko.delayed_recapture_legal", okk2, kr2);

            // ---------- undo ----------
            b = new Board(9, null, null);
            var snaps = new List<(ulong posKey, ulong sitKey, int side, int ko, byte[] cells, int[] caps, int hp, int hs, int st)>();
            for (int i = 0; i < 12; i++)
            {
                var kk = b.Key();
                snaps.Add((kk.posKey, kk.sitKey, b.Side, b.KoPoint, (byte[])b.Cells.Clone(),
                           (int[])b.Captures.Clone(), b.HistPos.Count, b.HistSit.Count, b.Stack.Count));
                List<int> legal = b.LegalMoves();
                PlayResult pr2 = b.Play(b.Side, legal[(i * 7) % legal.Count]);
                if (!pr2.Ok) break;
            }
            bool okall = true;
            for (int i = snaps.Count - 1; i >= 0; i--)
            {
                b.Undo();
                var s = snaps[i];
                var kk = b.Key();
                if (s.posKey != kk.posKey || s.sitKey != kk.sitKey || s.side != b.Side || s.ko != b.KoPoint ||
                    s.hp != b.HistPos.Count || s.hs != b.HistSit.Count || s.st != b.Stack.Count)
                {
                    okall = false;
                }
                else
                {
                    for (int j = 0; j < s.cells.Length; j++) if (s.cells[j] != b.Cells[j]) { okall = false; break; }
                    for (int j = 0; j < 3; j++) if (s.caps[j] != b.Captures[j]) { okall = false; break; }
                }
            }
            t.Check("undo.restores_exact_state", okall);

            b = new Board(9, null, null);
            b.Play(1, P(9, "E5"));
            b.Play(2, -1);
            t.Eq("undo.pass", b.Undo(), true);
            t.Eq("undo.pass_restored_side", b.Side, 2);
            t.Eq("undo.then_move", b.Undo(), true);
            t.Eq("undo.move_restored_side", b.Side, 1);
            t.Eq("undo.empty_stack", b.Undo(), false);

            // ---------- clone / set_stones ----------
            b = new Board(9, null, null);
            b.Play(1, P(9, "E5"));
            Board c = b.Clone();
            c.Play(2, P(9, "D5"));
            t.Eq("clone.independent", (ZeroCount(b.Cells), ZeroCount(c.Cells)), (80, 79));

            b = new Board(9, null, null);
            b.Play(1, P(9, "E5"));
            b.SetStones(new List<(int, int)> { (2, P(9, "A1")) }, 2);
            t.Eq("set_stones.resets_history", (b.HistPos.Count, b.Captures[1], b.Side), (1, 0, 2));

            // ---------- 计分不变量 ----------
            bool okarea = true;
            var rng = new Ai.Rng(2026);
            for (int trial = 0; trial < 30; trial++)
            {
                b = new Board(9, null, null);
                for (int i = 0; i < 20; i++)
                {
                    List<int> legal = b.LegalMoves();
                    if (legal.Count == 0) break;
                    b.Play(b.Side, legal[rng.RandInt(legal.Count)]);
                }
                ScoreResult sc = b.Score(null);
                if (sc.Black + sc.White + sc.Dame != 81) okarea = false;
            }
            t.Check("score.area_partition_invariant", okarea);

            // ---------- 终局 ----------
            b = new Board(9, null, null);
            b.Play(1, -1);
            t.Eq("pass.one_not_over", b.IsOver(), false);
            b.Play(2, -1);
            t.Eq("pass.two_over", b.IsOver(), true);
            r = b.Play(1, P(9, "E5"));
            t.Check("pass.play_after_over", !r.Ok && r.Reason == "over", r.Reason);
            b.Undo();
            t.Eq("pass.undo_reopens", b.IsOver(), false);

            // ---------- 数值格式 ----------
            t.Eq("fmt_num.int", Wq.FmtNum(3.0), "3");
            t.Eq("fmt_num.half", Wq.FmtNum(3.5), "3.5");
            t.Eq("fmt_num.quarter", Wq.FmtNum(0.25), "0.25");
            t.Eq("fmt_num.zero", Wq.FmtNum(0.0), "0");

            // ---------- AI ----------
            b = new Board(9, null, null);
            b.SetStones(new List<(int, int)> {
                (1, P(9, "E5")), (2, P(9, "E3")), (1, P(9, "G5")), (2, P(9, "G3")) }, 1);
            GenResult m1 = Ai.GenMove(b, 40, 5, new Profile());
            GenResult m2 = Ai.GenMove(b, 40, 5, new Profile());
            t.Check("ai.deterministic_same_seed", m1.Move == m2.Move && m1.Visits == m2.Visits,
                    m1.Move + "/" + m2.Move);
            List<int> lm = b.LegalMoves();
            t.Check("ai.legal_move", m1.Move == -1 || lm.Contains(m1.Move), m1.Move);
            t.Check("ai.different_seed_explores", Ai.GenMove(b, 40, 99, new Profile()).Move != int.MinValue);

            b = new Board(9, null, null);
            b.SetStones(new List<(int, int)> {
                (2, P(9, "E5")), (2, P(9, "E6")), (2, P(9, "E7")),
                (1, P(9, "D5")), (1, P(9, "D6")), (1, P(9, "D7")),
                (1, P(9, "F5")), (1, P(9, "F6")), (1, P(9, "F7")),
                (1, P(9, "E4")) }, 1);
            var legal9 = new HashSet<int>(b.LegalMoves());
            bool allok = true;
            foreach (int pl in new[] { 50, 150, 300 })
            {
                GenResult mv = Ai.GenMove(b, pl, 11, new Profile());
                if (mv.Move != -1 && !legal9.Contains(mv.Move)) allok = false;
            }
            t.Check("ai.genmove_always_legal", allok);
            t.Check("ai.priors_capture_higher", Ai.MovePrior(2, 3) > Ai.MovePrior(0, 3));
            t.Check("ai.priors_self_atari_lower", Ai.MovePrior(0, 1) < Ai.MovePrior(0, 3));

            // 自对弈可终局且全着合法
            b = new Board(9, null, null);
            int plies = 0;
            bool alllegal = true;
            while (!b.IsOver() && plies < 200)
            {
                GenResult mv = Ai.GenMove(b, 15, 100 + plies, new Profile());
                if (mv.Move == Ai.RESIGN) break;
                PlayResult pr3 = b.Play(b.Side, mv.Move);
                if (!pr3.Ok) { alllegal = false; break; }
                plies++;
            }
            t.Check("ai.selfplay_legal_and_terminates", alllegal && b.IsOver(), "plies=" + plies);

            return new UnitResult { Passed = t.Passed, Failed = t.Failed, Failures = t.Failures };
        }
    }
}
