# Requirements（运行环境 / 依赖需求）

> 配套 `README.md`。本项目是**多语言**工程，**没有单一依赖清单**；按层级列出真实依赖。

## 1. 依赖总览

| 组件 | 依赖 | 说明 |
|---|---|---|
| 6 个语言引擎（Py/Js/Rust/C++/C#/Go） | **零第三方依赖**（纯标准库） | 含 MCTS AI 全部自研 |
| `harness/` | Node ≥ 20（仅标准库，ESM） | **无 npm 依赖**，无需 `npm install` |
| `tournament/` | Node ≥ 20（仅标准库） | 含独立裁判引擎 |
| `tools/`（SGF / GTP / 让子 / Markov） | Node ≥ 20（仅标准库） | 共享 I/O 层 + 学习组件 |

## 2. 工具链（本机实测状态，2026-10-09）

| 需求 | 本机版本 / 路径 | 状态 | 用途 |
|---|---|---|---|
| Python | 3.14.7（`G:\Python314`，PATH 上的 `python`） | ✅ | `PyWeiqi/`（亦可用托管 3.13.12，注意其标准库完整性） |
| Node.js | 22.22.2 | ✅ | `JsWeiqi/` + `harness/` + `tournament/` + `tools/` |
| Rust + Cargo | 1.98.0 | ✅ | `RustWeiqi/`（`cargo build --release`） |
| MinGW-w64 g++ | 15.2.0（`G:\mingw64`） | ✅ | `CppWeiqi/`（`bash build.sh`，`-O2 -static`） |
| .NET SDK | 10.0.401 | ✅ | `CsWeiqi/`（`dotnet build -c Release`） |
| **Go** | 1.27.1 —— **受管安装** `C:\Users\psw\.workbuddy\binaries\go\versions\1.27.1\go\bin\go.exe` | ✅（见下方说明） | `GoWeiqi/`（`bash build.sh`） |
| Git | 2.55.0.windows.2（`G:\Git\cmd\git.exe`） | ✅ | 版本控制 |

> **Go 工具链说明**：系统 `G:\go`（PATH 上的 `go`，GOROOT=`G:\go`）的**标准库源残缺**
> （`src` 仅 8 项，缺 `fmt` 等）→ 直接 `go build` 会报 `package fmt is not in std`。
> 已修复方式：从阿里镜像下载完整发行包解压到受管目录（**未改动 `G:\go`**），
> `GoWeiqi/build.sh` 内**显式设置 `GOROOT`** 指向受管路径。若要让 PATH 上的 `go` 也恢复，
> 需另行清理全局 `GOROOT` 环境变量（属环境变更，未擅自执行）。

## 3. 构建（克隆/换机后）

```bash
# 解释型：无需构建
cd PyWeiqi   && python main.py test
cd JsWeiqi   && node main.mjs test

# 编译型
cd RustWeiqi && cargo build --release          # target/release/rustweiqi.exe
cd CppWeiqi  && bash build.sh                  # cppweiqi.exe
cd CsWeiqi   && dotnet build -c Release        # bin/Release/net10.0/CsWeiqi.dll
cd GoWeiqi   && bash build.sh                  # goweiqi.exe（脚本内设 GOROOT）
```

## 4. 验收门（改动后必须全绿）

```bash
# ① 各语言自测（黄金值 35 用例 + 内部单测）
cd PyWeiqi   && python main.py test
cd JsWeiqi   && node main.mjs test
cd GoWeiqi   && ./goweiqi.exe test
cd RustWeiqi && cargo run --release -- test
cd CppWeiqi  && ./cppweiqi.exe test
cd CsWeiqi   && dotnet run -c Release -- test

# ② 跨引擎黄金值一致性（6 引擎 + 独立裁判）
cd harness && node host.mjs                    # 期望 ALL GREEN

# ③ 共享 I/O 层（SGF / GTP / 让子）
cd tools && node tests_io.mjs                  # 期望 PASS: 165 passed, 0 failed
cd tools && node regress.mjs                   # CGTC 式回归：6 引擎 72/72

# ④ 循环赛冒烟
cd tournament && node probe.mjs
TOURNAMENT_PLAYOUTS=60 GAMES_PER_PAIR=1 node run_tournament.mjs

# ⑤ 学习组件（Markov）
cd tools && MARKOV_GAMES=40 MARKOV_PLAYOUTS=200 node train_markov.mjs
```

## 5. 构建产物不入库

`target/ bin/ obj/ *.exe *.o __pycache__` 均在 `.gitignore`；克隆后按 §3 重建。
`spec/games/` 的语料与 `spec/markov_model.json` **入库**（可重训、可复现）。
