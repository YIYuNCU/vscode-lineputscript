#!/usr/bin/env node
/*
 * TS 解析器 vs C# LinePutScript 差分（differential / fuzz）测试工具。
 *
 * 用法（在项目根目录 vscode-lineputscript 下，纯 Node CommonJS，无新依赖）：
 *   node test/tools/diff-fuzz.js [选项]
 *
 * 选项：
 *   --seed <n>        随机种子（默认 20240601，固定即可复现）
 *   --count <n>       每个随机类别生成的用例数（默认 300）
 *   --file <path>     额外把一个真实 .lps 文件作为用例（可重复），
 *                     例如 --file "G:\SteamLibrary\steamapps\common\VPet\Saves\Save_147785.lps"
 *   --report <path>   报告输出路径（默认 <系统临时目录>/lps-fuzz-report.txt）
 *   --samples <n>     每个差异类别给出的最小复现样例数（默认 3）
 *   --max-rounds <n>  最小化（delta debugging）最大轮数（默认 40）
 *   --no-minimize     不做样例最小化（直接取最短的失败用例）
 *   --skip-build      跳过 dotnet build（已构建过时）
 *   --skip-tsc        跳过 tsc 编译，复用 <tmp>/lps-fuzz-out
 *   --ts-out <dir>    直接使用已编译好的目录（需含 src/lps/{parser,escape,formatter}.js），隐含 --skip-tsc；
 *                     用于对比旧版/其它版本的 TS 实现
 *   -h, --help        显示本说明
 *
 * 流程：
 *   1. 用 node_modules/typescript/bin/tsc 把 TS 编译到 <tmp>/lps-fuzz-out（CommonJS），require 其中的
 *      src/lps/{parser,escape,formatter}。
 *   2. 生成确定性随机文档 + 穷举小字母表文档，一次性写入 <tmp>/lps-fuzz-cases.json，
 *      调用 `dotnet run --no-build --project test/LinePutScriptConsistency -- --dump-many <cases.json>`
 *      取得 C# 结果（需要先 dotnet build 一次，本脚本默认会做）。
 *   3. 逐字段比较：行数、每行 name/info/text/comments/subs、decoded 值、formatLpsDocument 与 C# ToString()、
 *      decodeLpsTextLikeCSharp 与 TextDeReplace（decodeLpsText 与「把换行还原为 /n 的 TextDeReplace」）、encodeLpsText 与 TextReplace、normalizedText。
 *   4. 检查 TS 的 range/nameRange/separatorRange/infoRange/textRange/commentRange（及 sub 的）是否指向「原始输入文本」
 *      中的正确位置（CRLF 输入同样校验）。续行（:\n| / :\n:）或行内含孤立 \r 的逻辑行，其原文范围本来就包含换行/CR，
 *      只校验整行 range 并单独归入 info 类别，不计为错误。
 *   5. 对每个差异类别做 delta 最小化，输出按类别归并的报告（每类 3 个最小复现：输入 JSON 字符串、TS 结果、C# 结果）。
 *
 * range 约定（期望值，相对原始输入的 UTF-16 下标，半开区间）：
 *   line.range         = 逻辑行（去掉行尾换行与 \r，含 /// 注释）在原文中的范围
 *   nameRange          = 首段 '#' 之前；separatorRange = '#'；infoRange = '#' 之后到该段结束（无 '#' 时二者均为 undefined）
 *   textRange          = 最后一段（无 ':|' 时与首段相同，对应 C# text = sts.Last()）
 *   commentRange       = 自 '///' 起到行尾（无注释时 undefined）
 *   sub.range/nameRange/separatorRange/infoRange 同理，针对各自的 ':|' 分段。
 *
 * 退出码：有 error 级差异为 1，否则 0（info 级差异不影响退出码）。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');

// ───────────────────────────── 参数 ─────────────────────────────

function parseArgs(argv) {
  const o = {
    seed: 20240601,
    count: 300,
    files: [],
    report: path.join(os.tmpdir(), 'lps-fuzz-report.txt'),
    samples: 3,
    maxRounds: 40,
    minimize: true,
    skipBuild: false,
    skipTsc: false,
    tsOut: null,
    help: false
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const need = () => {
      if (i + 1 >= argv.length) throw new Error(`参数 ${a} 缺少值`);
      return argv[++i];
    };
    switch (a) {
      case '--seed': o.seed = Number(need()) >>> 0; break;
      case '--count': o.count = Math.max(1, Number(need()) | 0); break;
      case '--file': o.files.push(need()); break;
      case '--report': o.report = need(); break;
      case '--samples': o.samples = Math.max(1, Number(need()) | 0); break;
      case '--max-rounds': o.maxRounds = Math.max(0, Number(need()) | 0); break;
      case '--no-minimize': o.minimize = false; break;
      case '--skip-build': o.skipBuild = true; break;
      case '--skip-tsc': o.skipTsc = true; break;
      case '--ts-out': o.tsOut = path.resolve(need()); o.skipTsc = true; break;
      case '-h': case '--help': o.help = true; break;
      default: throw new Error(`未知参数 ${a}`);
    }
  }
  return o;
}

// ───────────────────────────── 随机数 ─────────────────────────────

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeRng(seed) {
  const next = mulberry32(seed);
  return {
    next,
    int: (n) => Math.floor(next() * n),
    range: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    chance: (p) => next() < p
  };
}

// ───────────────────────────── 用例生成 ─────────────────────────────

const EOLS = ['\n', '\r\n', '\r'];
const WORDS = ['a', 'b', 'c', 'name', 'x1', 'Pet', '中文', '😀', 'é', '日本語', 'abc def', ' ', '  ', '\t', '1', '3.14'];
const ESC = ['/n', '/r', '/tab', '/id', '/com', '/!', '/|', '/stop', '/equ', '/null', '/name', '/!n', '//n', '/!!/!|',
  '/nn', '/ro', '/tabs', '/idx', '/come', '/stopx', '/equal', '/', '//', '/!/', '/|/|', '/N', '/ n', '/t', '/s', '/=', '/,', '/#'];
const PLAIN_SPECIAL = ['|', ',', '=', '\t', '#', '\r', '\n', ':', '/', '///', ':|'];

function soup(R, toks, min, max) {
  const n = R.range(min, max);
  let s = '';
  for (let i = 0; i < n; i++) s += R.pick(toks);
  return s;
}

function joinWith(R, parts, seps) {
  let s = '';
  for (let i = 0; i < parts.length; i++) {
    if (i > 0) s += R.pick(seps);
    s += parts[i];
  }
  return s;
}

const GEN = {};
const HAND = {};

HAND['eol'] = [
  '', '\n', '\r\n', '\r', 'a:|b', 'a:|b\n', 'a:|b\r\n', 'a:|b\r', 'a:|b\n\n', 'a:|b\r\n\r\n', 'a:|b\r\r\n', 'a:|b\n\r',
  'a:|b\nc:|d', 'a:|b\r\nc:|d', 'a:|b\rc:|d', 'a:|b\r\nc:|d\r\n', '\r\na:|b', '\na:|b', '\ra:|b', 'a\r:|b', 'a:\r|b', 'a:|\rb',
  'a:|b\r\n\r\nc:|d', 'a:|b\n\n\nc:|d', '\r\n\r\na:|b\r\n\r\n', 'a#i\r\n:|b', 'a:|b\r\nc:|d\re:|f\ng:|h'
];
GEN['eol'] = (R) => {
  const pool = ['a:|b', 'x#1:|y#2:|z', ':|', 'k#v:|', 'n:|t', 'a:|b///c', '///c', 'abc', 'pet#名字:|age#3:|文本'];
  const n = R.range(1, 5);
  const lines = [];
  for (let i = 0; i < n; i++) lines.push(R.pick(pool));
  const lead = R.pick(['', '', '\n', '\r\n', '\r', '\n\n', '\r\n\r\n', '\n\r']);
  const trail = R.pick(['', '', '\n', '\r\n', '\r', '\n\n', '\r\n\r\n', '\n\r']);
  return lead + joinWith(R, lines, [...EOLS, '\n\n', '\r\n\r\n', '\r\r\n']) + trail;
};

HAND['cont'] = [
  ':\n|', ':\n:', 'a:\n|b', 'a:|b:\n|c', 'a:|b:\n:c', ':\n:\n|', '::\n|', ':\n||', ':\n:\n:', ':\n|\n|', ':\n|:\n|',
  'a:\n:\n|b:|c', 'a:|\n|b', 'a:|b:\n|\nc:|d', 'a:|:\n|', 'a::\n|b', 'a:|b:\n:\n|c', 'a:|b:\n::\nc', 'a:|b:\n|:|c',
  'a:|b:\r\n|c', 'a:|b:\r\n:c', 'a:|b:\r\n:\r\n|c', 'a:|b:\n\r|c', 'a:|b:\r|c', ':\n:\n:\n|', 'a\n:\n|b', 'a:\n\n|b',
  'a:|b\n|c', 'a:|b\n:c', 'a:|b:\n|c:\n|d', 'a:|b:\n:c:\n:d', 'a:|b:\n|c:\n:d', 'a:|b:\n:c:\n|d', 'a:|b::\n|:|c', 'a:|b:\n|||c',
  'a:|b:\n::|c', 'a:|b:\n:|c', 'a:|b:\n|///c', 'a:|b///c:\n|d', 'a:|b///c:\n:d', 'a#i:\n|j:|t', 'a#i:\n:j:|t', 'a:|s#x:\n|y:|t',
  ':\n|a:|b', ':\n:a:|b', 'a:|b:\n|', 'a:|b:\n:', 'a:|b:\n', 'a:|b\n:', 'a:|b\n|'
];
const CONT_TOK = ['a', 'b', 'x#1', ':|', '\n', '\r\n', ':', '|', ':\n|', ':\n:', ':\n', '\n|', '\n:', '#', '///', ' ', '\r', '::\n|', ':\n||'];
GEN['cont'] = (R) => soup(R, CONT_TOK, 2, 10);

HAND['comment'] = [
  '///', '////', '/////', '///c', ' ///c', 'a///c', 'a:|///c', 'a:|b///c', 'a#i:|b///c', 'a:|b////', 'a:|b///c///d', '///:|', '///a\n///b',
  'a///:|b', 'a#///x:|', 'a:|///', 'a:|b///\n', '//', '/ //', 'a:|b//', 'a:|b/// c', 'a:|b ///c', 'a:|b/c//', ':|///c', ':|:|///c',
  'a:|s#x///y:|t', 'a:|s#x:|t///y', '///c\r\n///d', 'a:|b///c\r\nd:|e', 'a:|b///c:\n|d', 'a:|b///c:\n:d', 'a///b:|c'
];
GEN['comment'] = (R) => {
  const left = ['', 'a', 'a:|', 'a#i:|s:|t', ' ', 'a:|s#x:|', 'n#1:|'];
  const mid = ['///', '////', '/// ', '///c', '//', '/', '/// :| x', '///#', '/n///', '/!///'];
  const right = ['', 'c', ':|x', '///d', '\n', '\r\n', '\n///', ':\n|c', ':\n:///c', '////', ' '];
  const n = R.range(1, 3);
  const lines = [];
  for (let i = 0; i < n; i++) lines.push(R.pick(left) + R.pick(mid) + R.pick(right));
  return joinWith(R, lines, EOLS);
};

HAND['emptyname'] = [
  ':|', ':|:|', '#x:|y', '#:|', ':|a', 'a:|:|', '#:|#:|', ':|:|:|', '#:|#:|#:|', ':|#x:|', ':|a:|b', '#', '##', '#x', ':|#', ':|#:|',
  '#:|a:|b', 'a:|#x:|b', 'a:|#:|', 'a:|b#:|c', ':|b:|', ':|:|b', '#a#b:|', 'a:|#a#b:|c'
];
GEN['emptyname'] = (R) => {
  const segs = ['', '#', '#x', 'a', 'a#', 'a#b', '#:', ' '];
  const n = R.range(1, 5);
  const parts = [];
  for (let i = 0; i < n; i++) parts.push(R.pick(segs));
  return parts.join(':|') + R.pick(['', '', ':|', 'text', '///c']);
};

HAND['nosep'] = [
  'abc', 'abc#def', 'a\nb\nc', 'a:b', 'a|b', 'a:', 'a|', ':', '|', '#', '##', 'a#b#c', ' ', '/n', '///c', 'a///c', 'abc\r\ndef',
  'a#b///c', 'a:\n|b', 'a:\n:b', '中文', '😀', 'abc:', ':abc', '|abc|'
];
GEN['nosep'] = (R) => {
  const pool = ['abc', 'abc#def', 'a:b', 'a|b', 'a:', 'a|', ':', '|', '#', '##', 'a#b#c', '', ' ', '/n', '///c', '中文', 'x:|y'];
  const n = R.range(1, 5);
  const lines = [];
  for (let i = 0; i < n; i++) lines.push(R.pick(pool));
  return joinWith(R, lines, EOLS);
};

HAND['onlysep'] = [
  ':|', ':|:|', ':|:|:|', ':|\n:|', ':|\r\n:|', ':|:|\n:|:|', ':| ', ' :|', ' :| ', ':|///c', ':|:|///c', ':|\n\n:|', ':|\r:|'
];
GEN['onlysep'] = (R) => soup(R, [':|', ':|', ':|:|', '\n', '\r\n', ' ', '///c', ':', '|'], 1, 8);

HAND['hash'] = [
  '#', '##', '###', 'a#b#c:|d#e#f:|g#h', 'a##b:|', '#a:|b', 'a#:|', 'a#b:|c#:|d', '#:|#:|#', 'a#b#c', 'a:|#b#c:|d', 'a:|b#c#d:|e#f',
  'a#b:|c#d:|e#f', 'a#b///c#d', 'a#b:|c///d#e', '##:|##:|##'
];
GEN['hash'] = (R) => {
  const word = () => R.pick(['a', 'b', 'x', '1', '', '中', '/id', '/n']);
  const seg = () => {
    let s = word();
    const k = R.range(0, 3);
    for (let i = 0; i < k; i++) s += '#' + word();
    return s;
  };
  const n = R.range(1, 5);
  const parts = [];
  for (let i = 0; i < n; i++) parts.push(seg());
  return parts.join(':|') + R.pick(['', ':|', 'text', 'te#xt', '///c#d']);
};

HAND['escape'] = [
  'a#/n:|/n', 'a#/r:|/r', 'a#/tab:|/tab', 'a#/id:|/id', 'a#/com:|/com', 'a#/!:|/!', 'a#/|:|/|', 'a#/stop:|/stop', 'a#/equ:|/equ',
  'a#/null:|/null', 'a#/name:|/name', 'a#/!n:|/!n', 'a#//n:|//n', 'a#/!!/!|:|/!!/!|', 'a#/nn:|/nn', 'a#/stop:|', 'a#/stopx/n:|',
  'a#/idx/com/tab:|', '/n', '/r', '/tab', '/id', '/com', '/!', '/|', '/stop', '/equ', '/null', '/name', '/!n', '//n', '/!!/!|', '/', '//',
  '/!/!', '/|/|', '/n/n', '/nu/ll', '/tabtab', '/st/op', '/stop:|', ':/|', ':/stop|', '/:|', '/ /n', '/\t', '//tab', '///n', '/!!n',
  '/!|', '/|!', '/n:|/n', 'a#b,c:|d#e,f', 'a#b=c', 'a#b|c:|', 'a#b\tc:|', 'k#\\n:|\\t', 'a#/equ/equ:|/equ'
];
GEN['escape'] = (R) => {
  const frag = () => {
    const n = R.range(0, 4);
    let s = '';
    for (let i = 0; i < n; i++) {
      const k = R.int(10);
      s += k < 5 ? R.pick(ESC) : k < 7 ? R.pick(WORDS) : R.pick(PLAIN_SPECIAL.filter((x) => x !== '\n' && x !== '\r' && x !== ':|' && x !== '///' && x !== '#'));
    }
    return s;
  };
  const nLines = R.range(1, 3);
  const lines = [];
  for (let l = 0; l < nLines; l++) {
    let s = R.pick(['a', 'b', frag()]);
    if (R.chance(0.7)) s += '#' + frag();
    s += ':|';
    const nSubs = R.range(0, 2);
    for (let i = 0; i < nSubs; i++) s += R.pick(['s', 'k', frag()]) + (R.chance(0.7) ? '#' + frag() : '') + ':|';
    s += frag();
    lines.push(s);
  }
  return joinWith(R, lines, ['\n', '\r\n']);
};

HAND['sepcombo'] = [
  ':|:|', ':::|', '|:|', '::||', ':|:', '|:|:|', 'a::|b', 'a:|:b', '::|', ':::', '|||', ':|||', '||:|', ':||:|', 'a|:|b', 'a:||b', 'a::|:|b',
  'a:|:|:|b', 'a:|::|b', 'a:|b:|:|c', ':|:|:|:|', 'a#::|b', 'a#|:|b', 'a#:|:|b', '#:|:|', '::|::|', ':|:::|'
];
GEN['sepcombo'] = (R) => soup(R, [':|', ':', '|', 'a', '#', ':|:|', ':::|', '|:|', '::||', 'b', ' '], 1, 8);

HAND['blank'] = [
  '\n\na:|b', 'a:|b\n\n', '\n\na:|b\n\n', '\n\n\n', '\r\n\r\n', ' ', '  \n  ', 'a:|b\n \nc:|d', 'a:|b\n\t\nc:|d', 'a:|b\n\n\n\nc:|d', '\n \n',
  '\ta:|b', 'a:|b\n\n///c\n\n', '\n:|\n', '\n\n:|\n\n', ' \na:|b', 'a:|b\n ', '\r\n \r\n'
];
GEN['blank'] = (R) => {
  const pool = ['a:|b', '', '', ' ', '\t', '   ', ':|', '///c', 'k#v:|t'];
  const n = R.range(1, 7);
  const lines = [];
  for (let i = 0; i < n; i++) lines.push(R.pick(pool));
  return joinWith(R, lines, [...EOLS, '\n', '\n']);
};

HAND['spaces'] = [
  ' a : | b ', 'a :| b', ' a#b :| c#d :| e ', 'a:| ', ' :|', ' :| ', 'a# :| ', 'a #b:|', ' ///c', 'a: |b', 'a :|b :|c', 'a\t:|b', 'a:|\tb',
  'a:|b ///c', 'a:|b/// c ', '  a#  b  :|  c  '
];
GEN['spaces'] = (R) => soup(R, [' ', '  ', 'a', '#', ':|', ' :| ', '\t', '///', ' ///', 'b', '\n', ' \n '], 1, 10);

HAND['unicode'] = [
  '中文:|文本', '名字#值:|子#子值:|文本///注释', '😀:|😀', '😀#😀:|😀#😀:|😀///😀', 'a#😀:|', '👨\u200d👩\u200d👧:|x', 'e\u0301:|e\u0301', '：|', 'a：|b', '｜', 'a:｜b',
  '＃', 'a＃b:|', '\uFEFFa:|b', 'a:|b\uFEFF', '\u0000', 'a\u0000:|b', 'a:|\u0000', 'a\u2028b:|c', 'a:|b\u0085c', 'a\u00a0:|b', '\u2029a:|b',
  '日本語#テキスト:|カタカナ///コメント', 'a:|b\uD83D\uDE00///\uD83D\uDE00', '😀\n😀:|\n:|😀', ':\n|😀', ':\n:😀'
];
GEN['unicode'] = (R) => soup(R, ['中', '文', '😀', '👨\u200d👩\u200d👧', 'é', 'e\u0301', '：|', '｜', '＃', '\uFEFF', '\u0000', '\u2028', '\u0085', '\u00a0',
  '日本語', ':|', '#', '\n', '///', '/n', 'a', '\r\n', ':\n|'], 1, 10);

const MIXED_TOK = [...CONT_TOK, ':|', '#', '///', '/n', '/r', '/tab', '/id', '/com', '/!', '/|', '/stop', '/equ', '/null', '/name', '/!n', '//n',
  '/!!/!|', '中文', '😀', ' ', '\t', ',', '=', '/', '\n', '\r\n', '\r', '\n\n', ':|:|', ':::|', '|:|'];
HAND['mixed'] = [];
GEN['mixed'] = (R) => soup(R, MIXED_TOK, 3, 25);

HAND['realistic'] = [
  'pet#小猫:|age#3:|name#Tom,Jerry:|desc/ntext///备注', 'food#苹果:|price#12.5:|count#3:|\nfood#香蕉:|price#8:|count#1:|',
  'vpet#Name:|gold#100:|exp#12/com34:|\n:|///comment line\nsave#1:|time#2024-01-01 12:00:00:|',
  'multi#line:|text:\n|second line:\n|third line\nnext#x:|y',
  'multi#line:|text:\n:soft wrap\nnext#x:|y', 'a#b:|c#d:|e\r\nf#g:|h#i:|j\r\n'
];
GEN['realistic'] = (R) => {
  const names = ['pet', 'food', 'vpet', 'save', 'item', '名字', 'gold'];
  const fields = ['age', 'price', 'count', 'exp', 'time', 'name', 'desc'];
  const n = R.range(1, 4);
  const lines = [];
  for (let i = 0; i < n; i++) {
    let s = R.pick(names);
    if (R.chance(0.7)) s += '#' + R.pick(WORDS).trim() + (R.chance(0.3) ? R.pick(ESC) : '');
    s += ':|';
    const k = R.range(0, 3);
    for (let j = 0; j < k; j++) s += R.pick(fields) + (R.chance(0.8) ? '#' + R.pick(['1', '12.5', 'a/comb', '中文', '2024-01-01 12:00:00', '/id1']) : '') + ':|';
    if (R.chance(0.5)) s += R.pick(['text', 'a/nb', '', '1', '中文/n文本']);
    if (R.chance(0.3)) s += '///' + R.pick(['c', '注释', ' x ', '/n']);
    lines.push(s);
    if (R.chance(0.15)) lines.push(R.pick([':|///only comment', '///only comment', '']));
  }
  let text = joinWith(R, lines, ['\n', '\n', '\r\n']);
  if (R.chance(0.2)) text += R.pick(['\n', '\r\n']);
  return text;
};

function* allStrings(alphabet, maxLen) {
  let layer = [''];
  for (let len = 1; len <= maxLen; len++) {
    const next = [];
    for (const p of layer) for (const c of alphabet) next.push(p + c);
    for (const s of next) yield s;
    layer = next;
  }
}

function generateCases(opts) {
  const cases = [];
  const seen = new Set();
  const add = (cat, text) => {
    if (seen.has(text)) return;
    seen.add(text);
    cases.push({ cat, text });
  };

  // 手写样例
  for (const cat of Object.keys(HAND)) for (const t of HAND[cat]) add(cat, t);

  // 穷举：{':','|','\n'} 长度≤5，原样 / 前后加字符 / CRLF 版本
  for (const s of allStrings([':', '|', '\n'], 5)) {
    add('cont-exhaustive', s);
    add('cont-exhaustive', 'x' + s + 'y');
    add('cont-exhaustive-crlf', ('a:|' + s + 'b').replace(/\n/g, '\r\n'));
  }
  // 穷举：{':','|','a','#'} 长度≤5
  for (const s of allStrings([':', '|', 'a', '#'], 5)) add('sep-exhaustive', s);
  // 穷举：{'/',':','|','a','\n'} 长度≤4（覆盖 ///、////、:|/// 等）
  for (const s of allStrings(['/', ':', '|', 'a', '\n'], 4)) add('slash-exhaustive', s);

  // 随机
  const R = makeRng(opts.seed);
  for (const cat of Object.keys(GEN)) {
    const g = GEN[cat];
    let made = 0;
    let guard = 0;
    while (made < opts.count && guard++ < opts.count * 20) {
      const before = cases.length;
      add(cat, g(R));
      if (cases.length > before) made++;
    }
  }

  // 真实文件
  for (const f of opts.files) {
    let text = fs.readFileSync(f, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1); // 与 File.ReadAllText 一致
    add('file', text);
    cases[cases.length - 1].file = f;
  }
  return cases;
}

// ───────────────────────────── C# 交互 ─────────────────────────────

const csCache = new Map();
let csCalls = 0;

function runDotnet(args, opts) {
  return cp.execFileSync('dotnet', args, Object.assign({ cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 30, stdio: ['ignore', 'pipe', 'inherit'] }, opts));
}

function csRunChunk(texts) {
  const file = path.join(os.tmpdir(), 'lps-fuzz-cases.json');
  fs.writeFileSync(file, JSON.stringify(texts), 'utf8');
  const out = runDotnet(['run', '--no-build', '--project', 'test/LinePutScriptConsistency', '--', '--dump-many', file]);
  csCalls++;
  const start = out.indexOf('[');
  const arr = JSON.parse(out.slice(start));
  if (arr.length !== texts.length) throw new Error(`C# 返回 ${arr.length} 项，期望 ${texts.length}`);
  return arr;
}

function ensureCs(texts) {
  const need = [...new Set(texts)].filter((t) => !csCache.has(t));
  const CHUNK = 6000;
  for (let i = 0; i < need.length; i += CHUNK) {
    const part = need.slice(i, i + CHUNK);
    const res = csRunChunk(part);
    for (let k = 0; k < part.length; k++) csCache.set(part[k], res[k]);
  }
}

// ───────────────────────────── C# 预处理的 JS 复刻（含到原文的偏移映射）─────────────────────────────
// 仅用作 range 校验的「期望值」来源；其结果（行数）会与 C# 实际输出交叉校验。

function replicaLoad(orig) {
  let cur = { ch: [], os: [], oe: [] };
  for (let i = 0; i < orig.length; i++) {
    if (orig[i] === '\r') continue;
    cur.ch.push(orig[i]); cur.os.push(i); cur.oe.push(i + 1);
  }
  const pass = (src, pat, rep) => {
    const out = { ch: [], os: [], oe: [] };
    const n = src.ch.length;
    for (let i = 0; i < n;) {
      let m = i + pat.length <= n;
      for (let k = 0; m && k < pat.length; k++) if (src.ch[i + k] !== pat[k]) m = false;
      if (m) {
        const s = src.os[i];
        const e = src.oe[i + pat.length - 1];
        for (const c of rep) { out.ch.push(c); out.os.push(s); out.oe.push(e); }
        i += pat.length;
      } else {
        out.ch.push(src.ch[i]); out.os.push(src.os[i]); out.oe.push(src.oe[i]);
        i++;
      }
    }
    return out;
  };
  cur = pass(cur, ':\n|', '/n');
  cur = pass(cur, ':\n:', '');
  let lo = 0;
  let hi = cur.ch.length;
  while (lo < hi && cur.ch[lo] === '\n') lo++;
  while (hi > lo && cur.ch[hi - 1] === '\n') hi--;
  const normalized = cur.ch.slice(lo, hi).join('');
  const lines = [];
  let st = lo;
  for (let i = lo; i <= hi; i++) {
    if (i === hi || cur.ch[i] === '\n') {
      if (i > st) lines.push({ text: cur.ch.slice(st, i).join(''), start: cur.os[st], end: cur.oe[i - 1] });
      st = i + 1;
    }
  }
  return { normalized, lines };
}

function expectedRanges(t) {
  const ci = t.indexOf('///');
  const wc = ci < 0 ? t : t.slice(0, ci);
  const segs = [];
  let s = 0;
  for (;;) {
    const k = wc.indexOf(':|', s);
    if (k < 0) { segs.push([s, wc.length]); break; }
    segs.push([s, k]);
    s = k + 2;
  }
  const entry = (seg) => {
    const v = wc.slice(seg[0], seg[1]);
    const h = v.indexOf('#');
    const nameEnd = h < 0 ? seg[1] : seg[0] + h;
    return {
      range: [seg[0], seg[1]],
      name: [seg[0], nameEnd],
      sep: h < 0 ? null : [nameEnd, nameEnd + 1],
      info: h < 0 ? null : [nameEnd + 1, seg[1]]
    };
  };
  const line = entry(segs[0]);
  line.range = [0, t.length];
  line.text = segs[segs.length - 1];
  line.comment = ci < 0 ? null : [ci, t.length];
  return { line, subs: segs.slice(1, -1).map(entry) };
}

// ───────────────────────────── 比较 ─────────────────────────────

function loadTsModules(outDir) {
  const req = (rel) => require(path.join(outDir, 'src', 'lps', rel));
  const parser = req('parser.js');
  const escape = req('escape.js');
  const formatter = req('formatter.js');
  for (const [mod, names] of [[parser, ['parseLpsDocument']], [escape, ['decodeLpsText', 'decodeLpsTextLikeCSharp', 'encodeLpsText']], [formatter, ['formatLpsDocument']]]) {
    for (const n of names) if (typeof mod[n] !== 'function') throw new Error(`编译产物缺少导出函数 ${n}`);
  }
  return { parseLpsDocument: parser.parseLpsDocument, decodeLpsText: escape.decodeLpsText, decodeLpsTextLikeCSharp: escape.decodeLpsTextLikeCSharp, encodeLpsText: escape.encodeLpsText, formatLpsDocument: formatter.formatLpsDocument };
}

const J = (v) => JSON.stringify(v);

function briefLine(name, info, subs, text, comments) {
  return `${name}${info ? '#' + info : ''}:|${subs.map((s) => `${s.name}${s.info ? '#' + s.info : ''}:|`).join('')}${text}${comments ? '///' + comments : ''}`;
}

function describeRange(text, r) {
  if (!r) return 'undefined';
  return `[${r.start},${r.end}) ${J(text.slice(r.start, r.end))}`;
}

function evaluate(text, cs, mods) {
  const out = new Map();
  const add = (kind, detail, severity) => {
    if (!out.has(kind)) out.set(kind, Object.assign({ severity: severity || 'error' }, detail));
  };
  if (cs.error) { add('cs.error', { ts: null, cs: cs.error }); return out; }

  // 转义函数（对整段输入）
  try {
    const d = mods.decodeLpsTextLikeCSharp(text);
    if (d !== cs.deReplace) add('escape.decode', { ts: J(d), cs: J(cs.deReplace) });
    // 扩展实际使用的解码器不把 /n 解成换行：C# 结果里的换行只可能来自 /n（输入文本本身不含换行时）
    if (!text.includes('\n')) {
      const kept = mods.decodeLpsText(text);
      const expected = cs.deReplace.split('\n').join('/n');
      if (kept !== expected) add('escape.decode.keep-n', { ts: J(kept), cs: J(expected) });
    }
  } catch (e) { add('ts.throw', { where: 'decodeLpsText', ts: String(e && e.stack || e), cs: '(no throw)' }); }
  try {
    const d = mods.encodeLpsText(text);
    if (d !== cs.replace) add('escape.encode', { ts: J(d), cs: J(cs.replace) });
  } catch (e) { add('ts.throw', { where: 'encodeLpsText', ts: String(e && e.stack || e), cs: '(no throw)' }); }

  let doc;
  try { doc = mods.parseLpsDocument(text); } catch (e) {
    add('ts.throw', { where: 'parseLpsDocument', ts: String(e && e.stack || e), cs: '(no throw)' });
    return out;
  }

  const rep = replicaLoad(text);
  if (rep.lines.length !== cs.lines.length) {
    add('oracle.mismatch', { where: 'JS 复刻的 Load 预处理行数 ≠ C# 实际行数（工具自身问题）', ts: rep.lines.length, cs: cs.lines.length }, 'internal');
  }
  if (typeof doc.normalizedText === 'string' && doc.normalizedText !== rep.normalized) {
    add('normalizedText', { ts: J(doc.normalizedText), cs: J(rep.normalized) });
  }

  // 行 / sub 逐字段
  const tl = doc.lines;
  const cl = cs.lines;
  if (tl.length !== cl.length) {
    add('parse.lines.count', {
      ts: J(tl.map((l) => briefLine(l.name, l.info, l.subs, l.text, l.comments))),
      cs: J(cl.map((l) => briefLine(l.name, l.info, l.subs, l.text, l.comments)))
    });
  } else {
    for (let i = 0; i < tl.length; i++) {
      const T = tl[i];
      const C = cl[i];
      const cmp = (kind, where, a, b) => { if (a !== b) add(kind, { where, ts: J(a), cs: J(b) }); };
      const keepN = (value) => value.split('\n').join('/n');
      const w = `line ${i}`;
      cmp('parse.line.name', w, T.name, C.name);
      cmp('parse.line.info', w, T.info, C.info);
      cmp('parse.line.decodedInfo', w, T.decodedInfo, keepN(C.decodedInfo));
      cmp('parse.line.text', w, T.text, C.text);
      cmp('parse.line.decodedText', w, T.decodedText, keepN(C.decodedText));
      cmp('parse.line.comments', w, T.comments, C.comments);
      if (T.subs.length !== C.subs.length) {
        add('parse.sub.count', {
          where: w,
          ts: J(T.subs.map((s) => `${s.name}${s.info ? '#' + s.info : ''}`)),
          cs: J(C.subs.map((s) => `${s.name}${s.info ? '#' + s.info : ''}`))
        });
      } else {
        for (let j = 0; j < T.subs.length; j++) {
          const ws = `line ${i} sub ${j}`;
          cmp('parse.sub.name', ws, T.subs[j].name, C.subs[j].name);
          cmp('parse.sub.info', ws, T.subs[j].info, C.subs[j].info);
          cmp('parse.sub.decodedInfo', ws, T.subs[j].decodedInfo, keepN(C.subs[j].decodedInfo));
        }
      }
    }
  }

  // 格式化
  try {
    const f = mods.formatLpsDocument(doc);
    if (f !== cs.toString) {
      // C# 每个逻辑行的 ToString 都不含换行，故可逐行对齐比较；
      // 无 ":|" 的非注释行 C# 会输出 "name:|<text>"（text 与整行相同，内容被复制），TS 刻意保持原样 → 单独归为 info。
      const csLines = cs.toString.split('\n');
      let reported = false;
      if (tl.length === cl.length && csLines.length === cl.length && rep.lines.length === tl.length) {
        for (let i = 0; i < tl.length; i++) {
          const tf = mods.formatLpsDocument(Object.assign({}, doc, { lines: [tl[i]] }));
          if (tf === csLines[i]) continue;
          const lt = rep.lines[i].text;
          const ci = lt.indexOf('///');
          const wc = ci < 0 ? lt : lt.slice(0, ci);
          // 仅当解析结果与 C# 一致时才视为「有意偏差」；解析本身有误导致的格式差异仍为 error
          const T = tl[i];
          const C = cl[i];
          const sameParse = T.name === C.name && T.info === C.info && T.text === C.text && T.comments === C.comments && T.subs.length === C.subs.length;
          const noSep = sameParse && wc.length > 0 && !wc.includes(':|');
          add(noSep ? 'format.line.no-separator' : 'format.line', { where: `line ${i}`, ts: J(tf), cs: J(csLines[i]) }, noSep ? 'info' : 'error');
          reported = true;
        }
      }
      if (!reported) add('format.document', { ts: J(f), cs: J(cs.toString) });
    }
  } catch (e) { add('ts.throw', { where: 'formatLpsDocument', ts: String(e && e.stack || e), cs: '(no throw)' }); }

  // range 校验
  checkRanges(text, doc, rep, add);
  return out;
}

function checkRanges(text, doc, rep, add) {
  if (doc.lines.length !== rep.lines.length) return; // 行数不一致由 parse.lines.count 报告
  const tag = text.includes('\r') ? 'CR' : 'LF';
  for (let i = 0; i < doc.lines.length; i++) {
    const L = doc.lines[i];
    const R = rep.lines[i];
    const tainted = text.slice(R.start, R.end) !== R.text; // 续行 / 行内含 \r：原文范围含换行或 CR
    if (tainted) {
      const lr = L.range;
      if (!lr || lr.start !== R.start || lr.end !== R.end) {
        add(`range.continuation.line [${tag}]`, {
          where: `line ${i}（续行/行内 CR，仅校验整行 range）`,
          ts: describeRange(text, lr),
          cs: describeRange(text, { start: R.start, end: R.end }),
          csLabel: '期望'
        }, 'info');
      }
      continue;
    }
    const exp = expectedRanges(R.text);
    const base = R.start;
    const abs = (p) => (p ? { start: p[0] + base, end: p[1] + base } : undefined);
    const chk = (field, where, tsR, expP) => {
      const e = abs(expP);
      const same = (!tsR && !e) || (tsR && e && tsR.start === e.start && tsR.end === e.end);
      if (same) return;
      add(`range.${field} [${tag}]`, { where, ts: describeRange(text, tsR), cs: describeRange(text, e), csLabel: '期望' });
    };
    const w = `line ${i}`;
    chk('line.range', w, L.range, exp.line.range);
    chk('line.nameRange', w, L.nameRange, exp.line.name);
    chk('line.separatorRange', w, L.separatorRange, exp.line.sep);
    chk('line.infoRange', w, L.infoRange, exp.line.info);
    chk('line.textRange', w, L.textRange, exp.line.text);
    chk('line.commentRange', w, L.commentRange, exp.line.comment);
    if (L.subs.length === exp.subs.length) {
      for (let j = 0; j < L.subs.length; j++) {
        const S = L.subs[j];
        const E = exp.subs[j];
        const ws = `line ${i} sub ${j}`;
        chk('sub.range', ws, S.range, E.range);
        chk('sub.nameRange', ws, S.nameRange, E.name);
        chk('sub.separatorRange', ws, S.separatorRange, E.sep);
        chk('sub.infoRange', ws, S.infoRange, E.info);
      }
    }
  }
}

// ───────────────────────────── 特征（用于相关性统计）─────────────────────────────

const FEATURES = [
  ['has CR', (t) => /\r/.test(t)],
  ['CRLF', (t) => /\r\n/.test(t)],
  ['lone CR (not before \\n)', (t) => /\r(?!\n)/.test(t)],
  ['cont-pipe  ":\\n|" (after CR strip)', (t) => /:\n\|/.test(t.replace(/\r/g, ''))],
  ['cont-soft  ":\\n:" (after CR strip)', (t) => /:\n:/.test(t.replace(/\r/g, ''))],
  ['cont-pipe+soft together', (t) => { const s = t.replace(/\r/g, ''); return /:\n\|/.test(s) && /:\n:/.test(s); }],
  ['":\\n" followed by ":" or "|" then more', (t) => /:\n[:|][:|\n]/.test(t.replace(/\r/g, ''))],
  ['"::\\n|" / ":\\n||" / ":\\n:\\n|" shapes', (t) => /::\n\||:\n\|\||:\n:\n\||:\n:\n:|:\n\|\n:/.test(t.replace(/\r/g, ''))],
  ['"///" comment', (t) => t.includes('///')],
  ['comment-only line', (t) => /(^|\n)\/\/\//.test(t.replace(/\r/g, ''))],
  ['"#"', (t) => t.includes('#')],
  ['"/" escape-like', (t) => /\/[a-z!|]/.test(t)],
  ['blank line / leading / trailing NL', (t) => /^\r?\n|\r?\n$|\n\r?\n/.test(t)],
  ['line without ":|"', (t) => t.replace(/\r/g, '').split('\n').some((l) => l.length > 0 && !l.includes(':|'))],
  ['surrogate pair (emoji)', (t) => /[\uD800-\uDBFF][\uDC00-\uDFFF]/.test(t)]
];

// ───────────────────────────── 最小化 ─────────────────────────────

function candidatesOf(text) {
  const cps = Array.from(text);
  const n = cps.length;
  const set = new Set();
  const list = [];
  for (const k of [4, 3, 2, 1]) {
    for (let i = 0; i + k <= n; i++) {
      const cand = cps.slice(0, i).concat(cps.slice(i + k)).join('');
      if (cand.length === 0 || cand === text || set.has(cand)) continue;
      set.add(cand);
      list.push(cand);
    }
  }
  list.sort((a, b) => a.length - b.length);
  return list;
}

// ───────────────────────────── 报告 ─────────────────────────────

const KIND_DESC = {
  'cs.error': 'C# 侧抛异常',
  'ts.throw': 'TS 侧抛异常',
  'oracle.mismatch': '工具自检失败：JS 复刻的 C# 预处理行数与 C# 实际不符',
  'normalizedText': 'TS document.normalizedText ≠ C# LpsDocument.Load 预处理结果（Replace("\\r","") → ":\\n|"→"/n" → ":\\n:"→"" → Trim("\\n")）',
  'parse.lines.count': '解析出的逻辑行数不同（续行/软换行/空行处理）',
  'parse.line.name': 'Line.Name 不同',
  'parse.line.info': 'Line 原始 info（存储串）不同',
  'parse.line.decodedInfo': 'Line.Info（反转义）不同',
  'parse.line.text': 'Line.text（原始）不同',
  'parse.line.decodedText': 'Line.Text（反转义）不同',
  'parse.line.comments': 'Line.Comments 不同',
  'parse.sub.count': '一行内 Sub 数量不同',
  'parse.sub.name': 'Sub.Name 不同',
  'parse.sub.info': 'Sub 原始 info 不同',
  'parse.sub.decodedInfo': 'Sub.Info（反转义）不同',
  'format.document': 'formatLpsDocument ≠ C# LpsDocument.ToString()（无法逐行对齐时的整体比较）',
  'format.line': 'formatLpsDocument 单行输出 ≠ C# 对应行的 ToString()',
  'format.line.no-separator': '无 ":|" 的非注释行：C# 输出 name:|<整行文本>（内容被复制），TS 保持原样（info，视为有意偏差）',
  'escape.decode': 'decodeLpsTextLikeCSharp ≠ Sub.TextDeReplace',
  'escape.decode.keep-n': 'decodeLpsText（保留 /n）≠ Sub.TextDeReplace 的结果把换行还原为 /n',
  'escape.encode': 'encodeLpsText ≠ Sub.TextReplace'
};

function kindDesc(kind) {
  if (KIND_DESC[kind]) return KIND_DESC[kind];
  if (kind.startsWith('range.continuation.line')) return '续行/含孤立 CR 的逻辑行：整行 range 与原文映射范围不同（info，非错误）';
  if (kind.startsWith('range.')) return 'TS 返回的 range 与原始输入中的期望位置不符（' + (kind.includes('[CR]') ? '输入含 CR' : '输入仅 LF') + '）';
  return '';
}

function clip(s, n) {
  s = String(s);
  return s.length > n ? `${s.slice(0, n)}…(+${s.length - n} chars)` : s;
}

function fmtDetail(d, wide) {
  const n = wide ? 600 : 400;
  const lines = [];
  if (d.where) lines.push(`    where: ${d.where}`);
  lines.push(`    TS   : ${clip(d.ts, n)}`);
  lines.push(`    ${d.csLabel ? d.csLabel.padEnd(4, ' ') : 'C#  '} : ${clip(d.cs, n)}`);
  return lines.join('\n');
}

// ───────────────────────────── 主流程 ─────────────────────────────

function compileTs(outDir) {
  const tmp = os.tmpdir();
  if (path.basename(outDir) === 'lps-fuzz-out' && path.dirname(outDir) === tmp && fs.existsSync(outDir)) {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
  const tsc = path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
  let output = '';
  let failed = false;
  try {
    output = cp.execFileSync(process.execPath, [tsc, '-p', './', '--noEmit', 'false', '--outDir', outDir, '--module', 'commonjs'],
      { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 28 });
  } catch (e) {
    failed = true;
    output = `${e.stdout || ''}${e.stderr || ''}`;
  }
  const parserJs = path.join(outDir, 'src', 'lps', 'parser.js');
  if (!fs.existsSync(parserJs)) throw new Error(`tsc 未产出 ${parserJs}\n${output}`);
  if (failed) console.warn(`[warn] tsc 报告了类型错误，但仍产出了 JS：\n${output.split('\n').slice(0, 12).join('\n')}`);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    const src = fs.readFileSync(__filename, 'utf8');
    console.log(src.slice(src.indexOf('/*') + 3, src.indexOf('*/')).replace(/^ \* ?/gm, ''));
    return 0;
  }
  const t0 = Date.now();
  const outDir = opts.tsOut || path.join(os.tmpdir(), 'lps-fuzz-out');

  if (!opts.skipTsc) { console.log('[1/5] tsc 编译 →', outDir); compileTs(outDir); }
  const mods = loadTsModules(outDir);

  if (!opts.skipBuild) {
    console.log('[2/5] dotnet build test/LinePutScriptConsistency');
    try {
      runDotnet(['build', 'test/LinePutScriptConsistency', '-nologo', '-v', 'q'], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      console.error(`${e.stdout || ''}${e.stderr || ''}`);
      throw new Error('dotnet build 失败');
    }
  }

  console.log('[3/5] 生成用例并运行 C#');
  const cases = generateCases(opts);
  const catCounts = new Map();
  for (const c of cases) catCounts.set(c.cat, (catCounts.get(c.cat) || 0) + 1);
  ensureCs(cases.map((c) => c.text));
  console.log(`      用例 ${cases.length} 个（${[...catCounts].map(([k, v]) => `${k}:${v}`).join(', ')}）`);

  console.log('[4/5] 比较');
  const featTotals = FEATURES.map(() => 0);
  /** @type {Map<string, {severity:string, cases:Array}>} */
  const kinds = new Map();
  const catFail = new Map();
  let failingCases = 0;
  for (const c of cases) {
    const feats = FEATURES.map(([, fn]) => fn(c.text));
    feats.forEach((f, i) => { if (f) featTotals[i]++; });
    c.feats = feats;
    const res = evaluate(c.text, csCache.get(c.text), mods);
    let hasError = false;
    for (const [kind, detail] of res) {
      let k = kinds.get(kind);
      if (!k) { k = { severity: detail.severity, cases: [] }; kinds.set(kind, k); }
      k.cases.push({ cat: c.cat, text: c.text, detail, feats, file: c.file });
      if (detail.severity !== 'info') hasError = true;
    }
    if (hasError) {
      failingCases++;
      catFail.set(c.cat, (catFail.get(c.cat) || 0) + 1);
    }
  }

  // 最小化
  console.log(`[5/5] ${opts.minimize ? '最小化样例' : '挑选样例'}（${kinds.size} 个差异类别）`);
  const evalCache = new Map();
  const hasKind = (text, kind) => {
    let m = evalCache.get(text);
    if (!m) { m = evaluate(text, csCache.get(text), mods); evalCache.set(text, m); }
    return m.has(kind);
  };
  const samples = new Map(); // kind -> [{text, cat, detail}]
  const items = [];
  for (const [kind, k] of kinds) {
    const nonFile = k.cases.filter((x) => !x.file).sort((a, b) => a.text.length - b.text.length);
    const picked = [];
    const usedCats = new Set();
    for (const x of nonFile) { if (picked.length < opts.samples + 2 && !usedCats.has(x.cat)) { picked.push(x); usedCats.add(x.cat); } }
    for (const x of nonFile) { if (picked.length < opts.samples + 2 && !picked.includes(x)) picked.push(x); }
    samples.set(kind, picked.map((x) => ({ kind, text: x.text, cat: x.cat, done: !opts.minimize })));
    for (const it of samples.get(kind)) items.push(it);
  }
  for (let round = 0; round < opts.maxRounds; round++) {
    const active = items.filter((it) => !it.done);
    if (!active.length) break;
    const cmap = new Map();
    const all = [];
    for (const it of active) { const cs = candidatesOf(it.text); cmap.set(it, cs); for (const c of cs) all.push(c); }
    ensureCs(all);
    let progressed = 0;
    for (const it of active) {
      const found = cmap.get(it).find((c) => hasKind(c, it.kind));
      if (found) { it.text = found; progressed++; } else it.done = true;
    }
    if (!progressed) break;
  }

  // 汇总报告
  const out = [];
  const P = (s = '') => out.push(s);
  const errKinds = [...kinds].filter(([, k]) => k.severity !== 'info');
  const infoKinds = [...kinds].filter(([, k]) => k.severity === 'info');
  P('LPS TS ↔ C# 差分测试报告');
  P(`时间: ${new Date().toISOString()}   seed=${opts.seed}   count/类别=${opts.count}   用时 ${((Date.now() - t0) / 1000).toFixed(1)}s   dotnet 调用 ${csCalls} 次`);
  P(`TS 编译产物: ${outDir}`);
  P(`用例总数: ${cases.length}（${[...catCounts].map(([k, v]) => `${k}=${v}`).join(', ')}）`);
  if (opts.files.length) P(`真实文件: ${opts.files.join(', ')}`);
  P(`有 error 级差异的用例: ${failingCases} / ${cases.length}`);
  P('');
  P('════════ 汇总（error 级）════════');
  if (!errKinds.length) P('(无差异)');
  const sortedErr = errKinds.sort((a, b) => b[1].cases.length - a[1].cases.length);
  for (const [kind, k] of sortedErr) {
    const cats = new Map();
    for (const x of k.cases) cats.set(x.cat, (cats.get(x.cat) || 0) + 1);
    P(`  ${String(k.cases.length).padStart(5)}  ${kind}   — 涉及类别: ${[...cats].map(([c, n]) => `${c}(${n})`).join(', ')}`);
  }
  P('');
  P('各生成类别的失败率（error 级）:');
  for (const [cat, n] of catCounts) P(`  ${cat.padEnd(24)} ${String(catFail.get(cat) || 0).padStart(5)} / ${String(n).padStart(5)}`);
  P('');
  if (infoKinds.length) {
    P('════════ info 级（不计为错误）════════');
    for (const [kind, k] of infoKinds) P(`  ${String(k.cases.length).padStart(5)}  ${kind}   ${kindDesc(kind)}`);
    P('');
  }

  const renderKind = (kind, k) => {
    P(`──── ${kind}  [${k.severity}]  ${k.cases.length} 例`);
    P(`  说明: ${kindDesc(kind)}`);
    const rows = [];
    FEATURES.forEach(([name], i) => {
      const fail = k.cases.reduce((n, x) => n + (x.feats[i] ? 1 : 0), 0);
      if (fail > 0 && featTotals[i] > 0) rows.push({ name, fail, total: featTotals[i], ratio: fail / featTotals[i] });
    });
    rows.sort((a, b) => b.ratio - a.ratio || b.fail - a.fail);
    if (rows.length) {
      P('  特征相关性（含该特征的用例中失败比例，前 5）:');
      for (const r of rows.slice(0, 5)) P(`    ${(r.ratio * 100).toFixed(0).padStart(3)}%  ${String(r.fail).padStart(5)}/${String(r.total).padEnd(5)}  ${r.name}`);
    }
    const seen = new Set();
    const mins = [];
    for (const it of samples.get(kind) || []) {
      if (seen.has(it.text)) continue;
      seen.add(it.text);
      const m = evalCache.get(it.text) || evaluate(it.text, csCache.get(it.text), mods);
      mins.push({ text: it.text, cat: it.cat, detail: m.get(kind) });
    }
    mins.sort((a, b) => a.text.length - b.text.length);
    let n = 0;
    for (const m of mins) {
      if (!m.detail) continue;
      if (n++ >= opts.samples) break;
      P(`  样例 ${n}  (来源类别 ${m.cat}${opts.minimize ? ', 已最小化' : ''})`);
      P(`    input: ${J(m.text)}`);
      P(fmtDetail(m.detail, false));
    }
    const fileCase = k.cases.find((x) => x.file);
    if (fileCase) {
      P(`  真实文件样例 (${fileCase.file})`);
      P(fmtDetail(fileCase.detail, true));
    }
    P('');
  };

  P('════════ 详情（error 级，按用例数降序）════════');
  for (const [kind, k] of sortedErr) renderKind(kind, k);
  if (infoKinds.length) {
    P('════════ 详情（info 级）════════');
    for (const [kind, k] of infoKinds) renderKind(kind, k);
  }

  const text = out.join('\n') + '\n';
  fs.mkdirSync(path.dirname(opts.report), { recursive: true });
  fs.writeFileSync(opts.report, text, 'utf8');

  const head = out.slice(0, out.indexOf('════════ 详情（error 级，按用例数降序）════════'));
  console.log(head.join('\n'));
  console.log(`完整报告: ${opts.report}`);
  return errKinds.length > 0 ? 1 : 0;
}

try {
  process.exitCode = main();
} catch (e) {
  console.error(e && e.stack || e);
  process.exitCode = 2;
}
