#!/usr/bin/env node
'use strict';
/*
 * 抓取并缓存繁简／异体字转换所需的开源词典（可复现构建的前提）。
 *
 *   node tools/fetch-lexicon.js [--force]
 *
 * 缓存目录：.work/lexicon/（已在 .gitignore 内）
 * 数据来源与许可：
 *   OpenCC          繁简字符表、台湾／香港地区异体字表   Apache-2.0
 *   cjkvi-variants  異体字データベース（整理 IPSJ-TS 0008:2007 与《教育部異體字字典》等）
 *   Unicode Unihan  变体关系（Unihan_Variants）与读音（Unihan_Readings）
 *
 * 已存在的文件默认跳过；--force 强制重新下载。每次运行都会写出 SOURCES.json（URL 与 SHA-256）。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DIR = path.join(ROOT, '.work', 'lexicon');
const FORCE = process.argv.includes('--force');

/* 上游引用：可用环境变量覆盖，便于锁定到具体版本/提交 */
const OPENCC_REF = process.env.OPENCC_REF || 'master';
const CJKVI_REF = process.env.CJKVI_REF || 'master';
const UNIHAN_URL = process.env.UNIHAN_URL || 'https://www.unicode.org/Public/UCD/latest/ucd/Unihan.zip';

const OPENCC_FILES = ['TSCharacters.txt', 'STCharacters.txt', 'TWVariants.txt', 'HKVariants.txt'];
const CJKVI_FILES = ['twedu-variants.txt', 'dypytz-variants.txt', 'hydzd-variants.txt', 'koseki-variants.txt', 'cjkvi-variants.txt'];

const TASKS = [
  ...OPENCC_FILES.map(f => ({ name: f, url: `https://raw.githubusercontent.com/BYVoid/OpenCC/${OPENCC_REF}/data/dictionary/${f}`, src: 'OpenCC' })),
  ...CJKVI_FILES.map(f => ({ name: f, url: `https://raw.githubusercontent.com/cjkvi/cjkvi-variants/${CJKVI_REF}/${f}`, src: 'cjkvi-variants' })),
  { name: 'Unihan.zip', url: UNIHAN_URL, src: 'Unicode Unihan', extract: ['Unihan_Variants.txt', 'Unihan_Readings.txt'] }
];

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

async function get(task) {
  const dest = path.join(DIR, task.name);
  if (fs.existsSync(dest) && !FORCE) {
    console.log(`  · ${task.name}（已缓存）`);
    return { name: task.name, url: task.url, sha256: sha256(fs.readFileSync(dest)), cached: true };
  }
  process.stdout.write(`  ↓ ${task.name} … `);
  const res = await fetch(task.url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`${task.url} → HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(dest, buf);
  console.log(`${(buf.length / 1024).toFixed(0)} KB`);
  return { name: task.name, url: task.url, sha256: sha256(buf), cached: false };
}

async function main() {
  fs.mkdirSync(DIR, { recursive: true });
  console.log('获取开源词典 → .work/lexicon/');
  const manifest = [];
  for (const t of TASKS) {
    const rec = await get(t);
    manifest.push({ file: rec.name, source: t.src, url: rec.url, sha256: rec.sha256, cached: rec.cached });
    if (t.extract) {
      execFileSync('unzip', ['-o', '-q', path.join(DIR, t.name), ...t.extract, '-d', DIR]);
      console.log(`  ⤷ 解出 ${t.extract.join('、')}`);
    }
  }
  fs.writeFileSync(path.join(DIR, 'SOURCES.json'),
    JSON.stringify({ generated: new Date().toISOString().slice(0, 10), refs: { OPENCC_REF, CJKVI_REF, UNIHAN_URL }, files: manifest }, null, 2), 'utf-8');
  console.log('完成。缓存清单：.work/lexicon/SOURCES.json');
}
main().catch(e => { console.error('失败：' + e.message); process.exit(1); });