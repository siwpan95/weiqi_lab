# weiqi_lab 循环赛战报 — 2026-10-09

## 设置

- 棋盘：9×9；规则：cn（数子 + 位置禁全同 + 禁自杀）；komi 7.5
- 每对局数：2；开局库手数：4（随机开局，Tier 1）
- 手数上限：243；裁判：`tournament/referee.mjs`（独立实现）
- 固定算力预算（playouts/手，按各引擎实测速度折算 ≈1s/手）：

| 引擎 | 语言 | playouts/手 |
|---|---|---|
| JsWeiqi | js | 80 |
| RustWeiqi | rs | 80 |
| CppWeiqi | cpp | 80 |
| CsWeiqi | cs | 80 |
| GoWeiqi | go | 80 |

## 交叉表（胜-负）

| 引擎 \ 对手 | js | rs | cpp | cs | go |
|---|---|---|---|---|---|
| **js** | — | 1-1 | 1-1 | 1-1 | 1-1 |
| **rs** | 1-1 | — | 1-1 | 1-1 | 2-0 |
| **cpp** | 1-1 | 1-1 | — | 1-1 | 2-0 |
| **cs** | 1-1 | 1-1 | 1-1 | — | 2-0 |
| **go** | 1-1 | 0-2 | 0-2 | 0-2 | — |

## 逐局结果

| # | 黑 | 白 | 结果 | 手数 | 尾盘 | 异常 |
|---|---|---|---|---|---|---|
| 1 | js | rs | B+1.5 | 118 | BJ4 Wpass BH7 WJ5 Bpass Wpass |  |
| 2 | rs | js | B+3.5 | 106 | BG7 Wpass BH3 WF7 Bpass Wpass |  |
| 3 | js | cpp | W+24.5 | 126 | Bpass WB8 Bpass WA9 Bpass Wpass |  |
| 4 | cpp | js | W+9.5 | 97 | WD9 BF9 WE9 BE3 Wpass Bpass |  |
| 5 | js | cs | B+10.5 | 110 | BE2 WD4 BF1 WD3 Bpass Wpass |  |
| 6 | cs | js | B+9.5 | 111 | WH8 BH9 WH7 BH8 Wpass Bpass |  |
| 7 | js | go | W+22.5 | 107 | WJ9 BH8 WH9 BJ3 Wpass Bpass |  |
| 8 | go | js | W+4.5 | 116 | BH4 WH1 Bpass WH5 Bpass Wpass |  |
| 9 | rs | cpp | B+21.5 | 129 | WJ5 BA2 Wpass BJ6 Wpass Bpass |  |
| 10 | cpp | rs | B+23.5 | 138 | BJ1 Wpass BD5 WH1 Bpass Wpass |  |
| 11 | rs | cs | W+8.5 | 100 | BJ7 WA5 Bpass WJ6 Bpass Wpass |  |
| 12 | cs | rs | W+16.5 | 101 | WG5 BC1 WH6 BD2 Wpass Bpass |  |
| 13 | rs | go | B+17.5 | 117 | Wpass BH8 WG6 BG7 Wpass Bpass |  |
| 14 | go | rs | W+12.5 | 113 | WJ2 BG2 WH1 BH2 Wpass Bpass |  |
| 15 | cpp | cs | W+14.5 | 107 | WG4 BA8 WA9 BB9 Wpass Bpass |  |
| 16 | cs | cpp | W+88.5 | 126 | BE7 WF7 BF8 WE8 Bpass Wpass |  |
| 17 | cpp | go | B+21.5 | 118 | BJ5 Wpass BF4 WJ4 Bpass Wpass |  |
| 18 | go | cpp | W+20.5 | 111 | WE1 BF2 WB4 BD1 Wpass Bpass |  |
| 19 | cs | go | B+27.5 | 112 | BB1 WE1 BF1 WG1 Bpass Wpass |  |
| 20 | go | cs | W+8.5 | 96 | BD4 WD2 BD1 WE1 Bpass Wpass |  |

## 引擎统计

| 引擎 | 胜 | 负 | 和 | 落子数 | 平均访问/手 | 平均估值 | 非法/错误 |
|---|---|---|---|---|---|---|---|
| JsWeiqi | 4 | 4 | 0 | 417 | 14 | 0.669 | 0 |
| RustWeiqi | 3 | 5 | 0 | 432 | 15 | 0.636 | 0 |
| CppWeiqi | 3 | 5 | 0 | 451 | 13 | 0.581 | 0 |
| CsWeiqi | 5 | 3 | 0 | 408 | 12 | 0.652 | 0 |
| GoWeiqi | 5 | 3 | 0 | 415 | 13 | 0.717 | 0 |

## 走法分歧（同一局面下不同引擎的首手中盘选择）

- 样本：20 手（引擎 × 该手局面）
- 不同选点：18 个 → 选点分歧率 0.850（近似，供跨期对比）

| 引擎 | 选点 | 访问数 |
|---|---|---|
| js | C3 | 4 |
| rs | J8 | 3 |
| js | G5 | 3 |
| cpp | J4 | 3 |
| js | D9 | 3 |
| cs | F4 | 3 |
| js | F3 | 3 |
| go | H1 | 3 |
| rs | J2 | 4 |
| cpp | C1 | 3 |
| rs | F5 | 3 |
| cs | B3 | 3 |
| rs | E5 | 3 |
| go | A8 | 2 |
| cpp | C1 | 3 |
| cs | E9 | 4 |
| cpp | D6 | 2 |
| go | G3 | 3 |
| cs | E9 | 3 |
| go | H8 | 3 |

> 生成耗时 45.7s；由 `tournament/run_tournament.mjs` 自动生成。
