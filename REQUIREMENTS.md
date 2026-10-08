# Requirements（运行环境 / 依赖需求）

> 配套 `README.md`。本项目是**多语言**工程，**没有单一依赖清单**；按层级列出真实依赖。

## 1. 依赖总览

| 组件 | 依赖 | 说明 |
|---|---|---|
| 5 个语言引擎（Py/Js/Rust/C++/C#） | **零第三方依赖**（纯标准库） | 含 MCTS AI 全部自研 |
| `harness/` | Node ≥ 20（仅标准库，ESM） | **无 npm 依赖**，无需 `npm install` |
| `tournament/` | Node ≥ 20（仅标准库） | 含独立裁判引擎 |

## 2. 工具链（本机实测状态，2026-10-08）

| 需求 | 本机版本 | 状态 | 用途 |
|---|---|---|---|
| Python | 3.13.14 | ✅ 实测通过 | `PyWeiqi/` |
| Node.js | 22.22.2 | ✅ 实测通过 | `JsWeiqi/` + `harness/` + `tournament/` |
| Rust + Cargo | 1.98.0 | ✅ 离线构建实测通过 | `RustWeiqi/`（`cargo build --release`） |
| MinGW-w64 g++ | 15.2.0 | ✅ 静态链接实测通过 | `CppWeiqi/`（`g++ -O2 -static`） |
| .NET SDK | 10.0.401 | ✅ 离线构建实测通过 | `CsWeiqi/`（`dotnet build -c Release`） |
| ~~Go~~ | 1.27.1 | ❌ **工具链残缺**（`G:\go\src\fmt` 缺失，现场复现） | 修复后可作第 6 门语言 |
| ~~Java~~ | — | ❌ 未安装 JDK | — |

## 3. 构建（克隆/换机后）

```bash
# Python / JavaScript：无需构建
cd PyWeiqi  && python main.py test
cd JsWeiqi  && node main.mjs test

# Rust
cd RustWeiqi && cargo build --release          # target/release/rustweiqi.exe

# C++
cd CppWeiqi  && bash build.sh                  # cppweiqi.exe（g++ -O2 -static）

# C#
cd CsWeiqi   && dotnet build -c Release        # bin/Release/net10.0/CsWeiqi.dll
```

## 4. 验收门（改动后必须全绿）

```bash
# ① 各语言自测（黄金值全用例）
cd PyWeiqi && python main.py test          # 期望 0 failed
cd JsWeiqi && node main.mjs test
cd RustWeiqi && cargo run --release -- test
cd CppWeiqi && ./cppweiqi.exe test
cd CsWeiqi && dotnet run -c Release -- test

# ② 跨引擎黄金值一致性（5 引擎 + 独立裁判逐位比对）
cd harness && node host.mjs

# ③ 循环赛冒烟
cd tournament && node probe.mjs
TOURNAMENT_PLAYOUTS=200 GAMES_PER_PAIR=1 node run_tournament.mjs
```

## 5. 构建产物不入库

`target/ bin/ obj/ *.exe *.o __pycache__` 均在 `.gitignore`；克隆后按 §3 重建。
