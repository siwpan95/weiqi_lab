#!/usr/bin/env bash
# build.sh — 构建 GoWeiqi（零第三方依赖）
#
# 本机现状：系统 PATH 上没有 go；Go 1.27 装在 D:\Go\go127（受管/本地安装），
# go.mod 声明 `go 1.27`。本脚本通过 **GOTOOLCHAIN=local** 把工具链锁定到本地这份，
# 既不触发联网下载，也满足 go.mod 的 1.27 要求（toolchain 覆盖方式）。
#
# 覆盖优先级：WEIQI_GO 指定 go 可执行文件 > PATH 上的 go > 本机 D:\Go\go127 > 受管安装
# 也可用 WEIQI_GOROOT 显式指定 GOROOT。
set -euo pipefail
cd "$(dirname "$0")"

# 候选 Go 工具链（按优先级，第一个存在者胜出）：
#   WEIQI_GO 指定 > PATH 上的 go > D:/Go/go127（本机本地）>
#   受管安装（本机 13122 1.27.0 / 原仓库机 psw 1.27.1）
# 也可用 WEIQI_GOROOT 显式指定 GOROOT。
GO_BIN="${WEIQI_GO:-}"
GOROOT_VAL="${WEIQI_GOROOT:-}"

if [ -z "$GO_BIN" ]; then
  CANDIDATES=(
    "go"
    "D:/Go/go127/bin/go.exe"
    "C:/Users/13122/.workbuddy/binaries/go/versions/1.27.0/go/bin/go.exe"
    "C:/Users/psw/.workbuddy/binaries/go/versions/1.27.1/go/bin/go.exe"
  )
  for c in "${CANDIDATES[@]}"; do
    if [ -x "$c" ]; then GO_BIN="$c"; break; fi
  done
  [ -z "$GO_BIN" ] && GO_BIN="go"
  # 显式路径（非 PATH go）时，自动推导 GOROOT（取 bin/ 的上一级）
  if [ -z "$GOROOT_VAL" ] && [ "$GO_BIN" != "go" ]; then
    GOROOT_VAL="$(dirname "$(dirname "$GO_BIN")")"
  fi
fi

# toolchain 覆盖：锁定本地工具链，禁止联网下载（离线/可移植）
export GOTOOLCHAIN="${GOTOOLCHAIN:-local}"

echo "using go: $GO_BIN"
if [ -n "$GOROOT_VAL" ]; then
  echo "using GOROOT: $GOROOT_VAL"
  GOROOT="$GOROOT_VAL" "$GO_BIN" build -o goweiqi.exe .
else
  "$GO_BIN" build -o goweiqi.exe .
fi
