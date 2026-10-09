#!/usr/bin/env bash
# tournament/run_ab100.sh — 开局方案 A/B（4 组 × ≥100 局，9 路，5 引擎）
#
# 组：random（随机）/ markov（计数表）/ cnndistill（CNN 蒸馏表）/ cnnjs（CNN 纯 JS 前向）
# 引擎排除 py（解释型，~130 playouts/s 会主导总时长）；每组 10 对 × 11 局 = 110 局。
#
# 用法：bash run_ab100.sh [random|markov|cnndistill|cnnjs|all]

set -u
cd "$(dirname "$0")"

GROUP="${1:-all}"
COMMON_SIZE=9
COMMON_PAIRS=11
COMMON_PLAYOUTS=80
COMMON_PLIES=4
COMMON_FILTER=js,rs,cpp,cs,go

run_one() {
  local tag="$1"; shift
  echo "=== 组 $tag ==="
  TOURNAMENT_SIZE=$COMMON_SIZE GAMES_PER_PAIR=$COMMON_PAIRS TOURNAMENT_PLAYOUTS=$COMMON_PLAYOUTS \
  OPENING_PLIES=$COMMON_PLIES ENGINES_FILTER=$COMMON_FILTER REPORT_SUFFIX="-ab100-$tag" \
  "$@" node run_tournament.mjs
}

if [ "$GROUP" = "all" ] || [ "$GROUP" = "random" ]; then
  run_one random env
fi
if [ "$GROUP" = "all" ] || [ "$GROUP" = "markov" ]; then
  run_one markov env OPENINGS=markov
fi
if [ "$GROUP" = "all" ] || [ "$GROUP" = "cnndistill" ]; then
  run_one cnndistill env OPENINGS=markov MARKOV_MODEL=../spec/markov_model-cnn9.json
fi
if [ "$GROUP" = "all" ] || [ "$GROUP" = "cnnjs" ]; then
  run_one cnnjs env OPENINGS=cnn
fi

echo "=== 统计 ==="
node ab_stat.mjs
