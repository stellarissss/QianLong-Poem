'use strict';
/*
 * 全库字／词频统计 → 供查看器「数据分析」模块使用。
 *
 *   buildFreq(poems)  ->  { chars:[[ch,poemCount,totalCount]…],
 *                           words:[[w,poemCount,totalCount]…], total }
 *
 * 约定（与检索保持一致）：
 *   · 以「诗题＋诗身」的底本原文为语料（与主检索同源，未加标点）；
 *   · 「字」＝单字；「词」＝相邻二字ＣＪＫ组合（二字「词」的近义代理，不作词法切分）；
 *   · poemCount＝出现过该字的诗数，totalCount＝全文出现总次数；
 *   · 「词」只保留 poemCount ≥ 2 者，舍去仅见于一首体的长尾噪声（约 57 万项）。
 *
 * 输出用于查看器内排行与相关搭配；「某字某词出现频率」的精确诗数仍由查看器
 * 按折叠规则扫描求得，故序、简体、异体三者结果一致。
 */
const fs = require('fs');
const path = require('path');

const CJK = /[\u3400-\u9FFF\uF900-\uFAFF]/;

function buildFreq(poems) {
  const cm = new Map();   // ch -> [poems, total]
  const wm = new Map();   // word -> [poems, total]
  for (const p of poems) {
    const text = (p.title || '') + (p.content || '');
    const arr = [];
    for (const ch of text) if (CJK.test(ch)) arr.push(ch);

    // 单字：出现过的字（每诗首个字 + 全诗计数）
    const seen = new Set();
    for (const ch of arr) seen.add(ch);
    for (const ch of seen) {
      let e = cm.get(ch);
      if (!e) { e = [0, 0]; cm.set(ch, e); }
      e[0]++;
    }
    for (const ch of arr) cm.get(ch)[1]++;

    // 二字词（相邻二字，均属ＣＪＫ）：每诗计入出现过与否＋出现次数
    const bseen = new Set(), bcnt = new Map();
    for (let i = 0; i < arr.length - 1; i++) {
      if (!CJK.test(arr[i]) || !CJK.test(arr[i + 1])) continue;
      const w = arr[i] + arr[i + 1];
      bseen.add(w);
      bcnt.set(w, (bcnt.get(w) || 0) + 1);
    }
    for (const w of bseen) {
      let e = wm.get(w);
      if (!e) { e = [0, 0]; wm.set(w, e); }
      e[0]++;
      e[1] += bcnt.get(w);
    }
  }

  const chars = [...cm.entries()].sort((a, b) => b[1][1] - a[1][1])
    .map(([ch, e]) => [ch, e[0], e[1]]);
  const words = [...wm.entries()]
    .filter(([, e]) => e[0] >= 2)                       // 去每诗仅 1 次之长尾噪声
    .sort((a, b) => b[1][1] - a[1][1])
    .map(([w, e]) => [w, e[0], e[1]]);

  const stats = {
    chars: chars.length,
    words: words.length,
    total: poems.length
  };
  console.log(`  字频：${stats.chars} 字 / 词频（二字，诗数≥2）：${stats.words} 种`);
  return { chars, words, total: poems.length };
}

module.exports = { buildFreq };