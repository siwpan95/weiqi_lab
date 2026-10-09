# CGTC 式回归 — 过手（盘上唯一空点即本方真眼 → 无候选手 → pass）
#
# 构造：全盘本方棋子，仅留一个内点空位，其四邻皆本方子 → 该点是真眼，
# 被 AI 的眼位过滤排除；本方又无其它合法着法 → genmove 必过手。

# 1) 9 路：全黑仅留 E5 → 黑方过手
loadsgf ./pass9_b.sgf 1
1 reg_genmove black
#? [pass]

# 2) 13 路：全黑仅留 G7 → 黑方过手
loadsgf ./pass13_b.sgf 1
2 reg_genmove black
#? [pass]
