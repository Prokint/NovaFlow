#!/usr/bin/env node
/**
 * 下载本地情感小模型（weibo-BERT int8，约 103MB）。
 *
 * 模型文件超过 GitHub 单文件 100MB 限制，所以不放进 git；
 * 它作为资产挂在 NovaFlow 的公开 release 上（免费 CDN、无需登录）。
 *
 * 用法：
 *   node scripts/fetch-sentiment-model.mjs            # 缺失时下载并校验 sha256
 *   node scripts/fetch-sentiment-model.mjs --force    # 强制重下
 *   DYC_SENT_MODEL_URL=<URL> node scripts/fetch-sentiment-model.mjs   # 换地址（自建对象存储）
 *
 * NovaFlow 打包流程会在打包前调用本脚本，把模型带进安装包；
 * 没带模型的版本也能跑——页面会自动退回纯规则情感分析。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TARGET = path.join(HERE, '..', 'viewer', 'sentiment', 'weibo-bert-int8.onnx');
const DEFAULT_URL = 'https://github.com/Prokint/NovaFlow/releases/download/v0.2.8/weibo-bert-int8.onnx';
const EXPECTED_SHA256 = 'df1f6ebc1262d1c206ab67ec287cfa6dfa0f12db368a0ce7ded2b4acd7364951';
const EXPECTED_SIZE = 103169605;

const force = process.argv.includes('--force');
const url = String(process.env.DYC_SENT_MODEL_URL || DEFAULT_URL).trim();

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

if (!force && fs.existsSync(TARGET)) {
  const size = fs.statSync(TARGET).size;
  if (size === EXPECTED_SIZE && sha256File(TARGET) === EXPECTED_SHA256) {
    console.log('sentiment model already present: ' + TARGET);
    process.exit(0);
  }
  console.log('existing model is incomplete or differs from the expected sha256; re-downloading');
}

fs.mkdirSync(path.dirname(TARGET), { recursive: true });
const part = TARGET + '.part';
try { fs.unlinkSync(part); } catch {}

console.log('downloading ' + url);
const t0 = Date.now();
const res = await fetch(url, { redirect: 'follow', headers: { 'user-agent': 'novaflow-sentiment-model-fetch' } });
if (!res.ok || !res.body) throw new Error('download failed: HTTP ' + res.status);
const out = fs.createWriteStream(part);
let received = 0;
let lastTick = 0;
for await (const chunk of res.body) {
  out.write(chunk);
  received += chunk.length;
  const now = Date.now();
  if (now - lastTick > 2000) {
    lastTick = now;
    const mb = (received / 1048576).toFixed(1);
    const total = res.headers.get('content-length') ? (Number(res.headers.get('content-length')) / 1048576).toFixed(1) + 'MB' : '?';
    console.log(`  ${mb}MB / ${total}`);
  }
}
await new Promise((r) => out.end(r));

const sha = sha256File(part);
if (received !== EXPECTED_SIZE || sha !== EXPECTED_SHA256) {
  fs.renameSync(part, TARGET + '.bad');
  throw new Error(`model verification failed: size=${received} sha256=${sha}`);
}
fs.renameSync(part, TARGET);
console.log(`ok ${(received / 1048576).toFixed(1)}MB in ${((Date.now() - t0) / 1000).toFixed(1)}s -> ${TARGET}`);
