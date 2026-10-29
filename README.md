# weiqi_lab — 多语言围棋引擎移植 + 对局多样性研究实验场

## 仓库角色定位（投资组合分级 ②）

> 本仓在 siwpan 投资组合（D:/projects/repos，共 133 仓）中定级为 **② 保留**，领域 **多语言引擎移植验证**。
> **角色**：多语言验证展示。
> **维护策略**：② 旗舰 / 枢纽仓库打磨保留，作为能力展示或收敛点；② 保留类仓库低优先维持、不主动扩张。
> 投资组合统一分级索引：`D:/projects/repos/PORTFOLIO_TIERING.md`。

> **6 种编程语言的功能对等围棋引擎**（Py / Js / Rust / C++ / C# / Go），共享同一套规则规范、
> 黄金值测试集、JSON-stdio 协议与**独立裁判层**；在此之上是 9 路跨语言循环赛，
> 以及共享 I/O 层（SGF / GTP / 让子定式）与首个学习型组件（马尔可夫落子模型）。
> 本仓是 [`G:\repos\lab`](https://gitee.com/siwpan/lab)（国际象棋多语言移植实验场）的**围棋版**。
>
> 许可证：MIT（`LICENSE`）。**零第三方依赖**（Node/Python/Rust/C++/C#/Go 全部只用标准库）。

## 1. 这是什么

同一套围棋规则内核（**中国数子口径**）+ MCTS(UCT+RAVE) 引擎，用 6 种语言各自独立实现为**功能对等**版本：

- 规则输出（走子/提子/自杀/三档劫/两套计分/Zobrist 键）**逐位一致** —— 由冻结的黄金值测试集守护；
- `tournament/referee.mjs`（**机制不同的独立实现**：字符串键、无 Zobrist）作为权威裁决层驱动跨语言循环赛；
- `tools/` 是**共享 I/O 层**（SGF 读写、GTP v2 适配器、让子定式、马尔可夫模型）——只做一份 Node 零依赖实现，
  避免 6 倍重复，并让 GoGui / Sabaki / gogui-regress 能直接驱动本实验场的**所有**引擎。

## 2. 仓库结构

| 路径 | 作用 |
|---|---|
| `PyWeiqi/` `JsWeiqi/` `RustWeiqi/` `CppWeiqi/` `CsWeiqi/` `GoWeiqi/` | 6 个语言引擎（规则核心 + MCTS AI + 自测 + JSON-stdio 驱动） |
| `spec/golden.json` | **黄金值测试集（35 用例）**：跨语言唯一测试真相，冻结产物 |
| `spec/regress/*.tst` `*.sgf` | CGTC 式回归用例（12 条）与配套 SGF 局面 |
| `spec/games/` | Markov 训练语料（`corpus-*.jsonl`）与 SGF 样本 |
| `spec/markov_model.json` | 冻结的马尔可夫落子模型 |
| `docs/RULES_SPEC.md` | 规则规范（单一真相来源） |
| `docs/PROTOCOL_SPEC.md` | JSON-stdio 协议规范（语义对齐 GTP v2） |
| `docs/PORTING.md` | 移植简报（交付物、验收门、性能要点） |
| `docs/RESEARCH.md` | 联网调研纪要（来源 + 许可证 + 借用范围） |
| `docs/TIER3_LEARNING.md` | 学习型组件（Markov / CNN）路线与实测对比 |
| `docs/ENGINE_STRENGTH.md` | **引擎强度提升路线（evidence-based）**：性能剖析、搜索改进、playout 策略、先验质量、实测 A/B |
| `harness/` | 跨引擎一致性总入口：引擎清单 + JSON-stdio 客户端 + 三项校验 |
| `tournament/` | 独立裁判层 + 循环赛 runner + 开局库 + 战报（`reports/`） |
| `tools/` | 共享 I/O 层 + 学习组件：`sgf.mjs` `gtp.mjs` `regress.mjs` `markov.mjs` `train_markov.mjs` `import_human.mjs` `distill_to_table.mjs` `eval_model.mjs` `cnn_forward.mjs` + `gen_golden.py` |
| `ml/` | **破例依赖区**（仅 `numpy`）：CNN 策略头 `cnn.py`/`corpus.py`/`train_cnn.py`/`eval_compare.py` + 权重导出 `export_weights.py`/`export_cnn_policy.py` + 权重 `cnn-*.npz` |

## 3. 验证状态（2026-10-08 ~ 10-09 实测）

### 3.1 各语言自测（黄金值 35/35 + 内部单测）

| 语言 | 命令 | 结果 |
|---|---|---|
| Python 3.14 | `cd PyWeiqi && python main.py test` | ✅ **93 passed, 0 failed**（golden 35/35, unit 58/58） |
| JavaScript (Node 22) | `cd JsWeiqi && node main.mjs test` | ✅ **93 passed, 0 failed** |
| Rust 1.98 | `cd RustWeiqi && cargo run --release -- test` | ✅ **93 passed, 0 failed** |
| C++ (MinGW g++ 15.2) | `cd CppWeiqi && bash build.sh && ./cppweiqi.exe test` | ✅ **98 passed, 0 failed**（unit 63/63） |
| C# (.NET 10) | `cd CsWeiqi && dotnet run -c Release -- test` | ✅ **93 passed, 0 failed** |
| Go 1.27 | `cd GoWeiqi && bash build.sh && ./goweiqi.exe test` | ✅ **93 passed, 0 failed** |

### 3.2 跨引擎一致性（`cd harness && node host.mjs` → **ALL GREEN**）

| 校验 | 结果 |
|---|---|
| ① 六引擎内置黄金值自测 | 6/6 通过（各 35/35） |
| ② 跨引擎协议差分（468 条命令 × 6 引擎，覆盖 3 盘径 × 4 规则档，含故意非法着法） | **0 处差异** |
| ③ 独立裁判交叉校验（318 项：合法性/提子/合法点集/计分/提子数） | **0 处不一致** |

移植期各语言另做**独立差分**：Js 6321 条、Rust 38 局、C++ 6393 条、C# 11454 条、Go 468 条命令 —— 全部 **0 差异**。

### 3.3 CGTC 式回归（`cd tools && node regress.mjs`）

| 引擎 | py | js | rs | cpp | cs | go |
|---|---|---|---|---|---|---|
| 通过 | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 |

合计 **72/72 通过，0 失败**（对杀/过手类局面，判据为「返回点落在期望集内」）。

### 3.4 循环赛与吞吐（9 路 · 实测 playouts/s）

- 吞吐：**cpp ≈12500 · rs ≈11765 · go ≈8000 · cs ≈2174 · js ≈870 · py ≈132**
  （循环赛按各引擎速度折算 **等效 ~1s/手** 的固定算力预算，见 `harness/engines.mjs`）
- 冒烟战报（10 局）：全部正常终局（99–139 手），0 非法 / 0 超时 / 0 崩溃 → `tournament/reports/`

### 3.5 Tier 3 学习型组件（Markov ✅ / 人类语料 ✅ / CNN ✅）

| 实验 | 模型 | 语料 | 盘径 | **top-1** | top-3 | 均匀基线 | 相对均匀 |
|---|---|---|---|---|---|---|---|
| 基线（第一轮） | Markov 模式模型 | 自对弈 cpp vs go（60 局） | 9 | 8.9% | 17.9% | 4.55% | 1.95× |
| **T3-A 对照** | Markov 模式模型 | 自对弈（12 局 / 30 playouts） | **19** | **1.3%** | 3.1% | 0.97% | **1.34×** |
| **T3-A 语料升级** | Markov 模式模型 | **人类职业棋谱 PGD（6000 局）** | **19** | **21.3%** | 36.8% | 0.43% | **50.1×** |
| **T3-C 容量升级** | **CNN（numpy，~2 万参数）** | 同上人类语料 | 19 | **25.84%** | 42.54% | 0.41% | 62.9× |
| **T3-D 蒸馏（零依赖）** | **CNN 蒸馏模式表** | 同上人类语料 | 19 | **22.70%** | 37.3% | 0.43% | **53.3×** |
| 对照 | CNN（numpy） | 自对弈（60 局） | 9 | 17.58% | 38.76% | 4.55% | 3.9× |

**两条轴都真实有效，且已用同盘径对照严格验证**：在**同为 19 路**、同一模型、同一代码下，
只把语料从"弱引擎自对弈"换成"人类职业棋谱"，相对均匀基线增益从 **1.34× 跳到 50.1×**
（紧邻偏置 2.34× → 18.1×；稳态热点从 `pass`/噪声变成**星位**）；
在此基础上换成 CNN，top-1 再升到 **25.84%**（模式表的 1.21×）。
详见 `docs/TIER3_LEARNING.md` 与 `tournament/reports/{markov,cnn}-*.md`。

> ⚠️ **2026-10-09 对称帧修正**：上表数字均为修正后。此前版本的表存在**偏移未做对称归一**的语义缺陷
> （同一棋形键下混入 8 个朝向的偏移 → 分布被抹平），使计数表/蒸馏表的 top-1 被严重低估
> （人类 19 路 7.25% → **21.34%**、CNN 蒸馏 7.33% → **22.70%**；合成可判定用例 2/8 → 8/8）。
> 修正后"蒸馏路径有损"的旧结论被推翻：蒸馏表以 **18 µs/手（CNN 的 1/22）零依赖**保留了 CNN 约 **88%** 的 top-1。
> 细节与回归测试见 `docs/TIER3_LEARNING.md` §2.6、`tools/tests_markov.mjs`。

**零依赖化的两条路径（实测对比）**：① 模式表蒸馏（`tools/distill_to_table.mjs`）——修正帧后 19 路 **22.70%**
（≈CNN 的 88%，**有损但代价极小、零依赖**），9 路 4.13% → **10.47%**（2.3×）；② **权重导出 + 纯 JS 前向**
（`tools/cnn_forward.mjs`，权重 `spec/cnn_weights-*.json` 仅 0.22MB）——与 Python **逐位等价**
（max|Δlogit| 3.8e-6），**无损保留完整预测力且运行期零依赖**。工程上 ② 用于开局（`OPENINGS=cnn`），
① 用于 playout 偏置（`pbias_model`，见 `docs/ENGINE_STRENGTH.md` §3.1）。

**引擎强度开关与推荐配置（仅 JsWeiqi 实现，默认全关 → 跨语言可比性不受影响）**：
`profile` 支持 `probe_k`（惰性探测）/`pw_c`+`pw_min`（渐进加宽）/`tree_reuse`/`lgr`/`lib2`/`pbias`+`pbias_model`/`cnn_prior` 等，
逐项实测与 A/B 见 `docs/ENGINE_STRENGTH.md`。其中**唯一经 300 局 A/B 证实显著**的是渐进加宽：

```json
{ "probe_k": 3, "pw_c": 0.5, "pw_min": 6 }
```

对**原始默认**的自对弈 A/B（9 路 · 150 playouts）：**两次各 300 局独立运行分别为 72.3% 与 70.7%**
（**合并 600 局 71.5%，p<0.0001，确认实验已复现**），且**每手快约 3.2×**（约 93 ms → 25~29 ms）；
其邻域参数（`pw_c=1.0`、`pw_min=4`）经扫描**显著更差**，说明该配置位于平台中部。
19 路 genmove 另因 `probe_k=3` 提速约 70×（5940 ms → 81 ms）。

其余开关（LGR / lib2 / pbias / cnn_prior / tree_reuse）经实测为**中性或负向**，与其移植状态一并见
`docs/PORTING.md` §4.1 与 `docs/ENGINE_STRENGTH.md` §7 的战果总表。

**依赖边界**：破例引入的 `numpy` **仅在 `ml/`**（隔离 venv）；引擎/`tools/`/`harness/`/`tournament/` 仍零依赖。
人类棋谱**不随仓分发**（`.cache/`、`spec/games/human-*.jsonl` 已 gitignore），按 `docs/RESEARCH.md` §7 的命令 + SHA 可复现。

**Markov/CNN 开局已接入循环赛**：`OPENINGS=markov`（模式表，可用 `MARKOV_MODEL` 指定蒸馏表）或
`OPENINGS=cnn`（纯 JS CNN 前向）；默认仍随机，模型缺失自动回退。
**A/B（4 组 × 110 局 = 440 局）**：四组黑胜率 31.8%–49.1%，**经 Bonferroni 校正后无任何稳健差异**
（最小校正后 p=0.0543），平均手数 111.5–113.1（不影响对局长度）。
差异全在**棋形结构**：CNN 前向开局仅 **25/110 唯一线**且 74.1% 落 1–2 线（忠实继承弱引擎语料的贴边/重复怪癖），
两种模式表均为 110/110 唯一。见 `tournament/reports/{openings-ab100,openings-profile}-*.md`。

## 4. 规则口径

| 档名 | ko | suicide | scoring | komi | 说明 |
|---|---|---|---|---|---|
| `cn`（**默认**） | positional | forbid | area | 7.5 | 中国数子口径（对齐 KataGo `Chinese`） |
| `tt` | positional | **allow** | area | 7.5 | Tromp-Taylor 逻辑规则 |
| `jp` | simple | forbid | territory | 6.5 | 日本数目口径（死子需显式指定） |

让子定式（GTP `fixed_handicap`）：按 GTP v2 §4.1.1 标准星位表放置（9/13/19 路 2–9 子，实测坐标见
`tools/tests_io.mjs` 快照断言）；让子子归黑方，放置后**白方先走**，`komi` 由控制器显式设置。

## 5. 快速开始

```bash
# ① 单语言自测
cd PyWeiqi && python main.py test        # 或 JsWeiqi/GoWeiqi/RustWeiqi/CppWeiqi/CsWeiqi

# ② 跨引擎一致性门（改动规则/AI 后必跑）
cd harness && node host.mjs              # 期望 ALL GREEN

# ③ 共享 I/O 层
node tools/tests_io.mjs                  # SGF/GTP/让子自测（165 项）
node tools/tests_markov.mjs              # Markov 模式表自测（29 项：对称帧/签名交叉校验）
node tools/gtp.mjs py                    # 用 GTP v2 驱动 PyWeiqi（可接 GoGui/Sabaki）
node tools/regress.mjs                   # CGTC 式回归（6 引擎 72/72）

# ④ 循环赛
cd tournament && node probe.mjs && GAMES_PER_PAIR=2 node run_tournament.mjs

# ⑤ 学习型组件
node tools/train_markov.mjs              # Markov：采集 → 训练 → 留出评估 → 报告
MARKOV_CORPUS=spec/games/human-2026-10-09.jsonl MARKOV_SIZE=19 MARKOV_TAG=-human19 node tools/train_markov.mjs
C://Users//psw//.workbuddy//binaries//python//envs//ml//Scripts//python.exe ml\train_cnn.py --corpus spec\games\human-2026-10-09.jsonl --size 19 --steps 2000 --batch 128 --max-games 600
C://...//envs//ml//Scripts//python.exe ml\eval_compare.py --corpus spec\games\human-2026-10-09.jsonl --size 19

# ⑥ 用 Markov 模型生成开局（循环赛）
OPENINGS=markov GAMES_PER_PAIR=2 node tournament/run_tournament.mjs
```

环境变量：`TOURNAMENT_SIZE/GAMES_PER_PAIR/OPENING_PLIES/TOURNAMENT_PLAYOUTS/MOVES_CAP`、
`WEIQI_ENGINES`/`ENGINES_FILTER`、`MARKOV_GAMES/MARKOV_PLAYOUTS/MARKOV_ENGINES`、
`WEIQI_PYTHON`（Python 解释器路径）、`MARKOV_TAG`（多实验报告后缀）、`OPENINGS=markov`、`REPORT_SUFFIX`。

## 6. 已知限制（诚实记录）

1. **AI 强度受限**：纯标准库 + 朴素 playout 的 MCTS，9 路战术分辨力约 **±5 点**（300 playouts 下），
   1–3 子局部战术不可靠；循环赛结果应按「弱引擎互搏」解读。
2. **AI 强度受限**：纯标准库 + 朴素 playout 的 MCTS，9 路战术分辨力约 **±5 点**（300 playouts 下），
   1–3 子局部战术不可靠；循环赛结果应按「弱引擎互搏」解读。
   其直接后果体现在 Tier 3：**弱引擎自对弈语料的可预测性极低**（紧邻偏置仅 1.97×、
   Markov 模型 top-1 0.91× 均匀基线），换成人类职业棋谱后同一模型即达 **17.0× 均匀**。
3. **学习型组件的边界**：CNN（`ml/`）依赖**仅 numpy**、约 2 万参数，19 路 top-1 25.84% 但推理 **404.9 µs/手**
   （比查表慢 22×），且已接近当前规模的能力上限；**未接入引擎**（离线研究轴）。
   若要用其预测力，建议走"蒸馏成零依赖先验表"的路子（见 `docs/TIER3_LEARNING.md` §5）。
3. **未实现**：GTP 时间控制（按 no-op 应答）、`final_status_list` 的死活判定、SGF 变体保留策略（只保主线）、
   死子自动判定/收单官（采用与 Tromp-Taylor / Gomill internal 一致的"盘上皆活"约定）。
4. **`genmove` 不要求跨语言一致**（RNG 允许差异）；同语言同 (局面, playouts, seed, profile) 可复现。
   本基线恰实现了六语言逐位一致，但**不构成契约**（见 `docs/PORTING.md` §4）。
5. **Go 工具链**：使用当前 PATH 上可执行的 Go 工具链即可（本项目基线为 go1.27.1）；
   `GoWeiqi/build.sh` 已显式设置 `GOROOT`，故不绑定特定安装位置 —— 换机 / 换盘只需保证 `go` 可达，
   且 `GOROOT` 指向一套标准库源完整的工具链。

## 7. 与 `G:\repos\lab` 的对应关系

| lab（国际象棋） | weiqi_lab（围棋） |
|---|---|
| 10 语言引擎（97 项逐字一致断言 + perft 黄金值） | 6 语言引擎（黄金值 35 用例 + 单测 58/63 项） |
| perft 黄金值契约 | 围棋无 perft 等价物 → 采用**局面 + 期望输出**范式（CGTC 式） |
| bestMove 共识 | 规则级逐位一致性 + 独立裁判交叉校验（弱引擎下 MCTS 共识不构成有效门禁） |
| `chess-cordis` harness | `harness/`（零依赖 Node，无框架） |
| `tournament/engine.mjs` 独立裁判 | `tournament/referee.mjs`（独立实现） |
| Tier 1 开局库 / Tier 2-C 风格档 | 开局库已实装；风格档以 `profile` 参数保留 |
| —（lab 无） | **Tier 3 学习型组件**：共享 I/O 层 + 马尔可夫落子模型（`tools/markov.mjs`） |

## 8. License

MIT，见 [`LICENSE`](./LICENSE)。调研与借鉴来源见 [`docs/RESEARCH.md`](./docs/RESEARCH.md)。
