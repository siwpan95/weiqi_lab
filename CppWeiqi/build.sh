#!/usr/bin/env bash
# build.sh -- one-shot build for CppWeiqi (MinGW-w64 g++, C++17, static, zero deps)
#
# Usage:
#   bash build.sh            # build cppweiqi.exe
#   CXX=/path/to/g++ bash build.sh
#   bash build.sh clean      # remove build artifacts
set -euo pipefail

cd "$(dirname "$0")"

# --- 工具链解析（默认取 PATH 上的 g++；缺失时回退本机安装路径）-------------
# 旧默认 /g/mingw64/bin/g++ 指向已移除的 G: 盘；本机 MinGW-w64 实测在 E: 盘。
# 仍可用环境变量 CXX 覆盖（例如 CXX=/e/mingw64/bin/g++.exe bash build.sh）。
CXX_DEFAULT="g++"
if ! command -v "$CXX_DEFAULT" >/dev/null 2>&1; then
  if [ -x "/e/mingw64/bin/g++.exe" ]; then
    CXX_DEFAULT="/e/mingw64/bin/g++.exe"
  fi
fi
CXX="${CXX:-$CXX_DEFAULT}"
CXXFLAGS="${CXXFLAGS:--std=c++17 -O2 -static -Wall -Wextra}"
SRCS="weiqi_rules.cpp weiqi_ai.cpp golden.cpp driver.cpp tests.cpp main.cpp"
OUT="cppweiqi.exe"

if [ "${1:-}" = "clean" ]; then
    rm -f "$OUT" *.o
    echo "cleaned"
    exit 0
fi

echo "building $OUT with $CXX $CXXFLAGS"
# shellcheck disable=SC2086
"$CXX" $CXXFLAGS -o "$OUT" $SRCS
echo "ok -> $OUT"
