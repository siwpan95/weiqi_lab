# weiqi_lab — 多语言围棋引擎移植 + 对局多样性研究实验场

> **5 种编程语言的功能对等围棋引擎**（Py / Js / Rust / C++ / C#），共享同一套规则规范、
> 黄金值测试集、JSON-stdio 协议与**独立裁判层**；在此之上是 9 路跨语言循环赛。
> 本仓是 [`G:\repos\lab`](https://gitee.com/siwpan/lab)（国际象棋多语言移植实验场）的**围棋版**：
> 把「移植正确性研究 + 对局多样性研究」的范式搬到围棋上。
>
> 许可证：MIT（`LICENSE`）。零第三方依赖（Node/Python/Rust/C++/C# 全部只用标准库）。

## 1. 这是什么

同一套围棋规则内核（**中国数子口径**）+ MCTS(UCT+RAVE) 引擎，用 5 种语言各自独立实现为**功能对等**版本：

- 规则输出（走子/提子/自杀/三档劫/两套计分/Zobrist 键）**逐位一致** —— 由冻结的黄金值测试集守护；
- 由 `tournament/referee.mjs`（**机制不同的独立实现**：字符串键、无 Zobrist）作为权威裁决层，
  驱动跨语言循环赛（固定算力预算、随机开局库、非法着法判负）。

## 2. 仓库结构

| 路径 | 作用 |
|---|---|
| `PyWeiqi/` `JsWeiqi/` `RustWeiqi/` `CppWeiqi/` `CsWeiqi/` | 5 个语言引擎（规则核心 + MCTS AI + 自测 + JSON-stdio 驱动） |
| `spec/golden.json` | **黄金值测试集（35 用例）**：跨语言唯一测试真相，冻结产物 |
| `docs/RULES_SPEC.md` | 规则规范（单一真相来源）：棋盘/走子算法/三档劫/计分/Zobrist 常量 |
| `docs/PROTOCOL_SPEC.md` | JSON-stdio 协议规范（语义对齐 GTP v2） |
| `docs/PORTING.md` | 移植简报（交付物、验收门、性能要点） |
| `docs/RESEARCH.md` | 联网调研纪要（来源 + 许可证 + 借用范围） |
| `harness/` | 跨引擎一致性总入口：引擎清单 + JSON-stdio 客户端 + 三项校验 |
| `tournament/` | 独立裁判层 + 循环赛 runner + 开局库 + 战报（`reports/`） |
| `tools/gen_golden.py` | 黄金值生成器（含**人工推导交叉校验**，不一致即拒绝生成） |

## 3. 验证状态（2026-10-08 实测）

### 3.1 各语言自测（黄金值 35/35 + 内部单测）

| 语言 | 命令 | 结果 |
|---|---|---|
| Python 3.13 | `cd PyWeiqi && python main.py test` | ✅ **93 passed, 0 failed**（golden 35/35, unit 58/58） |
| JavaScript (Node 22) | `cd JsWeiqi && node main.mjs test` | ✅ **93 passed, 0 failed** |
| Rust 1.98 | `cd RustWeiqi && cargo run --release -- test` | ✅ **93 passed, 0 failed** |
| C++ (MinGW g++ 15.2) | `cd CppWeiqi && bash build.sh && ./cppweiqi.exe test` | ✅ **98 passed, 0 failed**（unit 63/63） |
| C# (.NET 10) | `cd CsWeiqi && dotnet run -c Release -- test` | ✅ **93 passed, 0 failed** |

### 3.2 跨引擎一致性（`cd harness && node host.mjs` → **ALL GREEN**，3.6s）

| 校验 | 结果 |
|---|---|
| ① 五引擎内置黄金值自测 | 5/5 通过（各 35/35） |
| ② 跨引擎协议差分（468 条命令 × 5 引擎，覆盖 3 种盘径 × 4 种规则档，含故意非法着法） | **0 处差异**（`ok`/`reason`/`result` 逐位） |
| ③ 独立裁判交叉校验（318 项：合法性/提子/合法点集/计分/提子数） | **0 处不一致** |

移植过程中各语言还做了**独立差分**：Js 6321 条记录 0 差异、Rust 38 局自对弈 0 差异、
C++ 6393 条命令 0 差异、C# 11454 条命令 0 差异。

### 3.3 循环赛（`cd tournament && node probe.mjs` + `node run_tournament.mjs`）

- 实测吞吐（9 路，playouts/s）：**cpp ≈12500 · rs ≈11765 · cs ≈2174 · js ≈870 · py ≈132**
  （循环赛按各引擎速度折算 **等效 ~1s/手** 的固定算力预算，见 `harness/engines.mjs`）
- 冒烟战报（10 局，60 playouts/手，3.4 分钟）：**全部正常终局**（99–139 手），
  **0 非法着法 / 0 超时 / 0 崩溃**；交叉表呈各 2 胜 2 负的均势格局 → `tournament/reports/2026-10-08.md`

## 4. 规则口径

| 档名 | ko | suicide | scoring | komi | 说明 |
|---|---|---|---|---|---|
| `cn`（**默认**） | positional | forbid | area | 7.5 | 中国数子口径（对齐 KataGo `Chinese`） |
| `tt` | positional | **allow** | area | 7.5 | Tromp-Taylor 逻辑规则 |
| `jp` | simple | forbid | territory | 6.5 | 日本数目口径（死子需显式指定） |

黄金值集覆盖：Zobrist 键（含跨盘径一致性）、合法点计数、提子（单子/多子/角部双击）、
自杀三档对照、劫（立刻回提/推迟回提）、**禁全同（PSK）与简单劫的区分**、终局与 undo、
数子/数目两套计分（含 seki 类单官、和棋格式）、提子数、轮次错误。

## 5. 快速开始

```bash
# ① 单语言自测（各语言独立可跑，无需 Node）
cd PyWeiqi && python main.py test          # 或 JsWeiqi/RustWeiqi/CppWeiqi/CsWeiqi

# ② 跨引擎一致性门（改动规则/AI 后必跑）
cd harness && node host.mjs                # 期望 ALL GREEN

# ③ 循环赛
cd tournament && node probe.mjs
GAMES_PER_PAIR=2 node run_tournament.mjs   # 默认按各引擎 ~1s/手预算
TOURNAMENT_PLAYOUTS=60 GAMES_PER_PAIR=1 node run_tournament.mjs   # 冒烟
ENGINES_FILTER=rs,cpp node run_tournament.mjs                     # 子集
```

环境变量：`TOURNAMENT_SIZE`（默认 9）、`GAMES_PER_PAIR`（默认 2）、`OPENING_PLIES`（默认 2）、
`TOURNAMENT_PLAYOUTS`（覆盖各引擎预算）、`MOVES_CAP`（默认 3×N²）、`WEIQI_ENGINES`/`ENGINES_FILTER`（子集）。

## 6. 已知限制（诚实记录）

1. **AI 强度受限**：纯标准库 + 朴素 playout 的 MCTS，9 路战术分辨力约 **±5 点**（300 playouts 下），
   1–3 子的局部战术不可靠；循环赛结果应按"弱引擎互搏"解读，而非强弱排序。
   实测依据：`PyWeiqi/tests.py` 中记录的分辨力测试与被否定的"1 手强制提子"用例（0/6 命中）。
   根因与改进方向：playout 终局评估被随机提子主导（详见 `docs/RESEARCH.md` §4）。
2. **未实现**：SGF 读写、GTP 适配器、GTP 让子定式（星位表）、死子自动判定/收单官
   （采用与 Tromp-Taylor / Gomill internal 一致的"盘上皆活"约定）。
3. **Go（golang）引擎缺席**：本机 Go 工具链残缺（`G:\go\src\fmt` 缺失，现场复现），
   修复后可作第 6 门语言按同一黄金值加入。
4. **`genmove` 不要求跨语言一致**（RNG 允许差异）；同语言同 (局面, playouts, seed, profile) 可复现。
   本基线恰好实现了五语言逐位一致，但**不构成契约**（见 `docs/PORTING.md` §4）。

## 7. 与 `G:\repos\lab` 的对应关系

| lab（国际象棋） | weiqi_lab（围棋） |
|---|---|
| 10 语言引擎（97 项逐字一致断言 + perft 黄金值） | 5 语言引擎（黄金值 35 用例 + 单测 58/63 项） |
| perft 黄金值契约 | 围棋无 perft 等价物 → 采用**局面 + 期望输出**范式（CGTC 式，见 `docs/RESEARCH.md` §3.1） |
| bestMove 共识 | 规则级逐位一致性 + 独立裁判交叉校验（弱引擎下 MCTS 共识不构成有效门禁） |
| `chess-cordis` harness | `harness/`（零依赖 Node，无框架） |
| `tournament/engine.mjs` 独立裁判 | `tournament/referee.mjs`（独立实现） |
| Tier 1 开局库 / Tier 2-C 风格档 | 开局库已实装；风格档以 `profile` 参数保留（探索常数/RAVE/提子偏好/裁剪半径…） |

## 8. License

MIT，见 [`LICENSE`](./LICENSE)。调研来源与借用范围见 [`docs/RESEARCH.md`](./docs/RESEARCH.md)。
