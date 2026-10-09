// tools/sgf.mjs — SGF FF[4] 子集读写（零依赖）
//
// 定位：weiqi_lab 的**共享 I/O 层**。规则内核在 6 个语言里各自实现，SGF 只此一份。
// 用途：sgf 文本 <-> 游戏树 <-> JSON-stdio 命令序列（供 GTP 适配器 loadsgf 使用）。
//
// ── 坐标约定（关键，容易出错）─────────────────────────────────────────────
//   SGF  : 两个小写字母 [列][行]，列 a 在最左（x 向右增），行 a 在最上（y 向下增）。
//   引擎/GTP: "<列字母><行号>"，列 A→T（跳过 I，x 向右增），行号 1 在**下**（y 向上增）。
//   故 y 需翻转：y_engine = size - 1 - y_sgf  （x 不变，两边都是从左到右）。
//   例：19 路 SGF "dd" = D16（左上星）；GTP "A1" = SGF "as"。
//
// ── pass 约定 ────────────────────────────────────────────────────────────
//   SGF FF[4] 用**空值** B[] / W[] 表示过手；FF[3] 遗留写法用 B[tt]/W[tt]
//   （仅在 <=19 路时合法，tt 已越界）。两者都映射为命令 vertex="pass"。
//
// ── 变体处理 ─────────────────────────────────────────────────────────────
//   变体 ( ... ) 会被完整解析（不报错），但 toCommands/主线提取只保留**主线**
//   （SGF 语义：每个分支的第一个子序列即主线）。
//
// 编码：UTF-8 无 BOM，LF。

// ───────────────────────── 坐标转换 ─────────────────────────

/** 列字母（跳 I），共 19 个，x 从 0 起 */
export const COLS = "ABCDEFGHJKLMNOPQRST";

/** SGF 点串 "dd" → 顶点串 "D16"；"" 或越界 → "pass" */
export function sgfToVertex(value, size) {
  if (value === null || value === undefined) return "pass";
  const v = String(value);
  if (v.length === 0) return "pass";
  // 遗留 pass 写法：tt（19 路时列/行均为 t，已越界）
  if (v === "tt" && size <= 19) return "pass";
  if (v.length < 2) return "pass";
  const x = v.charCodeAt(0) - 97; // 'a'
  const y = v.charCodeAt(1) - 97;
  if (x < 0 || y < 0) throw new Error(`illegal SGF point: ${JSON.stringify(v)}`);
  // 越界点（如小盘上的 tt、ee）按 pass 处理
  if (x >= size || y >= size) return "pass";
  const yEngine = size - 1 - y; // ★ y 翻转：SGF 自上而下 → 引擎自下而上
  return COLS[x] + String(yEngine + 1);
}

/** 顶点串 "D16" → SGF 点串 "dd"；"pass"/-1 → "" */
export function vertexToSgf(vertex, size) {
  if (vertex === null || vertex === undefined) return "";
  const t = String(vertex).trim().toUpperCase();
  if (t === "PASS" || t === "") return "";
  const col = COLS.indexOf(t[0]);
  if (col < 0 || col >= size) throw new Error(`illegal vertex: ${vertex}`);
  const row = parseInt(t.slice(1), 10);
  if (!Number.isFinite(row) || row < 1 || row > size) throw new Error(`illegal vertex: ${vertex}`);
  const yEngine = row - 1;
  const ySgf = size - 1 - yEngine; // 逆翻转
  return String.fromCharCode(97 + col) + String.fromCharCode(97 + ySgf);
}

// ───────────────────────── 值类型（空白折叠规则）─────────────────────────

// SGF 的 Text 类型属性（保留换行）；其余按 SimpleText 折叠。
const TEXT_PROPS = new Set(["C", "GC"]);

/** 处理 SGF 值里的 `\` 转义（先于空白折叠）：
 *  - `\` + 换行 → 删除换行（软换行，不产出字符）
 *  - `\X` → 字面 X（含 `\]`、`\\`、`\:`）
 */
function unescapeValue(raw) {
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === "\\") {
      const nx = raw[i + 1];
      if (nx === undefined) break; // 末尾孤立反斜杠：丢弃
      if (nx === "\n") { i++; continue; }
      if (nx === "\r") { i++; if (raw[i + 1] === "\n") i++; continue; }
      out += nx;
      i++;
    } else {
      out += c;
    }
  }
  return out;
}

/** 空白折叠：Text 保留换行、其余空白归一为空格并去首尾；SimpleText 全部归一为空格。 */
function foldWhitespace(s, isText) {
  let out = "";
  const ws = /\s/;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (ws.test(c)) {
      if (isText && c === "\n") out += "\n";
      else if (out.length && out[out.length - 1] !== " ") out += " ";
      // 前导空白：跳过
    } else {
      out += c;
    }
  }
  return out.replace(/ $/, "");
}

/** 序列化时转义：`\` → `\\`，`]` → `\]` */
function escapeValue(s) {
  return String(s).replace(/\\/g, "\\\\").replace(/\]/g, "\\]");
}

// ───────────────────────── 解析 ─────────────────────────

function isUpperLetter(ch) {
  return ch >= "A" && ch <= "Z";
}

/**
 * parseSgf(text) → 游戏树
 *   {
 *     root:  { <IDENT>: [value, ...] },           // 根节点属性（保序）
 *     nodes: [ { props: {B|W:[v], ...}, color, value } ],   // 主线着法节点
 *     stats: { nodes, variations }
 *   }
 * 变体被解析后丢弃（只保留主线）。
 */
export function parseSgf(text) {
  const s = String(text);
  let i = 0;
  const n = s.length;
  let variations = 0;

  function skipWs() {
    while (i < n && /\s/.test(s[i])) i++;
  }

  function parseValueList() {
    // 读取紧随属性的一个或多个 [ ... ]
    const vals = [];
    for (;;) {
      skipWs(); // SGF 严格来说属性值的空白也需跳过
      if (i >= n || s[i] !== "[") break;
      i++; // consume '['
      let raw = "";
      while (i < n && s[i] !== "]") {
        if (s[i] === "\\") {
          // 保留转义给 unescapeValue，但需要避免把 `\]` 当成结束
          raw += s[i];
          i++;
          if (i < n) { raw += s[i]; i++; }
        } else {
          raw += s[i];
          i++;
        }
      }
      if (i < n && s[i] === "]") i++; // consume ']'
      vals.push(raw);
    }
    return vals;
  }

  function parseProperty(node) {
    const start = i;
    while (i < n && isUpperLetter(s[i])) i++;
    const ident = s.slice(start, i);
    if (!ident) return;
    const rawVals = parseValueList();
    const isText = TEXT_PROPS.has(ident);
    const vals = rawVals.map((r) => foldWhitespace(unescapeValue(r), isText));
    if (node[ident]) node[ident] = node[ident].concat(vals);
    else node[ident] = vals;
  }

  function parseTree() {
    if (s[i] !== "(") throw new Error(`SGF: expected '(' at ${i}`);
    i++; // consume '('
    const seq = []; // 本层的节点序列
    const children = []; // 本层各分叉的子树
    let cur = null;
    while (i < n) {
      skipWs();
      const ch = s[i];
      if (ch === ";") {
        i++;
        cur = {};
        seq.push(cur);
      } else if (ch === "(") {
        if (cur === null) {
          // 形如 ( ( ... ) )：无节点直接分叉，按子树处理
          children.push(parseTree());
        } else {
          children.push(parseTree());
        }
      } else if (ch === ")") {
        i++;
        break;
      } else if (isUpperLetter(ch)) {
        if (cur === null) { cur = {}; seq.push(cur); }
        parseProperty(cur);
      } else {
        // 未知字符（如小写属性名/杂符）：跳过，保证健壮
        i++;
      }
    }
    return { seq, children };
  }

  skipWs();
  if (i >= n || s[i] !== "(") throw new Error("SGF: 未找到根节点 '(...)'");
  const tree = parseTree();
  skipWs();

  // 主线 = 本层序列 ++ 第一个子分支的主线
  const line = [];
  (function flatten(t) {
    if (!t) return;
    for (const nd of t.seq) line.push(nd);
    if (t.children.length) {
      variations += t.children.length;
      flatten(t.children[0]);
      // 统计其余分叉里的变体数
      for (let k = 1; k < t.children.length; k++) countVariations(t.children[k]);
    }
  })(tree);

  function countVariations(t) {
    for (const c of t.children) { variations++; countVariations(c); }
  }

  if (line.length === 0) throw new Error("SGF: 空游戏树");

  const root = line.shift();
  const nodes = line.map((nd) => {
    let color = null;
    let value = null;
    if (Object.prototype.hasOwnProperty.call(nd, "B")) { color = "B"; value = nd.B[0] ?? ""; }
    else if (Object.prototype.hasOwnProperty.call(nd, "W")) { color = "W"; value = nd.W[0] ?? ""; }
    return { props: nd, color, value };
  });

  return { root, nodes, stats: { nodes: 1 + nodes.length, variations } };
}

// ───────────────────────── 序列化 ─────────────────────────

function dumpProps(props) {
  let out = "";
  for (const key of Object.keys(props)) {
    out += key;
    for (const v of props[key]) out += "[" + escapeValue(v) + "]";
  }
  return out;
}

/** serializeSgf(tree) → SGF 文本（FF[4]，可被 Sabaki/q5Go 打开） */
export function serializeSgf(tree) {
  const rootProps = { ...tree.root };
  if (!rootProps.GM) rootProps.GM = ["1"];
  if (!rootProps.FF) rootProps.FF = ["4"];
  let out = "(;" + dumpProps(rootProps);
  for (const nd of tree.nodes) {
    if (nd.color === "B" || nd.color === "W") {
      // 规范化：过手写空值
      out += ";" + nd.color + "[" + escapeValue(nd.value || "") + "]";
    } else {
      out += ";" + dumpProps(nd.props);
    }
  }
  out += ")";
  return out;
}

// ───────────────────────── 映射到 JSON-stdio 命令 ─────────────────────────

function parseSize(root) {
  const raw = root.SZ ? String(root.SZ[0] ?? "19") : "19";
  if (raw.includes(":")) {
    const [a, b] = raw.split(":").map((t) => parseInt(t, 10));
    if (a !== b) throw new Error(`SGF: 不支持长方形棋盘 SZ[${raw}]`);
    return a;
  }
  return parseInt(raw, 10);
}

function mapRules(root) {
  const ru = root.RU ? String(root.RU[0] ?? "").toLowerCase() : "";
  if (!ru) return "cn";
  if (ru.includes("jap") || ru.includes("jp")) return "jp";
  if (ru.includes("tromp")) return "tt";
  return "cn";
}

/**
 * toCommands(tree, opts?) → JSON-stdio 命令数组
 *   [{cmd:"clear",size,komi,rules}, {cmd:"set_stones",stones,side}, {cmd:"play",color,vertex} ...]
 * opts.rules 可覆盖 SGF RU[]；opts.upTo 只回放到第 N 手（loadsgf 的 move number）。
 */
export function toCommands(tree, opts = {}) {
  const root = tree.root;
  const size = parseSize(root);
  const rules = opts.rules || mapRules(root);

  const komiRaw = root.KM ? root.KM[0] : undefined;
  const komi = komiRaw === undefined || komiRaw === "" ? undefined : Number(komiRaw);

  const ha = root.HA ? parseInt(root.HA[0], 10) : 0;

  // 轮次：PL 优先；否则 HA>=2 → 白先，否则黑先（SGF FF[4] 约定）
  let pl = root.PL ? String(root.PL[0]).toUpperCase().slice(0, 1) : (ha >= 2 ? "W" : "B");
  if (pl !== "B" && pl !== "W") pl = ha >= 2 ? "W" : "B";

  // 摆子：AB 黑 / AW 白，AE 移除（在 set_stones 模型下即"不放入"）
  const ae = new Set();
  for (const p of root.AE || []) {
    const v = sgfToVertex(p, size);
    if (v !== "pass") ae.add(v);
  }
  const stones = [];
  for (const p of root.AB || []) {
    const v = sgfToVertex(p, size);
    if (v !== "pass" && !ae.has(v)) stones.push(["B", v]);
  }
  for (const p of root.AW || []) {
    const v = sgfToVertex(p, size);
    if (v !== "pass" && !ae.has(v)) stones.push(["W", v]);
  }

  const cmds = [];
  const clear = { cmd: "clear", size, rules };
  if (komi !== undefined && Number.isFinite(komi)) clear.komi = komi;
  cmds.push(clear);

  // 有摆子，或轮次非黑（如让子局白先）时才需要 set_stones
  if (stones.length > 0 || pl !== "B") {
    cmds.push({ cmd: "set_stones", stones, side: pl });
  }

  const limit = opts.upTo === undefined ? tree.nodes.length : Math.max(0, opts.upTo);
  let played = 0;
  for (const nd of tree.nodes) {
    if (played >= limit) break;
    if (nd.color !== "B" && nd.color !== "W") continue;
    cmds.push({ cmd: "play", color: nd.color, vertex: sgfToVertex(nd.value, size) });
    played++;
  }
  return cmds;
}

/** 便捷：从文本直接得到命令序列 */
export function sgfToCommands(text, opts = {}) {
  return toCommands(parseSgf(text), opts);
}

export default { parseSgf, serializeSgf, toCommands, sgfToCommands, sgfToVertex, vertexToSgf, COLS };
