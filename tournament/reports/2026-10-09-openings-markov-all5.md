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
| **js** | — | 1-1 | 1-1 | 0-2 | 2-0 |
| **rs** | 1-1 | — | 0-2 | 0-2 | 2-0 |
| **cpp** | 1-1 | 2-0 | — | 1-1 | 1-1 |
| **cs** | 2-0 | 2-0 | 1-1 | — | 1-1 |
| **go** | 0-2 | 0-2 | 1-1 | 1-1 | — |

## 逐局结果

| # | 黑 | 白 | 结果 | 手数 | 尾盘 | 异常 |
|---|---|---|---|---|---|---|
| 1 | js | rs | B+11.5 | 104 | BE2 WF1 BH1 WG1 Bpass Wpass |  |
| 2 | rs | js | B+5.5 | 120 | BC9 Wpass BF8 WD9 Bpass Wpass |  |
| 3 | js | cpp | B+13.5 | 132 | BC4 WJ6 BA4 WC3 Bpass Wpass |  |
| 4 | cpp | js | B+15.5 | 106 | BJ4 Wpass BG7 WJ5 Bpass Wpass |  |
| 5 | js | cs | W+22.5 | 102 | BG1 WC3 BC4 WF1 Bpass Wpass |  |
| 6 | cs | js | B+3.5 | 102 | BD1 Wpass BF3 WE1 Bpass Wpass |  |
| 7 | js | go | B+29.5 | 124 | BB1 Wpass BG8 WA1 Bpass Wpass |  |
| 8 | go | js | W+10.5 | 107 | WA2 Bpass WA5 BA3 Wpass Bpass |  |
| 9 | rs | cpp | W+8.5 | 108 | BD4 WD5 BC6 WD6 Bpass Wpass |  |
| 10 | cpp | rs | B+13.5 | 115 | Wpass BG4 WG2 BG3 Wpass Bpass |  |
| 11 | rs | cs | W+8.5 | 109 | WC6 Bpass WG4 BC5 Wpass Bpass |  |
| 12 | cs | rs | B+23.5 | 100 | BA1 WH7 BG1 WH8 Bpass Wpass |  |
| 13 | rs | go | B+6.5 | 102 | BH6 WD7 BC8 WE6 Bpass Wpass |  |
| 14 | go | rs | W+4.5 | 118 | BH9 WJ9 BH8 WH9 Bpass Wpass |  |
| 15 | cpp | cs | B+25.5 | 106 | BE5 WD9 BE8 WE4 Bpass Wpass |  |
| 16 | cs | cpp | B+9.5 | 110 | BA3 WJ2 BB9 WF5 Bpass Wpass |  |
| 17 | cpp | go | W+24.5 | 137 | WH1 Bpass WG8 BJ1 Wpass Bpass |  |
| 18 | go | cpp | W+30.5 | 139 | WE1 Bpass WC8 BD1 Wpass Bpass |  |
| 19 | cs | go | W+6.5 | 103 | WB8 BB9 WC7 BB7 Wpass Bpass |  |
| 20 | go | cs | W+12.5 | 121 | WC9 Bpass WG4 BD9 Wpass Bpass |  |

## 引擎统计

| 引擎 | 胜 | 负 | 和 | 落子数 | 平均访问/手 | 平均估值 | 非法/错误 |
|---|---|---|---|---|---|---|---|
| JsWeiqi | 6 | 2 | 0 | 418 | 15 | 0.616 | 0 |
| RustWeiqi | 3 | 5 | 0 | 411 | 14 | 0.684 | 0 |
| CppWeiqi | 3 | 5 | 0 | 451 | 15 | 0.606 | 0 |
| CsWeiqi | 2 | 6 | 0 | 402 | 13 | 0.598 | 0 |
| GoWeiqi | 6 | 2 | 0 | 443 | 14 | 0.700 | 0 |

## 走法分歧（同一局面下不同引擎的首手中盘选择）

- 样本：20 手（引擎 × 该手局面）
- 不同选点：17 个 → 选点分歧率 0.800（近似，供跨期对比）

| 引擎 | 选点 | 访问数 |
|---|---|---|
| js | H7 | 4 |
| rs | A9 | 5 |
| js | G4 | 6 |
| cpp | E7 | 4 |
| js | C9 | 6 |
| cs | C9 | 10 |
| js | H3 | 6 |
| go | H3 | 5 |
| rs | A4 | 6 |
| cpp | D2 | 7 |
| rs | J1 | 3 |
| cs | A8 | 5 |
| rs | B9 | 6 |
| go | G4 | 6 |
| cpp | E3 | 4 |
| cs | J3 | 5 |
| cpp | D1 | 5 |
| go | D7 | 5 |
| cs | B5 | 6 |
| go | G6 | 5 |

> 生成耗时 55.2s；由 `tournament/run_tournament.mjs` 自动生成。
