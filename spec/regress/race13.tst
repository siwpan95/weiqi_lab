# CGTC 式回归 — 13 路对杀（唯一合法着法，检验更大盘径与坐标翻转）

# 1) 纵向对杀：黑先，唯一着 G7
loadsgf ./race13_v.sgf 1
1 reg_genmove black
#? [G7]

# 2) 同局面，白先，唯一着 G7
loadsgf ./race13_v_w.sgf 1
2 reg_genmove white
#? [G7]

# 3) 纵向对杀 + 黑方一个真眼（H7）——候选仍唯一 = G7
loadsgf ./race13_v_eye.sgf 1
3 reg_genmove black
#? [G7]
