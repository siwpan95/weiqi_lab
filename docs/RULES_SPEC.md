# 围棋规则规范（单一真相来源）

> 本文件是 weiqi_lab 五语言引擎（Py / Js / Rust / C++ / C#）的**行为契约**。
> 任何实现与本文冲突即为缺陷；本文未明确者，以 `PyWeiqi/` 参考实现为准并回写本文。
> 版本：spec-v1（2026-10-08）

---

## 1. 棋盘与坐标

| 项 | 规定 |
|---|---|
| 棋盘尺寸 | `size` ∈ [2, 19]，默认 **9** |
| 点索引 | `idx = y * size + x`，`x` 从左到右（A→T），`y` 从下到上（1→19） |
| 列字母 | `"ABCDEFGHJKLMNOPQRST"`（**跳过 I**，共 19 个），`x` 对应第 `x` 个字符 |
| 顶点字符串 | `<列字母><行号>`，如 `A1`（左下角）= (0,0)，9 路 `J9` = (8,8)。行号 1 起、`y+1` |
| 虚着 | 顶点字符串 `"pass"`（协议层大小写不敏感，规范写作小写） |

底层表示：一维整数数组 `cells[size*size]`，取值 0=空、1=黑、2=白。

## 2. 走子算法（精确步骤）

对 `play(color, vertex)`：

```
1) 轮次检查：color 必须等于当前 side（黑先）。否则非法，reason="turn"。
2) 若是 pass：
     koPoint = -1；history 追加(当前 posKey, 新 side)；consecutivePasses += 1；
     side = 对方；返回 {ok:true, captures:0, self_captured:0}
3) 简单劫预检：若 koPoint != -1 且 vertex == koPoint → 非法，reason="ko"
4) 落子前检查：cells[vertex] != 0 → 非法，reason="occupied"
5) 在 vertex 放置 color 的棋子
6) 清除对方无气棋块（4 邻域同色连通块）：对每个与 vertex 相邻的对方棋块，
   若其气数 == 0 则整块提掉，captures += 块大小；记 captured_single =
   （当 captures 恰为 1 且被提块大小为 1 时，该点；否则 -1）
7) 自杀判定：若 vertex 所属己方棋块气数 == 0：
     - suicide == "forbid"：完全回滚本步 → 非法，reason="suicide"
     - suicide == "allow"：整块提掉自身，self_captured = 块大小
8) 禁全同判定（在步骤 6/7 完成后的新盘面上）：
     newPosKey = 新盘面 posKey；newSitKey = 新盘面 sitKey
     - ko == "positional"：newPosKey ∈ historyPosKeys → 回滚，非法，reason="superko"
     - ko == "situational"：newSitKey ∈ historySitKeys → 回滚，非法，reason="superko"
     - ko == "simple"：不做本步检查
9) 提交：koPoint 按 §4 计算并更新；side = 对方；consecutivePasses = 0
10) history 追加 (newPosKey, 新 side 即走子后的 side)
```

> 步骤 6 先于 7 —— 提子后再判自杀（提子可解除自杀）。这是 TT 与各国规则一致的次序。
> 步骤 8 中 **回滚必须是完全的**（盘面、captures、koPoint、history、side 均不得改动）。

## 3. 气与棋块

- 棋块 = 4 邻域同色极大连通块。
- 气 = 与棋块任一子相邻的空点数（**去重**）。
- `captures` 为累计提子数（分别记黑提白、白提黑，见 `prisoners`）。

## 4. koPoint（简单劫禁着点）

一次 `play(color, V)` 提交后：

```
若 captures == 1 且 V 所属己方棋块（提子后）大小 == 1 且该棋块气数 == 1：
    koPoint = 被提的那颗子的点
否则：
    koPoint = -1
```

- `suicide == "allow"` 且本步自提 → 己方棋块已不存在 → `koPoint = -1`。
- pass 必然置 `koPoint = -1`。
- `koPoint` 只约束**紧接着的下一手**（下一手提交时即被覆盖）。

## 5. 禁全同（三档）

| 档位 | 语义 |
|---|---|
| `simple` | 仅简单劫（§4 的 koPoint 禁着点），允许其他形式同形 |
| `positional` | **位置禁全同（PSK）**：新盘面（不含轮次）若等于对局中曾出现过的任一盘面 → 非法 |
| `situational` | **情境禁全同（SSK）**：新盘面 + 新 side 的组合若等于曾出现过的 (盘面, side) → 非法 |

- "曾出现过"包含**初始局面**与每一次走子（含 pass）后的局面。
- history 语义：`H[0]` = 初始局面（其 side = 开局轮次方，默认黑），`H[i]` = 第 i 手后局面（side = 该局面下轮到的一方）。
- `historyPosKeys` = { H[i].posKey }；`historySitKeys` = { (H[i].posKey, H[i].side) }。
- 对 `positional` / `situational`，§2 步骤 3 的 koPoint 预检**仍然执行**（冗余但保证与 simple 档在常见劫形上一致）。

## 6. Zobrist 键（跨语言逐位一致）

```
MASK = 0xFFFFFFFFFFFFFFFF
splitmix64(x):                        # 全程无符号 64 位，溢出即 mod 2^64
    z = (x + 0x9E3779B97F4A7C15) & MASK
    z = ((z ^ (z >> 30)) * 0xBF58476D1CE4E5B9) & MASK
    z = ((z ^ (z >> 27)) * 0x94D049BB133111EB) & MASK
    return z ^ (z >> 31)              # >> 为逻辑右移
```

- `MAX_POINTS = 361`
- `ZB(c, p) = splitmix64((c - 1) * 1024 + p)`，c∈{1,2}（1=黑,2=白），p∈[0,361)
- `SIDEKEY_W = splitmix64(4096)`
- `posKey   = XOR_{棋盘上的每颗子} ZB(颜色, 点索引)`（空盘 = 0）
- `sitKey   = posKey XOR (side == 2 ? SIDEKEY_W : 0)`
- 输出格式：`"0x" + 16 位小写十六进制`（例：`0x0000000000000000`、`0x1a2b3c4d5e6f7081`）
- **注意**：ZB 表固定按 361 点生成，与棋盘尺寸无关（同一子集在不同尺寸盘上键值相同）。

## 7. 合法着法集合

`legal_moves` = 所有空点中满足以下条件者（**不含 pass**，pass 恒合法）：

1. 非 koPoint 禁着点（§4）；
2. 落子后：己方棋块有气（`suicide=forbid` 时）；或 允许自提（`suicide=allow`）；
3. 满足当前 `ko` 档的全同判定（§5）。

顺序：按点索引升序输出。

## 8. 终局

- **连续两次 pass** → 对局结束（`consecutivePasses >= 2`）。
- 结束后不得再 `play`（返回非法，reason="over"）。（`undo` 可撤销回对局中。）

## 9. 计分

### 9.1 数子 / 面积计分（`scoring="area"`，默认）

对每个空白连通区域（4 邻域）扫描其边界颜色集合：

| 边界颜色 | 归属 |
|---|---|
| 仅黑 | 黑方地域 |
| 仅白 | 白方地域 |
| 黑与白 | 单官（dame，不计分） |
| 无（全盘无子） | 单官 |

```
black = 黑子数 + 黑方地域点数
white = 白子数 + 白方地域点数
dame  = 单官点数
diff  = black - (white + komi)
结果串：diff > 0 → "B+" + 数值；diff < 0 → "W+" + 数值；diff == 0 → "0"
数值格式：以 **0.25 为最小步长**（整数不带小数点，如 "B+3"；否则 ".25"/".5"/".75"，如 "B+3.5"、"B+0.25"）。
实现方式：`q = round(diff*4)`，`whole = |q|/4`，`rem = |q|%4` —— 全整数运算，避免浮点格式差异。
（注：komi 应为 0.25 的整数倍；默认档均为 0.5 的倍数。）
```

> **自动判定约定（与 Tromp-Taylor / Gomill internal 一致）**：盘上所有棋子一律视为活棋，
> **不做死子自动判定、不做死子协商**。本约定写死在计分中（`area` 档）。

### 9.2 数目 / 地域计分（`scoring="territory"`）

- 地域同上表前两行（只计"仅本方"的空白区域）。
- `prisoners` = 对局中本方提掉的对方子数 + **显式指定**的死子（`dead` 列表，见协议）。
- ```
  black = 黑地域 + black_prisoners
  white = 白地域 + white_prisoners + komi
  结果串格式同 9.1
  ```
- 该档**仅用于规则自测**，不用于自动对局（死子判定不可自动完成）。

## 10. 规则配置组合（档）

| 档名 | ko | suicide | scoring | 默认 komi |
|---|---|---|---|---|
| `cn`（**默认**，中国数子口径） | positional | forbid | area | 7.5 |
| `tt`（Tromp-Taylor 口径） | positional | **allow** | area | 7.5 |
| `jp`（日本数目口径） | simple | forbid | territory | 6.5 |

未显式指定时使用 `cn`。

## 11. 局面构造（set_stones）

用于黄金值测试与加载既有局面：

- 直接放置棋子，**不做任何合法性校验**（允许任意盘面）。
- **重复落点语义**（2026-10-09 补充，Go 移植时发现的规范空白）：当 stones 列表对同一点给出多次时，
  `cells` 取**最后一次**的颜色；而 Zobrist 键按**增量异或**维护，故同一点的重复落子会**相互抵消**
  （键只反映奇数次的那些落点）。六语言实现均按此行为对齐（Python 参考实现即增量 XOR）。
- 放置完成后：`history` 重置为**仅含当前局面**的单条记录（side = 指定方，默认黑）；
  `koPoint = -1`；`consecutivePasses = 0`；`prisoners = 0`。
  空盘（无子）时该条记录即 `posKey = 0`，故空盘同样计入禁全同历史（出现 1 次）。
- 与 `play` 的差别：`set_stones` 不产生历史，因此 superko 只能比对当前局面之后的重复。

## 12. 让子

M1 不实现 GTP `fixed_handicap` 星位定式；让子局面一律经 `set_stones` 表达。文档化为已知裁剪项。

## 13. 跨语言一致性要求（验收门）

| 输出 | 一致性要求 |
|---|---|
| 规则操作（play/undo/legal/legal_moves/score/key/set_stones） | **逐位一致**（黄金值断面） |
| `posKey` / `sitKey` | **逐位一致** |
| 结果串（`B+3.5`） | 逐字一致 |
| `genmove` | 不要求跨语言一致（RNG 允许差异）；但同语言内给定 (seed, playouts, profile) 必须可复现 |
| 搜索可确定的战术题 | 经 §14 的共识题验收（各语言应给出同一手） |

## 14. 战术共识题（consensus cases）

固定局面 + 固定预算下，五语言引擎（及裁判）应给出同一手 —— 选取**唯一显然好手**的局面
（如一步提净对方大块、唯一救活己方大块），列入 `spec/consensus.json`。
若出现分歧：先查规则实现与候选裁剪，若属搜索随机性导致的弱分歧，记录进报告"已知分歧（非缺陷）"。

---

## 附：与主流规则体系的差异说明（调研出处见 docs/RESEARCH.md）

- **中国规则（实战）**：数子 + 禁止自杀 + 禁全同（"中国超级劫"变体，含实战例外条款）。本规范取
  其**可编程内核**（PSK + 禁自杀 + 数子），与 KataGo `Chinese` 口径（area + PSK + 禁自提）一致。
- **Tromp-Taylor**：本规范 `tt` 档即其逻辑规则（允许自杀、PSK、两次 pass 终局、面积计分、盘上皆活）。
- **日本/韩国规则**：数目法 + 简单劫 + 超级劫判无胜负。本规范 `jp` 档仅保留"数目计分"可编程部分。
