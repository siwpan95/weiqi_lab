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

# --- 工具链解析（PATH 优先，回退本机安装路径）---------------------------------
# 旧 MANAGED_ROOT 指向另一台机器（用户 psw）的受管安装；本机实际情况：
#   - Go 安装在 D:\Go\go（go1.22.5，全局 GOROOT 环境变量为空，无冲突）
#   - 受管安装位于 C:\Users\13122\.workbuddy\binaries\go\versions\1.27.1\go
# 仍可用环境变量覆盖：WEIQI_GO 指定 go 可执行文件，WEIQI_GOROOT 指定 GOROOT。
MANAGED_ROOT="C:/Users/13122/.workbuddy/binaries/go/versions/1.27.1/go"
LOCAL_ROOT="D:/Go/go"
GO_BIN="${WEIQI_GO:-}"
GOROOT_VAL="${WEIQI_GOROOT:-}"

if [ -z "$GO_BIN" ]; then
  if command -v go >/dev/null 2>&1; then
    GO_BIN="go"
  elif [ -x "$LOCAL_ROOT/bin/go.exe" ]; then
    GO_BIN="$LOCAL_ROOT/bin/go.exe"
    [ -z "$GOROOT_VAL" ] && GOROOT_VAL="$LOCAL_ROOT"
  elif [ -x "$MANAGED_ROOT/bin/go.exe" ]; then
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
