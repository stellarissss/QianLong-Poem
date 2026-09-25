#!/usr/bin/env node
'use strict';
/*
 * 获取《御製詩集》原文：克隆 Kanripo 官方文本库 KR4f0005（钦定四库全书本，454 卷）。
 *
 *   node tools/fetch-kanripo.js
 *
 * 输出：.work/repo/KR4f0005_*.txt（每文件一卷；000 号为序、提要、奏摺与初集目録）
 * 文本由 Kanripo 汉籍リポジトリ以 CC BY-SA 4.0 发布，逐叶转录自文淵閣四庫全書。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const WORK = path.join(__dirname, '..', '.work');
const REPO = path.join(WORK, 'repo');
const URL = 'https://github.com/kanripo/KR4f0005.git';

function main() {
  fs.mkdirSync(WORK, { recursive: true });
  if (fs.existsSync(path.join(REPO, '.git'))) {
    console.log('已存在 .work/repo，执行更新…');
    execFileSync('git', ['-C', REPO, 'pull', '--ff-only'], { stdio: 'inherit' });
  } else {
    fs.rmSync(REPO, { recursive: true, force: true });
    console.log(`克隆 ${URL} …`);
    execFileSync('git', ['clone', '--depth', '1', URL, REPO], { stdio: 'inherit' });
  }
  const n = fs.readdirSync(REPO).filter(f => /^KR4f\d+_\d+\.txt$/.test(f)).length;
  console.log(`完成：${REPO}（${n} 个文本文件）`);
}

main();