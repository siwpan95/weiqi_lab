# JSON-stdio 通信协议规范（协议版本 1）

> 五语言引擎与 harness / 裁判 / 循环赛之间的唯一通信契约。
> 设计取向：**语义对齐 GTP v2**（便于未来加 GTP 适配器对接 GoGui/Sabaki/CGTC），
> 但线格式采用 JSON Lines（与 `G:\repos\lab` 的 JSON-stdio 传统一致）。
> 版本：protocol-v1（2026-10-08）

---

## 1. 线格式

- 传输：子进程 stdin / stdout，**每行一个 JSON 对象**（UTF-8，`\n` 结尾，无 BOM）。
- 引擎启动后**首先**输出一行 ready 事件，然后进入请求-响应循环：

```json
{"event":"ready","protocol":1,"name":"PyWeiqi","lang":"py","version":"v1"}
```

- 请求（控制器 → 引擎）：

```json
{"id":1,"cmd":"play","color":"B","vertex":"E5"}
```

- 响应（引擎 → 控制器），成功与失败二选一：

```json
{"id":1,"ok":true,"result":{"captures":2,"self_captured":0,"key":"0x1a2b..."}}
{"id":1,"ok":false,"error":"illegal move","reason":"suicide"}
```

- `id` 原样回显；`error` 为人类可读短句；`reason` 为机器可判定的稳定标识（见 §4）。
- 引擎**不得**向 stdout 写任何非 JSON 内容；日志一律写 stderr。
- 单条响应**必须在下一请求前完整输出**（同步语义，无流水线）。
- 未知命令 → `{"ok":false,"error":"unknown command"}`。
- 参数缺失/类型错误 → `{"ok":false,"error":"..."}`，**不带 `reason`**（`reason` 仅用于规则级失败）；
  引擎不得崩溃。顶点串非法（越界/含 I/空）经 `parse_vertex` 报错时同样不带 `reason`。

## 2. 命令总表

| cmd | 参数 | result | 说明 |
|---|---|---|---|
| `hello` | — | `{name,version,lang,protocol}` | 版本协商 |
| `clear` | `size`=int, `komi`=number, `rules`=obj | `{size,komi,rules}` | 重置对局。`rules` 见 §3，缺省 `cn` 档 |
| `set_stones` | `stones`=[[color,vertex],...], `side`="B"/"W" | `{stones:n}` | 直接摆子（§RULES_SPEC.11），不校验合法性 |
| `play` | `color`, `vertex` | `{captures,self_captured,key}` | 走子（vertex 可为 `"pass"`） |
| `undo` | — | `{moves:n}` | 撤销最后一手（含 pass） |
| `key` | — | `{key,situational}` | 当前 posKey / sitKey |
| `legal` | `color`,`vertex` | `{legal:bool,reason?:string}` | 单点合法性 |
| `legal_moves` | — | `{count,moves:[...]}` | 当前轮次方全部合法点（升序，不含 pass） |
| `genmove` | `color`,`playouts`=int,`seed`=int,`profile`=obj | `{vertex,visits,winrate}` | MCTS 产生着法并**落子** |
| `score` | `dead`=[[color,vertex],...]（可选） | `{black,white,komi,dame,result,...}` | 计分（§RULES_SPEC.9） |
| `prisoners` | — | `{black,white}` | 黑方提子数(白被提)/白方提子数 |
| `selftest` | `golden`=`<path>` | `{passed,failed,total,failures:[...]}` | 跑黄金值用例 |
| `quit` | — | `{}` | 输出响应后退出（exit code 0） |

### 2.1 `genmove` 细节

- `playouts`：固定模拟次数预算（默认 500）。引擎**必须**恰好执行该次数（或提前因唯一着法收敛）。
- `seed`：RNG 种子（默认 0）。**同语言**内相同 (局面, playouts, seed, profile) 必须可复现。
- `profile`：风格档对象，缺省为 `{}`（各语言内置默认值）。支持键：

| 键 | 默认 | 含义 |
|---|---|---|
| `c` | 0.7 | UCT 探索常数 |
| `rave` | true | 是否启用 RAVE(AMAF) |
| `rave_k` | 1000 | RAVE 混合常数（β = sqrt(k/(k+3N))) |
| `capture_bias` | 0.5 | playout 中"提子/逃子优先"概率 |
| `pattern_bias` | 0.5 | playout 中"贴近最后一手"概率 |
| `prune_radius` | 2 | 候选点裁剪半径（切比雪夫距离；0=不裁剪） |
| `pass_bias` | 0.0 | pass 虚拟胜场加成（等效经验） |
| `resign_threshold` | 0.0 | 胜率低于该值时（且已满 `resign_min_visits`）认输；0=不认输 |
| `resign_min_visits` | 200 | 认输判定最低访问数 |
| `mercy` | 0.0 | playout 提前终止：分差 > mercy×棋盘点数即停（0=关） |
| `pass_threshold` | 0.5 | 对手已过手时，本方估值 ≥ 该值即过手终局 |
| `score_scale` | 0.0 | 分差归一化尺度（0=自动取 棋盘点数/2） |

**AI 结构约定（五语言等价，见 PORTING.md §4）**：
- 选择：UCT + RAVE（`β = sqrt(rave_k/(rave_k+3N))` 混合 AMAF 与实测值）；
- **终局估值用"分差归一化"而非纯胜负**：`v = 0.5 + 0.5·clip((黑面积−白面积−komi)/scale, −1, 1)`
  —— 纯胜负制在"局面已定"时对所有着法给同一值、搜索退化为按下标选点，故必须用分差；
- 候选：切比雪夫半径 `prune_radius` 内的空点 ∩ 完整规则合法点；**眼位过滤**（不填自己单点真眼，打吃例外）；
  空盘取中央三分之一见方；
- 树内先验（等效经验）：提子加分、自填气减分（Pachi/Fuego 同款）；
- playout：局部候选（最后一手 1 邻域，无候选退全盘）+ 提子/救子优先 + 避自填气与填眼；
- **过手不入树**：`genmove` 先搜索；若无任何非填眼着法 → 过手；对手已过手且估值 ≥ `pass_threshold` → 过手终局。

**`winrate` 字段语义**：本实现返回的是**估值代理**（上述归一化 v，∈[0,1]），
以**根节点行棋方视角**给出；非严格胜率。

- 返回 `vertex` 为顶点串、`"pass"` 或 `"resign"`（后者仅在 `resign_threshold > 0` 时可能）；
  `visits` 为选中着法的访问数；`winrate` ∈ [0,1]（含义见上）。
- **终局性**：`genmove` 内的落子必须通过完整规则校验（含禁全同）；若根节点候选裁剪排除了某合法点，
  不得影响最终选择的合法性。

## 3. `rules` 对象

```json
{"ko":"positional","suicide":"forbid","scoring":"area"}
```

取值与默认见 `RULES_SPEC.md` §10。`clear` 时可用 `rules:"cn"|"tt"|"jp"` 字符串直接引用档名。

## 4. `reason` 稳定标识

| reason | 触发 |
|---|---|
| `turn` | 非当前轮次方 |
| `occupied` | 该点已有子 |
| `ko` | 简单劫禁着点 |
| `suicide` | 自杀（禁自杀档） |
| `superko` | 禁全同（PSK/SSK） |
| `over` | 已终局（连续两 pass） |
| `range` | 顶点越界/非法格式 |

## 5. 输入形式

- 顶点：`"A1"`…`"T19"`（跳过 I）、`"pass"`；大小写不敏感，规范输出大写。
- 颜色：`"B"/"b"/"black"`、`"W"/"w"/"white"`。
- 数值：`komi` 允许整数或浮点（输出保留原值）。
- `key` 输出：`"0x"` + 16 位小写 hex。

## 6. 黄金值用例文件格式（`spec/golden.json`）

```json
{
  "protocol": 1,
  "spec": "spec-v1",
  "cases": [
    {
      "id": "K01",
      "op": "key",
      "setup": {"size":9, "rules":{"ko":"positional","suicide":"forbid","scoring":"area"},
                "stones":[], "side":"B"},
      "expect": {"key":"0x0000000000000000","situational":"0x0000000000000000"}
    },
    {
      "id": "P01",
      "op": "play",
      "setup": {"size":9, "moves":[["B","E5"],["W","A1"],["B","E6"],["W","A2"],["B","F5"],["W","A3"],["B","E4"],["W","A4"]]},
      "args": {"color":"B","vertex":"D5"},
      "expect": {"ok":true,"captures":0,"self_captured":0}
    }
  ]
}
```

### setup 字段

| 字段 | 说明 |
|---|---|
| `size` | 棋盘尺寸，默认 9 |
| `komi` | 默认按档（cn/tt=7.5，jp=6.5） |
| `rules` | 档名或对象，默认 `"cn"` |
| `moves` | 依序合法走子（[color,vertex]），用于构造带历史的局面（superko 用例必用） |
| `stones` | 直接摆子 [[color,vertex],...]，与 `moves` 互斥（优先 `moves`） |
| `side` | `stones` 模式下的轮次方，默认 `"B"` |
| `ko_point` | 可选，直接指定 koPoint（stones 模式） |
| `dead` | 可选（territory 计分），死子列表 |

### op 与 expect

| op | 过程 | expect 键 |
|---|---|---|
| `key` | 构造局面后取键 | `key`,`situational` |
| `legal` | 对 `args.color/vertex` 调 `legal` | `legal`,`reason?` |
| `legal_moves` | 取合法点集 | `count`,`moves?`（列全时） |
| `play` | 对 `args` 走子 | `ok` 及 `captures`/`self_captured`；非法时 `reason` |
| `undo` | 走 `args.n` 手后撤销 | `ok` |
| `score` | 计分 | `black`,`white`,`dame`,`result` |
| `prisoners` | 提子数 | `black`,`white` |

> 判等规则：expect 中出现的键必须**逐位/逐字相等**；未出现的键不比对。
> 浮点比较：`result` 串按字符串比较；本节所有数值均为整数或半整数，无浮点误差问题。

## 7. 进程与超时约定

- 控制器（harness/tournament）负责 spawn、超时（默认：单命令 120s，`genmove` 按预算放宽）。
- 引擎崩溃/超时 → 控制器 kill 并记录（对局中判该方负，见 tournament 规则）。
- `quit` 后引擎应自行退出；控制器在 2s 后强制 kill。
