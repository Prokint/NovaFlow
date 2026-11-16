/* v0.9.48：极简 BERT WordPiece 分词器（从 vocab.txt 加载）。
 * 用于中文情感模型（weibo-BERT, BertTokenizer uncased）单文件离线推理；
 * 不依赖 transformers.js，避免额外 10MB 依赖。 */
(function (global) {
  'use strict';

  function isChineseChar(cp) {
    return (
      (cp >= 0x4e00 && cp <= 0x9fff) ||
      (cp >= 0x3400 && cp <= 0x4dbf) ||
      (cp >= 0x20000 && cp <= 0x2a6df) ||
      (cp >= 0x2a700 && cp <= 0x2b73f) ||
      (cp >= 0x2b740 && cp <= 0x2b81f) ||
      (cp >= 0x2b820 && cp <= 0x2ceaf) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0x2f800 && cp <= 0x2fa1f)
    );
  }

  // 常见中英文标点：这些字符按单字切分（与 HF 的 _is_punctuation 行为对齐）
  const PUNCT_RE = /[\u0021-\u002f\u003a-\u0040\u005b-\u0060\u007b-\u007e\u3000-\u303f\uff01-\uff0f\uff1a-\uff20\uff3b-\uff40\uff5b-\uff65\u2010-\u2027\u2030-\u205e\u00a1-\u00bf\u060c\u061b\u061f\u066a-\u066d\u06d4]|[^\u0000-\u007f\p{L}\p{N}]/u;

  function createBertTokenizer(vocabText, options) {
    const opts = options || {};
    const maxLen = opts.maxLen || 128;
    const doLower = opts.lower !== false;
    const vocab = new Map();
    const lines = String(vocabText).split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const w = lines[i];
      if (w) vocab.set(w, i);
    }
    const CLS = vocab.get('[CLS]') || 101;
    const SEP = vocab.get('[SEP]') || 102;
    const UNK = vocab.get('[UNK]') || 100;
    const PAD = vocab.get('[PAD]') || 0;

    function basicTokenize(text) {
      let s = String(text || '');
      s = s.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
      if (!s) return [];
      if (doLower) {
        s = s.normalize('NFD').replace(/\p{Mn}/gu, '').normalize('NFC').toLowerCase();
      }
      const out = [];
      let word = '';
      const flush = () => { if (word) { out.push(word); word = ''; } };
      for (const ch of s) {
        const cp = ch.codePointAt(0);
        if (ch === ' ') { flush(); continue; }
        if (isChineseChar(cp)) { flush(); out.push(ch); continue; }
        if (PUNCT_RE.test(ch)) { flush(); out.push(ch); continue; }
        word += ch;
      }
      flush();
      return out;
    }

    function wordpiece(token) {
      if (token.length > 100) return [UNK];
      const out = [];
      let start = 0;
      while (start < token.length) {
        let end = token.length;
        let cur = null;
        while (start < end) {
          let sub = token.slice(start, end);
          if (start > 0) sub = '##' + sub;
          if (vocab.has(sub)) { cur = sub; break; }
          end--;
        }
        if (!cur) return [UNK];
        out.push(cur);
        start = end;
      }
      return out;
    }

    function encodeOne(text, max) {
      const limit = (max || maxLen) - 2;
      const ids = [CLS];
      for (const tok of basicTokenize(text)) {
        const pieces = wordpiece(tok);
        for (const p of pieces) {
          if (ids.length - 1 >= limit) break;
          ids.push(vocab.has(p) ? vocab.get(p) : UNK);
        }
        if (ids.length - 1 >= limit) break;
      }
      ids.push(SEP);
      return ids;
    }

    /** 批量编码：返回 { inputIds: BigInt64Array[], attentionMask: BigInt64Array[], seqLen } 展开成批次用 */
    function encodeBatch(texts, max) {
      const limit = (max || maxLen) - 2;
      const encoded = [];
      for (let i = 0; i < texts.length; i++) {
        const ids = encodeOne(texts[i], max);
        if (limit > 0 && ids.length > limit + 2) ids.splice(limit + 1);
        encoded.push(ids);
      }
      const seqLen = encoded.reduce((m, ids) => Math.max(m, ids.length), 1);
      const b = encoded.length;
      const inputIds = new BigInt64Array(b * seqLen);
      const attentionMask = new BigInt64Array(b * seqLen);
      for (let i = 0; i < b; i++) {
        const ids = encoded[i];
        for (let j = 0; j < seqLen; j++) {
          const base = i * seqLen + j;
          if (j < ids.length) { inputIds[base] = BigInt(ids[j]); attentionMask[base] = 1n; }
          else { inputIds[base] = BigInt(PAD); attentionMask[base] = 0n; }
        }
      }
      return { inputIds, attentionMask, seqLen };
    }

    return { encodeOne, encodeBatch, size: vocab.size, special: { CLS, SEP, UNK, PAD } };
  }

  global.createBertTokenizer = createBertTokenizer;
})(typeof self !== 'undefined' ? self : globalThis);
