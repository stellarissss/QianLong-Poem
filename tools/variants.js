'use strict';
/*
 * 异体字规范化 → VAR 表（异体 → 标准简体）
 *
 * 思路：以底本原字为输入，凡「非标准字符」者，依多源异体关系求其正字，
 * 再经 OpenCC TSCharacters 折为常用简体；所得映射用于查看器物字的显示转换，
 * 并在简体字下以括注回标异体原文。
 *
 * 源优先级（小者优先）：
 *   1  《教育部異體字字典》正字（twedu）
 *   2  《第一批异体字整理表》(dypytz)、《汉语大字典》正字/简繁 (hydzd proper·simplified·traditional)
 *   3  《汉语大字典》异体字 (hydzd variant)
 *   4  《康熙字典》异体关系 (koseki)
 *   5  Unihan 变体字段（kZVariant → kSimplifiedVariant）
 *   6  cjkvi 関連字（对称关系，仅在读音一致时采信）
 *   7  OpenCC 台湾／香港地区异体字表
 *
 * 两道安全闸：
 *   一、仅处理「非标准字符」——标准字（GB2312 常用字 ∪ 繁简对照表双方）一律不动，
 *       以免出现「一→壹」「人→亻」一类倒转；
 *   二、目标必须仍属标准字，且折算结果须为 GB2312 常用简体；
 *       候选还须与源字读音相容（首读一致），剔除同形近义字（如「芃→梵」「韡→靴」）。
 */
const fs = require('fs');
const path = require('path');

const CJK = /[\u3400-\u9FFF\uF900-\uFAFF]/;
/* 只采信字形（正异体／简繁）关系；kSemanticVariant 一类表语义相通，非异体，故不取 */
const UNIHAN_VARIANT_FIELDS = ['kZVariant', 'kJapaneseOldVariant', 'kJapaneseNewVariant', 'kTraditionalVariant', 'kSimplifiedVariant'];

/* 人工复核：确认映射 / 屏蔽误判（空串表示保持原字不动）
 * 除词典外，另据本库语例逐条核定的木刻异体（诸表未收者）：
 *   㢤「妙㢤」「誠㢤」＝哉　桞「桞岸」「槐桞」＝柳　㺯「㺯影」「試㺯」＝弄
 *   茒「茒舍」「茒屋」＝茅　玊「玊椀」「玊砌」「玊輿」＝玉　㾗「沙㾗」「漲㾗」＝痕
 *   㩁「商㩁」「載㩁載渡」＝榷　皥「熙皥」「少皥」＝皞　㡡「紗㡡」「氷㡡」＝幮
 */
const OVERRIDE = new Map(Object.entries({
  '勑': '敕',
  '巻': '卷',
  '夘': '卯',
  '陜': '陝',
  '靣': '面',
  '㢤': '哉',
  '桞': '柳',
  '㺯': '弄',
  '茒': '茅',
  '玊': '玉',
  '㾗': '痕',
  '㩁': '榷',
  '皥': '皞',
  '㡡': '幮',
  '芃': '',   // 芃（草盛）非「梵」之异体
  '祇': '',   // 祇（神祇／祇今）与「祗」音义有别
  '弆': '',   // 弆（藏也）不与「去」相涉
  '汍': '',
  '渟': ''    // 渟（水止）不与「汀」相通
}));

function loadMap(file) {
  const m = new Map();
  for (const ln of fs.readFileSync(file, 'utf-8').split('\n')) {
    if (!ln || ln[0] === '#') continue;
    const p = ln.trim().split(/\s+/);
    if (p.length < 2 || [...p[0]].length !== 1) continue;
    const v = [...p[1]][0];
    if (v && v !== p[0] && !m.has(p[0])) m.set(p[0], v);
  }
  return m;
}

/* GB2312 常用字集：作为「标准简体」的判据 */
function loadGB() {
  const gb = new Set();
  const dec = new TextDecoder('gbk');
  for (let b1 = 0xA1; b1 <= 0xF7; b1++) for (let b2 = 0xA1; b2 <= 0xFE; b2++) {
    const s = dec.decode(Uint8Array.from([b1, b2]));
    if (s.length === 1 && s !== '\uFFFD' && s.codePointAt(0) > 0x2000) gb.add(s);
  }
  return gb;
}

/* Unihan 读音：取各汉语读音字段之并集（去声调归为音节），另录首读供严格校验。
 * Unihan 读音为多源汇编，同一字常并存古今异读，故并集偏宽；判定异体时以首读为准
 * （kMandarin 优先，余者依次递补），可剔除「衹→缇」「韡→靴」一类仅靠冷僻异读蒙混过关的误判。 */
const READING_FIELDS = ['kMandarin', 'kXHC1983', 'kTGHZ2013', 'kHanyuPinyin', 'kSMSZD2003Readings'];
function loadReadings(file) {
  const all = new Map(), primary = new Map(), prio = new Map();
  const out = { all, primary };
  if (!fs.existsSync(file)) return out;
  const strip = s => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[0-9]/g, '').toLowerCase();
  for (const ln of fs.readFileSync(file, 'utf-8').split('\n')) {
    if (!ln || ln[0] === '#') continue;
    const [cp, f, v] = ln.split('\t');
    const fi = READING_FIELDS.indexOf(f);
    if (fi < 0 || !v) continue;
    const ch = String.fromCodePoint(parseInt(cp.replace('U+', ''), 16));
    const set = all.get(ch) || new Set();
    for (let part of v.trim().split(/[\s,]+/)) {
      const i = part.indexOf(':');
      if (i >= 0) part = part.slice(i + 1);
      for (const sy of part.split(',')) { const s = strip(sy); if (/^[a-z]+$/.test(s)) set.add(s); }
    }
    all.set(ch, set);
    if (fi < (prio.has(ch) ? prio.get(ch) : 99)) {
      const first = strip(v.trim().split(/[\s,]+/)[0].split(':').pop().split(',')[0]);
      if (/^[a-z]+$/.test(first)) { primary.set(ch, first); prio.set(ch, fi); }
    }
  }
  return out;
}

function loadRelations(dir) {
  const rel = new Map();
  const add = (src, target, prio) => {
    if (src === target || !CJK.test(src) || !CJK.test(target) || [...src].length !== 1 || [...target].length !== 1) return;
    if (!rel.has(src)) rel.set(src, []);
    rel.get(src).push({ t: target, prio });
  };
  const rows = f => {
    const p = path.join(dir, f);
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf-8').split('\n') : [];
  };

  for (const ln of rows('twedu-variants.txt')) {           // 「正字, twedu/variant, 異體」
    const p = ln.split(','); if (p.length < 3) continue;
    add(p[2], p[0], 1);
  }
  for (const ln of rows('dypytz-variants.txt')) {          // 「正字, dypytz/variant, 異體」
    const p = ln.split(','); if (p.length < 3) continue;
    add(p[2], p[0], 2);
  }
  for (const ln of rows('hydzd-variants.txt')) {
    const p = ln.split(','); if (p.length < 3) continue;
    add(p[2], p[0], /proper|simplified|traditional/.test(p[1]) ? 2 : 3);
  }
  for (const ln of rows('koseki-variants.txt')) {
    const p = ln.split(','); if (p.length < 3) continue;
    add(p[2], p[0], 4);
  }
  const uv = path.join(dir, 'Unihan_Variants.txt');
  if (fs.existsSync(uv)) {
    const unp = cp => String.fromCodePoint(parseInt(cp.replace('U+', ''), 16));
    for (const ln of fs.readFileSync(uv, 'utf-8').split('\n')) {
      if (!ln || ln[0] === '#') continue;
      const [cp, f, v] = ln.split('\t');
      const fi = UNIHAN_VARIANT_FIELDS.indexOf(f);
      if (fi < 0 || !cp || !v) continue;
      const src = unp(cp);
      for (const x of v.split(' ')) add(src, unp(x.split('<')[0]), 5 + fi);
    }
  }
  for (const ln of rows('cjkvi-variants.txt')) {           // 「関連字」对称，需同音方采信
    const p = ln.split(','); if (p.length < 3 || p[1].indexOf('variant') < 0) continue;
    add(p[2], p[0], 11);
    add(p[0], p[2], 11);
  }
  const tw = path.join(dir, 'TWVariants.txt'), hk = path.join(dir, 'HKVariants.txt');
  if (fs.existsSync(tw)) for (const [k, v] of loadMap(tw)) add(k, v, 12);
  if (fs.existsSync(hk)) for (const [k, v] of loadMap(hk)) add(k, v, 13);

  return rel;
}

/**
 * @param {string} corpus 全库正文（诗题＋诗文）
 * @returns {{pairs:Array<[string,string]>, changed:Array, unresolved:Array, blocked:Array, stats:Object}}
 */
function buildVariants(corpus, lexiconDir) {
  const TS = loadMap(path.join(lexiconDir, 'TSCharacters.txt'));
  const ST = loadMap(path.join(lexiconDir, 'STCharacters.txt'));
  const GB = loadGB();
  const STD = new Set([...GB, ...TS.keys(), ...ST.keys()]);
  const READINGS = loadReadings(path.join(lexiconDir, 'Unihan_Readings.txt'));
  const READ = READINGS.all, PREAD = READINGS.primary;
  const REL = loadRelations(lexiconDir);

  const freq = new Map();
  for (const ch of corpus) freq.set(ch, (freq.get(ch) || 0) + 1);

  const sameRead = (a, b) => {
    const ra = READ.get(a), rb = READ.get(b);
    if (!ra || !rb) return null;
    for (const x of ra) if (rb.has(x)) return true;
    return false;
  };
  /* 首读不一，则同音关系（或形声关系）不成立 */
  const samePrimary = (a, b) => {
    const pa = PREAD.get(a), pb = PREAD.get(b);
    if (!pa || !pb) return null;
    return pa === pb;
  };

  const changed = [], unresolved = [], blocked = [];
  for (const [ch, count] of freq) {
    if (STD.has(ch) || !CJK.test(ch)) continue;
    if (OVERRIDE.has(ch)) {
      const fix = OVERRIDE.get(ch);
      if (!fix) { blocked.push({ ch, count }); continue; }
      changed.push({ ch, count, target: fix, simp: TS.get(fix) || fix, src: 'override' });
      continue;
    }
    let best = null;
    for (const r of (REL.get(ch) || [])) {
      if (r.t === ch || !STD.has(r.t)) continue;
      const simp = TS.get(r.t) || r.t;
      if (!GB.has(simp) || simp === ch) continue;
      if (sameRead(ch, r.t) === false) continue;
      if (samePrimary(ch, r.t) === false) continue;
      const cand = { t: r.t, simp, prio: r.prio, tf: freq.get(r.t) || 0 };
      if (!best || cand.prio < best.prio || (cand.prio === best.prio && cand.tf > best.tf)) best = cand;
    }
    if (!best) { unresolved.push({ ch, count }); continue; }
    changed.push({ ch, count, target: best.t, simp: best.simp, prio: best.prio, src: 'rel' });
  }

  changed.sort((a, b) => b.count - a.count);
  unresolved.sort((a, b) => b.count - a.count);
  return {
    pairs: changed.map(r => [r.ch, r.simp]),
    changed, unresolved, blocked,
    stats: {
      variants: changed.length,
      occurrences: changed.reduce((s, r) => s + r.count, 0),
      unresolved: unresolved.length,
      unresolvedOccurrences: unresolved.reduce((s, r) => s + r.count, 0),
      blocked: blocked.length
    }
  };
}

module.exports = { buildVariants };