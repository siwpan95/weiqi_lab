# CGTC 式回归 — 11 路对杀（唯一合法着法）

# 1) 纵向对杀：黑先，唯一着 F6
loadsgf ./race11_v.sgf 1
1 reg_genmove black
#? [F6]

# 2) 同局面，白先，唯一着 F6
loadsgf ./race11_v_w.sgf 1
2 reg_genmove white
#? [F6]

# 3) 纵向对杀 + 黑方一个真眼（F7 一侧的 G7）——候选仍唯一 = F6
loadsgf ./race11_v_eye.sgf 1
3 reg_genmove black
#? [F6]
