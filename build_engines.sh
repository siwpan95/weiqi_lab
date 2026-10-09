#!/usr/bin/env bash
# =============================================================================
# build_engines.sh — 重建 tournament/ 所需的「编译型」引擎产物
# -----------------------------------------------------------------------------
# 背景：本仓库的二进制产物（*.exe / *.dll）被 .gitignore 忽略，不会入库。
#       克隆到新机后，运行本脚本即可重建它们，使 6 引擎全部可跑。
#
# 本脚本只构建 tournament/engines.mjs 实际消费的产物：
#   Rust  RustWeiqi/target/release/rustweiqi.exe        (cargo build --release)
#   C++   CppWeiqi/cppweiqi.exe                          (MinGW-w64 g++，静态链接)
#   C#    CsWeiqi/bin/Release/net10.0/CsWeiqi.dll        (dotnet build -c Release)
#   Go    GoWeiqi/goweiqi.exe                            (go build，GOTOOLCHAIN=local)
#
# 纯解释型引擎无需本脚本：PyWeiqi / JsWeiqi 由驱动直接解释运行。
#
# 用法：
#   ./build_engines.sh            # 构建全部（缺某工具链时仅告警跳过）
#   ./build_engines.sh --verify   # 构建后额外跑 tournament/probe.mjs
#
# 环境变量（均可覆盖；**默认一律取 PATH，不写死本机安装路径**）：
#   LAB_ROOT   仓库根（默认=本脚本所在目录）
#   CARGO      Rust 工具链（默认 PATH 上的 cargo）
#   CXX        C++ 编译器（默认 PATH 上的 g++；缺省时回退 E:\mingw64\bin\g++.exe）
#   DOTNET     dotnet 可执行文件（默认 PATH 上的 dotnet）
#   WEIQI_GO   Go 可执行文件（默认交给 GoWeiqi/build.sh 自探测，含本地 1.27 回退）
#   WEIQI_GOROOT  Go GOROOT（同上）
# =============================================================================
set -u

LAB_ROOT="$(cd "$(dirname "$0")" && pwd)"
VERIFY=0
for a in "$@"; do [ "$a" = "--verify" ] && VERIFY=1; done

# --- 解析工具链（默认取 PATH；不写死本机绝对路径） ---------------------------
CARGO="${CARGO:-cargo}"
if command -v "$CARGO" >/dev/null 2>&1; then
  CARGO="$(command -v "$CARGO")"; HAVE_CARGO=1
else HAVE_CARGO=0; fi

CXX_DEFAULT="g++"
if ! command -v "$CXX_DEFAULT" >/dev/null 2>&1; then
  if [ -x "/e/mingw64/bin/g++.exe" ]; then CXX_DEFAULT="/e/mingw64/bin/g++.exe"; fi
fi
CXX="${CXX:-$CXX_DEFAULT}"
if command -v "$CXX" >/dev/null 2>&1 || [ -x "$CXX" ]; then HAVE_CXX=1; else HAVE_CXX=0; fi

if [ -z "${DOTNET:-}" ]; then DOTNET="$(command -v dotnet || true)"; fi

echo "LAB_ROOT = $LAB_ROOT"
echo "CARGO    = ${CARGO:-<none>} (${HAVE_CARGO})"
echo "CXX      = ${CXX:-<none>} (${HAVE_CXX})"
echo "DOTNET   = ${DOTNET:-<none>}"
echo "----------------------------------------------------------------------"

rc=0

# --- Rust : cargo build --release --------------------------------------------
if [ "$HAVE_CARGO" = "1" ]; then
  echo "[rust] cargo build --release (RustWeiqi) ..."
  ( cd "$LAB_ROOT/RustWeiqi" && "$CARGO" build --release ) \
    && echo "[rust] OK -> RustWeiqi/target/release/rustweiqi.exe" \
    || { echo "[rust] BUILD FAILED"; rc=1; }
else
  echo "[rust] SKIP: 未找到 cargo。安装 Rust + Cargo 并加入 PATH，或设置 CARGO=/path/cargo。"
fi

# --- C++ : 委托 CppWeiqi/build.sh（自带 CXX 探测/回退） ----------------------
if [ "$HAVE_CXX" = "1" ]; then
  echo "[cpp] bash CppWeiqi/build.sh ..."
  ( cd "$LAB_ROOT/CppWeiqi" && bash build.sh ) \
    && echo "[cpp] OK -> CppWeiqi/cppweiqi.exe" \
    || { echo "[cpp] BUILD FAILED"; rc=1; }
else
  echo "[cpp] SKIP: 未找到 C++ 编译器。安装 MinGW-w64 g++ 并加入 PATH，"
  echo "       或设置 CXX=/path/to/g++.exe 后重跑。"
fi

# --- C# : dotnet build -c Release --------------------------------------------
if [ -n "$DOTNET" ]; then
  echo "[cs] dotnet build -c Release (CsWeiqi) ..."
  ( cd "$LAB_ROOT/CsWeiqi" && "$DOTNET" build -c Release -v quiet ) \
    && echo "[cs] OK -> CsWeiqi/bin/Release/net10.0/CsWeiqi.dll" \
    || { echo "[cs] BUILD FAILED"; rc=1; }
else
  echo "[cs] SKIP: 未找到 dotnet。安装 .NET 10 SDK 并设置 DOTNET=/path/dotnet.exe。"
fi

# --- Go : 委托 GoWeiqi/build.sh（自探测本地 1.27 + GOTOOLCHAIN=local） --------
echo "[go] bash GoWeiqi/build.sh ..."
( cd "$LAB_ROOT/GoWeiqi" && bash build.sh ) \
  && echo "[go] OK -> GoWeiqi/goweiqi.exe" \
  || { echo "[go] BUILD FAILED"; rc=1; }

echo "----------------------------------------------------------------------"
if [ "$rc" = "0" ]; then echo "BUILD DONE (all attempted targets succeeded)";
else echo "BUILD DONE WITH ERRORS (rc=$rc)"; fi

# --- 可选：构建后探测 -------------------------------------------------------
if [ "$VERIFY" = "1" ]; then
  NODE="$(command -v node || true)"
  if [ -n "$NODE" ] && [ -f "$LAB_ROOT/tournament/probe.mjs" ]; then
    echo "[verify] running tournament/probe.mjs ..."
    ( cd "$LAB_ROOT/tournament" && "$NODE" probe.mjs )
  else
    echo "[verify] SKIP: node 或 tournament/probe.mjs 不可用。"
  fi
fi

exit $rc
