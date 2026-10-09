#!/usr/bin/env bash
# build.sh — 构建 GoWeiqi（零第三方依赖）
#
# 本机现状：`go`（GOROOT=G:\go）是一处残缺工具链（G:\go\src 只有 8 项，缺 fmt 等标准库）；
# 且全局环境变量 GOROOT=G:\go 会覆盖新 go.exe 的自带 GOROOT 探测。
# 故本脚本优先使用受管的完整发行包，并显式把 GOROOT 指向它：
#   WEIQI_GO    覆盖 go 可执行文件路径
#   WEIQI_GOROOT 覆盖 GOROOT
set -euo pipefail
cd "$(dirname "$0")"

MANAGED_ROOT="C:/Users/psw/.workbuddy/binaries/go/versions/1.27.1/go"
GO_BIN="${WEIQI_GO:-}"
GOROOT_VAL="${WEIQI_GOROOT:-}"

if [ -z "$GO_BIN" ]; then
  if [ -x "$MANAGED_ROOT/bin/go.exe" ]; then
    GO_BIN="$MANAGED_ROOT/bin/go.exe"
    [ -z "$GOROOT_VAL" ] && GOROOT_VAL="$MANAGED_ROOT"
  else
    GO_BIN="go"
  fi
fi

echo "using go: $GO_BIN"
if [ -n "$GOROOT_VAL" ]; then
  echo "using GOROOT: $GOROOT_VAL"
  GOROOT="$GOROOT_VAL" "$GO_BIN" build -o goweiqi.exe .
else
  "$GO_BIN" build -o goweiqi.exe .
fi
