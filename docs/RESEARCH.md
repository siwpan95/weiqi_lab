# 调研纪要（联网调研，2026-10-08）

> 本文记录 weiqi_lab 设计所依据的外部信息与来源。按工作区「借鉴必记账」原则：
> **来源 + 许可证 + 借用范围**三项齐备。本项目**未复制任何第三方代码**，
> 借用的均为公开算法思想、协议语义与测试方法论；下列各源仅作概念参照。

## 1. 结论速览（设计决策 ← 依据）

| 决策 | 依据 | 正文 |
|---|---|---|
| 默认规则取「数子 + 位置禁全同 + 禁自杀 + 贴7.5」 | 中国规则内核；与 KataGo `Chinese` 口径一致（area + PSK + 禁自提） | §2.1, §2.2 |
| 同时实现 Tromp-Taylor（允许自杀）与日本数目计分档 | TT 是国际计算机围棋事实标准；日本规则需死子协商，仅作计分档 | §2.3 |
| 测试方法论采「黄金局面集 + 唯一好手共识」 | 阿尔伯塔 CGTC 的 `.tst`/`reg_genmove` 范式（perft 无围棋等价物） | §3.1 |
| 仲裁层独立实现（`tournament/referee.mjs`） | Gomill 的 ringmaster 模型：控制器独立裁决合法性/计分 | §3.2 |
| AI 走 MCTS（UCT + RAVE + 轻量 playout） | MoGo/Pachi/Fuego 路线，纯标准库可实现；RAVE 约 +70:30、playout 知识约 +70:30 | §4.1–4.3 |
| playout 允许 simple-ko 近似，树内/终选走完整规则 | Fuego/Pachi 同款工程折衷（superko 在 playout 内代价高） | §4.3 |
| 自动对局用「盘上皆活」面积计分 | Gomill internal scorer 同款约定（假设残子皆活，仅加贴目） | §3.2 |
| 线协议语义对齐 GTP v2 | GTP v2 为围棋引擎事实标准；保留未来对接 GUI/CGTC 的能力 | §3.3 |

## 2. 规则体系

### 2.1 禁全同三档（PSK / SSK / Simple Ko）
- 来源：中文维基教科书《围棋/规则进阶》（zh.wikibooks.org）、Sensei's Library "Superko"（senseis.xmp.net）。
- 要点：PSK 只看盘面重复；SSK 还要求轮次方相同；Simple Ko 仅禁立刻回提。
  三劫循环、长生等"超级劫"在不同规则体系里分别判禁着/无胜负/重下。
- 借用范围：**概念**（三档语义定义），用于 `RULES_SPEC.md` §5 与 golden 用例 X 系列。

### 2.2 中国规则 / 六大规则体系对比
- 来源：Go Magic《从世界六大规则体系，看懂围棋的精妙之处》（gomagic.org）、维基百科《围棋规则比较》。
- 要点：中国规则 = 数子 + 黑贴 7.5 目 + 禁止自杀 + 明确禁全同（实战含例外条款）；
  日本/韩国 = 数目 + 贴 6.5 + 超级劫判无胜负；应氏 = 计点制。
- 借用范围：**概念**（口径参数），用于默认档 `cn` 与 README 的差异说明。

### 2.3 Tromp-Taylor 逻辑规则（原文）
- 来源：John Tromp "The game of Go"（tromp.github.io/go.html）、Sensei's Library "Tromp-Taylor Rules"、Wikibooks "Computer Go/Tromp-Taylor Rules"。
- 要点（逐条为规范来源）：4 邻域连通；"reaching empty" 定义气；一次走子 = 着色 → 清对方 → 清己方；
  禁止重复历史着色（PSK）；**允许自杀**；连续两 pass 终局；得分 = 己方子数 + 只及己色的空点数；盘上棋子无死子概念。
- 借用范围：**规范文字要点**（改写进 `RULES_SPEC.md` §2/§9），`tt` 档直接对应。
  该书页注明 TT ≈ 新西兰规则简化版；PSK 与 SSK 之别仅在极罕见局面。

## 3. 测试与工具链方法论

### 3.1 Computer Go Test Collection（CGTC）
- 来源：Martin Müller（阿尔伯塔大学）CGTC 2.0.1（cs.ualberta.ca/~games/go/cgtc/），经 GTP `loadsgf` + `reg_genmove` 驱动，
  配 `gogui-regress` 跑回归；「局面 SGF + 期望好手集合」为该集合的基本单元。
- 借用范围：**方法论**（局面 + 期望输出的回归范式）。本项目自建 `spec/golden.json` 与 `spec/consensus.json`，
  未使用其 SGF 文件；未来可直接用 gogui-regress 跑本引擎（需先加 GTP 适配器）。

### 3.2 Gomill（ringmaster / 内部计分）
- 来源：Matthew Woodcraft, gomill（mjw.woodcraft.me.uk/gomill，GPL-2.0+）。
- 要点：ringmaster 以 GTP 管理引擎循环赛（playoff / all-play-all）；非法着法/超时判负；
  `internal` scorer = **面积法、假设残子皆活、只加贴目**；无对局时钟、建议固定算力预算。
- 借用范围：**方法论/约定**（判负规则、固定预算、内部计分约定）。**不引入 GPL 代码**；
  本项目 `tournament/` 为自研零依赖实现，仅对齐语义。

### 3.3 GTP v2 协议
- 来源：Gunnar Farnebäck《Specification of the Go Text Protocol, version 2》（lysator.liu.se/~gunnar/gtp/）、
  GNU Go `gtp-commands.texi`、KataGo `GTP_Extensions.md`。
- 要点：命令集 `protocol_version/name/version/known_command/list_commands/boardsize/clear_board/komi/
  fixed_handicap/place_free_handicap/set_free_handicap/play/genmove/undo/final_score/final_status*/loadsgf/
  reg_genmove/showboard`；坐标跳 I；`genmove` 可返回 `resign`；`final_score` 以 SGF RE 格式返回。
- 借用范围：**协议语义**（命令语义与坐标约定映射到 JSON 线格式），见 `PROTOCOL_SPEC.md`。

## 4. AI 算法（MCTS 家族）

### 4.1 UCT / RAVE / AMAF
- 来源：Bouzy《MCTS for Computer Go》(AA2 讲义) —— 增强项自对弈胜率：探索常数调优 60:40、RAVE 70:30、
  playout 知识 70:30、盘面转置 60:40；Gelly & Silver《Achieving Master Level Play in 9×9 Computer Go》(AAAI 2008)
  —— MoGo 于 9 路达 KGS 3d，UCT-RAVE 对 GnuGo 3.7.10 从 24% → 69%（RAVE+启发式值函数）。
- 借用范围：**算法思想**（AMAF/RAVE 混合公式、β=sqrt(k/(k+3N)) 形式），写进 `PROTOCOL_SPEC.md` §2.1 的 profile 参数与各引擎 `ai` 模块。

### 4.2 Pachi 的工程细节
- 来源：Petr Baudiš & Jean-loup Gailly, Pachi（pasky.or.cz/go/pachi-tr.pdf）。
- 要点：RAVE 混合 `(1-β)·W/N + β·W_amaf/N_amaf`；先验值以"等效经验"注入；
  启发式（避填眼、劫先验、线位偏好）各有 Elo 代价表；`CFG distance`、playout policy 单项即 ±200 Elo 级。
- 借用范围：**算法思想**（等效经验、避眼/劫先验、playout 策略分层），用于 `ai` 模块与风格档设计。

### 4.3 Fuego 的 playout 策略与终局评估
- 来源：Enzenberger et al.《FUEGO — An Open-source Framework…》（TCIAIG）。
- 要点：playout 优先级 —— 提子 / 欠子防守 / MoGo 3×3 模式（近最后一手）→ 2 气棋块好气点位 → 全局提子 → 随机；
  禁自闭眼（除非挨提）；mercy rule（提子差 > 30% 棋盘判终）；**终局按 Tromp-Taylor 直接计分**；
  根节点 move filter（淘汰不成立征子、远离棋子的第一线）。
- 借用范围：**算法思想**（playout 分层与 mercy/终局计分约定），用于 `ai` 模块；mercy rule 列为可选 profile。

## 5. 参考实现观察（不作为行为契约）

| 项目 | 语言 | 许可证 | 观察点 |
|---|---|---|---|
| Tenuki Engine（Sir-Teo/tenuki） | C++20 | 未标注 | Tromp-Taylor + PSK + Zobrist + GTP + SGF 的最小骨架；与本项目"最小可验证内核"取向一致 |
| go-the-surrounding-game（maryanjimale959-lab） | Python | 未标注 | 纯 Python 全规则 + 启发式/MCTS + JS 双实现交叉校验的测试组织方式 |
| pyDLGO（RyXM/pyDLGO） | Python | 未标注 | Tromp-Taylor 在深度学习围棋中的实现说明（自杀禁否的具体差异） |
| KataGo（lightvector） | C++/CUDA | MIT | 规则档配置（Chinese = area + PSK + 禁自提）的事实参照 |

> 上述项目**均未复制代码**；仅作"存在先例"的证据与差异对照，避免闭门造车。

## 6. 借鉴记账（第二轮，2026-10-09）

| 来源 | 许可证 | 借用范围 | 落点 |
|---|---|---|---|
| **`G:\repos\zhuangtaiji`**（多范式决策引擎，公开仓 https://gitee.com/siwpan/zhuangtaiji ，作者同为 siwpan） | MIT | **DTMC 的接口形态与幂迭代求稳态思路**（`core/markov_chain.py`：states/matrix/step/simulate/steady_state/is_absorbing） | `tools/markov.mjs` §1 为 JS 重写；§2/§3（落子转移模型、棋形条件模型 + 退避）为本项目新增，来源中**没有**对应实现 |
| GTP v2 规范（Farnebäck） | 规范文本（公开） | 命令语义、输出格式（`= ` / `? `）、**§4.1.1 让子星位表**、坐标跳 I | `tools/gtp.mjs`（适配器）、`tools/tests_io.mjs`（坐标表快照断言） |
| SGF FF[4] 规范（red-bean.com） | 规范文本（公开） | 属性语义、坐标编码（y 向下 vs 引擎 y 向上→需翻转）、pass 写法（`B[]` 与遗留 `B[tt]`） | `tools/sgf.mjs` |
| CGTC（Müller） | — | `.tst` 用例格式与 `reg_genmove` 判据 | `spec/regress/*.tst` + `tools/regress.mjs` |

> 说明：`zhuangtaiji` 为同一作者的既有项目，许可证一致（MIT），无许可冲突；
> 本次仅借用**结构与算法思路**，未复制其 Python 代码；`tools/markov.mjs` 中的围棋专用层为本项目原创。

## 7. 未决/裁剪项（诚实记录）

1. **SGF 读写**：M1 不实现（局面用 `golden.json` 承载）；未来经 `loadsgf/printsgf` 补齐后可接 CGTC。
2. **GTP 适配器**：未实现；协议语义已对齐，属机械映射工作。
3. **让子定式**（`fixed_handicap` 星位表）：M1 未实现，用 `set_stones` 表达。
4. **死子自动判定 / 收单官**：不实现（采用"盘上皆活"约定），与 Gomill internal、TT 一致。
5. **神经网络（AlphaZero 路线）**：摒弃（破零依赖传统、需算力），MCTS 为设计上限。
6. **Go 语言引擎**：本机 Go 工具链残缺（`G:\go\src\fmt` 缺失，现场复现），M1 排除；修复后可作第 6 门语言加入。
