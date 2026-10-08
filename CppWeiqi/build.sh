#!/usr/bin/env bash
# build.sh -- one-shot build for CppWeiqi (MinGW-w64 g++, C++17, static, zero deps)
#
# Usage:
#   bash build.sh            # build cppweiqi.exe
#   CXX=/path/to/g++ bash build.sh
#   bash build.sh clean      # remove build artifacts
set -euo pipefail

cd "$(dirname "$0")"

CXX="${CXX:-/g/mingw64/bin/g++}"
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
