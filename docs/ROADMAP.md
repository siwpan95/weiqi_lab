# 规划路线图（长期 / 跨项目）

> 本文件承接 `docs/STRENGTH_INVESTIGATION_REPORT-2026-10-09.md` §5 的方向重排，
> 把**长期与跨项目**工作项列为规划。本批（2026-10-08~09）的已结案/确认项不重复列入。
> 优先级由 §5 的横向结论驱动：**瓶颈在估值质量，而非搜索侧算力分配**。

---

## 0. 治理与交付（先于一切技术项）

| 项 | 状态 | 说明 |
|---|---|---|
| **本批本地提交推送远程** | ✅ 已建仓推送 | `gitee.com/siwpan/weiqi_lab`（public, MIT）；master 已推，`git ls-remote` 核对 IN_SYNC（本地=远程=`f048d67`） |
| **建仓三件套核对** | ✅ 已核 | `README.md` / `LICENSE`（MIT）/ `.gitignore` 均齐备；默认 **公开 + MIT**（铁律 0） |
| **人类棋谱不分发** | ✅ 已落实 | `PGD` 语料 `.cache/` 与 `spec/games/human-*.jsonl` 均 gitignore，只入库导入脚本 + 哈希（`docs/RESEARCH.md` §7） |

---

## 1. 第一优先：估值质量（本批诊断的核心瓶颈）

> 横向结论（报告 §5）：叶子估值信息量极低（±5 点分辨力），噪声不被更聪明的选点修复。
> 因此"提升单次模拟质量"是唯一能撬动强度的方向。

| 项 | 优先级 | 预期收益 | 成本 / 风险 | 备注 |
|---|---|---|---|---|
| **死子判定**（终局计分修正） | 🔴 P0 | 直接消除"盘上皆活"给的错误终局分数 → 估值与自对弈语料质量同步提升；被低估的高杠杆项 | 中（需裁判/计分层改造） | `docs/ENGINE_STRENGTH.md` §6 已标记；建议作为本批之后**第一个动手项** |
| **价值头**（CNN 加 value head，替代/融合 playout 终局估值） | 🔴 P0 | 直击"±5 点病根"——MCTS 更需要价值估计 | 中（**基础价值头走现有 CPU 自研训练路径**：`ml/cnn.py` 是自研前向 + 自研 `Adam`，零依赖即可训练；**仅"更大网络"才需 torch/GPU，届时另走破例放行**） | `docs/ENGINE_STRENGTH.md` §5-P4-3 |
| **更长 playout / mercy 作为速度旋钮（另测）** | 🟡 P2 | 固定时间预算下可能换回质量 | 低 | `mercy` 已证**不可降噪**（报告 §2-T1），只能当速度旋钮，需固定时间协议重测 |

### 1.1 本批落实记录（Track A / Track B，2026-10-09）

- **Track A — 死子判定（代码已落地；A/B 结论：中性）**
  - 实现：`tools/scoring.mjs`（纯函数死子检测 + 含死子面积法）、`tournament/referee.mjs::scoreAuto()`（终局计分自动移除死子）、`JsWeiqi/ai.mjs` 叶子估值 `dead_stones` 开关（默认 0，行为逐位不变）。
  - A/B（`ab-profile-2026-10-09-deadstone-300`，9 路 · 150 pl · 300 局）：**A(无死子) 143 : B(死子) 157，p=0.2530 → 中性**（点估计 +2.3pp 但不显著，Bonferroni 下更弱）。
  - 结论：死子判定作**叶子估值增强**不带来显著强度提升；但其**终局计分**语义（`scoreAuto`）仍修正"盘上皆活"，作为自对弈语料的干净终局标签保留。引擎 `dead_stones` 维持默认 0。
- **Track B — 价值头（代码已落地；训练留待下批）**
  - 实现：`ml/cnn.py` 加 `Wv/bv` 参数 + `forwardV` / `backward(...,dvalue)` / `value_mse` + `load` 旧权重回退；`ml/export_weights.py` 导出 `has_value` 旗标与 `Wv/bv`；`tools/cnn_forward.mjs::valueFrom`（全局均值池化→线性→sigmoid，与 Python 严格对拍通过）；`JsWeiqi/ai.mjs` 叶子估值 `cnn_value` 融合开关（默认 0，行为逐位不变）。
  - 数值自检：合成价值头网络 JS↔Python 对拍 `value` |d|=2.7e-8、`forwardOne` 重构后最大 |d|=2.4e-7；`tests.mjs` 加 3 个价值头单测（含 `hasValue=false→0.5`、退化 `sigmoid` 确定性）。
  - 待下批：用 `scoreAuto` 干净语料训练价值头，再开 `cnn_value>0` 做 A/B（Track B5）。

---

## 2. 第二优先：教师质量（先验有效性的上限）

> 铁律①：先验质量上限 = 教师质量上限（报告 C7）。弱教师先验是负资产。

| 项 | 优先级 | 说明 |
|---|---|---|
| **强教师语料（cpp/rs @10–20k playouts）** | 🟡 P1 | 同分布但显著更强 → 重训 CNN / 蒸馏表才有意义；已验证 `cpp/rs @5000 pl` 蒸馏表达 21.9% top-1 |
| **人类棋谱用足**（PGD 全量 98k 局；数据增强 8 对称+旋转） | 🟡 P1 | 当前仅用 6000 局；19 路 CNN 已 25.84% |
| **CNN 蒸馏表接循环赛开局并做 ≥100 局/组 A/B** | 🟡 P1 | `MARKOV_MODEL=spec/markov_model-cnn19.json OPENINGS=markov`；当前 20 局/组不足（`docs/TIER3_LEARNING.md` §5） |

---

## 3. 第三优先：跨语言与工程（不贡献强度，但决定可比性与可维护性）

| 项 | 优先级 | 说明 |
|---|---|---|
| **跨语言并行搜索**（tree parallel + virtual loss / JS `worker_threads`） | 🟡 P1 | `docs/PORTING.md` §4.1 已记待办；**必须 6 语言同步**，否则跨语言对比变味。固定 playouts 协议下只改墙钟、不改可比结果 |
| **RAVE 移除考量** | 🟢 P3 | 已证 `rave:true` 是无效负载（`docs/ENGINE_STRENGTH.md` §2.1 / `docs/PORTING.md` §4.2）；可移除以简化代码、省每节点 2 字段 |
| **转置 / 局面去重** | 🟢 P3 | Zobrist 键已具备；低预算下树浅、中转局极少，优先级低 |
| **时间控制 / 迭代加深** | 🟢 P3 | GTP `time_settings` 当前 no-op；真实对局需要 |

---

## 4. 明确降级 / 暂不投入

| 项 | 理由 |
|---|---|
| **搜索侧低收益项**（RAVE 强度、LGR/lib2 强度、参数微调） | 全部已测中性（报告 §5）；弱引擎下质量类改动被估值噪声淹没 |
| **双活 balancing 规则（seki）** | Fuego 单项 +52% 但 seki 在 playout 中罕见，性价比低 |
| **19 路循环赛扩盘** | 先 §1 提速（已完成 70×）再扩；当前 19 路一局曾 80 分钟，现已可用，但强度仍低 |

---

## 5. 验收纪律（贯穿所有规划项）

- 每项都必须用 `tournament/ab_prior.mjs`（自对弈 A/B）、`tournament/sweep.mjs`（Bonferroni 汇总）、
  `tools/human_agreement.mjs`（留出段人类一致度）、`tools/eval_model.mjs`（留出集指标）**量化**，
  禁止"看起来变强"的主观判断。
- 效应量小（≤±10pp）的结论**必须确认实验 + 两侧同等复核**才准入报告。
- 参数疑似无效先**指纹检验**证机制，再谈强度。
