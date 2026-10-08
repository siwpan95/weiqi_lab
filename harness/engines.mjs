// harness/engines.mjs — 五语言引擎清单（harness 与 tournament 共用）
//
// 预算说明：`playouts` 为循环赛每手固定模拟次数预算，按各语言实测速度折算
// 至「约 1 秒/手」的等效算力（Gomill 建议的固定算力口径；本机 9 路实测见 README）。

import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const PY = process.env.WEIQI_PYTHON || "python";
const NODE = process.execPath;

export const ENGINES = [
  {
    key: "py", name: "PyWeiqi", lang: "py",
    cmd: PY, args: ["main.py", "driver"], cwd: path.join(ROOT, "PyWeiqi"),
    playouts: 200,
  },
  {
    key: "js", name: "JsWeiqi", lang: "js",
    cmd: NODE, args: ["driver.mjs"], cwd: path.join(ROOT, "JsWeiqi"),
    playouts: 800,
  },
  {
    key: "rs", name: "RustWeiqi", lang: "rs",
    cmd: path.join(ROOT, "RustWeiqi", "target", "release", "rustweiqi.exe"), args: ["driver"],
    cwd: path.join(ROOT, "RustWeiqi"),
    playouts: 8000,
  },
  {
    key: "cpp", name: "CppWeiqi", lang: "cpp",
    cmd: path.join(ROOT, "CppWeiqi", "cppweiqi.exe"), args: ["driver"],
    cwd: path.join(ROOT, "CppWeiqi"),
    playouts: 12000,
  },
  {
    key: "cs", name: "CsWeiqi", lang: "cs",
    cmd: "dotnet", args: [path.join("bin", "Release", "net10.0", "CsWeiqi.dll"), "driver"],
    cwd: path.join(ROOT, "CsWeiqi"),
    playouts: 8000,
  },
];

/** 只保留可执行文件存在 / 命令可在 PATH 上的引擎（探针制，不出假结果） */
export function availableEngines() {
  const filter = (process.env.WEIQI_ENGINES || "").split(",").map((s) => s.trim()).filter(Boolean);
  return ENGINES.filter((e) => {
    if (filter.length && !filter.includes(e.key)) return false;
    if (e.cmd.includes(path.sep) || /^[A-Za-z]:/.test(e.cmd)) return fs.existsSync(e.cmd);
    return true; // PATH 上的命令（python/dotnet/node）
  });
}
