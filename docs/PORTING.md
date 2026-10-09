# 移植简报（PORTING.md）—— 多语言功能对等实现要求

> 面向各语言移植者（人或代理）。**规则行为的唯一真相来源**：
> `docs/RULES_SPEC.md`（规则）+ `docs/PROTOCOL_SPEC.md`（协议）+ `spec/golden.json`（黄金值）。
> **参考实现**：`PyWeiqi/`（已全绿：golden 35/35 + unit 58/58）。
>
> **已完成的语言**（6/6）：`PyWeiqi` `JsWeiqi` `RustWeiqi` `CppWeiqi` `CsWeiqi` `GoWeiqi`
> —— 全部通过 golden 35/35 与跨引擎协议差分（0 差异）。新增语言请以下表为准补齐。

## 1. 每个语言目录的交付物

```
<Lang>Weiqi/
  rules.<ext>    规则核心（棋盘/坐标/走子/提子/自杀/三档劫/Zobrist/两套计分）
  ai.<ext>       MCTS(UCT+RAVE)：轻量 PBoard + 局部 playout + 树内先验 + 分差估值
  driver.<ext>   JSON-stdio 驱动（docs/PROTOCOL_SPEC.md 全部命令）
  main.<ext>     CLI：test | selftest | driver | selfplay
  tests.<ext>    内部单测（与 golden.json 互补）
```

构建产物命名：Rust `rustweiqi.exe`、C++ `cppweiqi.exe`、C# `CsWeiqi.dll`（`dotnet run` 亦可）。

## 2. 硬性验收门（缺一不可）

```bash
# ① 自测全绿（黄金值 35 用例逐位比对 + 内部单测）
<Lang>Weiqi: main test   → 必须输出 "PASS: N passed, 0 failed"，且 golden 段为 35/35

# ② 驱动可被 harness 驱动
printf '{"id":1,"cmd":"hello"}\n{"id":2,"cmd":"quit"}\n' | <driver 启动命令>
   → 首行 {"event":"ready",...}，随后 hello 响应含 name/lang/protocol=1
```

## 3. 必须逐位一致（跨语言完全相同）

| 项 | 要求 |
|---|---|
| `posKey` / `sitKey` | `splitmix64` 表与 XOR 规则严格按 RULES_SPEC §6；输出 `0x` + 16 位小写 hex |
| 走子结果 | `captures` / `self_captured` / 各 `reason`（turn/occupied/ko/suicide/superko/over/range） |
| `legal_moves` | 点集与顺序（索引升序）完全相同，含 pass 不计 |
| 计分 | `black`/`white`/`dame`/`result` 字符串（`B+3.5`/`W+7.5`/`0`） |
| 规则档 | `cn`(positional/forbid/area/7.5)、`tt`(positional/allow/area/7.5)、`jp`(simple/forbid/territory/6.5) |

## 4. AI 允许差异（不要求跨语言一致）

- RNG 可用本语言等价实现（splitmix64 流）；**同语言内**给定 (局面, playouts, seed, profile) 必须可复现。
- 结构必须等价（否则循环赛不公平）：UCT+RAVE 选择、RAVE 混合 `β=sqrt(k/(k+3N))`、
  playout 局部候选（最后一手 1 邻域，无候选退全盘）、提子/救子优先、避自填气与填眼、
  树内先验（提子 +、自填气 −）、**分差归一化估值**（`v=0.5+0.5·clip(diff/scale)`，scale=棋盘点数/2）、
  眼位过滤、空盘中央区候选、显式过手规则（不在树内）。
- 性能：越快越好；Python 参考约 100–300 playouts/s（9 路），Rust/C++ 应高 2–3 个数量级。

## 5. 性能实现要点（Python 参考踩坑记录，请直接采用）

1. 棋块扫描用 **stamp 数组**（代际标记），不要每次分配 `set`。
2. **提子预检**：仅当邻子除落点外没有任何空邻点时才做整块扫描。
3. **己方气数下界**：落点空邻点 ≥2 时己方气数必 ≥2 → 免扫描，且 `ko_new = -1`。
4. **单子判定**：`own_size == 1` ⟺ 落点无同色邻点（免扫描）。
5. playout 用局部候选（最后一手 1 邻域）；局部无候选才全盘扫描。

## 6. 语言特定注意

| 语言 | 注意 |
|---|---|
| **JS** | 64 位键用 `BigInt`；输出转 16 位 hex（`padStart`）。ESM（`.mjs`），零依赖。 |
| **Rust** | `u64` 溢出用 `wrapping_mul` / `wrapping_add`；`cargo build --release`；建议 `Vec<u8>` 棋盘。 |
| **C++** | `uint64_t`；`g++ -O2 -static`；C++17；注意 `>>` 为无符号右移（用 `uint64_t`）。 |
| **C#** | `ulong`；`unchecked` 块内做乘法/加法；`dotnet build -c Release`（net10.0）；注意 `>>` 对 `ulong` 是逻辑右移。 |
| **Go** | `uint64` 溢出天然回绕（无需显式 wrapping）；`math/bits` 可用；`encoding/json` 属标准库可用。**本机系统 Go 的 GOROOT 残缺**，`build.sh` 内需显式设 `GOROOT` 指向受管安装（见 REQUIREMENTS.md §2）。 |

## 7. 提交要求

- 自测输出粘贴到交付说明；若某项无法一致，**必须报告而非静默改测**。
- 不修改 `spec/golden.json`（只读）；若认为黄金值有误，报告 `case id` + 理由。
