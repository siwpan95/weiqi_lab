# weiqi_lab 循环赛战报 — 2026-10-09

## 设置

- 棋盘：9×9；规则：cn（数子 + 位置禁全同 + 禁自杀）；komi 7.5
- 每对局数：11；开局库手数：4（随机开局，Tier 1）
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
| **js** | — | 6-5 | 4-7 | 6-5 | 6-5 |
| **rs** | 5-6 | — | 7-4 | 7-4 | 5-6 |
| **cpp** | 7-4 | 4-7 | — | 7-4 | 4-7 |
| **cs** | 5-6 | 4-7 | 4-7 | — | 5-6 |
| **go** | 5-6 | 6-5 | 7-4 | 6-5 | — |

## 逐局结果

| # | 黑 | 白 | 结果 | 手数 | 尾盘 | 异常 |
|---|---|---|---|---|---|---|
| 1 | js | rs | B+7.5 | 117 | WF1 BF5 Wpass BE1 Wpass Bpass |  |
| 2 | rs | js | W+34.5 | 122 | BD3 WC4 Bpass WD4 Bpass Wpass |  |
| 3 | js | rs | B+13.5 | 118 | BE1 Wpass BF4 WF1 Bpass Wpass |  |
| 4 | rs | js | B+1.5 | 117 | WH2 BE3 WA8 BH3 Wpass Bpass |  |
| 5 | js | rs | W+18.5 | 103 | WC2 Bpass WC8 BB2 Wpass Bpass |  |
| 6 | rs | js | B+5.5 | 109 | WJ8 BH7 Wpass BJ7 Wpass Bpass |  |
| 7 | js | rs | B+7.5 | 119 | WD6 BF2 Wpass BD7 Wpass Bpass |  |
| 8 | rs | js | W+6.5 | 106 | BJ7 WJ4 Bpass WJ8 Bpass Wpass |  |
| 9 | js | rs | W+26.5 | 108 | BG8 WB2 BG9 WJ5 Bpass Wpass |  |
| 10 | rs | js | B+15.5 | 106 | BH3 Wpass BG7 WH4 Bpass Wpass |  |
| 11 | js | rs | B+3.5 | 116 | BF9 WE9 BJ2 WA6 Bpass Wpass |  |
| 12 | js | cpp | B+3.5 | 102 | BF9 Wpass BD3 WG9 Bpass Wpass |  |
| 13 | cpp | js | B+5.5 | 104 | BC9 Wpass BF8 WD9 Bpass Wpass |  |
| 14 | js | cpp | W+12.5 | 99 | WH5 BD4 WJ4 BD1 Wpass Bpass |  |
| 15 | cpp | js | W+14.5 | 107 | WA6 BF2 WC8 BE1 Wpass Bpass |  |
| 16 | js | cpp | W+0.5 | 92 | BE9 WB3 BH1 WD9 Bpass Wpass |  |
| 17 | cpp | js | W+18.5 | 109 | WA6 Bpass WC3 BA5 Wpass Bpass |  |
| 18 | js | cpp | W+36.5 | 107 | WE5 Bpass WA3 BE6 Wpass Bpass |  |
| 19 | cpp | js | W+12.5 | 100 | BD8 WC8 BH5 WD7 Bpass Wpass |  |
| 20 | js | cpp | W+14.5 | 106 | BA9 WD4 BE4 WB9 Bpass Wpass |  |
| 21 | cpp | js | B+19.5 | 111 | Wpass BJ1 Wpass BJ3 Wpass Bpass |  |
| 22 | js | cpp | W+20.5 | 112 | BC4 WD2 BE1 WD4 Bpass Wpass |  |
| 23 | js | cs | B+23.5 | 118 | BD1 Wpass BC9 WC1 Bpass Wpass |  |
| 24 | cs | js | W+9.5 | 107 | WD5 BE1 WE2 BF2 Wpass Bpass |  |
| 25 | js | cs | B+13.5 | 110 | BD9 Wpass BD5 WC9 Bpass Wpass |  |
| 26 | cs | js | W+30.5 | 114 | BC9 WB9 BH8 WE5 Bpass Wpass |  |
| 27 | js | cs | W+44.5 | 143 | WH7 BD9 WA1 BE8 Wpass Bpass |  |
| 28 | cs | js | W+28.5 | 103 | WG7 BG8 WH8 BD7 Wpass Bpass |  |
| 29 | js | cs | W+34.5 | 108 | BC4 WC5 BA4 WB4 Bpass Wpass |  |
| 30 | cs | js | W+38.5 | 120 | BA9 WB9 BA8 WA9 Bpass Wpass |  |
| 31 | js | cs | W+6.5 | 120 | Bpass WE9 BD7 WE7 Bpass Wpass |  |
| 32 | cs | js | B+5.5 | 87 | WA3 BC3 Wpass BA4 Wpass Bpass |  |
| 33 | js | cs | W+40.5 | 116 | BJ5 WJ6 BG5 WH5 Bpass Wpass |  |
| 34 | js | go | W+36.5 | 143 | WJ6 Bpass WA6 BC1 Wpass Bpass |  |
| 35 | go | js | W+88.5 | 122 | BC7 WA8 BB8 WC8 Bpass Wpass |  |
| 36 | js | go | W+20.5 | 141 | WC9 Bpass WH1 BB9 Wpass Bpass |  |
| 37 | go | js | W+16.5 | 102 | BB6 WA7 Bpass WB7 Bpass Wpass |  |
| 38 | js | go | W+10.5 | 120 | BJ3 WD6 BD7 WJ4 Bpass Wpass |  |
| 39 | go | js | W+12.5 | 93 | WB1 BH3 WJ1 BJ2 Wpass Bpass |  |
| 40 | js | go | W+16.5 | 94 | Bpass WJ3 BJ1 WJ2 Bpass Wpass |  |
| 41 | go | js | W+6.5 | 83 | WA2 BB2 WB3 BJ1 Wpass Bpass |  |
| 42 | js | go | B+3.5 | 117 | WJ3 BJ8 WA5 BJ2 Wpass Bpass |  |
| 43 | go | js | W+34.5 | 122 | BG6 WG7 Bpass WH9 Bpass Wpass |  |
| 44 | js | go | W+8.5 | 102 | BH5 WG3 Bpass WF4 Bpass Wpass |  |
| 45 | rs | cpp | B+17.5 | 115 | WG2 BG3 WG2 BH2 Wpass Bpass |  |
| 46 | cpp | rs | W+20.5 | 127 | WA5 Bpass WB4 BJ6 Wpass Bpass |  |
| 47 | rs | cpp | B+3.5 | 87 | WG8 BF4 WF3 BG3 Wpass Bpass |  |
| 48 | cpp | rs | B+19.5 | 107 | WG7 BF7 Wpass BE5 Wpass Bpass |  |
| 49 | rs | cpp | W+12.5 | 107 | WE3 BD2 WJ6 BE1 Wpass Bpass |  |
| 50 | cpp | rs | W+14.5 | 96 | BG6 WF7 BF6 WG6 Bpass Wpass |  |
| 51 | rs | cpp | W+4.5 | 103 | WF5 BJ2 WD9 BJ5 Wpass Bpass |  |
| 52 | cpp | rs | W+12.5 | 121 | WF1 BE9 WE2 BD8 Wpass Bpass |  |
| 53 | rs | cpp | W+38.5 | 123 | WB2 BA3 WB3 BE9 Wpass Bpass |  |
| 54 | cpp | rs | W+0.5 | 103 | WA3 BG3 WH3 BA2 Wpass Bpass |  |
| 55 | rs | cpp | B+19.5 | 111 | Wpass BH9 Wpass BJ8 Wpass Bpass |  |
| 56 | rs | cs | B+13.5 | 117 | WF5 BD1 Wpass BE5 Wpass Bpass |  |
| 57 | cs | rs | W+24.5 | 116 | BA5 WE9 Bpass WA4 Bpass Wpass |  |
| 58 | rs | cs | B+29.5 | 115 | Wpass BA9 WA8 BB8 Wpass Bpass |  |
| 59 | cs | rs | W+28.5 | 116 | BE7 WE8 BE9 WF9 Bpass Wpass |  |
| 60 | rs | cs | W+10.5 | 102 | BC1 WF5 BF7 WF6 Bpass Wpass |  |
| 61 | cs | rs | W+22.5 | 130 | BG6 WH1 Bpass WG5 Bpass Wpass |  |
| 62 | rs | cs | W+2.5 | 101 | WA4 BA9 WD5 BC9 Wpass Bpass |  |
| 63 | cs | rs | W+8.5 | 103 | WE2 BE3 WD1 BD5 Wpass Bpass |  |
| 64 | rs | cs | W+24.5 | 119 | WA8 Bpass WH7 BA9 Wpass Bpass |  |
| 65 | cs | rs | W+10.5 | 113 | WH5 Bpass WD2 BH4 Wpass Bpass |  |
| 66 | rs | cs | W+10.5 | 93 | WE2 BC7 WC8 BD8 Wpass Bpass |  |
| 67 | rs | go | B+29.5 | 115 | WG9 BB3 Wpass BH9 Wpass Bpass |  |
| 68 | go | rs | B+1.5 | 113 | WF4 BA8 WH3 BH6 Wpass Bpass |  |
| 69 | rs | go | W+52.5 | 120 | BC7 WC8 Bpass WF1 Bpass Wpass |  |
| 70 | go | rs | W+30.5 | 127 | WB8 BC8 WD8 BB5 Wpass Bpass |  |
| 71 | rs | go | W+10.5 | 91 | WD1 BJ7 WG3 BE1 Wpass Bpass |  |
| 72 | go | rs | W+0.5 | 110 | BC9 WB1 Bpass WD9 Bpass Wpass |  |
| 73 | rs | go | W+40.5 | 120 | BB9 WH3 Bpass WA9 Bpass Wpass |  |
| 74 | go | rs | W+8.5 | 115 | WD6 BJ2 WA4 BE6 Wpass Bpass |  |
| 75 | rs | go | W+30.5 | 102 | BA6 WD7 BE6 WE7 Bpass Wpass |  |
| 76 | go | rs | W+27.5 | 123 | WE3 BE1 WD1 BE4 Wpass Bpass |  |
| 77 | rs | go | W+20.5 | 129 | WC7 Bpass WH6 BG1 Wpass Bpass |  |
| 78 | cpp | cs | B+23.5 | 116 | BA2 WA1 BB1 WH7 Bpass Wpass |  |
| 79 | cs | cpp | W+38.5 | 118 | BB9 WC9 Bpass WA9 Bpass Wpass |  |
| 80 | cpp | cs | W+6.5 | 102 | BH9 WJ3 BH2 WJ2 Bpass Wpass |  |
| 81 | cs | cpp | B+17.5 | 101 | WB8 BC8 Wpass BB9 Wpass Bpass |  |
| 82 | cpp | cs | W+58.5 | 110 | BJ4 WJ5 BJ3 WJ4 Bpass Wpass |  |
| 83 | cs | cpp | W+4.5 | 120 | BJ7 WJ8 BH9 WJ9 Bpass Wpass |  |
| 84 | cpp | cs | W+24.5 | 99 | WH2 BF4 WJ3 BF6 Wpass Bpass |  |
| 85 | cs | cpp | W+20.5 | 117 | WA4 Bpass WA8 BA5 Wpass Bpass |  |
| 86 | cpp | cs | B+31.5 | 112 | BF2 Wpass BG6 WF3 Bpass Wpass |  |
| 87 | cs | cpp | W+40.5 | 112 | Bpass WH4 BH3 WJ3 Bpass Wpass |  |
| 88 | cpp | cs | B+10.5 | 106 | BF9 WB1 BC1 WB2 Bpass Wpass |  |
| 89 | cpp | go | W+2.5 | 101 | WF1 BF5 WA6 BG1 Wpass Bpass |  |
| 90 | go | cpp | W+4.5 | 80 | BD2 WE3 BD3 WJ5 Bpass Wpass |  |
| 91 | cpp | go | B+19.5 | 108 | BH1 Wpass BC5 WG1 Bpass Wpass |  |
| 92 | go | cpp | B+25.5 | 107 | WC8 BD8 WC7 BC8 Wpass Bpass |  |
| 93 | cpp | go | W+48.5 | 114 | Bpass WJ6 Bpass WH7 Bpass Wpass |  |
| 94 | go | cpp | B+2.5 | 102 | BD3 WA2 BE2 WB1 Bpass Wpass |  |
| 95 | cpp | go | B+19.5 | 132 | BF9 WH2 BD7 WG6 Bpass Wpass |  |
| 96 | go | cpp | W+40.5 | 102 | BF3 WE3 Bpass WG6 Bpass Wpass |  |
| 97 | cpp | go | W+18.5 | 101 | WJ4 BJ5 WH7 BG1 Wpass Bpass |  |
| 98 | go | cpp | B+27.5 | 123 | WF7 BG7 Wpass BH9 Wpass Bpass |  |
| 99 | cpp | go | W+12.5 | 108 | BH9 WA3 Bpass WJ9 Bpass Wpass |  |
| 100 | cs | go | W+88.5 | 136 | Bpass WG5 Bpass WF9 Bpass Wpass |  |
| 101 | go | cs | W+36.5 | 112 | BJ7 WG1 Bpass WJ6 Bpass Wpass |  |
| 102 | cs | go | W+12.5 | 86 | BA7 WA8 BF4 WE8 Bpass Wpass |  |
| 103 | go | cs | B+13.5 | 118 | BJ8 WG9 BC6 WJ9 Bpass Wpass |  |
| 104 | cs | go | W+26.5 | 124 | BH9 WD5 Bpass WG9 Bpass Wpass |  |
| 105 | go | cs | W+26.5 | 106 | Bpass WB3 Bpass WA5 Bpass Wpass |  |
| 106 | cs | go | B+9.5 | 126 | BH1 Wpass BJ7 WJ1 Bpass Wpass |  |
| 107 | go | cs | W+34.5 | 137 | WJ1 Bpass WB3 BH1 Wpass Bpass |  |
| 108 | cs | go | B+21.5 | 115 | Wpass BE9 WE8 BF8 Wpass Bpass |  |
| 109 | go | cs | B+5.5 | 125 | WC3 BD3 Wpass BB6 Wpass Bpass |  |
| 110 | cs | go | W+26.5 | 125 | WF5 BD2 WF7 BE1 Wpass Bpass |  |

## 引擎统计

| 引擎 | 胜 | 负 | 和 | 落子数 | 平均访问/手 | 平均估值 | 非法/错误 |
|---|---|---|---|---|---|---|---|
| JsWeiqi | 14 | 30 | 0 | 2281 | 13 | 0.648 | 0 |
| RustWeiqi | 12 | 32 | 0 | 2314 | 14 | 0.661 | 0 |
| CppWeiqi | 24 | 20 | 0 | 2223 | 14 | 0.649 | 0 |
| CsWeiqi | 28 | 16 | 0 | 2333 | 14 | 0.651 | 0 |
| GoWeiqi | 32 | 12 | 0 | 2343 | 14 | 0.623 | 0 |

## 走法分歧（同一局面下不同引擎的首手中盘选择）

- 样本：110 手（引擎 × 该手局面）
- 不同选点：62 个 → 选点分歧率 0.555（近似，供跨期对比）

| 引擎 | 选点 | 访问数 |
|---|---|---|
| js | E6 | 5 |
| rs | A2 | 7 |
| js | B4 | 4 |
| rs | J9 | 4 |
| js | G5 | 5 |
| rs | D7 | 5 |
| js | E9 | 4 |
| rs | H4 | 5 |
| js | B6 | 5 |
| rs | D2 | 5 |
| js | F2 | 5 |
| js | J7 | 3 |
| cpp | B8 | 6 |
| js | A3 | 4 |
| cpp | F8 | 4 |
| js | H6 | 4 |
| cpp | F1 | 6 |
| js | G7 | 4 |
| cpp | C4 | 6 |
| js | J6 | 6 |
| cpp | J3 | 5 |
| js | F5 | 5 |
| js | E5 | 4 |
| cs | H4 | 4 |
| js | H6 | 7 |
| cs | J8 | 4 |
| js | A7 | 5 |
| cs | E3 | 5 |
| js | B4 | 7 |
| cs | C3 | 4 |
| js | C5 | 4 |
| cs | E3 | 5 |
| js | A3 | 3 |
| js | B2 | 4 |
| go | D5 | 4 |
| js | H5 | 5 |
| go | J5 | 6 |
| js | J5 | 6 |
| go | J4 | 5 |
| js | B6 | 3 |
| go | G1 | 4 |
| js | A4 | 6 |
| go | H4 | 6 |
| js | J4 | 7 |
| rs | J2 | 4 |
| cpp | J4 | 6 |
| rs | G2 | 5 |
| cpp | B1 | 5 |
| rs | A3 | 3 |
| cpp | G4 | 5 |
| rs | H1 | 7 |
| cpp | F9 | 4 |
| rs | F4 | 8 |
| cpp | D4 | 7 |
| rs | A4 | 5 |
| rs | H7 | 5 |
| cs | H1 | 4 |
| rs | H4 | 4 |
| cs | C6 | 3 |
| rs | E4 | 5 |
| cs | G9 | 5 |
| rs | D8 | 4 |
| cs | D4 | 4 |
| rs | E3 | 3 |
| cs | B6 | 4 |
| rs | G9 | 5 |
| rs | F5 | 5 |
| go | E6 | 8 |
| rs | J9 | 4 |
| go | G7 | 6 |
| rs | D9 | 8 |
| go | G6 | 6 |
| rs | B4 | 6 |
| go | F1 | 4 |
| rs | A4 | 4 |
| go | F7 | 4 |
| rs | A5 | 6 |
| cpp | A5 | 6 |
| cs | F6 | 5 |
| cpp | H8 | 4 |
| cs | F7 | 5 |
| cpp | A3 | 3 |
| cs | C5 | 4 |
| cpp | C3 | 3 |
| cs | C1 | 3 |
| cpp | C6 | 5 |
| cs | B4 | 6 |
| cpp | G9 | 6 |
| cpp | A2 | 3 |
| go | J3 | 5 |
| cpp | C2 | 3 |
| go | J5 | 5 |
| cpp | B2 | 5 |
| go | H9 | 5 |
| cpp | F3 | 4 |
| go | F1 | 3 |
| cpp | D4 | 4 |
| go | H2 | 5 |
| cpp | F1 | 4 |
| cs | G6 | 4 |
| go | G6 | 6 |
| cs | H4 | 4 |
| go | A1 | 6 |
| cs | E2 | 5 |
| go | E8 | 4 |
| cs | C2 | 5 |
| go | G7 | 4 |
| cs | H2 | 6 |
| go | G6 | 4 |
| cs | F6 | 3 |

> 生成耗时 238.6s；由 `tournament/run_tournament.mjs` 自动生成。
