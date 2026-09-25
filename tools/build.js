#!/usr/bin/env node
'use strict';
/*
 * 构建：把精选语料与分卷解析结果合并为数据库，并生成可离线打开的单文件查看器。
 *
 *   node tools/build.js
 *
 * 产出：
 *   data/poems.json          完整数据库（长字段名，便于二次利用）
 *   dist/qianlong-poems.html 单文件查看器（内嵌数据、繁简折叠表、异体字表与拼音库，双击即用）
 *   dist/qianlong-poems.json 查看器所用精简数据库（压缩字段）
 *
 * 依赖 .work/lexicon/ 下的开源词典（node tools/fetch-lexicon.js）与 pinyin-pro（npm install）。
 */
const fs = require('fs');
const path = require('path');
const { parseAll } = require('./import.js');
const { buildVariants } = require('./variants.js');

const ROOT = path.join(__dirname, '..');
const WORK = path.join(ROOT, '.work');
const LEX = path.join(WORK, 'lexicon');
const DATA = path.join(ROOT, 'data');
const DIST = path.join(ROOT, 'dist');
const VERSION = '1.0.0';

const JI_ORDER = ['初集', '二集', '三集', '四集', '五集', '餘集'];

/* ---------- 1. 语料汇总 ---------- */
function loadCorpus() {
  const seed = JSON.parse(fs.readFileSync(path.join(DATA, 'seed.json'), 'utf-8')).poems || [];
  const repo = path.join(WORK, 'repo');
  let parsed = [], vols = 0;
  if (fs.existsSync(repo)) {
    const r = parseAll(repo);
    parsed = r.poems;
    vols = r.vols.length;
    console.log(`  分卷 ${vols} -> 成诗 ${parsed.length}`);
  } else {
    const pj = path.join(WORK, 'parsed.json');
    if (fs.existsSync(pj)) parsed = JSON.parse(fs.readFileSync(pj, 'utf-8'));
    console.warn('  未找到 .work/repo，改用 .work/parsed.json');
  }
  return { seed, parsed, vols };
}

/* ---------- 1b. 分卷解析结果 → 统一字段 ---------- */
function num2cn(n) {
  const d = '零一二三四五六七八九';
  if (n <= 10) return n === 10 ? '十' : d[n];
  if (n < 20) return '十' + d[n % 10];
  const t = Math.floor(n / 10), u = n % 10;
  return d[t] + '十' + (u ? d[u] : '');
}

function fromParsed(p) {
  const year = p.year || 0;
  const gz = (p.ganzhi && p.ganzhi.length) ? p.ganzhi : [];
  return {
    title: p.title,
    content: p.content,
    ji: p.ji,
    juan: p.juan,
    ganzhi: gz,
    year,
    year_text: year ? `乾隆${num2cn(year - 1735)}年（${gz.join('、') || '干支未詳'}）` : '',
    tags: [],
    note: (p.notes || []).join('；') || p.preface || '',
    series: p.series || '',
    source: `欽定四庫全書《御製詩${p.ji || ''}》卷${p.juan || '?'}（KR4f0005）`
  };
}

function merge(seed, parsed) {
  const seen = new Set();
  const out = [];
  const push = (p) => {
    const key = (p.title + '|' + p.content);
    if (!p.content || seen.has(key)) return false;
    seen.add(key);
    out.push(p);
    return true;
  };
  seed.forEach(push);
  parsed.forEach(p => push(fromParsed(p)));

  // 按分集、卷次排定篇序
  out.sort((a, b) => {
    const ka = JI_ORDER.indexOf(a.ji || ''), kb = JI_ORDER.indexOf(b.ji || '');
    const oa = ka < 0 ? JI_ORDER.length : ka, ob = kb < 0 ? JI_ORDER.length : kb;
    if (oa !== ob) return oa - ob;
    return (a.juan || 0) - (b.juan || 0);
  });

  // 重新编号
  const SRC_OF = p => p.provenance && p.provenance.source_of_record
    ? p.provenance.source_of_record
    : (p.ji ? `钦定四库全书《御製詩${p.ji}》卷${p.juan}` : p.source || '');
  return out.map((p, i) => ({
    id: 'ql-' + String(i + 1).padStart(5, '0'),
    title: p.title,
    content: p.content,
    ji: p.ji || '',
    juan: p.juan || 0,
    ganzhi: p.ganzhi || [],
    year: p.year || 0,
    year_text: p.year_text || '',
    tags: p.tags || [],
    source: SRC_OF(p),
    note: p.note || '',
    series: p.series || '',
    ...(p.provenance ? { provenance: p.provenance } : {})
  }));
}

/* ---------- 2. 繁简折叠表（OpenCC TSCharacters 全表，供显示切换与检索） ---------- */
function lexFile(name) {
  const p = path.join(LEX, name);
  if (fs.existsSync(p)) return p;
  const legacy = path.join(WORK, name);
  return fs.existsSync(legacy) ? legacy : null;
}

function buildFold() {
  const file = lexFile('TSCharacters.txt');
  if (!file) { console.warn('  未找到 TSCharacters.txt，跳过繁简折叠（请先运行 node tools/fetch-lexicon.js）'); return []; }
  const lines = fs.readFileSync(file, 'utf-8').split('\n');
  const pairs = [];
  const used = new Set();
  for (const ln of lines) {
    if (!ln || ln[0] === '#') continue;
    const parts = ln.trim().split(/\s+/);
    if (parts.length < 2) continue;
    const t = parts[0], s1 = [...parts[1]][0];
    if ([...t].length !== 1 || !s1) continue;
    if (t === s1) continue;
    if (used.has(t)) continue;
    used.add(t);
    pairs.push([t, s1]);
  }
  console.log(`  折叠表：${pairs.length} 对`);
  return pairs;
}

/* ---------- 2b. 异体字规范化（VAR：异体 → 标准简体） ---------- */
function buildVariant(poems) {
  if (!fs.existsSync(path.join(LEX, 'TSCharacters.txt'))) {
    console.warn('  未找到异体字词典，跳过异体规范化（请先运行 node tools/fetch-lexicon.js）');
    return { pairs: [], stats: {} };
  }
  let corpus = '';
  for (const p of poems) corpus += (p.title || '') + (p.content || '');
  const v = buildVariants(corpus, LEX);
  console.log(`  异体字：${v.stats.variants} 种 / ${v.stats.occurrences} 次（另有罕用正字 ${v.stats.unresolved} 种保持原样）`);
  return v;
}

/* ---------- 2c. 拼音库（pinyin-pro，MIT；构建期内嵌，查看器离线可用） ---------- */
function buildPinyinLib() {
  const file = path.join(ROOT, 'node_modules', 'pinyin-pro', 'dist', 'index.js');
  if (!fs.existsSync(file)) {
    console.warn('  未找到 pinyin-pro，查看器拼音功能将不可用（请执行 npm install）');
    return 'window.pinyinPro=null;';
  }
  const src = fs.readFileSync(file, 'utf-8');
  console.log(`  拼音库：pinyin-pro ${require(path.join(ROOT, 'node_modules', 'pinyin-pro', 'package.json')).version}（${(Buffer.byteLength(src) / 1024).toFixed(0)} KB）`);
  return src;
}

/* ---------- 3. 输出 ---------- */
function compact(poems) {
  return poems.map(p => {
    const o = { id: p.id, t: p.title, c: p.content, y: p.year, yt: p.year_text, ji: p.ji, j: p.juan };
    if (p.ganzhi && p.ganzhi.length) o.gz = p.ganzhi;
    if (p.tags && p.tags.length) o.tg = p.tags;
    if (p.note) o.nt = p.note;
    if (p.series) o.sr = p.series;
    if (p.provenance) o.prov = p.provenance;
    else if (p.source) o.src = p.source;
    return o;
  });
}

function stats(poems) {
  const withYear = poems.filter(p => p.year).length;
  const years = poems.filter(p => p.year).map(p => p.year);
  const byJi = {};
  poems.forEach(p => { const k = p.ji || '未分集'; byJi[k] = (byJi[k] || 0) + 1; });
  return {
    total: poems.length,
    with_year: withYear,
    year_range: years.length ? [Math.min(...years), Math.max(...years)] : [],
    by_ji: byJi
  };
}

function main() {
  fs.mkdirSync(DIST, { recursive: true });
  console.log('汇总语料…');
  const { seed, parsed, vols } = loadCorpus();
  const poems = merge(seed, parsed);
  const st = stats(poems);
  console.log(`合并：精选 ${seed.length} + 分卷 ${parsed.length} -> 去重后 ${poems.length} 首（涵盖 ${vols} 个分卷）`);

  const db = {
    meta: {
      subject: '清高宗·爱新觉罗·弘历（乾隆帝）御制诗全文数据库',
      version: VERSION,
      edition: '钦定四库全书《御製詩集》(KR4f0005) 及公开学术文本',
      license: '诗歌原文属公有领域；数据库结构与工具代码可自由使用',
      generated: new Date().toISOString().slice(0, 10),
      stats: st,
      fields: {
        id: '唯一标识', title: '诗题', content: '诗文（依源文，未加标点）', ji: '分集（初集/二集/…）',
        juan: '卷次', ganzhi: '干支纪年', year: '公元年（据干支与分集推定，0 表示未详）',
        year_text: '纪年文本', tags: '标签', source: '着录出处', note: '题解', provenance: '来源可追溯信息'
      }
    },
    poems
  };
  fs.writeFileSync(path.join(DATA, 'poems.json'), JSON.stringify(db, null, 2), 'utf-8');
  console.log(`写出 data/poems.json（${(fs.statSync(path.join(DATA, 'poems.json')).size / 1048576).toFixed(2)} MB）`);

  const cp = compact(poems);
  fs.writeFileSync(path.join(DIST, 'qianlong-poems.json'),
    JSON.stringify({ meta: db.meta, poems: cp }, null, 2), 'utf-8');

  const fold = buildFold();
  const variant = buildVariant(poems);
  const pinyin = buildPinyinLib();
  const tpl = fs.readFileSync(path.join(ROOT, 'app', 'viewer.template.html'), 'utf-8');
  const html = tpl
    .replace('/*__DB__*/', () => JSON.stringify({ poems: cp }))
    .replace('/*__FOLD__*/', () => JSON.stringify(fold))
    .replace('/*__VAR__*/', () => JSON.stringify(variant.pairs))
    .replace('/*__PINYIN__*/', () => pinyin)
    .replace('__VERSION__', VERSION)
    .replace('__BUILT__', new Date().toISOString().slice(0, 10))
    .replace('__COUNT__', String(poems.length));
  fs.writeFileSync(path.join(DIST, 'qianlong-poems.html'), html, 'utf-8');
  console.log(`写出 dist/qianlong-poems.html（${(Buffer.byteLength(html) / 1048576).toFixed(2)} MB）`);
  console.log('统计：', JSON.stringify(st));
}
main();