/* v0.9.48：情感模型 Web Worker（onnxruntime-web + weibo-BERT int8）。
 * 放在 Worker 里跑，避免 103MB 模型推理卡住页面；只做「模型判分」，与规则合并由页面完成。 */
/* global ort, createBertTokenizer */
try {
  importScripts('../vendor/ort/ort.wasm.min.js', './tokenizer.js');
} catch (e) {
  postMessage({ type: 'error', error: 'importScripts failed: ' + String((e && e.message) || e) });
  throw e;
}

const MODEL_URL = new URL('./weibo-bert-int8.onnx', self.location.href).href;
const VOCAB_URL = new URL('./vocab.txt', self.location.href).href;
const LABELS = ['neg', 'pos', 'neu'];
const MAX_LEN = 128;
const BATCH = 8;

let session = null;
let tokenizer = null;
let initPromise = null;
let cancelled = false;

function setupOrt() {
  ort.env.wasm.wasmPaths = new URL('../vendor/ort/', self.location.href).href;
  const cores = (navigator && navigator.hardwareConcurrency) || 4;
  ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.max(1, Math.min(4, cores)) : 1;
  ort.env.wasm.proxy = false;
  ort.env.logLevel = 'error';
}

async function init() {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    setupOrt();
    postMessage({ type: 'init-progress', stage: 'vocab' });
    const vocabResp = await fetch(VOCAB_URL);
    if (!vocabResp.ok) throw new Error('加载词表失败 HTTP ' + vocabResp.status);
    tokenizer = createBertTokenizer(await vocabResp.text(), { maxLen: MAX_LEN, lower: true });
    postMessage({ type: 'init-progress', stage: 'model' });
    const t0 = Date.now();
    session = await ort.InferenceSession.create(MODEL_URL, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    });
    postMessage({ type: 'ready', vocabSize: tokenizer.size, loadMs: Date.now() - t0, threads: ort.env.wasm.numThreads });
  })();
  return initPromise;
}

function softmax(logits) {
  const n = logits.length;
  let max = -Infinity;
  for (let i = 0; i < n; i++) if (logits[i] > max) max = logits[i];
  let sum = 0;
  const out = new Array(n);
  for (let i = 0; i < n; i++) { out[i] = Math.exp(logits[i] - max); sum += out[i]; }
  for (let i = 0; i < n; i++) out[i] /= sum;
  return out;
}

async function scoreBatch(texts) {
  const b = tokenizer.encodeBatch(texts, MAX_LEN);
  const feeds = {
    input_ids: new ort.Tensor('int64', b.inputIds, [texts.length, b.seqLen]),
    attention_mask: new ort.Tensor('int64', b.attentionMask, [texts.length, b.seqLen]),
    token_type_ids: new ort.Tensor('int64', new BigInt64Array(texts.length * b.seqLen), [texts.length, b.seqLen]),
  };
  const out = await session.run(feeds);
  const logits = out.logits;
  const dims = logits.dims;
  const data = logits.data;
  const classes = dims[dims.length - 1];
  const result = [];
  for (let i = 0; i < texts.length; i++) {
    const row = new Array(classes);
    for (let j = 0; j < classes; j++) row[j] = data[i * classes + j];
    const probs = softmax(row);
    let best = 0;
    for (let j = 1; j < classes; j++) if (probs[j] > probs[best]) best = j;
    result.push({
      label: LABELS[best] || 'neu',
      score: probs[best],
      probs: { neg: probs[0], pos: probs[1], neu: probs[2] },
    });
  }
  return result;
}

async function run(reqId, texts) {
  await init();
  cancelled = false;
  const total = texts.length;
  const results = new Array(total);
  const t0 = Date.now();
  for (let i = 0; i < total; i += BATCH) {
    if (cancelled) { postMessage({ type: 'cancelled', reqId }); return; }
    const slice = texts.slice(i, i + BATCH);
    const scored = await scoreBatch(slice);
    for (let j = 0; j < scored.length; j++) results[i + j] = scored[j];
    postMessage({ type: 'progress', reqId, done: Math.min(total, i + BATCH), total, ms: Date.now() - t0 });
  }
  postMessage({ type: 'result', reqId, labels: results, ms: Date.now() - t0 });
}

self.addEventListener('message', (ev) => {
  const msg = ev.data || {};
  if (msg.type === 'init') {
    init().catch((e) => postMessage({ type: 'error', error: String((e && e.message) || e) }));
    return;
  }
  if (msg.type === 'run') {
    run(msg.reqId, msg.texts || []).catch((e) => postMessage({ type: 'error', reqId: msg.reqId, error: String((e && e.message) || e) }));
    return;
  }
  if (msg.type === 'cancel') { cancelled = true; }
});
