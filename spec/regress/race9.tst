# CGTC 式回归 — 9 路对杀（唯一合法着法）
#
# 局面构造说明：先手方在两块对杀中只有「一处」可下（那口气），
# 且该点同时是提净对方的唯一着法 → 期望集为单点。
# 这类局面刻意让候选点收敛为 1，以规避 MCTS 根节点选择的随机性/分辨力问题
# （见报告「规范歧义与取舍」）。

# 1) 纵向对杀：黑先，唯一着 E5（提净白全块）
loadsgf ./race9_v.sgf 1
1 reg_genmove black
#? [E5]

# 2) 同局面，白先，唯一着 E5（提净黑全块）
loadsgf ./race9_v_w.sgf 1
2 reg_genmove white
#? [E5]

# 3) 纵向对杀 + 黑方一个真眼（B5）——候选仍唯一 = E5
loadsgf ./race9_v_eye.sgf 1
3 reg_genmove black
#? [E5]

# 4) 纵向对杀 + 黑白各一个真眼（B5/G5）——候选仍唯一 = E5
loadsgf ./race9_v_2eye.sgf 1
4 reg_genmove black
#? [E5]
