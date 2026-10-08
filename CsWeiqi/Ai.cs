// Ai.cs — MCTS(UCT+RAVE) 引擎（C# 移植；零第三方依赖）
//
// 对照 PyWeiqi/weiqi_ai.py。设计要点：
//   * 树内与最终落子走【完整规则】（禁全同）；playout 允许 simple-ko 近似（Fuego/Pachi 同款折衷）。
//   * 候选点裁剪：以最近棋子为中心、切比雪夫半径 R 内的空点（R=0 关裁剪）。
//   * playout 采用「局部候选」：优先只在最后一手 1 邻域内选点，局部无可选才全盘扫描。
//   * RNG 为 splitmix64 流；同 (局面, playouts, seed, profile) 可复现。
//   * 性能（PORTING §5）：stamp 数组代际标记（零 set 分配）、提子预检、己方气数下界、
//     单子判定、扁平静态邻点表、全部推演缓冲复用（热路径零分配）、arena 树；
//     最内层循环使用 MemoryMarshal/Unsafe 的 ref 算术消除边界检查（BCL，非第三方包）。

using System;
using System.Collections.Generic;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;

namespace CsWeiqi
{
    /// <summary>风格档（对应协议 §2.1 profile 对象）。</summary>
    public sealed class Profile
    {
        public double C = 0.7;
        public bool Rave = true;
        public double RaveK = 100.0;          // 与参考实现一致（PROTOCOL_SPEC 表记 1000）
        public double CaptureBias = 0.5;
        public double PatternBias = 0.5;
        public int PruneRadius = 2;
        public double PassBias = 0.0;
        public double ResignThreshold = 0.0;
        public int ResignMinVisits = 200;
        public double Mercy = 0.0;
        public double PassThreshold = 0.5;
        public double ScoreScale = 0.0;       // 0 → 自动 = n2/2（分差归一化尺度）
    }

    public struct GenResult
    {
        public int Move;      // -2=resign, -1=pass, >=0=点索引
        public int Visits;
        public double Winrate;
    }

    public static class Ai
    {
        public const int PASS = -1;
        public const int RESIGN = -2;

        // ------------------------------------------------------------------
        // RNG：splitmix64 流式
        // ------------------------------------------------------------------
        public sealed class Rng
        {
            private ulong _state;
            public Rng(long seed)
            {
                unchecked { _state = (ulong)seed + 0x9E3779B97F4A7C15UL; }
            }
            public ulong NextU64()
            {
                unchecked
                {
                    _state = _state + 0x9E3779B97F4A7C15UL;
                    return Wq.SplitMix64(_state);
                }
            }
            public int RandInt(int n)
            {
                return n > 0 ? (int)(NextU64() % (ulong)n) : 0;
            }
            public double Random()
            {
                return (double)(NextU64() >> 11) * (1.0 / 9007199254740992.0);
            }
        }

        // ------------------------------------------------------------------
        // 推演缓冲（复用，避免热路径分配）
        // ------------------------------------------------------------------
        private sealed class Scratch
        {
            public int[] Stamp;
            public int[] LibStamp;
            public int[] MarkStamp;
            public int Gen;
            public int MarkGen;

            public int[] Stack;
            public int[] Members;
            public int[] SaveIdx;
            public byte[] SaveOld;
            public int[] Captured;
            public bool[] Near;
            public bool[] Seen;
            public int[] Cands;
            public int[] Urgent;
            public int[] Pts;
            public int[] Local;
            public int[] Rescue;

            public Scratch(int n2)
            {
                Stamp = new int[n2];
                LibStamp = new int[n2];
                MarkStamp = new int[n2];
                Stack = new int[n2];
                Members = new int[n2];
                SaveIdx = new int[n2];
                SaveOld = new byte[n2];
                Captured = new int[n2];
                Near = new bool[n2];
                Seen = new bool[n2];
                Cands = new int[n2];
                Urgent = new int[n2];
                Pts = new int[8];
                Local = new int[n2];
                Rescue = new int[n2];
            }
        }

        // ------------------------------------------------------------------
        // 轻量棋盘 PBoard
        // ------------------------------------------------------------------
        private sealed class PBoard
        {
            public int Size;
            public int N2;
            public int[] Nbr;      // 扁平：每点 4 槽
            public byte[] Deg;     // 每点度数
            public int[] Px;       // 预计算 x 坐标（避免 Chebyshev 的除/取模）
            public int[] Py;       // 预计算 y 坐标
            public byte[] Cells;
            public int Side;
            public int Ko;
            public int Passes;
            public bool SuicideAllow;
            public int Last;
            public Scratch Sc;

            public PBoard(int size, int[][] neigh, byte[] cells, int side, int ko, int passes, bool suicideAllow)
            {
                Size = size;
                N2 = size * size;
                Nbr = new int[N2 * 4];
                Deg = new byte[N2];
                Px = new int[N2];
                Py = new int[N2];
                for (int p = 0; p < N2; p++)
                {
                    int[] l = neigh[p];
                    Deg[p] = (byte)l.Length;
                    int b = p * 4;
                    for (int k = 0; k < l.Length; k++) Nbr[b + k] = l[k];
                    Px[p] = p % size;
                    Py[p] = p / size;
                }
                Cells = cells;
                Side = side;
                Ko = ko;
                Passes = passes;
                SuicideAllow = suicideAllow;
                Last = -1;
                Sc = new Scratch(N2);
            }

            public void ResetFrom(PBoard other)
            {
                Array.Copy(other.Cells, Cells, Cells.Length);
                Side = other.Side;
                Ko = other.Ko;
                Passes = other.Passes;
                SuicideAllow = other.SuicideAllow;
                Last = -1;
            }

            /// <summary>棋块扫描 → (nlibs, lib0, member_count)。want 时成员写入 Sc.Members。</summary>
            private (int nlibs, int lib0, int mcount) Scan(int idx, bool want)
            {
                Scratch sc = Sc;
                int gen = ++sc.Gen;
                ref byte cells = ref MemoryMarshal.GetArrayDataReference(Cells);
                ref byte deg = ref MemoryMarshal.GetArrayDataReference(Deg);
                ref int nbr = ref MemoryMarshal.GetArrayDataReference(Nbr);
                ref int stamp = ref MemoryMarshal.GetArrayDataReference(sc.Stamp);
                ref int libstamp = ref MemoryMarshal.GetArrayDataReference(sc.LibStamp);
                ref int stack = ref MemoryMarshal.GetArrayDataReference(sc.Stack);
                ref int members = ref MemoryMarshal.GetArrayDataReference(sc.Members);

                int color = Unsafe.Add(ref cells, idx);
                int sp = 0;
                Unsafe.Add(ref stack, sp++) = idx;
                Unsafe.Add(ref stamp, idx) = gen;
                int mcount = 0;
                if (want) Unsafe.Add(ref members, mcount++) = idx;
                int nlibs = 0;
                int lib0 = -1;
                while (sp > 0)
                {
                    int cur = Unsafe.Add(ref stack, --sp);
                    int d = Unsafe.Add(ref deg, cur);
                    int b = cur << 2;
                    for (int k = 0; k < d; k++)
                    {
                        int nb = Unsafe.Add(ref nbr, b + k);
                        byte v = Unsafe.Add(ref cells, nb);
                        if (v == 0)
                        {
                            if (Unsafe.Add(ref libstamp, nb) != gen)
                            {
                                Unsafe.Add(ref libstamp, nb) = gen;
                                nlibs++;
                                if (lib0 < 0) lib0 = nb;
                            }
                        }
                        else if (v == color && Unsafe.Add(ref stamp, nb) != gen)
                        {
                            Unsafe.Add(ref stamp, nb) = gen;
                            Unsafe.Add(ref stack, sp++) = nb;
                            if (want) Unsafe.Add(ref members, mcount++) = nb;
                        }
                    }
                }
                return (nlibs, lib0, mcount);
            }

            /// <summary>早停数气：气数达 limit 立即返回（不建成员表）。</summary>
            private (int nlibs, int lib0) ScanLib(int idx, int limit)
            {
                Scratch sc = Sc;
                int gen = ++sc.Gen;
                ref byte cells = ref MemoryMarshal.GetArrayDataReference(Cells);
                ref byte deg = ref MemoryMarshal.GetArrayDataReference(Deg);
                ref int nbr = ref MemoryMarshal.GetArrayDataReference(Nbr);
                ref int stamp = ref MemoryMarshal.GetArrayDataReference(sc.Stamp);
                ref int libstamp = ref MemoryMarshal.GetArrayDataReference(sc.LibStamp);
                ref int stack = ref MemoryMarshal.GetArrayDataReference(sc.Stack);

                int color = Unsafe.Add(ref cells, idx);
                int sp = 0;
                Unsafe.Add(ref stack, sp++) = idx;
                Unsafe.Add(ref stamp, idx) = gen;
                int nlibs = 0;
                int lib0 = -1;
                while (sp > 0)
                {
                    int cur = Unsafe.Add(ref stack, --sp);
                    int d = Unsafe.Add(ref deg, cur);
                    int b = cur << 2;
                    for (int k = 0; k < d; k++)
                    {
                        int nb = Unsafe.Add(ref nbr, b + k);
                        byte v = Unsafe.Add(ref cells, nb);
                        if (v == 0)
                        {
                            if (Unsafe.Add(ref libstamp, nb) != gen)
                            {
                                Unsafe.Add(ref libstamp, nb) = gen;
                                nlibs++;
                                if (lib0 < 0) lib0 = nb;
                                if (nlibs >= limit) return (nlibs, lib0);
                            }
                        }
                        else if (v == color && Unsafe.Add(ref stamp, nb) != gen)
                        {
                            Unsafe.Add(ref stamp, nb) = gen;
                            Unsafe.Add(ref stack, sp++) = nb;
                        }
                    }
                }
                return (nlibs, lib0);
            }

            /// <summary>
            /// 早停数气 + 以 MarkStamp（代际 mg）标记已访问点（跨棋块去重）。
            /// 遍历使用独立的全新代际 Sc.Stamp，MarkStamp 仅作跨调去重标记。
            /// </summary>
            private (int nlibs, int lib0) ScanLibMarked(int idx, int limit, int mg)
            {
                Scratch sc = Sc;
                int gen = ++sc.Gen;
                ref byte cells = ref MemoryMarshal.GetArrayDataReference(Cells);
                ref byte deg = ref MemoryMarshal.GetArrayDataReference(Deg);
                ref int nbr = ref MemoryMarshal.GetArrayDataReference(Nbr);
                ref int stamp = ref MemoryMarshal.GetArrayDataReference(sc.Stamp);
                ref int libstamp = ref MemoryMarshal.GetArrayDataReference(sc.LibStamp);
                ref int mark = ref MemoryMarshal.GetArrayDataReference(sc.MarkStamp);
                ref int stack = ref MemoryMarshal.GetArrayDataReference(sc.Stack);

                int color = Unsafe.Add(ref cells, idx);
                int sp = 0;
                Unsafe.Add(ref stack, sp++) = idx;
                Unsafe.Add(ref stamp, idx) = gen;
                Unsafe.Add(ref mark, idx) = mg;
                int nlibs = 0;
                int lib0 = -1;
                while (sp > 0)
                {
                    int cur = Unsafe.Add(ref stack, --sp);
                    int d = Unsafe.Add(ref deg, cur);
                    int b = cur << 2;
                    for (int k = 0; k < d; k++)
                    {
                        int nb = Unsafe.Add(ref nbr, b + k);
                        byte v = Unsafe.Add(ref cells, nb);
                        if (v == 0)
                        {
                            if (Unsafe.Add(ref libstamp, nb) != gen)
                            {
                                Unsafe.Add(ref libstamp, nb) = gen;
                                nlibs++;
                                if (lib0 < 0) lib0 = nb;
                                if (nlibs >= limit) return (nlibs, lib0);
                            }
                        }
                        else if (v == color && Unsafe.Add(ref stamp, nb) != gen)
                        {
                            Unsafe.Add(ref stamp, nb) = gen;
                            Unsafe.Add(ref mark, nb) = mg;
                            Unsafe.Add(ref stack, sp++) = nb;
                        }
                    }
                }
                return (nlibs, lib0);
            }

            /// <summary>核心推演 → (ok, captures, own_size, own_libs, ko_new)；mutate=true 保留变化。</summary>
            private (bool ok, int caps, int ownSize, int ownLibs, int koNew) Simulate(int color, int p, bool mutate)
            {
                if (p < 0 || p >= N2) return (false, 0, 0, 0, -1);

                ref byte cells = ref MemoryMarshal.GetArrayDataReference(Cells);
                if (Unsafe.Add(ref cells, p) != 0 || p == Ko) return (false, 0, 0, 0, -1);

                Scratch sc = Sc;
                ref byte deg = ref MemoryMarshal.GetArrayDataReference(Deg);
                ref int nbr = ref MemoryMarshal.GetArrayDataReference(Nbr);
                ref int saveIdx = ref MemoryMarshal.GetArrayDataReference(sc.SaveIdx);
                ref byte saveOld = ref MemoryMarshal.GetArrayDataReference(sc.SaveOld);
                ref int cap = ref MemoryMarshal.GetArrayDataReference(sc.Captured);
                ref int mark = ref MemoryMarshal.GetArrayDataReference(sc.MarkStamp);

                int opp = 3 - color;
                int npdeg = Unsafe.Add(ref deg, p);
                int npb = p << 2;

                int saveLen = 0;
                Unsafe.Add(ref saveIdx, saveLen) = p; Unsafe.Add(ref saveOld, saveLen) = 0; saveLen++;
                Unsafe.Add(ref cells, p) = (byte)color;

                int capLen = 0;
                int mg = ++sc.MarkGen;
                int empties = 0;
                bool sameColorNb = false;

                for (int k = 0; k < npdeg; k++)
                {
                    int nb = Unsafe.Add(ref nbr, npb + k);
                    byte v = Unsafe.Add(ref cells, nb);
                    if (v == color) { sameColorNb = true; continue; }
                    if (v == 0) { empties++; continue; }
                    if (Unsafe.Add(ref mark, nb) == mg) continue;

                    // 提子预检：邻子除落点外还有空邻点时，其棋块气数必 ≥1；顺带判定是否单子。
                    bool otherEmpty = false;
                    bool sameOpp = false;
                    int d2 = Unsafe.Add(ref deg, nb);
                    int b2 = nb << 2;
                    for (int j = 0; j < d2; j++)
                    {
                        byte vv = Unsafe.Add(ref cells, Unsafe.Add(ref nbr, b2 + j));
                        if (vv == 0) { otherEmpty = true; break; }
                        if (vv == opp) sameOpp = true;
                    }
                    if (otherEmpty) { Unsafe.Add(ref mark, nb) = mg; continue; }
                    if (!sameOpp)
                    {
                        // 单子且无空邻 → 必被提。
                        Unsafe.Add(ref mark, nb) = mg;
                        Unsafe.Add(ref cap, capLen++) = nb;
                        continue;
                    }
                    // 早停：仅需判断「是否有气（≥1）」。无气才需完整成员表用于提子。
                    var (nlibsA, _l0) = ScanLibMarked(nb, 1, mg);
                    if (nlibsA == 0)
                    {
                        var (_nl, _lo, mcount) = Scan(nb, true);
                        ref int members = ref MemoryMarshal.GetArrayDataReference(sc.Members);
                        for (int i = 0; i < mcount; i++) Unsafe.Add(ref mark, Unsafe.Add(ref members, i)) = mg;
                        for (int i = 0; i < mcount; i++) Unsafe.Add(ref cap, capLen++) = Unsafe.Add(ref members, i);
                    }
                }
                if (capLen > 0)
                {
                    for (int i = 0; i < capLen; i++)
                    {
                        int m = Unsafe.Add(ref cap, i);
                        Unsafe.Add(ref saveIdx, saveLen) = m; Unsafe.Add(ref saveOld, saveLen) = (byte)opp; saveLen++;
                        Unsafe.Add(ref cells, m) = 0;
                    }
                    // 提子只把「对方」子变为空点；己方邻子集合不变，仅需重算空邻点数。
                    empties = 0;
                    for (int k = 0; k < npdeg; k++)
                    {
                        if (Unsafe.Add(ref cells, Unsafe.Add(ref nbr, npb + k)) == 0) empties++;
                    }
                }

                int ownSize;
                int nl;
                int koNew = -1;
                if (empties >= 2)
                {
                    ownSize = 1;
                    nl = empties;   // 下界（真实值只会更大）
                }
                else
                {
                    ownSize = sameColorNb ? 2 : 1;
                    // 单子棋块（无同色邻点）免扫描：气数 == 空邻点数；
                    // 多子棋块用早停数气（只需 0 / 1 / ≥2 三态）。
                    nl = sameColorNb ? ScanLib(p, 2).nlibs : empties;
                    if (nl == 0)
                    {
                        if (!SuicideAllow)
                        {
                            for (int i = saveLen - 1; i >= 0; i--)
                                Unsafe.Add(ref cells, Unsafe.Add(ref saveIdx, i)) = Unsafe.Add(ref saveOld, i);
                            return (false, 0, 0, 0, -1);
                        }
                        var (_nl2, _l, mc2) = Scan(p, true);
                        ref int members = ref MemoryMarshal.GetArrayDataReference(sc.Members);
                        for (int i = 0; i < mc2; i++)
                        {
                            int m = Unsafe.Add(ref members, i);
                            Unsafe.Add(ref saveIdx, saveLen) = m; Unsafe.Add(ref saveOld, saveLen) = (byte)color; saveLen++;
                            Unsafe.Add(ref cells, m) = 0;
                        }
                    }
                    else if (capLen == 1 && !sameColorNb && nl == 1)
                    {
                        koNew = Unsafe.Add(ref cap, 0);
                    }
                }

                int ncap = capLen;
                if (!mutate)
                {
                    for (int i = saveLen - 1; i >= 0; i--)
                        Unsafe.Add(ref cells, Unsafe.Add(ref saveIdx, i)) = Unsafe.Add(ref saveOld, i);
                    return (true, ncap, ownSize, nl, koNew);
                }
                Ko = koNew;
                Last = p;
                Passes = 0;
                Side = opp;
                return (true, ncap, ownSize, nl, koNew);
            }

            [MethodImpl(MethodImplOptions.AggressiveInlining)]
            public (bool ok, int caps, int ownSize, int ownLibs, int koNew) Probe(int color, int p)
            {
                return Simulate(color, p, false);
            }

            [MethodImpl(MethodImplOptions.AggressiveInlining)]
            public (bool ok, int caps, int ownSize, int ownLibs, int koNew) Apply(int color, int p)
            {
                return Simulate(color, p, true);
            }

            [MethodImpl(MethodImplOptions.AggressiveInlining)]
            public void PlayPass(int color)
            {
                Ko = -1;
                Passes += 1;
                Side = 3 - color;
                Last = -1;
            }

            /// <summary>简单眼：全部正交邻点是本方棋子（盘外忽略）。</summary>
            [MethodImpl(MethodImplOptions.AggressiveInlining)]
            public bool IsEye(int p, int color)
            {
                ref byte cells = ref MemoryMarshal.GetArrayDataReference(Cells);
                ref byte deg = ref MemoryMarshal.GetArrayDataReference(Deg);
                ref int nbr = ref MemoryMarshal.GetArrayDataReference(Nbr);
                int d = Unsafe.Add(ref deg, p);
                int b = p << 2;
                for (int k = 0; k < d; k++)
                {
                    if (Unsafe.Add(ref cells, Unsafe.Add(ref nbr, b + k)) != color) return false;
                }
                return true;
            }

            /// <summary>p 的邻点中是否存在 color 方、仅剩 1 气的棋块。</summary>
            public bool AdjacentAtari(int p, int color)
            {
                Scratch sc = Sc;
                int mg = ++sc.MarkGen;
                ref byte cells = ref MemoryMarshal.GetArrayDataReference(Cells);
                ref byte deg = ref MemoryMarshal.GetArrayDataReference(Deg);
                ref int nbr = ref MemoryMarshal.GetArrayDataReference(Nbr);
                ref int mark = ref MemoryMarshal.GetArrayDataReference(sc.MarkStamp);
                int d = Unsafe.Add(ref deg, p);
                int b = p << 2;
                for (int k = 0; k < d; k++)
                {
                    int nb = Unsafe.Add(ref nbr, b + k);
                    if (Unsafe.Add(ref cells, nb) != color || Unsafe.Add(ref mark, nb) == mg) continue;
                    int empties = 0;
                    int d2 = Unsafe.Add(ref deg, nb);
                    int b2 = nb << 2;
                    for (int j = 0; j < d2; j++)
                    {
                        if (Unsafe.Add(ref cells, Unsafe.Add(ref nbr, b2 + j)) == 0) { empties++; if (empties >= 2) break; }
                    }
                    if (empties >= 2) continue;
                    var (nlibs, _l0) = ScanLibMarked(nb, 2, mg);
                    if (nlibs == 1) return true;
                }
                return false;
            }

            /// <summary>最后一手附近的己方被打吃棋块的救手（其唯一气）→ 写入 Sc.Rescue，返回个数。</summary>
            public int RescueMoves(int color)
            {
                Scratch sc = Sc;
                int last = Last;
                if (last < 0) return 0;
                int mg = ++sc.MarkGen;
                ref byte cells = ref MemoryMarshal.GetArrayDataReference(Cells);
                ref byte deg = ref MemoryMarshal.GetArrayDataReference(Deg);
                ref int nbr = ref MemoryMarshal.GetArrayDataReference(Nbr);
                ref int mark = ref MemoryMarshal.GetArrayDataReference(sc.MarkStamp);
                ref int rescue = ref MemoryMarshal.GetArrayDataReference(sc.Rescue);
                ref int pts = ref MemoryMarshal.GetArrayDataReference(sc.Pts);

                int ptsLen = 0;
                Unsafe.Add(ref pts, ptsLen++) = last;
                int dl = Unsafe.Add(ref deg, last);
                int lb = last << 2;
                for (int k = 0; k < dl; k++) Unsafe.Add(ref pts, ptsLen++) = Unsafe.Add(ref nbr, lb + k);

                int count = 0;
                for (int i = 0; i < ptsLen; i++)
                {
                    int nb = Unsafe.Add(ref pts, i);
                    if (Unsafe.Add(ref cells, nb) != color || Unsafe.Add(ref mark, nb) == mg) continue;
                    int empties = 0;
                    int d2 = Unsafe.Add(ref deg, nb);
                    int b2 = nb << 2;
                    for (int j = 0; j < d2; j++)
                    {
                        if (Unsafe.Add(ref cells, Unsafe.Add(ref nbr, b2 + j)) == 0) { empties++; if (empties >= 2) break; }
                    }
                    if (empties >= 2) continue;
                    var (nlibs, lib0) = ScanLibMarked(nb, 2, mg);
                    if (nlibs == 1 && lib0 >= 0) Unsafe.Add(ref rescue, count++) = lib0;
                }
                return count;
            }

            /// <summary>面积计分（盘上皆活）→ (black_area, white_area)。</summary>
            public (int black, int white) Area()
            {
                Scratch sc = Sc;
                bool[] seenArr = sc.Seen;
                Array.Clear(seenArr, 0, N2);
                ref byte cells = ref MemoryMarshal.GetArrayDataReference(Cells);
                ref byte deg = ref MemoryMarshal.GetArrayDataReference(Deg);
                ref int nbr = ref MemoryMarshal.GetArrayDataReference(Nbr);
                ref int stack = ref MemoryMarshal.GetArrayDataReference(sc.Stack);
                ref bool seen = ref MemoryMarshal.GetArrayDataReference(seenArr);

                int bt = 0, wt = 0;
                int n2 = N2;
                for (int start = 0; start < n2; start++)
                {
                    if (Unsafe.Add(ref cells, start) != 0 || Unsafe.Add(ref seen, start)) continue;
                    int sp = 0;
                    Unsafe.Add(ref stack, sp++) = start;
                    Unsafe.Add(ref seen, start) = true;
                    int regionSize = 1;
                    int borders = 0;
                    while (sp > 0)
                    {
                        int cur = Unsafe.Add(ref stack, --sp);
                        int d = Unsafe.Add(ref deg, cur);
                        int b = cur << 2;
                        for (int k = 0; k < d; k++)
                        {
                            int nb = Unsafe.Add(ref nbr, b + k);
                            byte v = Unsafe.Add(ref cells, nb);
                            if (v == 0)
                            {
                                if (!Unsafe.Add(ref seen, nb))
                                {
                                    Unsafe.Add(ref seen, nb) = true;
                                    Unsafe.Add(ref stack, sp++) = nb;
                                    regionSize++;
                                }
                            }
                            else borders |= 1 << v;
                        }
                    }
                    if (borders == 0b10) bt += regionSize;
                    else if (borders == 0b100) wt += regionSize;
                }
                int bs = 0, ws = 0;
                for (int i = 0; i < n2; i++)
                {
                    byte v = Unsafe.Add(ref cells, i);
                    if (v == 1) bs++;
                    else if (v == 2) ws++;
                }
                return (bs + bt, ws + wt);
            }

            /// <summary>以切比雪夫半径 radius 标记棋子邻域 → 写入 Sc.Near，返回 whether any stone。</summary>
            public bool BuildNear(int radius)
            {
                bool[] near = Sc.Near;
                for (int i = 0; i < N2; i++) near[i] = false;
                ref byte cells = ref MemoryMarshal.GetArrayDataReference(Cells);
                ref int nbr = ref MemoryMarshal.GetArrayDataReference(Nbr);
                int size = Size;
                bool anyStone = false;
                for (int p = 0; p < N2; p++)
                {
                    if (Unsafe.Add(ref cells, p) == 0) continue;
                    anyStone = true;
                    int px = p % size, py = p / size;
                    int x0 = px - radius > 0 ? px - radius : 0;
                    int x1 = px + radius < size - 1 ? px + radius : size - 1;
                    int y0 = py - radius > 0 ? py - radius : 0;
                    int y1 = py + radius < size - 1 ? py + radius : size - 1;
                    for (int y = y0; y <= y1; y++)
                    {
                        int b = y * size;
                        for (int x = x0; x <= x1; x++) near[b + x] = true;
                    }
                }
                GC.KeepAlive(nbr);
                return anyStone;
            }
        }

        // ------------------------------------------------------------------
        // 先验 / 几何辅助
        // ------------------------------------------------------------------

        /// <summary>树内先验（等效经验）：提子加分、自填气减分。</summary>
        public static double MovePrior(int caps, int ownLibs)
        {
            double q = 0.5;
            if (caps >= 2) q += 0.25;
            else if (caps == 1) q += 0.15;
            if (ownLibs == 1) q -= 0.15;
            if (q < 0.05) q = 0.05;
            if (q > 0.9) q = 0.9;
            return q;
        }

        /// <summary>空盘开局候选：中央三分之一见方（9 路 = 3x3 共 9 点）。</summary>
        private static List<int> CenterZone(int size)
        {
            int lo = size / 3;
            int hi = size - 1 - size / 3;
            var pts = new List<int>();
            for (int y = lo; y <= hi; y++)
                for (int x = lo; x <= hi; x++)
                    pts.Add(y * size + x);
            return pts;
        }

        private static void Consider(PBoard pb, int color, int p, List<(int p, int caps, int olibs)> outList)
        {
            if (pb.Cells[p] != 0) return;
            if (pb.IsEye(p, color)) return;
            var r = pb.Probe(color, p);
            if (r.ok) outList.Add((p, r.caps, r.ownLibs));
        }

        /// <summary>裁剪后的候选点 → List&lt;(point, captures, own_libs)&gt;。</summary>
        private static List<(int p, int caps, int olibs)> Candidates(PBoard pb, int color, int radius)
        {
            int n2 = pb.N2;
            var outList = new List<(int p, int caps, int olibs)>();
            if (radius <= 0)
            {
                for (int p = 0; p < n2; p++) Consider(pb, color, p, outList);
                return outList;
            }
            bool anyStone = pb.BuildNear(radius);
            if (!anyStone)
            {
                foreach (int p in CenterZone(pb.Size)) Consider(pb, color, p, outList);
            }
            else
            {
                for (int p = 0; p < n2; p++)
                {
                    if (pb.Sc.Near[p]) Consider(pb, color, p, outList);
                }
            }
            return outList;
        }

        // ------------------------------------------------------------------
        // playout（热路径：零分配）
        // ------------------------------------------------------------------
        private static int Playout(PBoard pb, Rng rng, Profile pr, int maxMoves)
        {
            double capBias = pr.CaptureBias;
            double patBias = pr.PatternBias;
            double largeMargin = pr.Mercy * pb.N2;
            Scratch sc = pb.Sc;
            int n2 = pb.N2;

            ref byte cells = ref MemoryMarshal.GetArrayDataReference(pb.Cells);
            ref byte deg = ref MemoryMarshal.GetArrayDataReference(pb.Deg);
            ref int nbr = ref MemoryMarshal.GetArrayDataReference(pb.Nbr);
            ref int cands = ref MemoryMarshal.GetArrayDataReference(sc.Cands);
            ref int urgent = ref MemoryMarshal.GetArrayDataReference(sc.Urgent);
            ref int pts = ref MemoryMarshal.GetArrayDataReference(sc.Pts);
            ref int local = ref MemoryMarshal.GetArrayDataReference(sc.Local);
            ref int rescue = ref MemoryMarshal.GetArrayDataReference(sc.Rescue);

            int moves = 0;
            while (pb.Passes < 2 && moves < maxMoves)
            {
                int color = pb.Side;
                int last = pb.Last;
                int koNow = pb.Ko;
                int candLen = 0;
                int urgentLen = 0;
                int ptsLen = 0;

                // 局部候选：最后一手 + 其 1 邻域
                if (last >= 0)
                {
                    Unsafe.Add(ref pts, ptsLen++) = last;
                    int dl = Unsafe.Add(ref deg, last);
                    int lb = last << 2;
                    for (int k = 0; k < dl; k++) Unsafe.Add(ref pts, ptsLen++) = Unsafe.Add(ref nbr, lb + k);
                }
                for (int i = 0; i < ptsLen; i++)
                {
                    int pp = Unsafe.Add(ref pts, i);
                    if (Unsafe.Add(ref cells, pp) != 0 || pp == koNow) continue;
                    // 眼点必无提子，且 is_eye ⇒ adjacent_atari(opp)==false；
                    // 故与 Python 的 (is_eye && !adjacent_atari) 等价，可提前剔除以免 probe。
                    if (pb.IsEye(pp, color)) continue;
                    var rr = pb.Probe(color, pp);
                    if (!rr.ok) continue;
                    if (rr.caps == 0 && rr.ownLibs == 1) continue; // 避免自填气（填眼已提前剔除）
                    Unsafe.Add(ref cands, candLen++) = pp;
                    if (rr.caps > 0) Unsafe.Add(ref urgent, urgentLen++) = pp;
                }

                if (candLen == 0)
                {
                    for (int pp = 0; pp < n2; pp++)
                    {
                        if (Unsafe.Add(ref cells, pp) != 0 || pp == koNow) continue;
                        if (pb.IsEye(pp, color)) continue;
                        var rr = pb.Probe(color, pp);
                        if (!rr.ok) continue;
                        if (rr.caps == 0 && rr.ownLibs == 1) continue;
                        Unsafe.Add(ref cands, candLen++) = pp;
                        if (rr.caps > 0) Unsafe.Add(ref urgent, urgentLen++) = pp;
                    }
                }

                int rescueLen = pb.RescueMoves(color);
                for (int i = 0; i < rescueLen; i++)
                {
                    int m = Unsafe.Add(ref rescue, i);
                    if (Unsafe.Add(ref cells, m) == 0 && !Contains(sc.Urgent, urgentLen, m))
                        Unsafe.Add(ref urgent, urgentLen++) = m;
                }

                if (candLen == 0)
                {
                    pb.PlayPass(color);
                    moves++;
                    continue;
                }

                double r = rng.Random();
                int chosen;
                if (urgentLen > 0 && r < capBias)
                {
                    chosen = Unsafe.Add(ref urgent, rng.RandInt(urgentLen));
                }
                else if (last >= 0 && rng.Random() < patBias)
                {
                    int lastX = pb.Px[last], lastY = pb.Py[last];
                    int locLen = 0;
                    for (int i = 0; i < candLen; i++)
                    {
                        int pp = Unsafe.Add(ref cands, i);
                        int dx = pb.Px[pp] - lastX; if (dx < 0) dx = -dx;
                        int dy = pb.Py[pp] - lastY; if (dy < 0) dy = -dy;
                        if (dx <= 1 && dy <= 1) Unsafe.Add(ref local, locLen++) = pp;
                    }
                    chosen = locLen > 0
                        ? Unsafe.Add(ref local, rng.RandInt(locLen))
                        : Unsafe.Add(ref cands, rng.RandInt(candLen));
                }
                else
                {
                    chosen = Unsafe.Add(ref cands, rng.RandInt(candLen));
                }
                pb.Apply(color, chosen);
                moves++;
                if (largeMargin > 0.0)
                {
                    var (bt, wt) = pb.Area();
                    if ((bt - wt) > largeMargin || (wt - bt) > largeMargin) break;
                }
            }
            return moves;
        }

        [MethodImpl(MethodImplOptions.AggressiveInlining)]
        private static bool Contains(int[] arr, int len, int v)
        {
            for (int i = 0; i < len; i++) if (arr[i] == v) return true;
            return false;
        }

        // ------------------------------------------------------------------
        // 树（arena，零 Node 分配）
        // ------------------------------------------------------------------
        private struct Node
        {
            public int ToMove;
            public int Mv;
            public int N;
            public double W;
            public int AmafN;
            public double AmafW;
            public bool Expanded;
            public double Prior;
            public int ChildStart;
            public int ChildCount;
        }

        private static int Select(Node[] arena, int[] childStore, int node, double c, double raveK, bool rave)
        {
            double logN = Math.Log(arena[node].N + 1.0);
            int best = -1;
            double bestV = -1e18;
            int cs = arena[node].ChildStart;
            int cc = arena[node].ChildCount;
            for (int i = 0; i < cc; i++)
            {
                int ch = childStore[cs + i];
                int n = arena[ch].N;
                double q = n > 0 ? arena[ch].W / n : arena[ch].Prior;
                if (rave && arena[ch].AmafN > 0)
                {
                    double qa = arena[ch].AmafW / arena[ch].AmafN;
                    double beta = n > 0 ? Math.Sqrt(raveK / (raveK + 3.0 * n)) : 1.0;
                    q = (1.0 - beta) * q + beta * qa;
                }
                double val = q + c * Math.Sqrt(logN / (n + 1.0));
                if (val > bestV) { bestV = val; best = ch; }
            }
            return best;
        }

        private static void RngShuffle<T>(List<T> list, Rng rng)
        {
            for (int i = list.Count - 1; i > 0; i--)
            {
                int j = rng.RandInt(i + 1);
                T tmp = list[i]; list[i] = list[j]; list[j] = tmp;
            }
        }

        /// <summary>对 board（完整规则 Board）搜索 → GenResult。不落子 —— 由调用方复检。</summary>
        public static GenResult GenMove(Board board, int playouts, long seed, Profile profile)
        {
            Profile pr = profile ?? new Profile();
            var rng = new Rng(seed);
            int size = board.Size;
            int n2 = board.N2;
            bool suicideAllow = board.Rules.Suicide == "allow";
            List<int> fullLegal = board.LegalMoves();
            var legalMask = new bool[n2];
            for (int i = 0; i < fullLegal.Count; i++) legalMask[fullLegal[i]] = true;

            var pb0 = new PBoard(size, board.Neigh, (byte[])board.Cells.Clone(),
                                board.Side, board.KoPoint, board.Passes, suicideAllow);
            int radius = pr.PruneRadius;

            Node[] arena = new Node[4096];
            int arenaCount = 0;
            int[] childStore = new int[8192];
            int childCount = 0;

            int AddNode(int toMove, int mv, double prior, bool expanded)
            {
                if (arenaCount == arena.Length) Array.Resize(ref arena, arena.Length * 2);
                arena[arenaCount] = new Node
                {
                    ToMove = toMove,
                    Mv = mv,
                    Prior = prior,
                    Expanded = expanded,
                    ChildStart = 0,
                    ChildCount = 0,
                    N = 0,
                    W = 0.0,
                    AmafN = 0,
                    AmafW = 0.0,
                };
                return arenaCount++;
            }
            int AddChild(int c)
            {
                if (childCount == childStore.Length) Array.Resize(ref childStore, childStore.Length * 2);
                childStore[childCount] = c;
                return childCount++;
            }

            int root = AddNode(board.Side, PASS, 0.5, true);

            List<(int p, int caps, int olibs)> moves = Candidates(pb0, board.Side, radius);
            var filtered = new List<(int p, int caps, int olibs)>(moves.Count);
            for (int i = 0; i < moves.Count; i++)
            {
                if (legalMask[moves[i].p]) filtered.Add(moves[i]);
            }
            RngShuffle(filtered, rng);
            int rootStart = childCount;
            for (int i = 0; i < filtered.Count; i++)
            {
                var (m, c, ol) = filtered[i];
                int id = AddNode(3 - board.Side, m, MovePrior(c, ol), false);
                AddChild(id);
            }
            arena[root].ChildStart = rootStart;
            arena[root].ChildCount = childCount - rootStart;
            if (arena[root].ChildCount == 0)
            {
                return new GenResult { Move = PASS, Visits = 0, Winrate = 0.0 };
            }

            int maxMoves = 3 * n2;
            double scale = pr.ScoreScale > 0.0 ? pr.ScoreScale : n2 / 2.0;
            int sims = playouts < 1 ? 1 : playouts;

            var pb = new PBoard(size, board.Neigh, (byte[])pb0.Cells.Clone(),
                               pb0.Side, pb0.Ko, pb0.Passes, pb0.SuicideAllow);

            var chain = new int[1024];
            int chainLen;
            var mv1 = new int[n2];
            var mv2 = new int[n2];
            int simGen = 0;
            double komi = board.Komi;

            for (int sim = 0; sim < sims; sim++)
            {
                simGen++;
                pb.ResetFrom(pb0);
                int node = root;
                chainLen = 0;
                chain[chainLen++] = node;

                while (arena[node].Expanded && arena[node].ChildCount > 0)
                {
                    int ci = Select(arena, childStore, node, pr.C, pr.RaveK, pr.Rave);
                    int m = arena[ci].Mv;
                    int color = arena[node].ToMove;
                    if (m == PASS) pb.PlayPass(color);
                    else
                    {
                        pb.Apply(color, m);
                        if (color == 1) mv1[m] = simGen; else mv2[m] = simGen;
                    }
                    node = ci;
                    if (chainLen == chain.Length) Array.Resize(ref chain, chain.Length * 2);
                    chain[chainLen++] = node;
                }

                if (!arena[node].Expanded)
                {
                    int tmove = arena[node].ToMove;
                    List<(int p, int caps, int olibs)> cl = Candidates(pb, tmove, radius);
                    RngShuffle(cl, rng);
                    int start = childCount;
                    for (int i = 0; i < cl.Count; i++)
                    {
                        var (m, c, ol) = cl[i];
                        int id = AddNode(3 - tmove, m, MovePrior(c, ol), false);
                        AddChild(id);
                    }
                    arena[node].ChildStart = start;
                    arena[node].ChildCount = childCount - start;
                    arena[node].Expanded = true;
                }

                int leafToMove = arena[node].ToMove;
                Playout(pb, rng, pr, maxMoves);
                var (bt, wt) = pb.Area();
                double diffBlack = (bt - wt) - komi;
                double sv = 0.5 + 0.5 * (diffBlack / scale);
                if (sv < 0.0) sv = 0.0;
                else if (sv > 1.0) sv = 1.0;
                double resLeaf = leafToMove == 1 ? sv : 1.0 - sv;

                for (int i = 0; i < chainLen; i++)
                {
                    int nd = chain[i];
                    double v = arena[nd].ToMove == leafToMove ? resLeaf : 1.0 - resLeaf;
                    arena[nd].N += 1;
                    arena[nd].W += v;
                    int cc = arena[nd].ChildCount;
                    if (cc > 0)
                    {
                        double cv = 1.0 - v;
                        int[] stamps = arena[nd].ToMove == 1 ? mv1 : mv2;
                        int cs = arena[nd].ChildStart;
                        for (int j = 0; j < cc; j++)
                        {
                            int ch = childStore[cs + j];
                            int cm = arena[ch].Mv;
                            if (cm >= 0 && stamps[cm] == simGen)
                            {
                                arena[ch].AmafN += 1;
                                arena[ch].AmafW += cv;
                            }
                        }
                    }
                }
            }

            // 最终选择：key = (-N, -winrate, move)
            int best = -1;
            int bestN = 0;
            double bestWr = 0.0;
            int bestM = n2;
            int totalVisits = 0;
            int rootCS = arena[root].ChildStart;
            int rootCC = arena[root].ChildCount;
            for (int i = 0; i < rootCC; i++)
            {
                int ch = childStore[rootCS + i];
                int n = arena[ch].N;
                totalVisits += n;
                double wr = n > 0 ? arena[ch].W / n : 0.0;
                int m = arena[ch].Mv;
                bool better;
                if (best < 0) better = true;
                else if (n != bestN) better = n > bestN;
                else if (wr != bestWr) better = wr > bestWr;
                else better = m < bestM;
                if (better) { best = ch; bestN = n; bestWr = wr; bestM = m; }
            }

            int bestMv = best >= 0 ? arena[best].Mv : PASS;

            // 兜底：选中点必须在完整规则合法集内（候选裁剪不应越界）
            if (bestMv != PASS && !legalMask[bestMv])
            {
                int alt = -1, altN = 0, altM = n2;
                double altWr = 0.0;
                for (int i = 0; i < rootCC; i++)
                {
                    int ch = childStore[rootCS + i];
                    int m = arena[ch].Mv;
                    if (m < 0 || !legalMask[m]) continue;
                    int n = arena[ch].N;
                    double wr = n > 0 ? arena[ch].W / n : 0.0;
                    bool better;
                    if (alt < 0) better = true;
                    else if (n != altN) better = n > altN;
                    else if (wr != altWr) better = wr > altWr;
                    else better = m < altM;
                    if (better) { alt = ch; altN = n; altWr = wr; altM = m; }
                }
                if (alt >= 0) { bestMv = arena[alt].Mv; bestN = altN; bestWr = altWr; }
                else bestMv = PASS;
            }

            // 显式过手规则：对手已过手，且本方胜率达标 → 过手终局
            if (board.Passes >= 1 && bestMv != PASS && bestWr >= pr.PassThreshold)
            {
                return new GenResult { Move = PASS, Visits = bestN, Winrate = bestWr };
            }
            if (pr.ResignThreshold > 0.0 && totalVisits >= pr.ResignMinVisits && bestWr < pr.ResignThreshold)
            {
                return new GenResult { Move = RESIGN, Visits = bestN, Winrate = bestWr };
            }

            return new GenResult
            {
                Move = bestMv == PASS ? PASS : bestMv,
                Visits = bestN,
                Winrate = bestWr,
            };
        }

        // ------------------------------------------------------------------
        // 开发基准
        // ------------------------------------------------------------------

        /// <summary>纯 playout 吞吐 → (总步数, 秒数)。</summary>
        public static (long moves, double secs) BenchPlayouts(Board board, int iters, long seed)        {
            var pr = new Profile();
            bool suicideAllow = board.Rules.Suicide == "allow";
            int maxMoves = 3 * board.N2;
            var rng = new Rng(seed);
            long total = 0;
            byte[] template = (byte[])board.Cells.Clone();
            // 预热
            for (int w = 0; w < 50; w++)
            {
                var pw = new PBoard(board.Size, board.Neigh, (byte[])template.Clone(),
                                    board.Side, board.KoPoint, board.Passes, suicideAllow);
                Playout(pw, rng, pr, maxMoves);
            }
            var t0 = System.Diagnostics.Stopwatch.StartNew();
            for (int i = 0; i < iters; i++)
            {
                var pb = new PBoard(board.Size, board.Neigh, (byte[])template.Clone(),
                                    board.Side, board.KoPoint, board.Passes, suicideAllow);
                total += Playout(pb, rng, pr, maxMoves);
            }
            t0.Stop();
            return (total, t0.Elapsed.TotalSeconds);
        }

        /// <summary>单次 probe（simulate 非变异）的纳秒级开销。</summary>
        public static double BenchProbe(Board board, int iters)
        {
            bool suicideAllow = board.Rules.Suicide == "allow";
            var pb = new PBoard(board.Size, board.Neigh, (byte[])board.Cells.Clone(),
                                board.Side, board.KoPoint, board.Passes, suicideAllow);
            var pts = new List<int>();
            for (int i = 0; i < pb.N2; i++) if (pb.Cells[i] == 0) pts.Add(i);
            int np = pts.Count;
            long acc = 0;
            for (int w = 0; w < 1000; w++) { var r0 = pb.Probe(board.Side, pts[w % np]); acc += r0.caps; }
            var sw = System.Diagnostics.Stopwatch.StartNew();
            for (int it = 0; it < iters; it++)
            {
                int p = pts[it % np];
                var r = pb.Probe(board.Side, p);
                acc += r.ok ? 1 : 0;
                acc += r.caps;
            }
            sw.Stop();
            GC.KeepAlive(acc);
            return sw.Elapsed.TotalSeconds / iters * 1e9;
        }
    }
}
