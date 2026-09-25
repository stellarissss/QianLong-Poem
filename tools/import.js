#!/usr/bin/env node
'use strict';
/*
 * 《御製詩集》导入器：把 Kanripo KR4f0005 的 mandoku 原文解析为结构化诗库。
 *
 *   node tools/import.js [repoDir] [out.json]
 *
 * 源文本约定（KR4f0005，文淵閣四庫全書本）：
 *   - 每文件一卷；`#+PROPERTY: JUAN` 给出分集与卷次；
 *   - 行以 ¶ 结尾；`<pb:...>` 为原书叶面标记；
 *   - 行首全角空格数表层级：0 正文 / 1 卷首或按语 / 2 诗题或序文 / >=3 子题、题续或「右」回指标题；
 *   - `&KRxxxx;` 为 Kanripo 未映射到 Unicode 的罕见字占位符（源站显示时亦舍弃）；
 *   - `(...)` 为作者自注，`/` 表示注文在原刻中的换行。
 *
 * 诗题以各集《目録》为准（总目 454 卷齐备）：把目録条目按序在正文中定位，
 * 从而还原跨行、抬格的诗题，并把序文、按语与诗句区分开。
 */
const fs = require('fs');
const path = require('path');

const TIAN = '甲乙丙丁戊己庚辛壬癸';
const DI = '子丑寅卯辰巳午未申酉戌亥';

/* ---------------- 通用工具 ---------------- */

function cn2num(s) {
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  const d = { 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  let n = 0, t = 0;
  for (const c of s) {
    if (d[c] !== undefined) t = t * 10 + d[c];
    else if (c === '十') { n += (t || 1) * 10; t = 0; }
    else if (c === '百') { n += (t || 1) * 100; t = 0; }
    else return 0;
  }
  return n + t;
}

function indentOf(s) {
  let n = 0, i = 0;
  for (; i < s.length; i++) {
    const c = s[i];
    if (c === '　') n += 1;
    else if (c === '\t') n += 2;
    else break;
  }
  return { n, i };
}

/* 异体字规范：仅用于「目録 ↔ 正文」比对，不改动入库文字 */
const VARIANT = new Map(Object.entries({
  巻: '卷', 蔵: '藏', 榖: '糓', 徳: '德', 濳: '潛', 潜: '潛', 蒋: '蔣', 徴: '徵', 蘓: '蘇', 蘇: '蘇',
  髙: '高', 夀: '壽', 寳: '寶', 収: '收', 眀: '明', 冊: '册', 廼: '乃', 昬: '昏', 熈: '熙',
  㑹: '會', 曾: '曾', 幾: '幾', 兎: '兔', 崑: '昆', 甯: '寧', 寕: '寧', 冩: '寫', 冐: '冒',
  麅: '麅', 虗: '虛', 靣: '面', 㸃: '點', 儘: '盡', 盡: '盡', 隂: '陰', 隄: '堤', 䆳: '邃'
}));
const DROP = /[　\s·、，。！？；：；「」『』]/;

function canon(c) { return VARIANT.get(c) || c; }

/** 归一化：去掉圆括号注文与标点，异体字归并；同时给出归纳串下标到原串下标的映射 */
function normWithMap(s) {
  let out = '', map = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '(' || c === '（') {                    // 自注/小字：比对时整体舍弃
      const close = c === '(' ? ')' : '）';
      let j = s.indexOf(close, i + 1);
      if (j < 0) j = s.length - 1;
      i = j;
      continue;
    }
    if (DROP.test(c)) continue;
    out += canon(c);
    map.push(i);
  }
  return { out, map };
}

function norm(s) { return normWithMap(s).out; }

/* ---------------- 1. 目録索引 ---------------- */

const JUAN_RE = /^(初集|二集|三集|四集|五集|餘集)[卷巻](.+)$/;

function juanKey(ji, juan) { return ji + '|' + juan; }

/** 从目録文件切出「卷 → 诗题列表」 */
function splitIndex(text, ji) {
  const out = new Map();
  let cur = null;
  for (const raw of text.split('\n')) {
    if (raw.startsWith('#') || raw.startsWith('<pb:')) continue;
    let s = raw.replace(/\r/g, '');
    if (s.endsWith('¶')) s = s.slice(0, -1);
    s = s.replace(/&KR\d+;/g, '');
    if (!s.trim()) continue;
    const { n, i } = indentOf(s);
    const t = s.slice(i).replace(/[ \t]+$/, '');
    if (!t) continue;
    if (n === 1 && /^[卷巻]之?[0-9零一二三四五六七八九十百]+$/.test(t)) {
      cur = [];
      out.set(cn2num(t.replace(/^[卷巻]之?/, '')), cur);
      continue;
    }
    if (!cur) continue;
    if (n === 2) cur.push([t]);
    else if (cur.length) cur[cur.length - 1].push(t);
  }
  const res = new Map();
  for (const [k, v] of out) res.set(k, v.map(x => x.join('')));
  return res;
}

/* ---------------- 2. 卷正文解析 ---------------- */

/* 版心/卷题等行文，不属诗作 */
const RUNNING_HEAD = /^(欽定四庫全書|御製詩(初集|二集|三集|四集|五集|餘集)[卷巻巷][0-9零一二三四五六七八九十百]+|御製詩集)/;

function tokenize(text) {
  const lines = [];
  let page = '';
  for (const raw of text.split('\n')) {
    if (raw.startsWith('#')) continue;
    let s = raw.replace(/\r/g, '');
    let m;
    while ((m = /<pb:([^>]+)>/.exec(s))) { page = m[1]; s = s.slice(0, m.index) + s.slice(m.index + m[0].length); }
    if (s.endsWith('¶')) s = s.slice(0, -1);
    s = s.replace(/&KR\d+;/g, '').replace(/[ \t]+$/, '');
    if (!s.trim()) continue;
    const { n, i } = indentOf(s);
    const t = s.slice(i);
    if (n === 0 && RUNNING_HEAD.test(t)) continue;
    lines.push({ n, t, page });
  }
  return lines;
}

/** 拆出自注：(...) 内的文字，`/` 为原刻换行 */
function splitNotes(text) {
  let body = '', notes = [];
  const re = /\(([^)]*)\)/g;
  let m, last = 0;
  while ((m = re.exec(text))) {
    body += text.slice(last, m.index);
    const note = m[1].replace(/\//g, '').trim();
    if (note) notes.push(note);
    last = m.index + m[0].length;
  }
  body += text.slice(last);
  return { body, notes };
}

/**
 * 解析一卷。
 * @param {string} text 卷原文
 * @param {string[]} idxTitles 该卷目録诗题（可空）
 * @param {{ji:string,juan:number,file:string}} info
 */
function parseVolume(text, idxTitles, info) {
  const lines = tokenize(text);
  const poems = [];
  let ganzhi = [];
  let declaredCount = 0;
  let juanGanzhi = [];

  /* --- 2a. 目録比对：把每条目録诗题定位到正文中的标题行 --- */
  let S = '', Sn = '', Sn2S = [];
  const lineRange = [];
  for (const L of lines) {
    const st = S.length;
    S += L.t;
    lineRange.push([st, S.length]);
  }
  {
    const nm = normWithMap(S);
    Sn = nm.out; Sn2S = nm.map;
  }
  const lineAt = (() => {
    // S 下标 → 行号
    const arr = new Int32Array(S.length + 1);
    for (let li = 0; li < lineRange.length; li++) {
      for (let p = lineRange[li][0]; p < lineRange[li][1]; p++) arr[p] = li;
    }
    return p => arr[Math.min(p, S.length)];
  })();

  /* 诗题必在缩进行（全角空格 ≥2）。只在标题行行首起匹配，
     否则「夜」「月」等短题会命中诗句中的同名片段，导致串行。 */
  const S2Sn = new Int32Array(S.length + 1).fill(-1);
  for (let p = 0; p < Sn2S.length; p++) S2Sn[Sn2S[p]] = p;
  const snLine = new Int32Array(Sn.length);
  const lineEndSn = new Int32Array(lines.length).fill(-1);
  for (let p = 0; p < Sn.length; p++) {
    const li = lineAt(Sn2S[p]);
    snLine[p] = li;
    lineEndSn[li] = p + 1;
  }
  const isTitleStart = new Uint8Array(Sn.length);
  for (let li = 0; li < lines.length; li++) {
    if (lines[li].n < 2) continue;
    for (let k = lineRange[li][0]; k < lineRange[li][1]; k++) {
      if (S2Sn[k] >= 0) { isTitleStart[S2Sn[k]] = 1; break; }
    }
  }

  /** 在 titleStart 位置中定位诗题：优先整行吻合，其次首个吻合，最后容错 */
  const matchTitle = (T, from) => {
    const L = T.length;
    let loose = -1, seen = 0;
    for (let q = from; q + L <= Sn.length && seen < 80; q++) {
      if (!isTitleStart[q]) continue;
      seen++;
      if (Sn.startsWith(T, q)) {
        const e = q + L;
        if (e === lineEndSn[snLine[e - 1]]) return q;   // 恰好填满末行
        if (loose < 0) loose = q;
      }
    }
    if (loose >= 0) return loose;
    const k = L <= 6 ? 1 : L <= 14 ? 2 : 3;
    seen = 0;
    for (let q = from; q + L <= Sn.length && seen < 80; q++) {
      if (!isTitleStart[q]) continue;
      seen++;
      let miss = 0;
      for (let j = 0; j < L; j++) if (Sn[q + j] !== T[j] && ++miss > k) break;
      if (miss <= k) return q;
    }
    return -1;
  };

  const titleSpans = [];   // { title, l0, l1 }
  const missed = [];
  let cursor = 0;
  for (const tRaw of idxTitles || []) {
    const T = norm(tRaw);
    if (!T) continue;
    const p = matchTitle(T, cursor);
    if (p < 0) { missed.push(tRaw); continue; }
    const s0 = Sn2S[p], s1 = Sn2S[Math.min(p + T.length - 1, Sn2S.length - 1)] + 1;
    titleSpans.push({ title: tRaw, l0: lineAt(s0), l1: lineAt(s1 - 1) });
    cursor = p + T.length;
  }

  const spanOf = new Array(lines.length).fill(-1);
  titleSpans.forEach((sp, k) => { for (let i = sp.l0; i <= sp.l1; i++) spanOf[i] = k; });

  /* --- 2b. 结构遍历 --- */
  let cur = null;
  let series = '';        // 「右」回指标题系列的总题
  const close = () => { if (cur && (cur.content || cur.title)) poems.push(cur); cur = null; };
  const open = (title, fromIdx) => {
    close();
    cur = { title: title || '', titleFromIdx: !!fromIdx, content: '', preface: '', notes: [], series: series, juanGanzhi: juanGanzhi };
  };
  let noteBuf = '';       // 未归属的序文/按语

  for (let li = 0; li < lines.length; li++) {
    const L = lines[li];
    const t = L.t;

    if (L.n === 1 && /^古今體/.test(t)) {
      juanGanzhi = parseGanZhi(t);
      ganzhi = juanGanzhi;
      const mm = /古今體([0-9零一二三四五六七八九十百]+)首/.exec(t);
      declaredCount = mm ? cn2num(mm[1]) : 0;
      continue;
    }

    // 目録已定位的诗题行
    if (spanOf[li] >= 0) {
      const sp = titleSpans[spanOf[li]];
      if (!cur || cur.title !== sp.title || li === sp.l0) {
        if (li === sp.l0) {
          if (cur && !cur.content && cur.title) { /* 上一个无正文的标题：丢弃 */ }
          series = '';
          open(sp.title, true);
        }
      }
      continue;
    }

    const isProseLike = /^(按|恭按|謹按|臣按|御製|序|昨|前)/.test(t);

    if (L.n >= 3) {
      if (t.startsWith('右')) {
        // 回指标题：命名紧接其前的本篇，并把被取代的组题记入 series
        const nm = t.replace(/^右題?/, '');
        const obj = cur || (poems.length ? poems[poems.length - 1] : null);
        if (obj) {
          if (obj.titleFromIdx && obj.title) {
            // 目録以本篇小序充作诗题者：原文转入小序，不作组题
            if (obj.title.length >= 22) obj.preface = obj.title + obj.preface;
            else series = obj.title;
          }
          obj.title = nm;
          obj.titleFromIdx = false;
          obj.series = series;
          if (obj === cur) close();     // 右题位于诗后，命名后本篇即结束
        }
        continue;
      }
      if (cur && !cur.content && !cur.preface) { cur.title += t; continue; }  // 题续行
      open(t, false);                                                          // 子题
      continue;
    }

    if (L.n === 2) {
      // 序文、按语：题下尚未出现正文时，成为该题之序
      if (isProseLike || (cur && !cur.content && cur.title && /序/.test(cur.title))) {
        if (cur) cur.preface += t; else noteBuf += t;
        continue;
      }
      if (cur && !cur.content && cur.title) {  // 归入题续（少见）
        cur.preface += t;
        continue;
      }
      open(t, false);
      continue;
    }

    // n <= 1：正文
    if (isProseLike && L.n === 1 && !cur) { noteBuf += t; continue; }
    if (!cur) open('', false);
    cur.content += t;
  }
  close();

  /* --- 2c. 清理 --- */
  const out = [];
  for (const p of poems) {
    const sn = splitNotes(p.content);
    let body = sn.body.replace(/[ \t　]+/g, '');
    if (body.length < 4 && !p.title) continue;
    out.push({
      title: p.title.trim(),
      content: body,
      notes: sn.notes.concat(p.notes || []),
      preface: (p.preface || '').replace(/[ \t　]+/g, ''),
      series: p.series || '',
      ji: info.ji,
      juan: info.juan,
      ganzhi: p.juanGanzhi || [],
      src: info.file
    });
  }

  /* 组诗总题（有题有序、无正文）：小序并入其下第一首，并以组题记 series */
  const res = [];
  for (let i = 0; i < out.length; i++) {
    const p = out[i];
    if (!p.content && p.title && out[i + 1]) {
      if (p.preface) {
        out[i + 1].preface = p.preface + (out[i + 1].preface || '');
        if (!out[i + 1].series) out[i + 1].series = p.title;
      } else if (p.title.length >= 22) {
        out[i + 1].preface = p.title + (out[i + 1].preface || '');   // 目録小序条目
      }
      continue;
    }
    if (!p.content) continue;      // 其余无正文的标题行不单独成篇
    res.push(p);
  }
  return { poems: res, declared: declaredCount, ganzhi, missed };
}

/* ---------------- 3. 干支纪年 ---------------- */

const GANZHI_YEARS = (() => {
  const m = new Map();
  for (let y = 1736; y <= 1799; y++) {
    const i = ((y - 1984) % 60 + 60) % 60;
    const gz = TIAN[i % 10] + DI[i % 12];
    if (!m.has(gz)) m.set(gz, []);
    m.get(gz).push(y);
  }
  return m;
})();

function parseGanZhi(s) {
  const out = [];
  const w = s.replace(/[／/\s、，,]+/g, '');
  for (let i = 0; i < w.length - 1; i++) {
    if (TIAN.includes(w[i]) && DI.includes(w[i + 1])) out.push(w[i] + w[i + 1]);
  }
  return [...new Set(out)];
}

/* ---------------- 4. 全库装配 ---------------- */

const JI_ORDER = ['初集', '二集', '三集', '四集', '五集', '餘集'];

function listRepoFiles(repoDir) {
  return fs.readdirSync(repoDir).filter(f => /^KR4f\d+_\d+\.txt$/.test(f)).sort();
}

function parseAll(repoDir) {
  const files = listRepoFiles(repoDir);
  const index = new Map();   // 'ji|卷' -> titles
  const bodies = [];

  let curJi = '';        // 目録分集归属（同集目録后几卷常只题「目録二」）
  for (const f of files) {
    const text = fs.readFileSync(path.join(repoDir, f), 'utf-8');
    const props = [...text.matchAll(/#\+PROPERTY: JUAN (.+)/g)].map(m => m[1].trim());
    if (!props.length) continue;
    if (props.some(p => /目[録錄]/.test(p))) {
      // 同一文件可能含多段目録（如 000 号含初集目録一~四）
      const segs = text.split(/#\+PROPERTY: JUAN /).slice(1);
      for (const seg of segs) {
        const name = seg.split('\n')[0].trim();
        if (!/目[録錄]/.test(name)) continue;
        const nm = /^(初集|二集|三集|四集|五集|餘集)/.exec(name);
        if (nm) curJi = nm[1];
        if (!curJi) continue;
        for (const [k, v] of splitIndex(seg, curJi)) index.set(juanKey(curJi, k), v);
      }
      continue;
    }
    const m = JUAN_RE.exec(props[0]);
    if (!m) continue;                        // 序、提要、跋、奏摺等
    bodies.push({ file: f, ji: m[1], juan: cn2num(m[2]), text });
  }

  bodies.sort((a, b) => (JI_ORDER.indexOf(a.ji) - JI_ORDER.indexOf(b.ji)) || (a.juan - b.juan));

  /* 先解析，再按卷序做干支→公元的单调推进 */
  const vols = [];
  let yearCursor = 1736, stat = { unmatched: 0, matched: 0, idx: 0, sample: [] };
  for (const b of bodies) {
    const idxTitles = index.get(juanKey(b.ji, b.juan)) || null;
    const r = parseVolume(b.text, idxTitles, { ji: b.ji, juan: b.juan, file: b.file });
    let ys = [];
    for (const gz of r.ganzhi) {
      const cand = GANZHI_YEARS.get(gz) || [];
      const y = cand.find(v => v >= yearCursor);
      if (y) { ys.push(y); yearCursor = y; }
    }
    vols.push({ ...b, poems: r.poems, years: ys, ganzhi: r.ganzhi, declared: r.declared });
    if (idxTitles) {
      stat.idx += idxTitles.length;
      stat.unmatched += r.missed.length;
      if (stat.sample.length < 20) stat.sample.push(...r.missed.slice(0, 20 - stat.sample.length).map(t => b.ji + b.juan + '|' + t));
    }
  }

  const poems = [];
  for (const v of vols) {
    const y0 = v.years.length ? Math.min(...v.years) : 0;
    const y1 = v.years.length ? Math.max(...v.years) : 0;
    for (const p of v.poems) {
      poems.push({
        title: p.title || '（無題）',
        content: p.content,
        notes: p.notes,
        preface: p.preface,
        series: p.series,
        ji: p.ji,
        juan: p.juan,
        ganzhi: p.ganzhi,
        year: y0,
        year_end: y1,
        page: '',
        file: p.src
      });
    }
  }
  return { poems, vols, index, stat };
}

/* ---------------- 5. CLI ---------------- */

function main() {
  const args = process.argv.slice(2);
  const repoDir = args[0] || path.join(__dirname, '..', '.work', 'repo');
  const outFile = args[1] || path.join(__dirname, '..', '.work', 'parsed.json');
  if (!fs.existsSync(repoDir)) {
    console.error(`未找到源目录：${repoDir}\n请先运行 node tools/fetch-kanripo.js`);
    process.exit(1);
  }
  const { poems, vols, stat } = parseAll(repoDir);
  const byJi = {};
  for (const p of poems) byJi[p.ji] = (byJi[p.ji] || 0) + 1;
  const declared = {};
  for (const v of vols) declared[v.ji] = (declared[v.ji] || 0) + (v.declared || 0);
  console.log(`分卷 ${vols.length}，成诗 ${poems.length}`);
  console.log('  按集：', JSON.stringify(byJi));
  console.log('  卷首自记首数合计：', JSON.stringify(declared));
  console.log(`  目録条目 ${stat.idx}，未在正文定位 ${stat.unmatched}`);
  if (process.env.SHOW_MISS) stat.sample.forEach(s => console.log('    miss', s));
  const emptyTitle = poems.filter(p => p.title === '（無題）').length;
  console.log(`  无题 ${emptyTitle}`);
  fs.writeFileSync(outFile, JSON.stringify(poems), 'utf-8');
  console.log(`写出 -> ${outFile}`);
}

if (require.main === module) main();
module.exports = { parseAll, parseVolume, splitIndex, cn2num, parseGanZhi, norm };