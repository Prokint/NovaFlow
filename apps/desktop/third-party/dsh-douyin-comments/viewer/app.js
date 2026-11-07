/* 评论分析台 · 词云 + 评论表（纯前端，无依赖）
 * 数据来源：抖音评论采集插件/扩展导出的 JSON / CSV（可整目录批量载入）
 * 隐私：全部在本机浏览器内处理，不发任何网络请求
 */
(function () {
  'use strict';

  /* ===================== 主题（深 / 浅，可手动切换） ===================== */
  const safeThemeParam = (name) => { try { return new URLSearchParams(location.search).get(name) || ''; } catch (e) { return ''; } };
  /* v0.8.2：手动切换优先（localStorage 记住），其次 ?theme=，最后跟随系统偏好；
     两个子页共用同一 key，切主题时另一个 iframe 通过 storage 事件同步 */
  (function themeBoot() {
    const KEY = 'dsh.douyin.theme';
    const asked = safeThemeParam('theme');
    let stored = '';
    try { stored = localStorage.getItem(KEY) || ''; } catch (e) { stored = ''; }
    const apply = (mode) => {
      const dark = mode !== 'light';
      document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
      const meta = document.querySelector('meta[name="theme-color"]');
      if (meta) meta.setAttribute('content', dark ? '#0b0b0c' : '#f5f6f8');
    };
    const current = () => (document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark');
    const mode = stored || asked || ((window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light');
    apply(mode);
    window.__douyinTheme = {
      key: KEY,
      get: current,
      set: (m) => { const v = m === 'light' ? 'light' : 'dark'; try { localStorage.setItem(KEY, v); } catch (e) { /* ignore */ } apply(v); return v; },
      toggle: () => { const next = current() === 'light' ? 'dark' : 'light'; try { localStorage.setItem(KEY, next); } catch (e) { /* ignore */ } apply(next); return next; },
    };
    window.addEventListener('storage', (e) => {
      if (e.key === KEY && e.newValue) apply(e.newValue === 'light' ? 'light' : 'dark');
    });
  })();

  /* ===================== 工具 ===================== */
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const PROFILE_BASE = 'https://www.douyin.com/user/';

  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const fmtNum = (n) => {
    n = Number(n) || 0;
    if (n >= 100000000) return (n / 100000000).toFixed(1).replace(/\.0$/, '') + ' 亿';
    if (n >= 10000) return (n / 10000).toFixed(1).replace(/\.0$/, '') + ' 万';
    return String(n);
  };

  const pad2 = (n) => (n < 10 ? '0' + n : String(n));
  const fmtTime = (ts) => {
    if (!ts) return '';
    const d = new Date(Number(ts) * (String(ts).length > 10 ? 1 : 1000));
    if (isNaN(d.getTime())) return '';
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  };
  const fmtTimeShort = (ts) => {
    const s = fmtTime(ts);
    return s ? s.slice(5) : '';
  };

  const profileOf = (user) => {
    const sec = user && user.secUid ? String(user.secUid).trim() : '';
    return sec ? PROFILE_BASE + encodeURIComponent(sec) : '';
  };

  const videoUrl = (videoId) => {
    const id = String(videoId || '').trim();
    if (!id) return '';
    const v = state.videos.get(id);
    if (v && v.url) return v.url;
    return 'https://www.douyin.com/video/' + encodeURIComponent(id);
  };

  let toastTimer = null;
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), 2200);
  }

  function debounce(fn, ms) {
    let t = null;
    return function () {
      const args = arguments, self = this;
      clearTimeout(t);
      t = setTimeout(() => fn.apply(self, args), ms);
    };
  }

  const initials = (name) => {
    const s = String(name || '').trim();
    if (!s) return '?';
    return s.slice(0, 1).toUpperCase();
  };

  // 每个用户一个稳定的淡色头像底（按昵称/ID 散列取色），只用淡色、不参与数据配色
  const avatarHue = (user) => {
    const key = String((user && (user.secUid || user.uid || user.nickname)) || '');
    let h = 0;
    for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) % 360;
    return h;
  };
  const avatarStyle = (user) => {
    const h = avatarHue(user);
    // v0.8.1：浅色主题下淡底深字，避免深色块糊在白色页面上
    const light = document.documentElement.getAttribute('data-theme') === 'light';
    return light
      ? `background:hsl(${h} 42% 93%);color:hsl(${h} 45% 30%)`
      : `background:hsl(${h} 16% 18%);color:hsl(${h} 30% 78%)`;
  };

  /* ===================== 状态 ===================== */
  const state = {
    comments: [],              // 全部评论（已归一化、已去重）
    videos: new Map(),         // videoId -> { id, title, url, collectedAt }
    sources: [],               // 已载入文件名
    filters: { videoId: '', search: '', onlyHasProfile: false, onlyTopLevel: false, onlyNonEmpty: false, onlyContent: true, sentiment: '', topic: '', region: '', favoritesOnly: false },
    favorites: new Map(),      // v0.7.0：已收藏目标客户 uid -> { uid, nickname, region, savedAt, … }
    favReady: false,
    topics: [],                // v3.0：主题聚类结果（TF-IDF + k-means）
    topicBusy: false,
    kwKeep: [],               // v0.5.41：自定义加词（长词优先，避免被切碎）
    kwBlock: [],              // v0.5.41：自定义屏蔽词
    sort: 'digg',
    page: 1,
    pageSize: 50,
    words: [],
    wordMap: new Map(),        // word -> { word, count, cids:Set }
    lastWord: '',
    cloudReady: false,
    hoverWord: '',
  };

  /* v0.5.41：自定义加词 / 屏蔽词存在 localStorage（只在本机，不上传） */
  try {
    state.kwKeep = JSON.parse(localStorage.getItem('cw.kw.keep') || '[]') || [];
    state.kwBlock = JSON.parse(localStorage.getItem('cw.kw.block') || '[]') || [];
  } catch (e) { state.kwKeep = []; state.kwBlock = []; }

  /* ===================== CSV 解析 ===================== */
  function parseCsv(text) {
    text = String(text || '').replace(/^\uFEFF/, '');
    const rows = [];
    let row = [], field = '', inQuotes = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (inQuotes) {
        if (ch === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; }
          else inQuotes = false;
        } else field += ch;
      } else if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        row.push(field); field = '';
      } else if (ch === '\r') {
        if (text[i + 1] === '\n') i++;
        row.push(field); field = '';
        rows.push(row); row = [];
      } else if (ch === '\n') {
        row.push(field); field = '';
        rows.push(row); row = [];
      } else field += ch;
    }
    if (field.length || row.length) { row.push(field); rows.push(row); }
    // 去掉首格为 # 的中文说明行 / 空行
    return rows.filter((r) => {
      if (!r.length) return false;
      const first = String(r[0] == null ? '' : r[0]).trim();
      if (first.startsWith('#')) return false;
      if (r.every((c) => String(c == null ? '' : c).trim() === '')) return false;
      return true;
    });
  }

  function num(v) { const n = Number(String(v == null ? '' : v).trim()); return isFinite(n) ? n : 0; }

  /* ===================== 归一化 ===================== */
  function normalizeUser(u) {
    u = u || {};
    return {
      nickname: String(u.nickname || '').trim() || '匿名用户',
      uid: u.uid ? String(u.uid) : '',
      secUid: u.sec_uid ? String(u.sec_uid) : (u.secUid ? String(u.secUid) : ''),
      uniqueId: u.unique_id ? String(u.unique_id) : (u.uniqueId ? String(u.uniqueId) : ''),
      shortId: u.short_id ? String(u.short_id) : (u.shortId ? String(u.shortId) : ''),
    };
  }

  // v2.4：导出数据本来就带清洗后的文本（`text_clean`，去表情/@/#，扩展的 cleanText() 生成）。
  // 分词优先用它；老数据/快照没有该字段时，再在 tokensOf() 里剥 [表情] 兜底。
  function cleanForTokens(raw, text) {
    const cleaned = String(raw.text_clean != null ? raw.text_clean : (raw.textClean != null ? raw.textClean : '')).trim();
    if (cleaned) return cleaned;
    return String(text || '');
  }

  /* v0.5.56：「店透视」对未填写评价的买家会写入平台默认文案，
     这类文本不代表买家真实表达，单独标记后不参与词云/主题，情感改用评价类型兜底。*/
  const PLACEHOLDER_RE = /^该用户觉得商品.{0,8}(好|好评|不错|一般|差|5星|五星)/;
  function isPlaceholderText(text) {
    const s = String(text || '').trim();
    if (!s) return false;
    if (PLACEHOLDER_RE.test(s)) return true;
    return /^(此用户未填写评价|用户未及时作出评价|系统默认评价|该用户未填写评价)/.test(s);
  }

  function normalizeComment(raw, meta) {
    raw = raw || {};
    const text = String(raw.text != null ? raw.text : (raw.text_clean || raw.content || '')).trim();
    const cid = String(raw.cid || raw.comment_id || '');
    const user = normalizeUser(raw.user || {
      nickname: raw.user_nickname, uid: raw.user_uid, sec_uid: raw.user_sec_uid,
      unique_id: raw.user_unique_id, short_id: raw.user_short_id,
    });
    const videoId = String(raw.videoId || raw.video_id || meta.videoId || '');
    return {
      cid,
      videoId,
      videoTitle: meta.title || '',
      text,
      textClean: cleanForTokens(raw, text),
      digg: num(raw.digg_count != null ? raw.digg_count : raw.digg),
      replies: num(raw.reply_comment_total != null ? raw.reply_comment_total : raw.replies),
      ip: String(raw.ip_label || ''),
      createTime: num(raw.create_time),
      createTimeStr: String(raw.create_time_str || fmtTime(raw.create_time) || ''),
      isReply: raw.is_reply === true || String(raw.is_reply) === '1' || String(raw.is_reply).toLowerCase() === 'true' || num(raw.level) > 1,
      level: num(raw.level) || 1,
      isHot: raw.is_hot === true || String(raw.is_hot) === '1',
      isFolded: raw.is_folded === true || String(raw.is_folded) === '1',
      // v3.2：淘宝「店透视」表带的额外维度（抖音数据没有这几项，缺省为空）
      rating: String(raw.rating == null ? '' : raw.rating),
      sku: String(raw.sku == null ? '' : raw.sku),
      images: num(raw.images),
      // v0.5.56：占位文案（平台系统默认评价）标记
      textPlaceholder: isPlaceholderText(text),
      user,
    };
  }

  /* ===================== 载入数据 ===================== */
  function addComments(list) {
    let added = 0;
    const seen = new Set(state.comments.map((c) => c.videoId + '|' + c.cid));
    for (const c of list) {
      if (!c.text && !c.user.nickname) continue;
      const key = c.videoId + '|' + c.cid;
      if (c.cid && seen.has(key)) continue;
      seen.add(key);
      state.comments.push(c);
      added++;
    }
    return added;
  }

  function ingestJson(text, fileName) {
    let obj;
    try { obj = JSON.parse(String(text).replace(/^\uFEFF/, '')); }
    catch (e) { toast('JSON 解析失败：' + fileName); return -1; }
    let arr = null, meta = { videoId: '', title: '' };
    if (Array.isArray(obj)) arr = obj;
    else if (obj && Array.isArray(obj.comments)) {
      arr = obj.comments;
      meta.videoId = String(obj.videoId || obj.video_id || '');
      meta.title = String(obj.title || '');
    } else if (obj && obj.data && Array.isArray(obj.data.comments)) {
      arr = obj.data.comments;
    }
    if (!arr) { toast('这个 JSON 里没有 comments 数组：' + fileName); return -1; }
    if (meta.videoId) {
      state.videos.set(meta.videoId, {
        id: meta.videoId, title: meta.title || '视频 ' + meta.videoId.slice(-8),
        url: obj.url || ('https://www.douyin.com/video/' + meta.videoId),
        collectedAt: obj.collectedAt || '',
      });
    }
    const list = arr.map((c) => normalizeComment(c, meta));
    return addComments(list);
  }

  function ingestCsv(text, fileName) {
    const rows = parseCsv(text);
    if (!rows.length) { toast('CSV 是空的：' + fileName); return -1; }
    const header = rows[0].map((h) => String(h || '').trim());
    const idx = {};
    header.forEach((h, i) => { idx[h] = i; });
    if (idx.cid == null && idx.text == null) { toast('这不是评论导出 CSV：' + fileName); return -1; }
    const hasVideoCol = idx.video_id != null;
    let curMeta = { videoId: '', title: '' };
    if (!hasVideoCol) {
      // 单视频 CSV：从文件名里取 videoId
      const m = String(fileName || '').match(/(\d{15,25})/);
      if (m) {
        curMeta.videoId = m[1];
        if (!state.videos.has(m[1])) {
          state.videos.set(m[1], { id: m[1], title: '视频 ' + m[1].slice(-8), url: 'https://www.douyin.com/video/' + m[1], collectedAt: '' });
        }
      }
    }
    const get = (r, key) => (idx[key] != null ? r[idx[key]] : '');
    const list = [];
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      const vid = hasVideoCol ? String(get(r, 'video_id') || '').trim() : curMeta.videoId;
      if (hasVideoCol && vid && !state.videos.has(vid)) {
        state.videos.set(vid, { id: vid, title: '视频 ' + vid.slice(-8), url: 'https://www.douyin.com/video/' + vid, collectedAt: '' });
      }
      const meta = { videoId: vid, title: (state.videos.get(vid) || {}).title || '' };
      list.push(normalizeComment({
        cid: get(r, 'cid'),
        text: get(r, 'text') || get(r, 'text_clean'),
        text_clean: get(r, 'text_clean'),
        digg_count: get(r, 'digg_count'),
        reply_comment_total: get(r, 'reply_comment_total'),
        ip_label: get(r, 'ip_label'),
        create_time: get(r, 'create_time'),
        create_time_str: get(r, 'create_time_str'),
        is_reply: get(r, 'is_reply'),
        level: get(r, 'level'),
        is_hot: get(r, 'is_hot'),
        is_folded: get(r, 'is_folded'),
        user_nickname: get(r, 'user_nickname'),
        user_uid: get(r, 'user_uid'),
        user_sec_uid: get(r, 'user_sec_uid'),
        user_unique_id: get(r, 'user_unique_id'),
        user_short_id: get(r, 'user_short_id'),
      }, meta));
    }
    return addComments(list);
  }


  /* ===================== v3.2：xlsx 直读（店透视淘宝评价表） ===================== */
  // 只依赖浏览器内置能力：ZIP（本地文件头 + central directory）、DecompressionStream('deflate-raw')、DOMParser。
  function readU32(dv, off) { return dv.getUint32(off, true); }
  async function inflateRaw(bytes) {
    if (typeof DecompressionStream === 'undefined') throw new Error('当前浏览器不支持 DecompressionStream');
    const ds = new DecompressionStream('deflate-raw');
    const stream = new Blob([bytes]).stream().pipeThrough(ds);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  async function unzip(buf) {
    const dv = new DataView(buf);
    let eocd = -1;
    for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 65558); i--) {
      if (readU32(dv, i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('不是有效的 xlsx（找不到 ZIP 目录）');
    const count = dv.getUint16(eocd + 10, true);
    let off = readU32(dv, eocd + 16);
    const dec = new TextDecoder('utf-8');
    const out = new Map();
    for (let n = 0; n < count; n++) {
      if (readU32(dv, off) !== 0x02014b50) break;
      const method = dv.getUint16(off + 10, true);
      const compSize = readU32(dv, off + 20);
      const nameLen = dv.getUint16(off + 28, true);
      const extraLen = dv.getUint16(off + 30, true);
      const cmtLen = dv.getUint16(off + 32, true);
      const localOff = readU32(dv, off + 42);
      const name = dec.decode(new Uint8Array(buf, off + 46, nameLen));
      if (readU32(dv, localOff) === 0x04034b50) {
        const lName = dv.getUint16(localOff + 26, true);
        const lExtra = dv.getUint16(localOff + 28, true);
        const start = localOff + 30 + lName + lExtra;
        const raw = new Uint8Array(buf, start, compSize);
        out.set(name, { method, raw });
      }
      off += 46 + nameLen + extraLen + cmtLen;
    }
    return out;
  }
  async function zipText(zip, name) {
    const ent = zip.get(name);
    if (!ent) return '';
    const bytes = ent.method === 0 ? ent.raw : await inflateRaw(ent.raw);
    return new TextDecoder('utf-8').decode(bytes);
  }
  function colIndex(ref) {
    const m = /^([A-Z]+)/.exec(String(ref || ''));
    if (!m) return -1;
    let n = 0;
    for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
    return n - 1;
  }
  function parseSharedStrings(xml) {
    if (!xml) return [];
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    return Array.from(doc.getElementsByTagName('si')).map((si) =>
      Array.from(si.getElementsByTagName('t')).map((t) => t.textContent || '').join(''));
  }
  function parseSheet(xml, shared) {
    if (!xml) return [];
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    const rows = [];
    for (const row of Array.from(doc.getElementsByTagName('row'))) {
      const r = Number(row.getAttribute('r') || rows.length + 1) - 1;
      const cells = [];
      for (const c of Array.from(row.getElementsByTagName('c'))) {
        const ci = colIndex(c.getAttribute('r'));
        if (ci < 0) continue;
        const t = c.getAttribute('t') || '';
        let v = '';
        if (t === 'inlineStr') {
          v = Array.from(c.getElementsByTagName('t')).map((x) => x.textContent || '').join('');
        } else {
          const vNode = c.getElementsByTagName('v')[0];
          const raw = vNode ? (vNode.textContent || '') : '';
          v = t === 's' ? (shared[Number(raw)] || '') : raw;
        }
        cells[ci] = v;
      }
      rows[r] = cells;
    }
    for (let i = 0; i < rows.length; i++) if (!rows[i]) rows[i] = [];
    return rows;
  }
  async function readXlsxRows(buf) {
    const zip = await unzip(buf);
    const wb = await zipText(zip, 'xl/workbook.xml');
    const rels = await zipText(zip, 'xl/_rels/workbook.xml.rels');
    const shared = parseSharedStrings(await zipText(zip, 'xl/sharedStrings.xml'));
    // 取第一张 sheet 的路径（workbook.xml 的 r:id → rels 的 Target）
    let sheetPath = 'xl/worksheets/sheet1.xml';
    const doc = new DOMParser().parseFromString(wb || '<workbook/>', 'application/xml');
    const sheetEl = doc.getElementsByTagName('sheet')[0];
    const rid = sheetEl ? (sheetEl.getAttribute('r:id') || sheetEl.getAttribute('id') || '') : '';
    if (rid && rels) {
      const rdoc = new DOMParser().parseFromString(rels, 'application/xml');
      for (const rel of Array.from(rdoc.getElementsByTagName('Relationship'))) {
        if (rel.getAttribute('Id') === rid) {
          const target = rel.getAttribute('Target') || '';
          sheetPath = target.startsWith('/') ? target.slice(1) : ('xl/' + target.replace(/^[.][/]/, ''));
          break;
        }
      }
    }
    let xml = await zipText(zip, sheetPath);
    if (!xml) xml = await zipText(zip, 'xl/worksheets/sheet1.xml');
    return parseSheet(xml, shared);
  }
  // 表头识别：店透视「旺旺号/初评时间/评价类型/SKU/初评」；也兼容通用「评价内容/买家昵称」类表
  function detectTable(rows) {
    const HEAD_KEYS = ['旺旺号', '初评', '评价内容', '评论内容', '买家昵称', '评价时间', '评价类型', 'SKU'];
    for (let i = 0; i < Math.min(rows.length, 12); i++) {
      const cells = rows[i].map((c) => String(c || '').trim());
      const hits = HEAD_KEYS.filter((k) => cells.some((c) => c === k || c.indexOf(k) >= 0)).length;
      if (hits >= 3) {
        const idx = {};
        cells.forEach((c, j) => {
          if (c && idx[c] == null) idx[c] = j;
        });
        return { headerRow: i, header: cells, idx };
      }
    }
    return null;
  }
  // v3.2.1：先精确匹配，再按「名称包含 + 关键词最短」匹配，并可排除某些列。
  // 修 bug：表头里 `初评时间` 在 `初评` 之前，旧实现会把「初评时间」当成正文列，导致分析台把日期当评论。
  function pickIndex(idx, names, exclude) {
    const keys = Object.keys(idx);
    for (const n of names) if (idx[n] != null) return idx[n];
    for (const n of names) {
      const cands = keys.filter((k) => k.indexOf(n) >= 0 && !(exclude && exclude.some((x) => k.indexOf(x) >= 0)));
      cands.sort((a, b) => a.length - b.length);
      if (cands.length) return idx[cands[0]];
    }
    return -1;
  }
  function cellAt(row, i) { return i >= 0 && i < row.length ? String(row[i] == null ? '' : row[i]).trim() : ''; }
  function parseDayEpoch(s) {
    const m = /^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(String(s || ''));
    if (!m) return { epoch: 0, day: '' };
    const d = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] || 0), Number(m[5] || 0), Number(m[6] || 0));
    return { epoch: Math.floor(d / 1000), day: m[1] + '-' + String(m[2]).padStart(2, '0') + '-' + String(m[3]).padStart(2, '0') };
  }
  function ingestTaobaoRows(rows, fileName) {
    const t = detectTable(rows);
    if (!t) { toast('没认出这张表的表头（需要包含 旺旺号/初评 或 评价内容/买家昵称 等列）：' + fileName); return -1; }
    const { headerRow, idx } = t;
    const iNick = pickIndex(idx, ['旺旺号', '买家昵称', '用户昵称', '昵称'], ['时间', '类型']);
    const iTime = pickIndex(idx, ['初评时间', '评价时间', '评论时间', '时间']);
    const iText = pickIndex(idx, ['初评', '评价内容', '评论内容', '内容'], ['时间', '类型', '晒图', '图片', '追评']);
    const iType = pickIndex(idx, ['评价类型', '评分'], ['时间']);
    const iSku = pickIndex(idx, ['SKU', '规格'], ['时间']);
    const iUse = pickIndex(idx, ['有用', '点赞'], ['时间']);
    const iImg = pickIndex(idx, ['晒图', '图片'], ['时间']);
    const iCid = pickIndex(idx, ['评论ID', '评价ID', 'cid']);
    const m = String(fileName || '').match(/(\d{6,})/);
    const pid = m ? m[1] : (String(fileName || '').replace(/\.[^.]+$/, '') || 'taobao');
    const videoId = 'tb' + pid;
    if (!state.videos.has(videoId)) {
      state.videos.set(videoId, {
        id: videoId,
        title: '淘宝商品 ' + pid + '（店透视评价导出）',
        url: 'https://item.taobao.com/item.htm?id=' + pid,
        collectedAt: '',
      });
    }
    const meta = { videoId, title: (state.videos.get(videoId) || {}).title || '' };
    const list = [];
    let seq = 0;
    for (let i = headerRow + 1; i < rows.length; i++) {
      const row = rows[i] || [];
      const text = cellAt(row, iText);
      const nick = cellAt(row, iNick);
      if (!text && !nick) continue;
      seq++;
      const { epoch, day } = parseDayEpoch(cellAt(row, iTime));
      const timeStr = day || cellAt(row, iTime);
      let imgCount = 0;
      const imgRaw = cellAt(row, iImg);
      if (imgRaw && imgRaw.trim().startsWith('[')) {
        try { const arr = JSON.parse(imgRaw); imgCount = Array.isArray(arr) ? arr.length : 0; } catch (_) { imgCount = 0; }
      }
      const cid = cellAt(row, iCid) || ('tb-' + seq + '-' + String(nick + timeStr + text).length);
      list.push(normalizeComment({
        cid,
        text,
        digg_count: cellAt(row, iUse),
        create_time: epoch,
        create_time_str: timeStr,
        level: 1,
        rating: cellAt(row, iType),
        sku: cellAt(row, iSku),
        images: imgCount,
        user_nickname: nick,
      }, meta));
    }
    return addComments(list);
  }
  async function ingestXlsx(file) {
    const buf = await file.arrayBuffer();
    let rows;
    try { rows = await readXlsxRows(buf); }
    catch (e) { toast('xlsx 解析失败：' + file.name + '（' + ((e && e.message) || e) + '）'); return -1; }
    if (!rows.length) { toast('这个表格是空的：' + file.name); return -1; }
    return ingestTaobaoRows(rows, file.name);
  }

  async function loadFiles(fileList) {
    const files = Array.from(fileList || []).filter((f) => /\.(json|csv|xlsx)$/i.test(f.name));
    if (!files.length) { toast('没有找到 .json / .csv / .xlsx 文件'); return; }
    setLoading(true);
    let total = 0;
    const names = [];
    for (const f of files) {
      try {
        let n;
        if (/\.xlsx$/i.test(f.name)) {
          n = await ingestXlsx(f);
        } else {
          const text = await f.text();
          n = /\.json$/i.test(f.name) ? ingestJson(text, f.name) : ingestCsv(text, f.name);
        }
        if (n >= 0) {
          total += n;
          names.push(f.name);
        }
      } catch (e) {
        console.warn('读取失败', f.name, e);
      }
    }
    state.sources = state.sources.concat(names);
    updateScope();
    updateEmptyState();
    $('#btnClear').disabled = state.comments.length === 0;
    if (total > 0) toast(`载入 ${total} 条评论（${names.length} 个文件）`);
    else toast('没有新增评论（可能是重复文件）');
    setLoading(false);
    refreshAll();
  }

  /* ===================== 过滤 ===================== */
  function filtered() {
    const f = state.filters;
    const q = f.search.trim().toLowerCase();
    return state.comments.filter((c) => {
      if (f.videoId && c.videoId !== f.videoId) return false;
      if (f.onlyHasProfile && !profileOf(c.user)) return false;
      if (f.onlyTopLevel && c.isReply) return false;
      if (f.onlyNonEmpty && !c.text) return false;
      // v3.0：情感 / 主题筛选（主题由 baseFiltered 的聚类结果给出，避免自我循环）
      if (f.sentiment && ((c.sentiment && c.sentiment.label) || 'neu') !== f.sentiment) return false;
      if (f.topic !== '' && f.topic != null && String(c.topic == null ? -1 : c.topic) !== String(f.topic)) return false;
      // v0.7.0：属地筛选 + 只看已收藏客户
      if (f.region) { const r = c.ip || '未知属地'; if (r !== f.region) return false; }
      if (f.favoritesOnly && !(c.user.uid && state.favorites.has(String(c.user.uid)))) return false;
      if (q) {
        const hay = (c.text + ' ' + c.user.nickname + ' ' + c.user.uniqueId + ' ' + c.ip).toLowerCase();
        if (hay.indexOf(q) === -1) return false;
      }
      return true;
    });
  }

  // v3.0：不含情感/主题的“基础筛选”，主题聚类与洞察面板都基于它，避免筛选后主题编号漂移
  function baseFiltered() {
    const savedS = state.filters.sentiment, savedT = state.filters.topic;
    state.filters.sentiment = ''; state.filters.topic = '';
    const out = filtered();
    state.filters.sentiment = savedS; state.filters.topic = savedT;
    return out;
  }

  /* ===================== 分词 ===================== */
  const STOPWORDS = new Set((
    '的 了 是 在 我 你 他 她 它 们 这 那 有 和 就 都 也 又 还 要 会 能 可以 不是 没有 一个 这个 那个 ' +
    '什么 怎么 为什么 因为 所以 但是 然后 而且 如果 就是 这样 那样 这么 那么 自己 我们 你们 他们 ' +
    '她们 它们 人家 别人 大家 真的 真是 确实 其实 应该 可能 觉得 感觉 知道 看到 看过 听到 时候 ' +
    '现在 之前 以后 一样 一直 已经 还是 只是 不过 有点 一点 一些 这些 那些 多少 几个 一次 一下 ' +
    '评论 回复 视频 抖音 作者 楼主 主播 up 啊 吧 呢 吗 呀 哦 嗯 哈 啦 嘛 哇 呵 嘿 诶 哎 唉 么 ' +
    '哇塞 哈哈哈 哈哈哈哈 呵呵 嘿嘿 666 233 999 111 1111 2333 555 干嘛 咋 咱 俺 啥 嘞 咯 嗷 呜 喵 ' +
  '必须 直接 肯定 一定 主要 以及 中的 的话 之类 等等 以为 希望 想要 需要 为了 要是 还有 才有 都要 没了 不对 一句 一段 一眼 看完 出来 上去 下去 起来 下来 过去 回去 以前 之后 刚才 马上 立刻 终于 甚至 反而 竟然 居然 果然 依然 仍然 偶尔 总是 经常 有时 从来 一向 还要 会不会 能不能 是不是 有没有 怎么办 怎么样 什么时候 干什么 什么样 什么的 或者 来说 来讲 似的 一般 差不多 一会 一下 一起 这种 那种 哪种 各种 这种 都是 才是 也是 还是 只是 就是 而是 于是 但是 可是 因此 所以 如果 虽然 不管 无论 即使 尽管 只要 只有 除了 关于 对于 由于 按照 根据 通过 经过 沿着 随着 直到 等到'
  ).split(/\s+/).filter(Boolean));

  /* v0.5.41：按社区做法（jieba 系 + 中文停用词四表的口径）补齐常见泛词，
   * 让「真的 / 感觉 / 很多 / 这种 / 都是」这类词在词云里自然消失。 */
  for (const w of (
    '真的 感觉 觉得 知道 认为 以为 希望 想要 需要 应该 必须 一定 肯定 估计 可能 或许 大概 差不多 几乎 简直 实在 确实 其实 本来 原来 果然 竟然 居然 反而 甚至 尤其 特别 非常 十分 相当 比较 稍微 略微 更加 越来越 太多 好多 很多 不少 有些 挺多 一堆 一大 全都 全部 整个 所有 每个 任何 某些 其他 其它 剩下 别的 另外 此外 而且 并且 或者 还不如 不如 要不 不然 否则 因此 所以 于是 然后 接着 随后 最后 首先 其次 总之 反正 究竟 到底 毕竟 何况 况且 再说 至于 关于 对于 根据 按照 依照 通过 经过 凭借 由于 因为 为了 除了 除非 即使 即便 哪怕 无论 不管 不论 只要 虽然 尽管 但是 可是 不过 然而 只是 就算 如果 要是 假如 万一 一旦 直到 等到 每当 之前 之后 以前 以后 现在 目前 当时 那时 这时 此时 同时 立刻 马上 立即 刚刚 刚才 已经 曾经 从来 一向 一直 始终 总是 经常 常常 时常 有时 偶尔 很少 从不 再次 重新 继续 仍然 依然 依旧 仍旧 还要 还没 还没有 不用 不要 不能 不会 不敢 不想 不需要 说不定 不一定 不可能 不错 不好 好看 不起 老是 不知道 不打 还好 好听 好玩 可爱 漂亮 厉害 牛逼 牛批 牛皮 离谱 逆天 绝了 完了 笑死 笑了 感动 无语 服了 麻了 破防 上头 东西 事情 时候 时间 地方 方式 方法 方面 问题 情况 样子 意思 内容 部分 结果 原因 感觉 心里 希望 想法 办法 事情 过程 水平 大家 大家伙 各位 咱们 我们 你们 他们 她们 它们 自己 别人 人家 有人 没人 谁都 什么 啥 咋 咋样 怎么办 怎么样 什么样 为什么 为啥 什么时候 哪里 哪儿 这里 那里 这边 那边 这样 那样 这么 那么 这种 那种 哪种 这些 那些 哪些 这个 那个 哪个 一次 一下 一会 一起 一直 一边 一样 一般 一致 一切 一共 一点 一半 一天 一年 一句 一段 一条 一遍 一层 一群 一批 一部分 一方面 双方 彼此 互相 相互 各种 各自 每次 每天 每年 某个 某些 是不是 有没有 要不要 会不会 能不能 对不对 好不好 行不行 可不可以 有没有人 我说 你说 他说 她说 我说真的 我觉 你们觉得 我觉得 说实话 说真的 说白了 换句话说 也就是 也就是说 也就是说 另一方面 与此同时 除此之外 不仅如此 由此可见 总的来说 简单说 总之 唉 哎 哎呀 哎哟 天哪 天啊 我的天 妈呀 卧槽 我靠 哈哈哈 哈哈 呵呵 嘿嘿 嘻嘻 么么 哇哦 嗯嗯 对对 好好 是是 行行 可以可以 谢谢 感谢 多谢 辛苦 支持 关注 收藏 转发 分享 弹幕 直播 主播 作者 楼主 老铁 兄弟 姐姐 哥哥 妹妹 弟弟 朋友 视频 评论 回复 点赞 投币 三连 关注了 已关注 取关 前排 沙发 板凳 路过 打卡 签到 首次 第一次 上次 下次 这次 那次 刚才 刚刚 突然 忽然 立刻 最终 终于 好像 似乎 显然 明显 确实 的确 真的 真是 简直 完全 全部 整体 总体'
  ).split(/\s+/)) if (w) STOPWORDS.add(w);

  /* v0.5.40：只看虚词字符组成的词直接丢掉（都是 / 这种 / 我的 / 出来 / 中的…）。
   * 依据是「实词至少有一个非虚词字符」，这样不用维护几千条停用词也能过滤掉大部分口头词。 */
  const FUNCTION_CHARS = new Set(('的是我你他她它们这那个也就都还又和与在有不会能可要什么怎样些点时候一二三不没很太更最对错上下中内外到说看想做去来出进过回从被把给跟于为以因此所以就而且并且但是然后如果虽然不过只是当然因为所以着了吧呢吗啊呀哦嗯啦嘛哇种才里完句直真错对同再又').split(''));
  function isFunctionOnly(t) {
    for (const ch of t) if (!FUNCTION_CHARS.has(ch)) return false;
    return true;
  }

  let segmenter = null;
  try {
    if (typeof Intl !== 'undefined' && Intl.Segmenter) segmenter = new Intl.Segmenter('zh-Hans', { granularity: 'word' });
  } catch (e) { segmenter = null; }

  function tokensOf(text) {
    const out = [];
    // v2.3：抖音表情是 [憨笑] [流泪] 这种方括号标签文本，直接分词会把标签名当成词（点进去只有一条「[悲伤]」）。
    // 分词前先把方括号标签剥掉，纯表情评论因此不贡献任何关键词。
    const s = String(text || '').replace(/\[[^\[\]]{1,12}\]/g, ' ');
    if (!s.trim()) return out;
    if (segmenter) {
      for (const seg of segmenter.segment(s)) {
        if (!seg.isWordLike) continue;
        out.push(seg.segment);
      }
    } else {
      // 兜底：中文取 2-gram，英文/数字按词
      const parts = s.match(/[A-Za-z][A-Za-z0-9'+.-]*|\d+(?:\.\d+)?|[\u4e00-\u9fff]+/g) || [];
      for (const p of parts) {
        if (/^[\u4e00-\u9fff]+$/.test(p)) {
          if (p.length === 1) out.push(p);
          else for (let i = 0; i + 2 <= p.length; i++) out.push(p.slice(i, i + 2));
        } else out.push(p);
      }
    }
    // v0.5.41：自定义加词——Intl.Segmenter 没有词典，会把「酒池肉林」切成「酒池 / 肉林」，
    // 用户把整词加进来后，只要原文里出现就按整词计一次（每条评论内仍去重）。
    if (state.kwKeep && state.kwKeep.length) {
      const low = s.toLowerCase();
      for (const kw of state.kwKeep) if (kw && low.indexOf(kw) >= 0) out.push(kw);
    }
    return out;
  }

  function cleanToken(w, strict) {
    let t = String(w || '').trim();
    if (!t) return '';
    t = t.replace(/[\s\u3000]+/g, '');
    if (!t) return '';
    if (/^[\d.,%+\-/:]+$/.test(t)) return '';
    if (/^[A-Za-z]+$/.test(t)) t = t.toLowerCase();
    if (t.length < 2) return '';
    if (strict !== false) {
      if (STOPWORDS.has(t.toLowerCase())) return '';
      if (isFunctionOnly(t)) return '';      // v0.5.40：这种 / 都是 / 我的 …
    }
    if (/^(.)\1{2,}$/.test(t)) return '';       // 啊啊啊
    return t;
  }

  function parseWordList(v) {
    const out = [];
    for (const raw of String(v || '').split(/[,，、;；\s]+/)) {
      const t = raw.trim().toLowerCase();
      if (t.length >= 2 && out.indexOf(t) === -1) out.push(t);
    }
    return out.slice(0, 200);
  }

  function applyWordLists() {
    const keepEl = $('#kwKeep'), blockEl = $('#kwBlock');
    state.kwKeep = parseWordList(keepEl ? keepEl.value : '');
    state.kwBlock = parseWordList(blockEl ? blockEl.value : '');
    try {
      localStorage.setItem('cw.kw.keep', JSON.stringify(state.kwKeep));
      localStorage.setItem('cw.kw.block', JSON.stringify(state.kwBlock));
    } catch (e) {}
    refreshAll();
  }

  function buildWords(comments) {
    const map = new Map();
    const blockSet = new Set(state.kwBlock || []);
    const keepSet = new Set(state.kwKeep || []);
    let docN = 0;
    for (const c of comments) if (c.text && !c.textPlaceholder) docN++;
    for (const c of comments) {
      if (!c.text || c.textPlaceholder) continue;
      const seen = new Set();
      for (const raw of tokensOf(c.textClean || c.text)) {
        const isKeep = keepSet.has(String(raw || '').toLowerCase());
        const w = isKeep ? String(raw).toLowerCase() : cleanToken(raw, state.filters.onlyContent !== false);
        if (!w || seen.has(w) || blockSet.has(w)) continue;
        seen.add(w);
        let rec = map.get(w);
        if (!rec) { rec = { word: w, count: 0, weight: 0, ratio: 0, generic: false, cids: new Set(), users: new Set() }; map.set(w, rec); }
        rec.count++;
        if (c.cid) rec.cids.add(c.cid);
        rec.users.add(c.user.secUid || c.user.uid || c.user.nickname);
      }
    }
    // v0.5.41：轻量 IDF（对标 jieba.analyse 的 TF-IDF 思路，但只用本视频语料，不用外部语料）：
    //   weight = df * log(1 + N / df)，N = 有文字的评论数
    // 同时把「这条视频里到处都在说」的泛词（df/N > 40% 且样本 ≥ 30 条）直接剔除。
    const out = [];
    for (const rec of map.values()) {
      rec.ratio = docN ? rec.count / docN : 0;
      rec.weight = rec.count * Math.log(1 + (docN || 1) / Math.max(1, rec.count));
      rec.generic = docN >= 30 && rec.ratio > 0.4;
      if (!rec.generic) out.push(rec);
    }
    return out.sort((a, b) => b.weight - a.weight || b.count - a.count || a.word.localeCompare(b.word));
  }

  /* ===================== 情感分析（v3.0） =====================
   * 纯本地词典法：正向/负向词表（分级权重）+ 程度副词提升 + 否定词翻转 + 抖音表情标签。
   * 不联网、不调模型，结果可解释；输出挂在评论上：c.sentiment = { score, label, hits }。
   */
  const SENT_POS_STRONG = new Set(('太棒 牛逼 绝了 神作 惊艳 完美 精彩 厉害 高能 真香 给力 宝藏 神器 顶 爱了 圈粉 封神 天花板 牛逼克拉斯 大佬 佩服 五体投地 神评 笑死'.split(/\s+/)));
  const SENT_POS = new Set(('好 赞 棒 强 牛 喜欢 爱 支持 感谢 感动 治愈 暖心 温柔 靠谱 良心 专业 优秀 燃 爽 香 甜 不错 挺好 蛮好 中肯 客观 理性 真实 实在 清楚 明白 简洁 干净 顺畅 稳定 实用 有用 值得 推荐 安利 好用 期待 开心 快乐 高兴 兴奋 满意 舒服 舒适 好看 好听 好玩 可爱 漂亮 帅 美 有趣 搞笑 好笑 感人 贴心 用心 细致 耐心 认真 高手 内行 尊敬 涨知识 学到 受教 好评 有质感 有诚意 有干货 硬核'.split(/\s+/)));
  const SENT_NEG_STRONG = new Set(('垃圾 恶心 恶心人 烂 骗子 欺骗 智障 弱智 傻逼 恶臭 反感 讨厌 恨 愤怒 崩溃 心碎 失望 无语 离谱 逆天 破防 麻了 服了 难受 痛苦 吐了 呕吐 鄙视 白眼 嘲讽 喷 骂 举报 差评 水军 掉粉 取关 别买 不值 退钱 翻车 侮辱 冒犯 恶俗 低俗 割韭菜 智商税 阴阳怪气 洗白 洗地 拉胯 恰饭 硬广'.split(/\s+/)));
  const SENT_NEG = new Set(('不行 不好 难看 难听 难受 麻烦 复杂 混乱 卡 卡顿 慢 贵 亏 可惜 遗憾 一般 普通 平庸 老套 套路 水 敷衍 凑数 多余 尬 冷场 叹气 皱眉 害怕 恐怖 吓人 阴影 不适 争议 质疑 反驳 抬杠 双标 强行 尴尬 无聊 拖沓 生气 发怒 差 弱 划水 广告 坑 糊弄 玄学 劝退'.split(/\s+/)));
  const SENT_NEGATORS = new Set(('不 没 无 未 别 莫 非 勿 没有 不是 不算 不会 不能 不要 不用 不必 不够 不太 不怎么 没那么'.split(/\s+/)));
  const SENT_DEGREE = new Set(('太 很 非常 特别 超 巨 极 真 更 最 十分 相当 格外 尤其 愈发 更加 简直 实在 真是 巨他妈'.split(/\s+/)));
  const EMOJI_POS = new Set(('憨笑 微笑 大笑 笑哭 呲牙 偷笑 得意 调皮 酷 比心 鼓掌 加油 玫瑰 爱心 飞吻 抱拳 胜利 强 点赞 撒花 庆祝 耶 亲亲 害羞 愉快 色 吃瓜 调皮'.split(/\s+/)));
  const EMOJI_NEG = new Set(('流泪 大哭 崩溃 发怒 生气 鄙视 白眼 呕吐 敲打 菜刀 心碎 失望 无语 裂开 叹气 皱眉 骷髅 害怕 惊恐 再见 弱 尬 汗 擦汗 抠鼻 黑线 委屈 可怜 抓狂 咒骂 闭嘴 哼 怒 困'.split(/\s+/)));

  const EMOJI_TAG_RE = /\[[^\[\]]{1,12}\]/g;

  function sentimentOf(text) {
    const raw = String(text || '');
    let score = 0;
    let emoHits = 0;
    const tags = raw.match(EMOJI_TAG_RE) || [];
    for (const t of tags) {
      const name = t.slice(1, -1);
      if (EMOJI_POS.has(name)) { score += 1.2; emoHits++; }
      else if (EMOJI_NEG.has(name)) { score -= 1.2; emoHits++; }
    }
    const s = raw.replace(EMOJI_TAG_RE, ' ').replace(/@[^\s@]+|#[^\s#]+/g, ' ');
    if (!s.trim()) {
      const norm0 = Math.tanh(score / 2);
      return { score: Math.round(norm0 * 100) / 100, label: norm0 > 0.15 ? 'pos' : (norm0 < -0.15 ? 'neg' : 'neu'), hits: emoHits };
    }
    const toks = [];
    if (segmenter) for (const seg of segmenter.segment(s)) if (seg.isWordLike) toks.push(seg.segment);
    else for (const p of s.match(/[A-Za-z][A-Za-z0-9']*|[\u4e00-\u9fff]{1,4}/g) || []) toks.push(p);
    let hits = 0;
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      let base = 0;
      if (SENT_POS_STRONG.has(t)) base = 2;
      else if (SENT_POS.has(t)) base = 1;
      else if (SENT_NEG_STRONG.has(t)) base = -2;
      else if (SENT_NEG.has(t)) base = -1;
      if (!base) continue;
      let mult = 1;
      for (let j = Math.max(0, i - 2); j < i; j++) {
        if (SENT_DEGREE.has(toks[j])) mult *= 1.5;
        if (SENT_NEGATORS.has(toks[j])) mult *= -0.8;
      }
      score += base * mult;
      hits++;
    }
    const norm = Math.tanh(score / 2);
    return {
      score: Math.round(norm * 100) / 100,
      label: norm > 0.15 ? 'pos' : (norm < -0.15 ? 'neg' : 'neu'),
      hits: hits + emoHits,
    };
  }

  function annotateSentiment(list) {
    for (const c of list) {
      if (c.sentiment) continue;
      if (c.textPlaceholder && c.rating) {
        // v0.5.56：正文是平台默认文案时，用评价类型给一个保守标签（好评→正向 / 差评→负向 / 其余中性）
        const r = String(c.rating);
        const label = /好评|推荐|5星|五星/.test(r) ? 'pos' : (/差评|1星|2星/.test(r) ? 'neg' : 'neu');
        c.sentiment = { score: label === 'pos' ? 0.6 : (label === 'neg' ? -0.6 : 0), label, hits: 0, fromRating: true };
        continue;
      }
      c.sentiment = sentimentOf(c.text);
    }
  }

  const SENT_LABEL = { pos: '正向', neu: '中性', neg: '负向' };

  function sentimentStats(list) {
    const s = { pos: 0, neu: 0, neg: 0 };
    for (const c of list) {
      const l = (c.sentiment && c.sentiment.label) || 'neu';
      s[l] = (s[l] || 0) + 1;
    }
    return s;
  }

  /* ===================== 主题聚类（v3.0） =====================
   * TF-IDF + 轻量 k-means（确定性种子：等距取 k 篇当初始中心），纯前端、无依赖。
   * 输出 state.topics = [{ id, label, terms, count, reps:[comment] }]，评论上挂 c.topic。
   */
  function buildTopics(list) {
    const docs = [];
    for (const c of list) {
      if (!c.text || c.textPlaceholder) continue;
      const seen = new Set();
      const toks = [];
      for (const raw of tokensOf(c.textClean || c.text)) {
        const w = cleanToken(raw, true);
        if (!w || seen.has(w)) continue;
        seen.add(w);
        toks.push(w);
      }
      if (toks.length >= 2) docs.push({ c, toks });
    }
    const n = docs.length;
    for (const c of list) delete c.topic;
    if (n < 12) { state.topics = []; return; }
    const df = new Map();
    for (const d of docs) for (const w of d.toks) df.set(w, (df.get(w) || 0) + 1);
    const minDf = Math.max(2, Math.round(n * 0.012));
    const vocab = Array.from(df.entries())
      .filter(([, v]) => v >= minDf)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 900)
      .map(([w]) => w);
    if (vocab.length < 8) { state.topics = []; return; }
    const idx = new Map(vocab.map((w, i) => [w, i]));
    const idf = vocab.map((w) => Math.log(1 + n / df.get(w)));
    const vecs = docs.map((d) => {
      const tf = new Map();
      for (const w of d.toks) { const i = idx.get(w); if (i != null) tf.set(i, (tf.get(i) || 0) + 1); }
      const v = new Map();
      let sum = 0;
      for (const [i, f] of tf) { const val = (1 + Math.log(f)) * idf[i]; v.set(i, val); sum += val * val; }
      const norm = Math.sqrt(sum) || 1;
      for (const [i, val] of v) v.set(i, val / norm);
      return v;
    });
    const k = Math.max(3, Math.min(8, Math.round(Math.sqrt(n) / 2)));
    const cos = (a, b) => {
      let s = 0;
      const small = a.size <= b.size ? a : b;
      const big = a.size <= b.size ? b : a;
      for (const [i, v] of small) { const w = big.get(i); if (w) s += v * w; }
      return s;
    };
    const cent = [];
    for (let i = 0; i < k; i++) cent.push(new Map(vecs[Math.min(n - 1, Math.floor((i + 0.5) * n / k))]));
    const assign = new Array(n).fill(-1);
    for (let it = 0; it < 14; it++) {
      let moved = 0;
      for (let d = 0; d < n; d++) {
        let best = 0, bestS = -2;
        for (let c = 0; c < k; c++) { const s = cos(vecs[d], cent[c]); if (s > bestS) { bestS = s; best = c; } }
        if (assign[d] !== best) { assign[d] = best; moved++; }
      }
      const next = Array.from({ length: k }, () => new Map());
      for (let d = 0; d < n; d++) {
        const m = next[assign[d]];
        for (const [i, v] of vecs[d]) m.set(i, (m.get(i) || 0) + v);
      }
      for (let c = 0; c < k; c++) {
        const m = next[c];
        let sum = 0;
        for (const v of m.values()) sum += v * v;
        const norm = Math.sqrt(sum) || 1;
        for (const [i, v] of m) m.set(i, v / norm);
        cent[c] = m;
      }
      if (!moved && it > 2) break;
    }
    const raw = [];
    for (let c = 0; c < k; c++) {
      const members = [];
      const termW = new Map();
      for (let d = 0; d < n; d++) {
        if (assign[d] !== c) continue;
        members.push(d);
        for (const [i, v] of vecs[d]) termW.set(i, (termW.get(i) || 0) + v);
      }
      if (members.length < 2) { raw.push(null); continue; }
      const terms = Array.from(termW.entries()).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([i]) => vocab[i]);
      const reps = members
        .map((d) => ({ d, s: cos(vecs[d], cent[c]) * (1 + Math.log1p(Math.max(0, docs[d].c.digg))) }))
        .sort((a, b) => b.s - a.s)
        .slice(0, 3)
        .map((x) => docs[x.d].c);
      raw.push({ label: terms.slice(0, 2).join(' · ') || ('主题 ' + (c + 1)), terms, count: members.length, reps, members });
    }
    state.topics = raw.filter(Boolean).map((t, i) => ({ id: i, label: t.label, terms: t.terms, count: t.count, reps: t.reps }));
    const keep = new Set(raw.map((t, i) => (t ? i : -1)).filter((i) => i >= 0));
    const remap = new Map();
    let j = 0;
    for (let i = 0; i < raw.length; i++) if (raw[i]) remap.set(i, j++);
    for (let d = 0; d < n; d++) {
      const c0 = assign[d];
      if (!keep.has(c0)) continue;
      docs[d].c.topic = remap.get(c0);
    }
  }

  /* ===================== 洞察面板（v3.0） ===================== */
  function dashboardCard(title, sub, bodyHtml, extraClass) {
    return `<div class="insight-card${extraClass ? ' ' + extraClass : ''}">
      <div class="insight-head"><h3>${esc(title)}</h3><span class="meta">${esc(sub || '')}</span></div>
      <div class="insight-body">${bodyHtml}</div>
    </div>`;
  }

  function svgTrend(list) {
    const byDay = new Map();
    let minT = Infinity, maxT = -Infinity;
    for (const c of list) {
      const s = String(c.createTimeStr || '').slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) continue;
      const neg = c.sentiment && c.sentiment.label === 'neg' ? 1 : 0;
      const rec = byDay.get(s) || { n: 0, neg: 0 };
      rec.n++; rec.neg += neg;
      byDay.set(s, rec);
      const t = Date.parse(s + 'T00:00:00');
      if (t < minT) minT = t;
      if (t > maxT) maxT = t;
    }
    const days = Array.from(byDay.entries()).sort((a, b) => (a[0] < b[0] ? -1 : 1));
    if (days.length < 2) {
      return `<p class="meta">${days.length ? '只有一天的数据（' + days[0][0] + '），看不出趋势' : '没有可用的时间字段'}</p>`;
    }
    const shown = days.slice(-30);
    const maxN = Math.max.apply(null, shown.map(([, v]) => v.n)) || 1;
    const W = 300, H = 92, pad = 4;
    const x = (i) => pad + (i * (W - pad * 2)) / Math.max(1, shown.length - 1);
    const y = (n) => H - pad - (n / maxN) * (H - pad * 2);
    const pts = shown.map(([, v], i) => [x(i), y(v.n)]);
    const line = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
    const area = line + ` L${x(shown.length - 1).toFixed(1)} ${H - pad} L${pad} ${H - pad} Z`;
    const negPts = shown.map(([, v], i) => [x(i), H - pad - (v.neg / Math.max(1, v.n)) * (H - pad * 2)]);
    const negLine = negPts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
    const peak = shown.reduce((a, b) => (b[1].n > a[1].n ? b : a));
    return `<svg class="trend" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="评论量趋势">
      <path class="area" d="${area}"></path>
      <path class="line" d="${line}"></path>
      <path class="negline" d="${negLine}"></path>
      ${pts.map((p, i) => (i === 0 || i === pts.length - 1 || shown[i] === peak ? `<circle class="dot" cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="1.8"></circle>` : '')).join('')}
    </svg>
    <div class="legend"><span><i class="sw-line"></i>每天评论数</span><span><i class="sw-neg"></i>负评占比</span><span class="meta">峰值 ${valEsc(peak[0].slice(5))} · ${peak[1].n} 条</span></div>
    <div class="axis"><span>${esc(shown[0][0].slice(5))}</span><span>${esc(shown[shown.length - 1][0].slice(5))}</span></div>`;
  }

  function valEsc(v) { return String(v == null ? '' : v).replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m])); }

  /* ===================== 情感健康度（v3.1：熵权法 + TOPSIS，按天分桶） ===================== */
  const HEALTH_GRADES = [
    { min: 80, label: '很好', cls: 'h-good' },
    { min: 65, label: '较好', cls: 'h-ok' },
    { min: 50, label: '一般', cls: 'h-mid' },
    { min: 35, label: '偏弱', cls: 'h-warn' },
    { min: 0, label: '较差', cls: 'h-bad' },
  ];
  const HEALTH_IND = [
    { key: 'negRatio', label: '负面占比', cap: 0.35 },
    { key: 'negDigg', label: '负评点赞占比', cap: 0.35 },
    { key: 'burst', label: '评论热度', cap: 1 },
    { key: 'topNeg', label: '高赞负评率', cap: 0.5 },
  ];

  function healthMedian(nums) {
    if (!nums.length) return 0;
    const a = nums.slice().sort((x, y) => x - y);
    const mid = a.length >> 1;
    return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
  }

  // 按天分桶：每天是一个“方案”，4 个指标都是「越大越差」的风险向
  function healthBuckets(list) {
    const diggAll = list.map((c) => Number(c.digg) || 0);
    const diggMedian = healthMedian(diggAll);
    const map = new Map();
    for (const c of list) {
      const day = String(c.createTimeStr || '').slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
      let b = map.get(day);
      if (!b) { b = { day, n: 0, neg: 0, digg: 0, negDigg: 0, topN: 0, topNeg: 0 }; map.set(day, b); }
      const dg = Number(c.digg) || 0;
      const neg = c.sentiment && c.sentiment.label === 'neg' ? 1 : 0;
      b.n++; b.digg += dg; b.neg += neg;
      if (neg) b.negDigg += dg;
      if (dg >= diggMedian && dg > 0) { b.topN++; b.topNeg += neg; }
    }
    return Array.from(map.values()).sort((a, b) => (a.day < b.day ? -1 : 1));
  }

  // 熵权法：m 个方案 × k 个指标；方案少于 2 个或区分度全为 0 时退化成等权
  function entropyWeights(matrix) {
    const m = matrix.length, k = matrix[0].length;
    const w = new Array(k).fill(1 / k);
    if (m < 2) return w;
    const sums = [];
    for (let j = 0; j < k; j++) { let s = 0; for (let i = 0; i < m; i++) s += matrix[i][j]; sums.push(s); }
    const div = 1 / Math.log(m);
    const ds = [];
    for (let j = 0; j < k; j++) {
      if (sums[j] <= 0) { ds.push(0); continue; }
      let e = 0;
      for (let i = 0; i < m; i++) {
        const p = matrix[i][j] / sums[j];
        if (p > 0) e -= p * Math.log(p);
      }
      ds.push(Math.max(0, 1 - e * div));
    }
    const sumD = ds.reduce((s, v) => s + v, 0);
    if (sumD <= 0) return w;
    for (let j = 0; j < k; j++) w[j] = ds[j] / sumD;
    return w;
  }

  // TOPSIS：指标全为「越大越差」，返回每个方案的风险贴近度 0~1（1 = 最差）
  function topsisRisk(matrix, w) {
    const m = matrix.length, k = matrix[0].length;
    if (m < 2) return matrix.map((row) => row.reduce((s, v, j) => s + v * w[j], 0));
    const norm = [];
    for (let j = 0; j < k; j++) {
      let sq = 0;
      for (let i = 0; i < m; i++) sq += matrix[i][j] * matrix[i][j];
      norm.push(Math.sqrt(sq) || 1);
    }
    const v = matrix.map((row) => row.map((x, j) => (x / norm[j]) * w[j]));
    const best = [], worst = [];
    for (let j = 0; j < k; j++) {
      let hi = -Infinity, lo = Infinity;
      for (let i = 0; i < m; i++) { if (v[i][j] > hi) hi = v[i][j]; if (v[i][j] < lo) lo = v[i][j]; }
      best.push(hi); worst.push(lo);
    }
    return v.map((row) => {
      let db = 0, dw = 0;
      for (let j = 0; j < k; j++) { db += Math.pow(row[j] - best[j], 2); dw += Math.pow(row[j] - worst[j], 2); }
      db = Math.sqrt(db); dw = Math.sqrt(dw);
      return db + dw === 0 ? 0.5 : dw / (db + dw);
    });
  }

  function healthOf(list) {
    const buckets = healthBuckets(list);
    if (!buckets.length) return null;
    const maxN = Math.max.apply(null, buckets.map((b) => b.n)) || 1;
    const matrix = buckets.map((b) => [
      Math.min(1, b.neg / Math.max(1, b.n) / HEALTH_IND[0].cap),
      Math.min(1, b.negDigg / Math.max(1, b.digg) / HEALTH_IND[1].cap),
      Math.min(1, b.n / maxN / HEALTH_IND[2].cap),
      Math.min(1, b.topNeg / Math.max(1, b.topN) / HEALTH_IND[3].cap),
    ]);
    const w = entropyWeights(matrix);
    const risks = topsisRisk(matrix, w);
    const totalN = buckets.reduce((s, b) => s + b.n, 0) || 1;
    const risk = buckets.reduce((s, b, i) => s + risks[i] * (b.n / totalN), 0);
    const score = Math.max(0, Math.min(100, Math.round((1 - risk) * 100)));
    const grade = HEALTH_GRADES.find((g) => score >= g.min) || HEALTH_GRADES[HEALTH_GRADES.length - 1];
    const metrics = HEALTH_IND.map((ind, j) => {
      const mean = buckets.reduce((s, b, i) => s + matrix[i][j] * (b.n / totalN), 0);
      return { key: ind.key, label: ind.label, risk: mean, weight: w[j], contrib: w[j] * mean };
    });
    return { score, risk, grade, metrics, days: buckets.length };
  }

  function renderHealth(list) {
    const h = healthOf(list);
    if (!h) return '';
    const riskPct = (x) => Math.round(x * 100);
    const rows = h.metrics
      .slice()
      .sort((a, b) => b.contrib - a.contrib)
      .map((m) => '<tr><td>' + esc(m.label) + '</td><td class="num">' + riskPct(m.risk) + '%</td><td class="num">' + Math.round(m.weight * 100) + '%</td><td class="num">' + riskPct(m.contrib) + '%</td></tr>')
      .join('');
    const marks = [20, 40, 60, 80].map((x) => '<span class="mk" style="left:' + x + '%"></span>').join('');
    return '<div class="insight-card health">'
      + '<div class="insight-head"><h3>情感健康度</h3><span class="meta">熵权法 + TOPSIS · 按天分桶（' + fmtNum(h.days) + ' 天）</span></div>'
      + '<div class="insight-body">'
      + '<div class="health-top">'
      + '<div class="health-score"><b>' + h.score + '</b><small>/100</small></div>'
      + '<span class="health-grade ' + h.grade.cls + '">' + esc(h.grade.label) + '</span>'
      + '<div class="health-bar"><i class="' + h.grade.cls + '" style="width:' + h.score + '%"></i>' + marks + '</div>'
      + '<span class="meta">风险 ' + riskPct(h.risk) + '%</span>'
      + '</div>'
      + '<table class="health-metrics"><thead><tr><th>指标（越大越差）</th><th>风险</th><th>权重</th><th>贡献</th></tr></thead><tbody>' + rows + '</tbody></table>'
      + '<p class="meta" title="分数 = 100 − Σ(按天风险 × 当天评论占比)；权重由熵权法从数据里算，区分度越高的指标权重越大。">分数 = 100 − 按天加权风险</p>'
      + '</div></div>';
  }


/* ---------- v0.5.56：AI 解读（只发摘要，模型不参与计算） ---------- */
const AI_CONSENT_KEY = 'cw.ai.consent';
let aiText = '';
let aiAbort = null;

function aiApiPath() {
  const p = String(location.pathname || '');
  // v0.6.0：合并进 dsh-douyin-comments 后挂载点是 /plugins/<pkg>/viewer，不再写死旧包名
  const mounted = /^\/plugins\/[^/]+\/(app|viewer)(\/|$)/.test(p);
  if ((location.protocol === 'http:' || location.protocol === 'https:') && mounted) return 'api/explain';
  return '';
}

function aiClip(s, n) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

function buildDigest(list) {
  const rows = Array.isArray(list) ? list : filtered();
  const byDay = new Map();
  const skuCount = new Map();
  const ratingCount = new Map();
  const videoIds = new Set();
  const users = new Set();
  const negatives = [];
  let placeholder = 0;
  for (const c of rows) {
    const day = String(c.createTimeStr || '').slice(0, 10);
    if (day) {
      const d = byDay.get(day) || { day: day, n: 0, neg: 0 };
      d.n += 1;
      if (c.sentiment === 'neg') d.neg += 1;
      byDay.set(day, d);
    }
    if (c.sku) skuCount.set(c.sku, (skuCount.get(c.sku) || 0) + 1);
    if (c.rating) ratingCount.set(c.rating, (ratingCount.get(c.rating) || 0) + 1);
    if (c.videoId) videoIds.add(c.videoId);
    const nick = (c.user && (c.user.nickname || c.user.uid)) || '';
    if (nick) users.add(nick);
    if (c.textPlaceholder) placeholder += 1;
    if (c.sentiment === 'neg' && negatives.length < 10) {
      negatives.push({ text: aiClip(c.textClean || c.text, 80), rating: c.rating || '', sku: aiClip(c.sku, 40) });
    }
  }
  const videoId = String(state.filters.videoId || '') || (videoIds.size === 1 ? Array.from(videoIds)[0] : '');
  const video = videoId && state.videos && state.videos.get ? state.videos.get(videoId) : null;
  const health = (() => { try { return healthOf(rows); } catch (e) { return null; } })();
  const st = sentimentStats(rows);
  return {
    schema: 'cv-digest/1',
    generatedAt: new Date().toISOString(),
    source: {
      platform: (rows[0] && rows[0].source) || 'unknown',
      product: videoId || '',
      title: (video && video.title) || '',
      files: (state.sources || []).length,
    },
    totals: { comments: rows.length, users: users.size, days: byDay.size, videos: videoIds.size },
    ratings: Object.fromEntries(ratingCount),
    placeholder: placeholder ? { count: placeholder, note: '平台系统默认评价（正文为占位文案），不代表买家真实表达' } : { count: 0 },
    sentiment: st,
    health: health ? { score: health.score, grade: health.grade, risk: Math.round(health.risk * 100) } : null,
    keywords: buildWords(rows).slice(0, 30).map((w) => ({ w: w.word, n: w.count })),
    topics: (state.topics || []).slice(0, 6).map((t) => ({
      label: t.label,
      terms: (t.terms || []).slice(0, 4),
      count: t.count,
      samples: (t.reps || []).slice(0, 2).map((c) => aiClip(c.textClean || c.text, 80)),
    })),
    skus: Array.from(skuCount.entries()).sort((a, b) => b[1] - a[1]).slice(0, 8).map((kv) => ({ name: aiClip(kv[0], 40), count: kv[1] })),
    negatives: negatives,
    trend: Array.from(byDay.values()).sort((a, b) => (a.day < b.day ? -1 : 1)).slice(-30),
    filters: {
      videoId: state.filters.videoId || '',
      sentiment: state.filters.sentiment || '',
      topic: state.filters.topic || '',
      search: state.filters.search || '',
    },
  };
}

function renderAiResult(text, meta) {
  const body = $('#aiBody');
  const note = '<div class="ai-note">AI 生成 · 仅供参考' + (meta ? ' · ' + valEsc(meta) : '') + '</div>';
  let parsed = null;
  try { parsed = JSON.parse(String(text || '').trim()); } catch (e) { parsed = null; }
  if (!parsed || typeof parsed !== 'object') {
    body.innerHTML = '<p>' + valEsc(text).replace(/\n/g, '<br>') + '</p>' + note;
    return;
  }
  const parts = [];
  if (parsed.headline) parts.push('<p><strong>' + valEsc(parsed.headline) + '</strong></p>');
  if (parsed.reading) parts.push('<p>' + valEsc(parsed.reading) + '</p>');
  if (Array.isArray(parsed.issues) && parsed.issues.length) {
    parts.push('<h4>主要问题</h4><ul>' + parsed.issues.map(function (it) {
      const sev = ['high', 'medium', 'low'].indexOf(it && it.severity) >= 0 ? it.severity : 'low';
      return '<li><span class="ai-sev-' + sev + '">●</span> ' + valEsc(it && it.title) + (it && it.evidence ? ' — ' + valEsc(it.evidence) : '') + '</li>';
    }).join('') + '</ul>');
  }
  if (Array.isArray(parsed.actions) && parsed.actions.length) {
    parts.push('<h4>建议</h4><ul>' + parsed.actions.map(function (a) {
      return '<li>' + valEsc(a && a.title) + (a && a.why ? '<br><span class="ai-sev-low">' + valEsc(a.why) + '</span>' : '') + '</li>';
    }).join('') + '</ul>');
  }
  if (Array.isArray(parsed.quotes) && parsed.quotes.length) {
    parts.push('<h4>买家原话</h4><ul>' + parsed.quotes.map(function (q) {
      let s = '<li><span class="ai-q">「' + valEsc(q && q.text) + '」</span>';
      if (q && q.rating) s += '<span class="ai-tag">' + valEsc(q.rating) + '</span>';
      if (q && q.sku) s += '<span class="ai-tag">' + valEsc(aiClip(q.sku, 20)) + '</span>';
      return s + '</li>';
    }).join('') + '</ul>');
  }
  parts.push(note);
  body.innerHTML = parts.join('');
}

async function runAiExplain() {
  const card = $('#aiCard');
  const body = $('#aiBody');
  const btn = $('#btnAi');
  const meta = $('#aiMeta');
  const list = filtered();
  if (!list.length) { toast('先载入评论数据'); return; }
  let digest = buildDigest(list);
  let digestJson = JSON.stringify(digest);
  if (digestJson.length > 11000) {
    digest.keywords = digest.keywords.slice(0, 20);
    digest.trend = digest.trend.slice(-14);
    digest.topics = digest.topics.slice(0, 4);
    digest.negatives = digest.negatives.slice(0, 6);
    digestJson = JSON.stringify(digest);
  }

  card.hidden = false;
  btn.disabled = true;
  $('#btnAiRetry').hidden = true;
  $('#btnAiCopy').hidden = true;
  meta.textContent = '';
  aiText = '';
  const t0 = Date.now();
  const api = aiApiPath();

  if (!api) {
    // 独立页 / 扩展内联页：没有服务端，退回「把摘要交给任意 AI」
    try {
      await navigator.clipboard.writeText(digestJson);
      toast('已复制摘要（' + Math.round(digestJson.length / 1024) + ' KB）：粘给任意 AI 即可；在 DSH 里可直接点「AI 解读」');
    } catch (e) {
      toast('当前页面调不了模型：摘要已生成，可手动复制');
    }
    body.innerHTML = '<p>当前页面不在 DSH 插件里，没法直接调用模型。下面是这次分析对应的统计摘要（' +
      Math.round(digestJson.length / 1024) + ' KB），粘给任意 AI 就能得到同样的解读：</p>' +
      '<textarea class="input" style="width:100%;height:160px" readonly>' + valEsc(digestJson) + '</textarea>' +
      '<div class="ai-note">摘要不含昵称原文、用户 ID 与链接</div>';
    btn.disabled = false;
    return;
  }

  if (localStorage.getItem(AI_CONSENT_KEY) !== '1') {
    const ok = window.confirm('AI 解读会把「统计摘要」发送给 DSH 里配置的模型（约 2~3K tokens）。摘要不含昵称原文、用户 ID 与链接。是否继续？');
    if (!ok) { card.hidden = true; btn.disabled = false; return; }
    localStorage.setItem(AI_CONSENT_KEY, '1');
  }

  body.innerHTML = '<p class="ai-cursor">正在生成解读…</p>';
  try {
    aiAbort = new AbortController();
    const res = await fetch(api, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ digest: digest }),
      signal: aiAbort.signal,
    });
    if (!res.ok) {
      const info = await res.json().catch(function () { return {}; });
      throw new Error(info.hint || info.error || ('HTTP ' + res.status));
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let model = '';
    let usage = 0;
    // v0.5.60：流式期间模型输出的是 JSON 原文（带 { } 和字段名），直接打字机展示很难看。
    // 这里只显示一个「正在生成」提示 + 实时字数，等流结束后再由 renderAiResult() 渲染成结构化卡片。
    const p = document.createElement('p');
    p.className = 'ai-streaming';
    p.innerHTML = '<span class="ai-spin"></span><span class="ai-streaming-text">正在生成…</span>';
    body.innerHTML = '';
    body.classList.add('is-streaming');
    body.appendChild(p);
    for (;;) {
      const step = await reader.read();
      if (step.done) break;
      buf += dec.decode(step.value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const line = frame.split('\n').filter(function (l) { return l.indexOf('data: ') === 0; })[0];
        if (!line) continue;
        let obj = null;
        try { obj = JSON.parse(line.slice(6)); } catch (e) { obj = null; }
        if (!obj) continue;
        if (obj.model) model = obj.model;
        if (obj.delta) {
          aiText += obj.delta;
          const note = p.querySelector('.ai-streaming-text');
          if (note) note.textContent = '正在生成… ' + aiText.length + ' 字';
        }
        if (obj.usage) {
          const u = obj.usage || {};
          usage = Number(u.inputTokens || u.promptTokens || 0) + Number(u.outputTokens || u.completionTokens || 0);
        }
        if (obj.error) throw new Error(obj.error);
      }
    }
    body.classList.remove('is-streaming');
    const secs = ((Date.now() - t0) / 1000).toFixed(1) + 's';
    const info = [model, usage ? usage + ' tokens' : '', secs].filter(Boolean).join(' · ');
    renderAiResult(aiText, info);
    meta.textContent = info;
    $('#btnAiRetry').hidden = false;
    $('#btnAiCopy').hidden = false;
  } catch (err) {
    const msg = String((err && err.message) || err);
    body.classList.remove('is-streaming');
    body.innerHTML = '<p class="ai-err">AI 解读失败：' + valEsc(msg) + '</p>' +
      '<p class="ai-sev-low">本地统计不受影响。可以点「重新生成」，或把摘要复制出来交给任意 AI。</p>';
    meta.textContent = '失败';
  } finally {
    btn.disabled = false;
    aiAbort = null;
  }
}

function bindAiEvents() {
  const btn = $('#btnAi');
  if (btn) btn.addEventListener('click', function () { void runAiExplain(); });
  const retry = $('#btnAiRetry');
  if (retry) retry.addEventListener('click', function () { void runAiExplain(); });
  const copy = $('#btnAiCopy');
  if (copy) copy.addEventListener('click', function () {
    if (!aiText) return;
    navigator.clipboard.writeText(aiText).then(function () { toast('已复制 AI 解读'); }).catch(function () { toast('复制失败'); });
  });
  const close = $('#btnAiClose');
  if (close) close.addEventListener('click', function () {
    if (aiAbort) { try { aiAbort.abort(); } catch (e) {} }
    $('#aiCard').hidden = true;
  });
}

  function renderInsights(list) {
    const box = $('#insightGrid') || $('#insights');
    if (!box) return;
    const total = list.length;
    const st = sentimentStats(list);
    const pct = (n) => (total ? Math.round((n / total) * 100) : 0);
    const seg = (cls, n) => (total && n ? `<i class="sent-seg ${cls}" style="width:${(n / total) * 100}%"></i>` : '');
    const negTop = list
      .filter((c) => c.sentiment && c.sentiment.label === 'neg')
      .sort((a, b) => b.digg - a.digg)
      .slice(0, 3);
    const sentHtml = total
      ? `<div class="sent-bar">${seg('pos', st.pos)}${seg('neu', st.neu)}${seg('neg', st.neg)}</div>
         <div class="sent-list">
           <span><i class="sw-dot pos"></i>正向 ${fmtNum(st.pos)} · ${pct(st.pos)}%</span>
           <span><i class="sw-dot neu"></i>中性 ${fmtNum(st.neu)} · ${pct(st.neu)}%</span>
           <span><i class="sw-dot neg"></i>负向 ${fmtNum(st.neg)} · ${pct(st.neg)}%</span>
         </div>
         ${negTop.length ? `<div class="mini-list"><div class="mini-h">负评 Top${negTop.length}（按点赞）</div>${negTop.map((c) => `<button class="mini-row" type="button" data-neg-cid="${esc(c.cid)}"><span class="mini-txt">${esc((c.text || '').slice(0, 46) || '（无文字）')}</span><span class="mini-num">${fmtNum(c.digg)}</span></button>`).join('')}</div>` : '<p class="meta">没有识别到负向评论</p>'}`
      : '<p class="meta">暂无数据</p>';

    const regions = new Map();
    for (const c of list) if (c.ip) regions.set(c.ip, (regions.get(c.ip) || 0) + 1);
    const regTop = Array.from(regions.entries()).sort((a, b) => b[1] - a[1]).slice(0, 8);
    const regMax = regTop.length ? regTop[0][1] : 1;
    const regHtml = regTop.length
      ? regTop.map(([k, v]) => `<div class="region-row"><span class="region-name">${esc(k)}</span><span class="region-bar"><i style="width:${(v / regMax) * 100}%"></i></span><span class="region-num">${fmtNum(v)}</span></div>`).join('')
      : '<p class="meta">导出数据里没有属地字段</p>';

    const topics = (state.topics || []).slice().sort((a, b) => b.count - a.count).slice(0, 6);
    const topicHtml = topics.length
      ? topics.map((t) => `<div class="topic-item">
          <button class="topic-main" type="button" data-topic="${t.id}" title="只看这个主题">
            <span class="topic-label">${esc(t.label)}</span>
            <span class="topic-count">${fmtNum(t.count)} 条</span>
          </button>
          <div class="topic-terms">${t.terms.slice(0, 3).map((w) => `<button class="chip" type="button" data-topic-word="${esc(w)}">${esc(w)}</button>`).join('')}</div>
          <div class="topic-reps">${t.reps.slice(0, 2).map((c) => `<div class="topic-rep">${esc((c.text || '').slice(0, 52) || '（无文字）')}</div>`).join('')}</div>
        </div>`).join('')
      : '<p class="meta">评论太少（< 12 条带文字）或没有明显主题</p>';

    box.innerHTML = renderHealth(list) + dashboardCard('情感分布', `${fmtNum(total)} 条评论`, sentHtml)
      + dashboardCard('评论趋势', '按天 · 最近 30 天', svgTrend(list))
      + dashboardCard('地域分布', 'Top 8 省份/地区', regHtml)
      + dashboardCard('主题聚类', `${topics.length} 个主题 · TF-IDF + k-means`, topicHtml, 'topic-card');

    const sub = $('#insightSub');
    if (sub) sub.textContent = total ? `负评率 ${pct(st.neg)}% · ${topics.length} 个主题` : '';
    box.classList.toggle('is-empty', total === 0);
    syncInsightHeights();
  }

  // v0.5.51：主题卡与左侧「地域分布」等高——量左侧自然高度，把主题列表限到同高并在内部滚动。
  // 之前主题多（6 个簇 × 标签/词/代表评论）会把整行撑高，视觉上和左边不齐。
  function syncInsightHeights() {
    const apply = () => {
    const box = $('#insightGrid') || $('#insights');
    if (!box) return;
    const topic = box.querySelector('.insight-card.topic-card');
    if (!topic) return;
    const cards = Array.from(box.querySelectorAll('.insight-card'));
    const left = cards[cards.indexOf(topic) - 1] || null;
    const body = topic.querySelector('.insight-body');
    if (!body) return;
    body.style.maxHeight = '';
    body.style.overflowY = '';
    if (!left) return;
    const leftBody = left.querySelector('.insight-body');
    const leftHead = left.querySelector('.insight-head');
    const topicHead = topic.querySelector('.insight-head');
    if (!leftBody || !leftHead || !topicHead) return;
    const cs = getComputedStyle(left);
    const padV = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    // 关键：左侧 body 是 flex:1，会被整行拉伸；量自然高度前先取消 stretch，否则会「越量越高」
    const prevFlex = leftBody.style.flex;
    leftBody.style.flex = '0 0 auto';
    const naturalLeftBody = leftBody.offsetHeight;
    leftBody.style.flex = prevFlex;
    const naturalLeft = leftHead.offsetHeight + naturalLeftBody + padV;
    const csT = getComputedStyle(topic);
    const padT = parseFloat(csT.paddingTop) + parseFloat(csT.paddingBottom);
    const max = Math.max(120, Math.round(naturalLeft - topicHead.offsetHeight - padT));
    body.style.maxHeight = max + 'px';
    body.style.overflowY = 'auto';
    };
    apply();
    // v0.5.51b：字体/布局晚到会让首帧量到的字高偏小，补两帧 + 字体就绪后再复算（幂等）
    requestAnimationFrame(() => requestAnimationFrame(apply));
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(apply).catch(() => {});
  }

  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(syncInsightHeights, 150);
  });

  function renderTopicFilter() {
    const sel = $('#topicFilter');
    if (!sel) return;
    const cur = state.filters.topic;
    const opts = ['<option value="">全部主题</option>'];
    for (const t of (state.topics || [])) {
      opts.push(`<option value="${t.id}">${esc(t.label)}（${fmtNum(t.count)} 条）</option>`);
    }
    sel.innerHTML = opts.join('');
    sel.value = cur === '' ? '' : String(cur);
    sel.disabled = !(state.topics || []).length;
  }

  /* ===================== KPI ===================== */
  function renderKpis(list) {
    const users = new Set();
    let digg = 0, hot = 0, topLevel = 0;
    for (const c of list) {
      users.add(c.user.secUid || c.user.uid || c.user.nickname);
      digg += c.digg;
      if (c.digg >= 100) hot++;
      if (!c.isReply) topLevel++;
    }
    const avg = list.length ? (digg / list.length) : 0;
    const pct = (n) => (list.length ? Math.round(n / list.length * 100) : 0) + '%';
    const st = sentimentStats(list);
    const cells = [
      { k: '评论数', v: fmtNum(list.length), s: '条' },
      { k: '参与用户', v: fmtNum(users.size), s: '人' },
      { k: '关键词', v: fmtNum(state.words.length), s: '个' },
      { k: '平均点赞', v: fmtNum(Math.round(avg * 10) / 10), s: '' },
      { k: '正向评论', v: pct(st.pos), s: fmtNum(st.pos) + ' 条' },
      { k: '负向评论', v: pct(st.neg), s: fmtNum(st.neg) + ' 条' },
      { k: '主题', v: fmtNum((state.topics || []).length), s: '个' },
      { k: '一级评论', v: pct(topLevel), s: fmtNum(topLevel) + ' 条' },
    ];
    $('#kpis').innerHTML = cells.map((c) => `
      <div class="kpi">
        <div class="k">${esc(c.k)}</div>
        <div class="v">${esc(c.v)}<small>${esc(c.s || '')}</small></div>
      </div>`).join('');
  }

  function updateScope() {
    const el = $('#sourceInfo');
    if (!state.comments.length) { el.textContent = '未载入数据'; return; }
    const parts = [
      `${state.videos.size} 个视频`,
      `${fmtNum(state.comments.length)} 条评论`,
      `${state.sources.length} 个文件`,
    ];
    el.textContent = parts.join(' · ') + (state.videos.size === 1 ? ' · 单条视频' : '');
  }

  // v2.9：加载骨架屏（请求列表 / 读文件 / 解析 JSON 时先占位，避免白屏和跳动）
  let skeletonBuilt = false;
  let wordListStash = null;
  function buildSkeletons() {
    if (skeletonBuilt) return;
    skeletonBuilt = true;
    // v0.5.61：词云骨架不再用「几块大方块」，改成一群宽度/字号不一的「词块」，
    // 位置按螺旋分散、越靠中心越大，视觉上像正在排版的词云（taste：骨架要像真实内容的形状）。
    const cloud = $('#skCloud');
    if (cloud) {
      // v0.5.61b：46 个词块，golden-angle 螺旋 + rad^0.62（中心密、边缘疏），尺寸随半径递减
      const N = 46;
      let html = '';
      for (let i = 0; i < N; i++) {
        const ang = i * 2.399963;
        const rad = Math.pow(i / (N - 1), 0.62);
        const x = 50 + Math.cos(ang) * rad * 43;
        const y = 50 + Math.sin(ang) * rad * 38;
        const scale = 1 - 0.7 * rad;
        const w = 4.6 + 10.4 * scale;
        const h = 1.9 + 1.7 * scale;
        html += '<i class="sk-w" style="left:' + (x - w / 2).toFixed(2) + '%;top:' + (y - h / 2).toFixed(2) +
          '%;width:' + w.toFixed(2) + '%;height:' + h.toFixed(2) + '%;animation-delay:' + (i * 0.02).toFixed(2) + 's"></i>';
      }
      cloud.innerHTML = html;
    }
    const tb = $('#skTable');
    if (tb) {
      // 列宽对齐真实表格：内容 / 用户（头像+昵称）/ 点赞 / 回复 / 属地 / 时间 / 层级 / 情感
      tb.innerHTML = Array.from({ length: 12 }, (_, r) =>
        '<div class="sk-row">' +
          '<i class="sk-t" style="width:' + [52, 38, 46, 30, 44, 36, 48, 40, 50, 34, 46, 42][r] + '%"></i>' +
          '<span class="sk-user"><b></b><i style="width:' + [22, 30, 26, 34, 24, 28, 20, 26, 32, 24, 28, 22][r] + 'px"></i></span>' +
          '<i style="width:18px"></i><i style="width:16px"></i><i style="width:26px"></i>' +
          '<i style="width:52px"></i><i style="width:22px"></i><i class="sk-pill" style="width:34px"></i>' +
        '</div>'
      ).join('');
    }
  }
  function setLoading(on) {
    if (on) buildSkeletons();
    document.body.classList.toggle('is-loading', !!on);
    const c = $('#skCloud');
    if (c) c.hidden = !on;
    const t = $('#skTable');
    if (t) t.hidden = !on;
    const k = $('#kpis');
    if (k) k.setAttribute('aria-busy', on ? 'true' : 'false');
    // 关键词列表也放 8 行骨架（先暂存真实列表再清空，否则骨架会被追加到上百条真实项底下、滚出视野）
    const wl = $('#wordList');
    if (wl) {
      if (on) {
        wordListStash = wl.innerHTML;
        wl.innerHTML = '';
        [72, 54, 64, 46, 58, 40, 50, 36].forEach((w) => {
          const li = document.createElement('li');
          li.className = 'sk-li';
          li.innerHTML = '<i style="width:' + w + '%"></i>';
          wl.appendChild(li);
        });
        wl.scrollTop = 0;
      } else {
        wl.querySelectorAll('.sk-li').forEach((li) => li.remove());
        if (wordListStash != null) {
          wl.innerHTML = wordListStash;
          wordListStash = null;
        }
      }
    }
  }

  function updateEmptyState() {
    const empty = state.comments.length === 0;
    document.body.classList.toggle('is-empty', empty);
    const el = $('#cloudEmpty');
    if (el) el.classList.toggle('hidden', !empty);
  }

  /* ===================== 视频下拉 ===================== */
  function renderVideoFilter() {
    const sel = $('#videoFilter');
    const cur = state.filters.videoId;
    const counts = new Map();
    for (const c of state.comments) counts.set(c.videoId, (counts.get(c.videoId) || 0) + 1);
    const opts = ['<option value="">全部视频（' + state.comments.length + ' 条评论）</option>'];
    const list = Array.from(state.videos.values()).sort((a, b) => (counts.get(b.id) || 0) - (counts.get(a.id) || 0));
    for (const v of list) {
      const n = counts.get(v.id) || 0;
      if (!n) continue;
      const label = (v.title || ('视频 ' + String(v.id).slice(-8))) + `（${n} 条）`;
      opts.push(`<option value="${esc(v.id)}">${esc(label)}</option>`);
    }
    sel.innerHTML = opts.join('');
    sel.value = cur;
    // 「打开原视频 ↗」：选中某条视频时可用；只载入了一条视频时默认可用
    const btn = $('#btnOpenVideo');
    const onlyId = state.videos.size === 1 ? Array.from(state.videos.keys())[0] : '';
    const target = cur || onlyId;
    const meta = target ? (state.videos.get(target) || {}) : null;
    btn.disabled = !target;
    btn.dataset.videoId = target || '';
    btn.title = target
      ? '在新标签页打开抖音视频页：' + ((meta && meta.title) || target)
      : '先在左侧选一条视频（或只载入一条视频）';
  }

  /* ===================== 词云布局 ===================== */
  // 词云只用一支色阶：前 6 个高频词用强调色（数据色），其余两级中性灰。
  // v0.8.1：颜色走 CSS token，浅色主题下自动换成深灰（否则 #c2c2c7 在白色底上看不清）。
  function wordTier(rank) {
    if (rank < 6) return { color: 'var(--accent)', weight: 600 };
    if (rank < 26) return { color: 'var(--cloud-mid)', weight: 500 };
    return { color: 'var(--cloud-low)', weight: 400 };
  }

  function measureWord(word, fontSize, cloud) {
    const span = document.createElement('span');
    span.className = 'cw';
    span.textContent = word;
    span.style.position = 'absolute';
    span.style.visibility = 'hidden';
    span.style.whiteSpace = 'nowrap';
    span.style.fontSize = fontSize + 'px';
    span.style.fontWeight = '600';
    span.style.letterSpacing = '0.5px';    cloud.appendChild(span);
    const w = span.offsetWidth, h = span.offsetHeight;
    cloud.removeChild(span);
    return { w: Math.max(w, 8), h: Math.max(h, 8) };
  }

  function layoutCloud(words, cloud) {
    const W = cloud.clientWidth, H = cloud.clientHeight;
    if (!W || !H || !words.length) return [];
    cloud.innerHTML = '';
    const placed = [];
    const pad = 6;
    const maxWords = words.length;
    // v0.5.41：字号按 IDF 权重（而不是纯词频），泛词自动变小
    const minCount = words[maxWords - 1] ? words[maxWords - 1].weight : 1;
    const maxCount = words[0] ? words[0].weight : 1;
    const maxFont = Math.max(24, Math.min(60, Math.round(Math.min(W, H) / 7.5)));
    const minFont = 13;

    const sizeOf = (c) => {
      const t = maxCount === minCount ? 1 : (Math.sqrt(c) - Math.sqrt(minCount)) / (Math.sqrt(maxCount) - Math.sqrt(minCount));
      return Math.round(minFont + (maxFont - minFont) * Math.max(0, Math.min(1, t)));
    };

    const cx = W / 2, cy = H / 2;
    // 把阿基米德螺旋归一化到椭圆里，避免只用水平方向铺、留下上下一大片空白
    const rx = Math.max(40, cx - pad), ry = Math.max(40, cy - pad);

    for (let i = 0; i < maxWords; i++) {
      const rec = words[i];
      const fs = sizeOf(rec.weight);
      const m = measureWord(rec.word, fs, cloud);
      if (m.w > W - pad * 2) continue;
      let angle = (i % 2 === 0 ? 1 : -1) * 0.35;
      let okRect = null;
      for (let step = 0; step < 2600; step++) {
        const sr = 0.055 * Math.pow(Math.max(angle, 0.001), 0.85);
        const x = cx + Math.cos(angle) * sr * rx - m.w / 2;
        const y = cy + Math.sin(angle) * sr * ry - m.h / 2;
        const rect = { x, y, w: m.w, h: m.h };
        if (x >= pad && y >= pad && x + m.w <= W - pad && y + m.h <= H - pad) {
          let hit = false;
          for (const p of placed) {
            if (rect.x < p.x + p.w + 3 && rect.x + rect.w + 3 > p.x &&
                rect.y < p.y + p.h + 2 && rect.y + rect.h + 2 > p.y) { hit = true; break; }
          }
          if (!hit) { okRect = rect; break; }
        }
        angle += 0.38;
      }
      if (!okRect) continue;
      const span = document.createElement('span');
      span.className = 'cw';
      span.textContent = rec.word;
      span.dataset.word = rec.word;
      span.style.left = Math.round(okRect.x) + 'px';
      span.style.top = Math.round(okRect.y) + 'px';
      span.style.fontSize = fs + 'px';
      const tier = wordTier(placed.length);
      span.style.color = tier.color;
      span.style.fontWeight = String(tier.weight);
      cloud.appendChild(span);
      placed.push(okRect);
    }
    return placed;
  }

  /* ===================== 词云交互 ===================== */
  let hideTipTimer = null;

  function wordSamples(rec, n) {
    const out = [];
    for (const c of state.comments) {
      if (!c.text) continue;
      if (rec.cids.has(c.cid) || (c.cid === '' && tokensOf(c.textClean || c.text).map(cleanToken).indexOf(rec.word) >= 0)) {
        out.push(c);
        if (out.length >= n) break;
      }
    }
    return out;
  }

  function showTooltip(span, rec) {
    // v2.1：先清掉「上一个词 mouseout 排下的隐藏定时器」，否则快速从一个词扫到另一个词时，
    // 新弹框会在 180ms 后被旧定时器关掉——表现为「有时候悬停不弹框」。
    clearTimeout(hideTipTimer);
    hideTipTimer = null;
    const tip = $('#tooltip');
    const samples = wordSamples(rec, 2);
    const userCount = rec.users ? rec.users.size : 0;
    const items = samples.map((c) => {
      const href = profileOf(c.user);
      const tag = href ? 'a' : 'div';
      const attrs = href ? ` href="${esc(href)}" target="_blank" rel="noopener noreferrer"` : '';
      const go = href ? ' · <span class="go">点这里打开 TA 的主页 ↗</span>' : ' · <span class="go">（该用户无主页信息）</span>';
      return `<${tag} class="tt-item"${attrs}>
        <div class="tt-txt">${esc(c.text || '（无文字）')}</div>
        <div class="tt-user">${esc(c.user.nickname)}${go}</div>
      </${tag}>`;
    }).join('');
    tip.innerHTML = `
      <div class="tt-word">${esc(rec.word)}</div>
      <div class="tt-meta">出现 ${rec.count} 条评论 · ${userCount} 位用户说了这个词</div>
      <div class="tt-comments">${items || '<div class="muted small">没有可展示的样例评论</div>'}</div>
      <div class="tt-more" data-act="open-drawer">查看全部 ${rec.count} 条 →</div>`;
    tip.classList.remove('hidden');
    positionTooltip(span);
    tip.onmouseenter = () => clearTimeout(hideTipTimer);
    tip.onmouseleave = () => hideTooltip();
    const more = tip.querySelector('[data-act="open-drawer"]');
    if (more) more.addEventListener('click', (e) => { e.stopPropagation(); openDrawer(rec.word); });
  }

  function positionTooltip(span) {
    const tip = $('#tooltip');
    const r = span.getBoundingClientRect();
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    const gap = 12;
    // 悬浮框本身可点（样例评论 → 主页），所以要尽量别盖住词：鼠标进不到词上就会出现
    // 「悬停 A 却显示 B 的框」。做法：在词云面板内试上/下/左/右四个位置，取压住词面积最小的。
    const cloudRect = $('#cloud').getBoundingClientRect();
    const wordRects = $$('.cw', $('#cloud')).map((el) => el.getBoundingClientRect());
    const overlapArea = (x, y) => {
      let sum = 0;
      for (const w of wordRects) {
        const ox = Math.min(x + tw, w.right + 4) - Math.max(x, w.left - 4);
        const oy = Math.min(y + th, w.bottom + 4) - Math.max(y, w.top - 4);
        if (ox > 0 && oy > 0) sum += ox * oy;
      }
      return sum;
    };
    const inside = (x, y) => x >= cloudRect.left + 4 && y >= cloudRect.top + 4 &&
      x + tw <= cloudRect.right - 4 && y + th <= cloudRect.bottom - 4;
    const clampTo = (v, lo, hi) => Math.max(lo, Math.min(v, hi));
    const loX = cloudRect.left + 6, hiX = cloudRect.right - tw - 6;
    const loY = cloudRect.top + 6, hiY = cloudRect.bottom - th - 6;
    const cands = [
      { x: r.left + r.width / 2 - tw / 2, y: r.top - th - gap },        // 上
      { x: r.left + r.width / 2 - tw / 2, y: r.bottom + gap },          // 下
      { x: r.right + gap + 2, y: r.top + r.height / 2 - th / 2 },       // 右
      { x: r.left - tw - gap - 2, y: r.top + r.height / 2 - th / 2 },   // 左
    ].map((c) => ({
      x: clampTo(Math.round(c.x), loX, Math.max(loX, hiX)),
      y: clampTo(Math.round(c.y), loY, Math.max(loY, hiY)),
    }));
    let best = null, bestScore = Infinity;
    for (const c of cands) {
      // 越界（词云面板放不下）优先扣分；再按压住词的总面积排序
      const score = overlapArea(c.x, c.y) + (inside(c.x, c.y) ? 0 : 1e9);
      if (score < bestScore) { bestScore = score; best = c; }
    }
    if (!best) return;
    tip.style.left = best.x + 'px';
    tip.style.top = best.y + 'px';
  }

  function hideTooltip() {
    clearTimeout(hideTipTimer);
    hideTipTimer = setTimeout(() => { $('#tooltip').classList.add('hidden'); }, 180);
  }

  function bindCloudHover() {
    const cloud = $('#cloud');

    function activate(span) {
      const rec = state.wordMap.get(span.dataset.word);
      if (!rec) return;
      if (state.hoverWord !== rec.word) {
        state.hoverWord = rec.word;
        $$('.cw', cloud).forEach((el) => {
          if (el === span) { el.classList.add('hot'); el.classList.remove('dim'); }
          else { el.classList.add('dim'); el.classList.remove('hot'); }
        });
      }
      showTooltip(span, rec);
    }

    cloud.addEventListener('mouseover', (e) => {
      const span = e.target.closest('.cw');
      if (!span) return;
      activate(span);
    });
    // 兜底：tooltip 是浮在词云上的可点面板，会挡住它下面的词，光靠 mouseover 就会出现
    // 「悬停 A 却显示 B 的框 / 悬停了不弹」。这里在 document 上按鼠标坐标做几何命中，
    // 即使指针落在 tooltip 上，只要下面有词就切到那个词。
    function clearHighlight() {
      $$('.cw', cloud).forEach((el) => { el.classList.remove('hot'); el.classList.remove('dim'); });
      state.hoverWord = '';
    }
    let moveRaf = 0;
    let lastPt = null;
    document.addEventListener('mousemove', (e) => {
      lastPt = { x: e.clientX, y: e.clientY };
      // 指针在抽屉里（抽屉会盖住词云右半边）时不要再去命中它背后的词，
      // 否则翻抽屉时词云会莫名其妙地高亮。
      const inDrawer = e.target && e.target.closest ? !!e.target.closest('#drawer') : false;
      if (inDrawer) {
        if (state.hoverWord) clearHighlight();
        return;
      }
      if (moveRaf) return;
      moveRaf = requestAnimationFrame(() => {
        moveRaf = 0;
        if (!lastPt) return;
        const p = lastPt;
        const spans = $$('.cw', cloud);
        let hit = null;
        for (const el of spans) {
          const r = el.getBoundingClientRect();
          if (p.x >= r.left && p.x <= r.right && p.y >= r.top && p.y <= r.bottom) { hit = el; break; }
        }
        // 指针不在任何词上（空处 / 悬浮框上）就必须把高亮清掉。
        // 否则从悬浮框里移出来时，那个词没有 mouseout 事件，会一直亮着、别的词一直变淡，
        // 看起来就是「没悬浮在词上却高亮了」。
        if (!hit) {
          if (state.hoverWord) clearHighlight();
          return;
        }
        const tip = $('#tooltip');
        if (state.hoverWord === hit.dataset.word && !tip.classList.contains('hidden')) return;
        activate(hit);
      });
    });
    document.addEventListener('mouseleave', () => {
      clearHighlight();
      hideTooltip();
    });
    cloud.addEventListener('mouseout', (e) => {
      const span = e.target.closest('.cw');
      if (!span) return;
      const to = e.relatedTarget && e.relatedTarget.closest ? e.relatedTarget.closest('.cw') : null;
      if (to === span) return;
      span.classList.remove('hot');
      if (!to) {
        $$('.cw', cloud).forEach((el) => el.classList.remove('dim'));
        state.hoverWord = '';
      }
      hideTooltip();
    });
    cloud.addEventListener('click', (e) => {
      const span = e.target.closest('.cw');
      if (!span) return;
      openDrawer(span.dataset.word);
    });
  }

  /* ===================== 侧栏关键词 ===================== */
  function renderWordList() {
    const list = $('#wordList');
    const top = state.words.slice(0, 30);
    const max = top.length ? top[0].count : 1;
    $('#wordInfo').textContent = state.words.length ? `${state.words.length} 个词 · 点击看评论` : '';
    if (!top.length) {
      list.innerHTML = '<li class="muted small" style="display:block;cursor:default">暂无关键词</li>';
      return;
    }
    list.innerHTML = top.map((w, i) => `
      <li data-word="${esc(w.word)}">
        <span class="rank">${i + 1}</span>
        <span class="w" title="${esc(w.word)}">${esc(w.word)}</span>
        <span class="n">${w.count}</span>
      </li>`).join('');
  }

  /* ===================== 抽屉 ===================== */
  const drawer = { word: '', list: [], shown: 0, pageStep: 20 };

  function commentsWithWord(word) {
    const out = [];
    const rec = state.wordMap.get(word);
    for (const c of filtered()) {
      if (!c.text) continue;
      const has = rec && c.cid ? rec.cids.has(c.cid) : tokensOf(c.textClean || c.text).map(cleanToken).indexOf(word) >= 0;
      if (has) out.push(c);
    }
    out.sort((a, b) => b.digg - a.digg);
    return out;
  }

  function openDrawer(word) {
    const list = commentsWithWord(word);
    drawer.word = word;
    drawer.list = list;
    drawer.shown = 0;
    $('#drawerTitle').textContent = '「' + word + '」';
    $('#drawerSub').textContent = `${list.length} 条评论包含这个词（按点赞降序）`;
    $('#drawerBody').innerHTML = '';
    $('#drawer').classList.remove('hidden');
    $('#tooltip').classList.add('hidden');
    renderDrawerMore();
  }

  function renderDrawerMore() {
    const body = $('#drawerBody');
    const next = drawer.list.slice(drawer.shown, drawer.shown + drawer.pageStep);
    if (!drawer.shown && !drawer.list.length) {
      body.innerHTML = '<div class="empty small">没有找到包含这个词的评论</div>';
    }
    const frag = document.createElement('div');
    frag.innerHTML = next.map((c) => {
      const href = profileOf(c.user);
      const go = href
        ? `<a class="dc-go" href="${esc(href)}" target="_blank" rel="noopener noreferrer">打开主页 ↗</a>`
        : '<span class="dc-go off" title="导出数据里没有 sec_uid">无主页信息</span>';
      const badges = [
        c.isHot ? '<span class="badge hot">热评</span>' : '',
        c.isReply ? '<span class="badge reply">回复</span>' : '',
        c.isFolded ? '<span class="badge fold">折叠</span>' : '',
      ].join('');
      return `<div class="dc">
        <div class="dc-head">
          <div class="dc-user">
            <span class="avatar" style="${esc(avatarStyle(c.user))}">${esc(initials(c.user.nickname))}</span>
            <div class="user-meta">
              <span class="user-name">${esc(c.user.nickname)}</span>
              <span class="user-sub">${esc(c.user.uniqueId || (c.user.shortId ? 'ID ' + c.user.shortId : 'ID ' + String(c.user.uid || '').slice(-8)))}</span>
            </div>
          </div>
          ${go}
        </div>
        <div class="dc-text">${esc(c.text || '（无文字）')}</div>
        <div class="dc-meta">
          <span>赞 ${fmtNum(c.digg)}</span>
          <span>回复 ${fmtNum(c.replies)}</span>
          ${c.ip ? `<span>属地 ${esc(c.ip)}</span>` : ''}
          <span>${esc(c.createTimeStr || fmtTimeShort(c.createTime))}</span>
          <span class="spacer"></span>
          ${badges}
        </div>
      </div>`;
    }).join('');
    while (frag.firstChild) body.appendChild(frag.firstChild);
    drawer.shown += next.length;
    const more = $('#btnDrawerMore');
    more.disabled = drawer.shown >= drawer.list.length;
    more.textContent = drawer.shown >= drawer.list.length
      ? `已全部显示（${drawer.list.length} 条）`
      : `加载更多（还有 ${drawer.list.length - drawer.shown} 条）`;
  }

  function closeDrawer() { $('#drawer').classList.add('hidden'); }

  /* ===================== 表格 ===================== */
  function sortList(list) {
    const arr = list.slice();
    const by = state.sort;
    if (by === 'digg') arr.sort((a, b) => b.digg - a.digg || b.createTime - a.createTime);
    else if (by === 'time') arr.sort((a, b) => b.createTime - a.createTime || b.digg - a.digg);
    else if (by === 'len') arr.sort((a, b) => b.text.length - a.text.length || b.digg - a.digg);
    else if (by === 'replies') arr.sort((a, b) => b.replies - a.replies || b.digg - a.digg);
    return arr;
  }

  function highlight(text, q) {
    if (!q) return esc(text);
    const lower = text.toLowerCase();
    let idx = lower.indexOf(q);
    if (idx === -1) return esc(text);
    let out = '', i = 0;
    while (idx !== -1) {
      out += esc(text.slice(i, idx)) + '<span class="hl">' + esc(text.slice(idx, idx + q.length)) + '</span>';
      i = idx + q.length;
      idx = lower.indexOf(q, i);
    }
    out += esc(text.slice(i));
    return out;
  }

  function sentBadge(c) {
    const l = (c.sentiment && c.sentiment.label) || 'neu';
    return '<span class="sbadge ' + l + '" title="词典打分 ' + ((c.sentiment && c.sentiment.score) || 0) + '">' + SENT_LABEL[l] + '</span>';
  }

  function renderTable() {
    const list = sortList(filtered());
    const total = list.length;
    const pages = Math.max(1, Math.ceil(total / state.pageSize));
    if (state.page > pages) state.page = pages;
    const start = (state.page - 1) * state.pageSize;
    const rows = list.slice(start, start + state.pageSize);
    const q = state.filters.search.trim().toLowerCase();
    const tbody = $('#tbody');
    tbody.innerHTML = rows.map((c) => {
      const href = profileOf(c.user);
      const nameHtml = highlight(c.user.nickname, q);
      const favRec = c.user.uid ? state.favorites.get(String(c.user.uid)) : null;
      const userCell = `<div class="user-cell">
        <span class="avatar" style="${esc(avatarStyle(c.user))}">${esc(initials(c.user.nickname))}</span>
        <div class="user-meta">
          ${href ? `<a class="user-name" href="${esc(href)}" target="_blank" rel="noopener noreferrer" title="打开抖音主页">${nameHtml}</a>`
                 : `<span class="user-name nolink" title="导出数据里没有 sec_uid，无法拼主页">${nameHtml}</span>`}
          <span class="user-sub">${esc(c.user.uniqueId || (c.user.shortId ? 'ID ' + c.user.shortId : ''))}</span>
          <button type="button" class="fav-star${favRec ? ' on' : ''}" data-fav-uid="${esc(c.user.uid)}" data-fav-nick="${esc(c.user.nickname)}" data-fav-secuid="${esc(c.user.secUid)}" data-fav-unique="${esc(c.user.uniqueId)}" data-fav-region="${esc(c.ip || '')}" title="${favRec ? '取消收藏' : '收藏为目标客户'}" aria-label="收藏客户">${favRec ? '★' : '☆'}</button>
        </div>
      </div>`;
      const badges = `<span class="badges">
        ${c.isHot ? '<span class="badge hot">热</span>' : ''}
        ${c.isReply ? '<span class="badge reply">回复</span>' : ''}
        ${c.isFolded ? '<span class="badge fold">折叠</span>' : ''}
      </span>`;
      return `<tr>
        <td class="cell-text"><div class="txt">${highlight(c.text || '（无文字）', q)}${badges}</div>
          ${c.videoTitle && !state.filters.videoId ? `<div class="muted small" style="margin-top:4px"><a class="video-link" href="${esc(videoUrl(c.videoId))}" target="_blank" rel="noopener noreferrer" title="在原视频页打开这条视频">${esc(c.videoTitle)} ↗</a></div>` : ''}
        </td>
        <td data-label="用户">${userCell}</td>
        <td class="num" data-label="点赞">${fmtNum(c.digg)}</td>
        <td class="num" data-label="回复">${fmtNum(c.replies)}</td>
        <td class="muted" data-label="属地">${esc(c.ip || '-')}</td>
        <td class="muted small" data-label="时间">${esc(c.createTimeStr ? c.createTimeStr.slice(0, 16) : fmtTime(c.createTime))}</td>
        <td class="muted small" data-label="层级">${c.isReply ? '二级' : '一级'}</td>
        <td class="cell-sent" data-label="情感">${sentBadge(c)}</td>
      </tr>`;
    }).join('');
    $('#tableEmpty').classList.toggle('hidden', rows.length > 0);
    $('#tableCount').textContent = `（${total} 条${state.filters.search ? '，含搜索「' + state.filters.search + '」' : ''}）`;
    $('#btnExport').disabled = total === 0;
    if ($('#btnExportJson')) $('#btnExportJson').disabled = total === 0;
    renderPager(pages, total);
  }

  function renderPager(pages, total) {
    const pager = $('#pager');
    const cur = state.page;
    const btns = [];
    btns.push(`<button type="button" data-page="1" ${cur === 1 ? 'disabled' : ''}>« 首页</button>`);
    btns.push(`<button type="button" data-page="${cur - 1}" ${cur === 1 ? 'disabled' : ''}>‹ 上一页</button>`);
    const from = Math.max(1, cur - 3), to = Math.min(pages, from + 6);
    for (let p = from; p <= to; p++) {
      btns.push(`<button type="button" data-page="${p}" class="${p === cur ? 'on' : ''}">${p}</button>`);
    }
    btns.push(`<button type="button" data-page="${cur + 1}" ${cur === pages ? 'disabled' : ''}>下一页 ›</button>`);
    btns.push(`<button type="button" data-page="${pages}" ${cur === pages ? 'disabled' : ''}>末页 »</button>`);
    pager.innerHTML = btns.join('') + `<span class="info">第 ${cur} / ${pages} 页 · 共 ${total} 条</span>`;
  }

  /* ===================== 导出 ===================== */
  function csvCell(v) {
    const s = String(v == null ? '' : v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  const EXPORT_COLS = [
    ['cid', '评论ID'], ['video_id', '视频ID'], ['video_title', '视频标题'], ['text', '评论内容'],
    ['user_nickname', '用户昵称'], ['user_unique_id', '抖音号'], ['user_sec_uid', 'sec_uid(主页链接用)'],
    ['digg_count', '点赞数'], ['reply_comment_total', '回复数'], ['ip_label', '属地'],
    ['create_time_str', '发布时间'], ['level', '层级(1一级/2二级)'],
    ['sentiment', '情感(正向/中性/负向)'], ['topic', '主题'],
  ];

  function topicLabelOf(c) {
    const t = state.topics && state.topics[c.topic];
    return t ? t.label : '';
  }

  function exportRows() {
    const list = sortList(filtered());
    if (!list.length) { toast('没有可导出的评论'); return null; }
    return list;
  }

  function download(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
  }

  function stamp() { return new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-'); }

  // 导出 CSV：第 1 行英文键（给程序读），第 2 行中文说明（给 Excel 里的人看，首格带 # 标记）
  function exportFilteredCsv() {
    const list = exportRows();
    if (!list) return;
    const rows = [EXPORT_COLS.map((c) => c[0]).join(',')];
    rows.push(EXPORT_COLS.map((c, i) => (i === 0 ? '# ' : '') + c[1]).join(','));
    for (const c of list) {
      rows.push([
        csvCell(c.cid), csvCell(c.videoId), csvCell(c.videoTitle), csvCell(c.text),
        csvCell(c.user.nickname), csvCell(c.user.uniqueId), csvCell(c.user.secUid),
        csvCell(c.digg), csvCell(c.replies), csvCell(c.ip), csvCell(c.createTimeStr || fmtTime(c.createTime)),
        csvCell(c.isReply ? 2 : 1),
        csvCell(SENT_LABEL[(c.sentiment && c.sentiment.label) || 'neu']),
        csvCell(topicLabelOf(c)),
      ].join(','));
    }
    download(new Blob(['\uFEFF' + rows.join('\r\n') + '\r\n'], { type: 'text/csv;charset=utf-8' }), 'comments-view-' + stamp() + '.csv');
    toast(`已导出 ${list.length} 条评论（CSV）`);
  }

  // 导出 JSON：meta + comments（与采集插件导出的 JSON 结构接近，方便再喂给别的工具）
  function exportFilteredJson() {
    const list = exportRows();
    if (!list) return;
    const vids = Array.from(new Set(list.map((c) => String(c.videoId))));
    const payload = {
      exportedAt: new Date().toISOString(),
      count: list.length,
      filters: {
        videoId: state.filters.videoId || '',
        search: state.filters.search || '',
        onlyHasProfile: !!state.filters.onlyHasProfile,
        onlyTopLevel: !!state.filters.onlyTopLevel,
        onlyNonEmpty: !!state.filters.onlyNonEmpty,
        sortBy: state.filters.sortBy || 'digg',
      },
      videos: vids.map((id) => ({ videoId: id, title: (state.videos.get(id) || {}).title || '' })),
      comments: list.map((c) => ({
        cid: c.cid, videoId: c.videoId, videoTitle: c.videoTitle,
        text: c.text, textClean: c.textClean, createTime: c.createTime, createTimeStr: c.createTimeStr,
        diggCount: c.digg, replyCommentTotal: c.replies, ipLabel: c.ip,
        level: c.isReply ? 2 : 1, isReply: !!c.isReply, isHot: !!c.isHot, isFolded: !!c.isFolded,
        sentiment: (c.sentiment && c.sentiment.label) || 'neu',
        sentimentScore: (c.sentiment && c.sentiment.score) || 0,
        topic: topicLabelOf(c),
        // v3.2：淘宝「店透视」表带过来的维度（抖音数据为空则省略）
        ...(c.rating || c.sku || c.images ? { rating: c.rating || '', sku: c.sku || '', images: c.images || 0 } : {}),
        user: { nickname: c.user.nickname, uid: c.user.uid, secUid: c.user.secUid, uniqueId: c.user.uniqueId, shortId: c.user.shortId },
      })),
    };
    download(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' }), 'comments-view-' + stamp() + '.json');
    toast(`已导出 ${list.length} 条评论（JSON）`);
  }

  /* ===================== 刷新 ===================== */
  function recomputeWords(list) {
    state.words = buildWords(list);
    state.wordMap = new Map(state.words.map((w) => [w.word, w]));
  }

  let layoutSeq = 0;
  function renderCloud() {
    const cloud = $('#cloud');
    if (!state.comments.length) { cloud.innerHTML = ''; return; }
    const size = Number($('#cloudSize').value) || 120;
    const words = state.words.slice(0, size).filter((w) => w.count >= 2 || state.words.length < 40);
    const use = words.length ? words : state.words.slice(0, size);
    const seq = ++layoutSeq;
    // 等一帧，保证 cloud 已按最新尺寸布局
    requestAnimationFrame(() => {
      if (seq !== layoutSeq) return;
      layoutCloud(use, cloud);
      state.cloudReady = true;
    });
  }

  function refreshAll() {
    // v3.0：先给全部评论打情感分（筛选按它走），再在“基础筛选”集合上做主题聚类，
    // 最后按当前筛选渲染表格 / KPI / 洞察。
    annotateSentiment(state.comments);
    const base = baseFiltered();
    buildTopics(base);
    const list = filtered();
    recomputeWords(list);
    renderKpis(list);
    renderInsights(list);
    renderTopicFilter();
    renderVideoFilter();
    renderWordList();
    renderCloud();
    fillRegionFilter();
    renderRegionPanel();
    $('#cloudSub').textContent = state.words.length
      ? `${state.words.length} 个词 · ${fmtNum(list.length)} 条评论`
      : '';
    state.page = 1;
    renderTable();
  }

  /* ===================== 事件绑定 ===================== */
  // 嵌入模式下「刷新列表 / 清空」用的钩子（v2.5）
  var embedResetList = null;
  let currentFile = null; // 当前载入的导出文件（清空时从下拉列表里移除这一条）

  function bindEvents() {
    $('#btnOpenFiles').addEventListener('click', () => $('#fileInput').click());
    const btnOpenFiles2 = $('#btnOpenFiles2');
    if (btnOpenFiles2) btnOpenFiles2.addEventListener('click', () => $('#fileInput').click());
    $('#btnOpenDir').addEventListener('click', () => $('#dirInput').click());
    $('#fileInput').addEventListener('change', (e) => { loadFiles(e.target.files); e.target.value = ''; });
    $('#dirInput').addEventListener('change', (e) => { loadFiles(e.target.files); e.target.value = ''; });

  const btnTheme = $('#btnTheme');
  if (btnTheme) {
    btnTheme.addEventListener('click', () => {
      const mode = window.__douyinTheme ? window.__douyinTheme.toggle() : 'dark';
      toast(mode === 'light' ? '已切换到浅色主题' : '已切换到深色主题');
      if (state.comments.length) { renderTable(); renderRegionPanel(); }
      const gm = $('#groupModal');
      if (gm && !gm.classList.contains('hidden')) renderGrouped(gm.dataset.mode === '__fav__' ? '__fav__' : '');
    });
  }

    $('#btnClear').addEventListener('click', () => {
      state.comments = [];
      state.videos = new Map();
      state.sources = [];
      state.words = [];
      state.wordMap = new Map();
      state.page = 1;
      state.filters.videoId = '';
      state.filters.search = '';
      $('#search').value = '';
      updateEmptyState();
      updateScope();
      refreshAll();
      $('#btnClear').disabled = true;
      $('#cloudEmpty').classList.remove('hidden');
      $('#tableEmpty').classList.remove('hidden');
      $('#videoFilter').innerHTML = '';
      $('#btnOpenVideo').disabled = true;
      $('#btnOpenVideo').dataset.videoId = '';
      closeDrawer();
      if (embedResetList) embedResetList();
      toast('已清空');
    });

    $('#cloudSize').addEventListener('change', () => { renderCloud(); });
    $('#btnRelayout').addEventListener('click', () => { renderCloud(); toast('已重新排布'); });

    // 「打开原视频 ↗」：新标签页打开当前选中视频的抖音页面
    $('#btnOpenVideo').addEventListener('click', () => {
      const btn = $('#btnOpenVideo');
      const id = btn.dataset.videoId || state.filters.videoId;
      const url = videoUrl(id);
      if (!url) { toast('先选择一条视频'); return; }
      window.open(url, '_blank', 'noopener');
    });

    $('#wordList').addEventListener('click', (e) => {
      const li = e.target.closest('li[data-word]');
      if (!li) return;
      openDrawer(li.dataset.word);
    });

    $('#videoFilter').addEventListener('change', (e) => {
      state.filters.videoId = e.target.value;
      state.filters.topic = '';
      refreshAll();
    });
    const sentSel = $('#sentFilter');
    if (sentSel) sentSel.addEventListener('change', (e) => { state.filters.sentiment = e.target.value; refreshAll(); });
    const topicSel = $('#topicFilter');
    if (topicSel) topicSel.addEventListener('change', (e) => { state.filters.topic = e.target.value; state.page = 1; refreshAll(); });
    const insights = $('#insights');
    if (insights) {
      insights.addEventListener('click', (e) => {
        const t = e.target.closest('[data-topic]');
        if (t) { state.filters.topic = t.dataset.topic; state.page = 1; refreshAll(); return; }
        const w = e.target.closest('[data-topic-word]');
        if (w) { $('#search').value = w.dataset.topicWord; state.filters.search = w.dataset.topicWord; state.page = 1; renderTable(); document.querySelector('.table-panel').scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
        const n = e.target.closest('[data-neg-cid]');
        if (n) {
          const c = state.comments.find((x) => x.cid === n.dataset.negCid);
          if (c) toast((SENT_LABEL[(c.sentiment && c.sentiment.label) || 'neu']) + '：' + (c.text || '（无文字）').slice(0, 80));
        }
      });
    }
    ['onlyHasProfile', 'onlyTopLevel', 'onlyNonEmpty', 'onlyContent'].forEach((id) => {
      $('#' + id).addEventListener('change', (e) => {
        state.filters[id] = e.target.checked;
        refreshAll();
      });
    });

    // v0.7.0：属地筛选 / 只看已收藏客户
    const regionSel = $('#regionFilter');
    if (regionSel) regionSel.addEventListener('change', (e) => {
      state.filters.region = e.target.value;
      state.page = 1;
      refreshAll();
    });
    const onlyFavBox = $('#onlyFav');
    if (onlyFavBox) onlyFavBox.addEventListener('change', (e) => {
      state.filters.favoritesOnly = e.target.checked;
      state.page = 1;
      refreshAll();
    });

    // 评论表用户旁的收藏星标
    $('#tbody').addEventListener('click', (e) => {
      const star = e.target.closest('[data-fav-uid]');
      if (!star) return;
      e.preventDefault();
      const ds = star.dataset;
      void toggleFavorite({ uid: ds.favUid, nickname: ds.favNick, secUid: ds.favSecuid, uniqueId: ds.favUnique }, ds.favRegion);
    });

    // 地域分布面板 / 地域分组弹层
    const regionBars = $('#regionBars');
    if (regionBars) regionBars.addEventListener('click', (e) => {
      const row = e.target.closest('[data-region]');
      if (!row) return;
      const region = row.dataset.region || '';
      state.filters.region = region;
      state.page = 1;
      const sel = $('#regionFilter');
      if (sel) sel.value = region;
      refreshAll();
      document.querySelector('.table-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    if ($('#btnGroupRegion')) $('#btnGroupRegion').addEventListener('click', () => openGroupModal(''));
    if ($('#btnExportRegions')) $('#btnExportRegions').addEventListener('click', exportRegionCsv);
    if ($('#btnFavList')) $('#btnFavList').addEventListener('click', () => openGroupModal('__fav__'));
    if ($('#btnCloseGroup')) $('#btnCloseGroup').addEventListener('click', closeGroupModal);
    if ($('#groupModal')) {
      $('#groupModal').addEventListener('click', (e) => { if (e.target === $('#groupModal')) closeGroupModal(); });
      $('#groupChips').addEventListener('click', (e) => {
        const favChip = e.target.closest('[data-fav-region]');
        if (favChip) {
          favRegion = favChip.dataset.favRegion || '';
          renderGrouped('__fav__');
          return;
        }
        const chip = e.target.closest('[data-group-region]');
        if (!chip) return;
        renderGrouped(chip.dataset.groupRegion || '');
      });
      $('#groupBody').addEventListener('click', (e) => {
        const star = e.target.closest('[data-fav-uid]');
        if (star) {
          const ds = star.dataset;
          void toggleFavorite({ uid: ds.favUid, nickname: ds.favNick, secUid: ds.favSecuid, uniqueId: ds.favUnique }, ds.favRegion);
          return;
        }
        const bulk = e.target.closest('[data-fav-region-all]');
        if (bulk) void favoriteRegion(bulk.dataset.favRegionAll || '');
      });
    }

    // v0.5.41：自定义加词 / 屏蔽词（逗号或空格分隔，改完 400ms 自动生效并记忆）
    const kwKeepEl = $('#kwKeep'), kwBlockEl = $('#kwBlock');
    if (kwKeepEl) kwKeepEl.value = (state.kwKeep || []).join(',');
    if (kwBlockEl) kwBlockEl.value = (state.kwBlock || []).join(',');
    const onKwTune = debounce(applyWordLists, 400);
    if (kwKeepEl) kwKeepEl.addEventListener('input', onKwTune);
    if (kwBlockEl) kwBlockEl.addEventListener('input', onKwTune);

    const onSearch = debounce(() => {
      state.filters.search = $('#search').value;
      state.page = 1;
      renderTable();
    }, 200);
    $('#search').addEventListener('input', onSearch);

    $('#sortBy').addEventListener('change', (e) => {
      state.sort = e.target.value;
      state.page = 1;
      renderTable();
    });

    $('#pager').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-page]');
      if (!btn) return;
      state.page = Number(btn.dataset.page) || 1;
      renderTable();
      document.querySelector('.table-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });

    $('#btnExport').addEventListener('click', exportFilteredCsv);
    $('#btnExportJson').addEventListener('click', exportFilteredJson);

    $('#btnCloseDrawer').addEventListener('click', closeDrawer);
    $('#btnDrawerMore').addEventListener('click', renderDrawerMore);
    $('#btnDrawerFilter').addEventListener('click', () => {
      const w = drawer.word;
      if (!w) return;
      $('#search').value = w;
      state.filters.search = w;
      state.page = 1;
      closeDrawer();
      renderTable();
      document.querySelector('.table-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
      toast('已在评论表里筛选「' + w + '」');
    });

    window.addEventListener('resize', debounce(() => {
      if (!state.comments.length) return;
      renderCloud();
    }, 260));

    // 拖拽文件到页面
    document.addEventListener('dragover', (e) => { e.preventDefault(); });
    document.addEventListener('drop', (e) => {
      e.preventDefault();
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) loadFiles(e.dataTransfer.files);
    });

    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        closeDrawer();
        closeGroupModal();
        $('#tooltip').classList.add('hidden');
      }
    });

    bindCloudHover();
  }

  /* ===================== v0.7.0：地域分布 / 收藏目标客户 =====================
   * 地域 = 导出数据里的 `ip_label`（抖音按 IP 归属地给的省份/地区字符串）。
   * 收藏只存 uid + 昵称/属地/抖音号，落盘由服务端放在 `$DSH_HOME/douyin-collector/favorites.json`，
   * 因此切换 NovaFlow 账号 / DSH profile 天然隔离；自包含词云 HTML 里没有服务端，收藏自动禁用。
   */
  let groupRegion = '';
// v0.8.5：已收藏客户弹层里的属地筛选（只列收藏里出现过的属地）。
let favRegion = '';

  function canUseFavApi() { return /^https?:/.test(location.protocol); }
  function favEndpoint(kind) { return EMBED_API + '/favorites' + (kind ? '/' + kind : ''); }

  function favPayload(user, region) {
    const u = user || {};
    return {
      uid: String(u.uid || ''),
      secUid: String(u.secUid || ''),
      nickname: String(u.nickname || ''),
      uniqueId: String(u.uniqueId || ''),
      region: String(region || ''),
      profileUrl: u.secUid ? 'https://www.douyin.com/user/' + encodeURIComponent(String(u.secUid)) : '',
    };
  }

  function renderFavBadge() {
    const b = $('#favBadge');
    if (b) b.textContent = String(state.favorites.size);
  }

  async function loadFavorites() {
    if (!canUseFavApi()) return;
    try {
      const r = await fetch(favEndpoint(), { cache: 'no-store' });
      if (!r.ok) return;
      const data = await r.json();
      state.favorites = new Map((data.favorites || []).map((f) => [String(f.uid), f]));
      state.favReady = true;
    } catch (e) { /* 旧服务端 / 离线：忽略，收藏按钮会提示 */ }
    renderFavBadge();
    if (state.comments.length) { renderTable(); renderRegionPanel(); }
  }

  async function toggleFavorite(user, region) {
    if (!canUseFavApi()) { toast('自包含词云 HTML 里不能收藏：请在插件面板里打开'); return; }
    const uid = String((user && user.uid) || '');
    if (!uid) { toast('这个用户没有 uid，无法收藏'); return; }
    const was = state.favorites.get(uid) || null;
    const label = (user && user.nickname) || uid;
    if (was) state.favorites.delete(uid);
    else state.favorites.set(uid, Object.assign(favPayload(user, region), { savedAt: Date.now() }));
    renderFavBadge(); renderTable(); renderRegionPanel();
    try {
      const r = await fetch(favEndpoint(was ? 'remove' : ''), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(was ? { uid } : { user: favPayload(user, region) }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || data.ok === false) throw new Error((data && data.error) || ('HTTP ' + r.status));
      state.favorites = new Map((data.favorites || []).map((f) => [String(f.uid), f]));
      state.favReady = true;
      toast(was ? '已取消收藏：' + label : '已收藏客户：' + label);
    } catch (e) {
      if (was) state.favorites.set(uid, was); else state.favorites.delete(uid);
      toast('收藏失败：' + ((e && e.message) || e) + '（可能需要重启 NovaFlow / DSH 才加载新接口）');
    }
    renderFavBadge(); renderTable(); renderRegionPanel();
    const modal = $('#groupModal');
    if (modal && !modal.classList.contains('hidden')) {
      renderGrouped(modal.dataset.mode === '__fav__' ? '__fav__' : groupRegion);
    }
  }

  async function favoriteRegion(region) {
    if (!canUseFavApi()) { toast('自包含词云 HTML 里不能收藏：请在插件面板里打开'); return; }
    const group = collectGroups().find((g) => g.region === region);
    if (!group) { toast('没有这个地域的数据'); return; }
    const users = group.users.filter((u) => u.uid).map((u) => favPayload(u, region));
    if (!users.length) { toast('这个地域的用户都没有 uid，无法收藏'); return; }
    try {
      const r = await fetch(favEndpoint(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ users }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || data.ok === false) throw new Error((data && data.error) || ('HTTP ' + r.status));
      state.favorites = new Map((data.favorites || []).map((f) => [String(f.uid), f]));
      toast(`已收藏「${region}」的 ${users.length} 位客户`);
    } catch (e) {
      toast('批量收藏失败：' + ((e && e.message) || e));
    }
    renderFavBadge(); renderTable(); renderRegionPanel();
    const modal = $('#groupModal');
    if (modal && !modal.classList.contains('hidden')) {
      renderGrouped(modal.dataset.mode === '__fav__' ? '__fav__' : groupRegion);
    }
  }

  /** 按属地聚合：地域 -> {region, comments, digg, users[]}，users 按获赞降序 */
  function collectGroups() {
    const groups = new Map();
    for (const c of state.comments) {
      const region = c.ip || '未知属地';
      let g = groups.get(region);
      if (!g) { g = { region, comments: 0, digg: 0, users: new Map() }; groups.set(region, g); }
      g.comments += 1; g.digg += c.digg || 0;
      const key = c.user.uid || ('nick:' + c.user.nickname);
      let u = g.users.get(key);
      if (!u) {
        u = {
          uid: c.user.uid || '', nickname: c.user.nickname || '', secUid: c.user.secUid || '',
          uniqueId: c.user.uniqueId || '', region, comments: 0, digg: 0, lastAt: 0, sample: '',
        };
        g.users.set(key, u);
      }
      u.comments += 1; u.digg += c.digg || 0;
      const at = Number(c.createTime) || 0;
      if (at >= u.lastAt) { u.lastAt = at; if (c.text) u.sample = String(c.text).slice(0, 60); }
    }
    const out = Array.from(groups.values());
    for (const g of out) {
      g.users = Array.from(g.users.values()).sort((a, b) => (b.digg || 0) - (a.digg || 0) || (b.comments || 0) - (a.comments || 0));
      g.userCount = g.users.length;
    }
    out.sort((a, b) => b.comments - a.comments);
    return out;
  }

  function fillRegionFilter() {
    const sel = $('#regionFilter');
    if (!sel) return;
    const groups = collectGroups();
    const cur = state.filters.region || '';
    const opts = ['<option value="">全部属地</option>'];
    for (const g of groups) opts.push(`<option value="${esc(g.region)}">${esc(g.region)}（${fmtNum(g.comments)}）</option>`);
    sel.innerHTML = opts.join('');
    if (cur && groups.some((g) => g.region === cur)) sel.value = cur;
    else if (cur) state.filters.region = '';
  }

  function renderRegionPanel() {
    const host = $('#regionBars');
    if (!host) return;
    const groups = collectGroups();
    const uidSet = new Set();
    let favRows = 0;
    for (const g of groups) for (const u of g.users) {
      uidSet.add(u.uid || ('nick:' + u.nickname));
      if (u.uid && state.favorites.has(String(u.uid))) favRows += 1;
    }
    const max = groups.reduce((m, g) => Math.max(m, g.comments), 0) || 1;
    host.innerHTML = groups.length
      ? groups.slice(0, 12).map((g) => `<button type="button" class="region-row${state.filters.region === g.region ? ' on' : ''}" data-region="${esc(g.region)}" title="点击只看「${esc(g.region)}」的评论">
          <span class="region-name">${esc(g.region)}</span>
          <span class="region-track"><i style="width:${Math.max(3, (g.comments / max) * 100)}%"></i></span>
          <span class="region-num">${fmtNum(g.comments)} 条 · ${fmtNum(g.userCount)} 人</span>
        </button>`).join('')
      : '<p class="meta">导出数据里没有属地字段（ip_label），无法按地域分组。</p>';
    const sub = $('#regionSub');
    if (sub) sub.textContent = groups.length
      ? `共 ${groups.length} 个地域 · ${fmtNum(uidSet.size)} 位用户${favRows ? ' · 已收藏 ' + fmtNum(favRows) + ' 人' : ''}`
      : '';
    renderFavBadge();
  }

  function openGroupModal(mode) {
    const modal = $('#groupModal');
    if (!modal) return;
    modal.dataset.mode = mode || '';
    modal.classList.remove('hidden');
    renderGrouped(mode === '__fav__' ? '__fav__' : '');
  }

  function closeGroupModal() {
    const modal = $('#groupModal');
    if (modal) modal.classList.add('hidden');
  }

  function groupUserRow(u) {
    const rec = u.uid ? state.favorites.get(String(u.uid)) : null;
    const profile = u.secUid ? 'https://www.douyin.com/user/' + encodeURIComponent(String(u.secUid)) : '';
    const name = profile
      ? `<a class="user-name" href="${esc(profile)}" target="_blank" rel="noopener noreferrer">${esc(u.nickname)}</a>`
      : `<span class="user-name">${esc(u.nickname || '匿名用户')}</span>`;
    return `<div class="group-user">
      <span class="avatar" style="${esc(avatarStyle({ secUid: u.secUid, uid: u.uid, nickname: u.nickname }))}">${esc(initials(u.nickname))}</span>
      <div class="gu-main">
        ${name}
        <span class="muted small">${esc(u.uniqueId || (u.uid ? 'uid ' + String(u.uid).slice(-8) : '') || '无抖音号')}${u.region ? ' · ' + esc(u.region) : ''}</span>
        ${u.sample ? `<div class="gu-sample">${esc(u.sample)}</div>` : ''}
      </div>
      <div class="gu-stats"><span>${fmtNum(u.comments)} 条</span><span>赞 ${fmtNum(u.digg)}</span></div>
      <button type="button" class="fav-star${rec ? ' on' : ''}" data-fav-uid="${esc(u.uid)}" data-fav-nick="${esc(u.nickname)}" data-fav-secuid="${esc(u.secUid || '')}" data-fav-unique="${esc(u.uniqueId || '')}" data-fav-region="${esc(u.region || '')}" title="${rec ? '取消收藏' : '收藏为目标客户'}">${rec ? '★' : '☆'}</button>
    </div>`;
  }

  function renderGrouped(region) {
    const modal = $('#groupModal');
    if (!modal) return;
    const favMode = region === '__fav__';
    groupRegion = favMode ? '' : String(region || '');
    const body = $('#groupBody');
    if (favMode) {
      const favsAll = Array.from(state.favorites.values());
      const regionOfFav = (f) => String((f && f.region) || '').trim() || '未知属地';
      const counts = new Map();
      for (const f of favsAll) counts.set(regionOfFav(f), (counts.get(regionOfFav(f)) || 0) + 1);
      if (favRegion && !counts.has(favRegion)) favRegion = '';
      const favs = favRegion ? favsAll.filter((f) => regionOfFav(f) === favRegion) : favsAll;
      $('#groupTitle').textContent = '已收藏客户';
      const rows = Array.from(counts.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh'));
      $('#groupChips').innerHTML = [
        `<button type="button" class="chip${favRegion ? '' : ' on'}" data-fav-region="">全部（${fmtNum(favsAll.length)}）</button>`,
        ...rows.map(([region, n]) => `<button type="button" class="chip${favRegion === region ? ' on' : ''}" data-fav-region="${esc(region)}">${esc(region)} · ${fmtNum(n)}</button>`),
      ].join('');
      const sub = $('#groupSub');
      if (sub) sub.textContent = favRegion ? `${fmtNum(favs.length)} / ${fmtNum(favsAll.length)} 位 · ${favRegion}` : `${fmtNum(favsAll.length)} 位`;
      body.innerHTML = favs.length
        ? favs.map((f) => groupUserRow({ uid: f.uid, nickname: f.nickname, secUid: f.secUid, uniqueId: f.uniqueId, region: f.region, comments: 0, digg: 0, sample: f.note || '' })).join('')
        : `<p class="meta">${favsAll.length ? '这个属地没有已收藏客户' : '还没有收藏客户：在评论表里点用户旁的「☆」，或在「按地域分组看客户」里批量收藏。'}</p>`;
      return;
    }
    const groups = collectGroups();
    $('#groupTitle').textContent = groupRegion ? `${groupRegion} · 地域客户` : '按地域分组看客户';
    const chips = [`<button type="button" class="chip${groupRegion ? '' : ' on'}" data-group-region="">全部地域（${groups.length}）</button>`]
      .concat(groups.map((g) => `<button type="button" class="chip${groupRegion === g.region ? ' on' : ''}" data-group-region="${esc(g.region)}">${esc(g.region)} · ${fmtNum(g.userCount)}人</button>`))
      .join('');
    $('#groupChips').innerHTML = chips;
    const list = groupRegion ? groups.filter((g) => g.region === groupRegion) : groups;
    const usersTotal = list.reduce((n, g) => n + g.userCount, 0);
    const sub = $('#groupSub');
    if (sub) sub.textContent = `${list.length} 个地域 · ${fmtNum(usersTotal)} 位用户（按获赞降序，每区最多列 200 人）`;
    body.innerHTML = list.length
      ? list.map((g) => `<div class="group-block">
          <div class="group-head"><strong>${esc(g.region)}</strong>
            <span class="meta">${fmtNum(g.comments)} 条评论 · ${fmtNum(g.userCount)} 位用户 · 总获赞 ${fmtNum(g.digg)}</span>
            <span class="inline"><button type="button" class="btn small ghost" data-fav-region-all="${esc(g.region)}">收藏本区全部</button></span>
          </div>
          ${g.users.slice(0, 200).map(groupUserRow).join('')}
          ${g.userCount > 200 ? '<p class="meta">仅显示前 200 位（按获赞排序）</p>' : ''}
        </div>`).join('')
      : '<p class="meta">没有可分组的数据。</p>';
  }

  function exportRegionCsv() {
    const groups = collectGroups();
    if (!groups.length) { toast('没有数据可导出'); return; }
    const rows = [['地域', '用户昵称', '抖音号', 'uid', 'sec_uid(主页用)', '评论数', '获赞', '最近评论时间', '是否已收藏', '代表评论']];
    for (const g of groups) {
      for (const u of g.users) {
        rows.push([
          g.region, u.nickname, u.uniqueId, u.uid, u.secUid, u.comments, u.digg,
          u.lastAt ? fmtTime(u.lastAt) : '',
          (u.uid && state.favorites.has(String(u.uid))) ? '是' : '',
          u.sample,
        ]);
      }
    }
    const text = '\uFEFF' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
    const d = new Date();
    const pad = (x) => String(x).padStart(2, '0');
    download(new Blob([text], { type: 'text/csv;charset=utf-8' }), `douyin-regions-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.csv`);
    toast(`已导出 ${groups.length} 个地域、${rows.length - 1} 位用户`);
  }

  /* ===================== 启动 ===================== */
  // 单文件快照（插件「导出词云」生成的自包含 HTML）会在加载本脚本前塞入
  //   window.__CW_BOOT__ = { title, exportedAt, docs: [<导出 JSON 对象>, …] }
  // 这里把它当成本地文件一样读进来，用户双击 HTML 就能看词云，不用再选文件。
  function bootFromSnapshot() {
    const boot = window.__CW_BOOT__;
    if (!boot || !Array.isArray(boot.docs) || !boot.docs.length) return false;
    let total = 0;
    boot.docs.forEach((doc, i) => {
      try {
        const name = (doc && doc.__name) || `快照-${i + 1}.json`;
        const n = ingestJson(JSON.stringify(doc), name);
        if (n > 0) { total += n; state.sources.push(name); }
      } catch (e) { console.warn('快照读取失败', e); }
    });
    if (!total) return false;
    if (boot.title) document.title = boot.title;
    updateScope();
    updateEmptyState();
    $('#btnClear').disabled = false;
    refreshAll();
    toast(`词云快照：${total} 条评论${boot.exportedAt ? '（导出于 ' + String(boot.exportedAt).slice(0, 16).replace('T', ' ') + '）' : ''}`);
    return true;
  }

  /* ---- 嵌入 DSH 模式：从插件服务端读本地导出文件，不用手选（v0.1.0） ---- */
  const EMBED_API = new URL('api/', location.href).href.replace(/\/$/, '');
  // v0.1.5：把「清空了哪些文件 / 上次看的是哪个」记在浏览器 localStorage 里。
  // 之前只存内存，切会话（iframe 重载）后列表重新扫描磁盘、又自动载入最新一份，
  // 看起来就是「清空了又全回来」。现在清空过的文件会被持久忽略，下次进来也不会自动载入它。
  const EMBED_STORE_KEY = 'cw.embed.v1';
  function embedStoreGet() {
    try { return JSON.parse(localStorage.getItem(EMBED_STORE_KEY) || '{}') || {}; } catch (e) { return {}; }
  }
  function embedStoreSet(v) {
    try { localStorage.setItem(EMBED_STORE_KEY, JSON.stringify(v)); } catch (e) { /* 隐私模式忽略 */ }
  }

  function embedLabel(f) {
    const d = new Date(f.mtime || Date.now());
    const pad = (x) => String(x).padStart(2, '0');
    const when = `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    const raw = f.title || (f.videoId ? '视频 ' + String(f.videoId).slice(-8) : f.name || '');
    const name = raw.length > 26 ? raw.slice(0, 26) + '…' : raw;
    return `${when} · ${name}${f.count ? ' · ' + f.count + ' 条' : ''}`;
  }

  async function embedLoad(file) {
    setLoading(true);
    currentFile = file;
    try {
      const r = await fetch(EMBED_API + '/load?path=' + encodeURIComponent(file.path), { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const text = await r.text();
      const n = ingestJson(text, file.name);
      if (n > 0) {
        state.sources.push(file.path);
        if (file.path) { embedStoreSet(Object.assign(embedStoreGet(), { lastPath: file.path })); }
        updateScope();
        updateEmptyState();
        $('#btnClear').disabled = false;
        setLoading(false);
        refreshAll();
        toast(`已载入 ${n} 条评论（本地导出）`);
      }
    } finally {
      setLoading(false);
    }
  }

  async function bootEmbed() {
    const params = new URLSearchParams(location.search);
    if (params.get('embed') !== '1') return false;
    // v0.6.0：采集完成后 DSH 客户端用 ?latest=1&gen=<n> 重载这个页面。
    // gen 每采一次 +1：同一个 gen 只强制载入最新一份一次，之后仍恢复「上次看的那份」；
    // 手动点「刷新列表」（reload(false)）不会触发强制载入，免得把人从旧记录上踢走。
    const latestGen = String(params.get('gen') || '');
    let forceLatest = params.get('latest') === '1';
    if (forceLatest) {
      let seenGen = '';
      try { seenGen = localStorage.getItem('cw.latestGen') || ''; } catch (e) { seenGen = ''; }
      if (!latestGen || seenGen === latestGen) {
        forceLatest = false;
      } else {
        try { localStorage.setItem('cw.latestGen', latestGen); } catch (e) { /* 隐私模式忽略 */ }
      }
    }
    document.body.classList.add('is-embed');
    const dirBtn = $('#btnOpenDir');
    if (dirBtn) dirBtn.hidden = true;
    const host = document.querySelector('.actions');
    if (!host) return false;

    const select = document.createElement('select');
    select.id = 'embedSelect';
    select.className = 'select small';
    select.style.width = '280px';
    select.style.maxWidth = '280px';
    select.title = '本地导出的评论 JSON（默认目录：当前工作区 douyin-comments/ 与 ~/.dsh/douyin-collector/out）';
    const refresh = document.createElement('button');
    refresh.id = 'embedRefresh';
    refresh.type = 'button';
    refresh.className = 'btn small ghost';
    refresh.textContent = '刷新列表';
    host.insertBefore(select, host.firstChild);
    host.insertBefore(refresh, select.nextSibling);

    let files = [];
    const store = embedStoreGet();
    const cleared = new Set(Array.isArray(store.cleared) ? store.cleared : []);
    const persist = () => embedStoreSet({ cleared: Array.from(cleared), lastPath: store.lastPath || '' });
    // v2.6：下拉框始终有一个「请选择…」占位项（清空后列表没了就只显示它）
    const fill = (emptyText) => {
      select.innerHTML = '';
      const ph = document.createElement('option');
      ph.value = '';
      ph.disabled = true;
      ph.selected = true;
      ph.textContent = files.length
        ? '请选择要查看的导出文件…'
        : (emptyText || '没有找到本地导出 JSON');
      select.appendChild(ph);
      files.forEach((f, i) => {
        const o = document.createElement('option');
        o.value = String(i);
        o.textContent = embedLabel(f);
        select.appendChild(o);
      });
    };
    select.style.display = '';
    const reload = async (auto) => {
      setLoading(true);
      try {
        const r = await fetch(EMBED_API + '/list', { cache: 'no-store' });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const data = await r.json();
        // v0.1.5：清空过的文件持久忽略（磁盘还在，只是不再出现在下拉里）
        files = (data.files || []).filter((f) => !cleared.has(f.path));
        fill();
        select.style.display = '';
        if (files.length) select.value = '';
        if (!files.length) {
          toast('没有找到本地导出的 douyin-comments-*.json');
          return;
        }
        // v0.1.5：优先恢复「上次看的那份」；从没清空过则自动载入最新一份；
        // 一旦清空过（cleared 非空）就不再自动装满，停在下拉占位，用户自己选。
        const last = store.lastPath ? files.findIndex((f) => f.path === store.lastPath) : -1;
        if (auto && forceLatest) {
          // v0.6.0：采集刚落盘 → 直接看最新那份（即使之前清空过旧记录，新导出也不在 cleared 里）
          select.value = '0';
          await embedLoad(files[0]);
          return;
        }
        if (last >= 0) {
          select.value = String(last);
          await embedLoad(files[last]);
        } else if (auto && !cleared.size) {
          select.value = '0';
          await embedLoad(files[0]);
        }
      } catch (e) {
        toast('读取本地导出列表失败：' + ((e && e.message) || e));
      } finally {
        setLoading(false);
      }
    };

    // v0.1.5：点「清空」清掉已载入评论，并把**刚刚那条**持久记为「已清空」——
    // 记在 localStorage 里，所以切会话/刷新页面后它也不会再出现在下拉里、不会被自动载入。
    embedResetList = () => {
      if (!files.length && !currentFile) return;
      if (currentFile) {
        if (currentFile.path) cleared.add(currentFile.path);
        const idx = files.findIndex((f) => (f.path || f.name) === (currentFile.path || currentFile.name));
        if (idx >= 0) files.splice(idx, 1);
        currentFile = null;
      }
      store.lastPath = '';
      persist();
      fill();
      select.value = '';
    };

    select.addEventListener('change', () => {
      const f = files[Number(select.value)];
      if (f) embedLoad(f).catch((e) => toast('载入失败：' + ((e && e.message) || e)));
    });
    refresh.addEventListener('click', () => void reload(false));

    // v0.1.6：不再需要「找回已清空的」，改成「管理记录」——可以勾选多条导出记录批量删除（真删磁盘文件）
    const manageBtn = document.createElement('button');
    manageBtn.type = 'button';
    manageBtn.id = 'embedManageBtn';
    manageBtn.className = 'btn small ghost';
    manageBtn.textContent = '管理记录';
    manageBtn.title = '勾选多条导出记录批量删除（会删掉磁盘上的导出文件）';
    host.insertBefore(manageBtn, refresh.nextSibling);

    const manager = document.createElement('div');
    manager.id = 'embedManage';
    manager.className = 'embed-manage';
    manager.hidden = true;
    manager.innerHTML =
      '<div class="em-box" role="dialog" aria-label="管理导出记录">'
      + '<div class="em-head"><strong>管理导出记录</strong><span class="muted small" id="emHint">勾选后点「删除选中」，文件会从磁盘删除（不可恢复）</span>'
      + '<button type="button" class="btn small ghost" id="emClose">关闭</button></div>'
      + '<div class="em-list" id="emList"></div>'
      + '<div class="em-foot"><label class="small"><input type="checkbox" id="emAll"> 全选</label>'
      + '<span class="muted small" id="emCount">共 0 条</span>'
      + '<span class="em-spacer"></span>'
      + '<button type="button" class="btn small ghost" id="emCancel">取消</button>'
      + '<button type="button" class="btn small danger" id="emDelete">删除选中</button></div>'
      + '</div>';
    document.body.appendChild(manager);

    const emList = manager.querySelector('#emList');
    const emAll = manager.querySelector('#emAll');
    const emCount = manager.querySelector('#emCount');
    let emFiles = [];

    const emRender = () => {
      emList.innerHTML = emFiles.length
        ? emFiles.map((f, i) => `<label class="em-row"><input type="checkbox" class="em-check" value="${i}">`
            + `<span class="em-main">${esc(embedLabel(f))}</span>`
            + `<span class="em-meter">${f.count ? f.count + ' 条' : ''} · ${(f.size / 1024).toFixed(0)} KB</span></label>`).join('')
        : '<div class="muted small" style="padding:16px 4px">没有可管理的导出记录</div>';
      emAll.checked = false;
      emCount.textContent = '共 ' + emFiles.length + ' 条';
    };

    const emRefresh = async () => {
      try {
        const r = await fetch(EMBED_API + '/list', { cache: 'no-store' });
        const data = await r.json();
        emFiles = Array.isArray(data.files) ? data.files : [];
      } catch {
        emFiles = files.slice();
      }
      emRender();
      await emProbeDelete();
    };

    // v0.1.8：删接口能不能用要探测一下——DSH 启动时加载的是当时的服务端代码，
    // 老进程里没有 POST /api/delete（会回 405 + 空 body），直接点删除会报
    // "Unexpected end of JSON input"。这里提前探测并把按钮置灰 + 提示重启。
    const emDeleteBtn = manager.querySelector('#emDelete');
    const emHint = manager.querySelector('#emHint');
    let emCanDelete = false;
    const emProbeDelete = async () => {
      let can = false;
      let note = '';
      try {
        const r = await fetch(EMBED_API + '/delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{"paths":[]}',
        });
        const text = await r.text();
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch { data = null; }
        can = r.ok && !!data && data.ok !== false;
        if (!can) {
          note = r.status === 405 || r.status === 404
            ? '当前 DSH 还在跑旧的服务端代码，重启 DSH 后才能删除记录（现在什么都不会删）'
            : '删除接口不可用（HTTP ' + r.status + '）' + ((data && data.error) ? '：' + data.error : '');
        }
      } catch (e) {
        can = false;
        note = '连不上删除接口：' + ((e && e.message) || e);
      }
      emCanDelete = can;
      emDeleteBtn.disabled = !can;
      emHint.textContent = can
        ? '勾选后点「删除选中」，文件会从磁盘删除（不可恢复）'
        : note;
    };

    manageBtn.addEventListener('click', async () => {
      manager.hidden = false;
      await emRefresh();
    });
    const closeManager = () => { manager.hidden = true; };
    manager.querySelector('#emClose').addEventListener('click', closeManager);
    manager.querySelector('#emCancel').addEventListener('click', closeManager);
    manager.addEventListener('click', (e) => { if (e.target === manager) closeManager(); });
    emAll.addEventListener('change', () => {
      emList.querySelectorAll('.em-check').forEach((box) => { box.checked = emAll.checked; });
    });

    emDeleteBtn.addEventListener('click', async () => {
      if (!emCanDelete) { toast('删除接口不可用：重启 DSH 后再试（文件没有被改动）'); return; }
      const picked = Array.from(emList.querySelectorAll('.em-check:checked'))
        .map((box) => emFiles[Number(box.value)])
        .filter(Boolean);
      if (!picked.length) { toast('先勾选要删除的记录'); return; }
      if (!window.confirm('确定删除 ' + picked.length + ' 条导出记录？\n\n文件会从磁盘删除，不可恢复。')) return;
      try {
        const r = await fetch(EMBED_API + '/delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ paths: picked.map((f) => f.path) }),
        });
        const raw = await r.text();
        let data = {};
        try { data = raw ? JSON.parse(raw) : {}; } catch { data = {}; }
        if (!r.ok && !data.error) {
          toast('删除失败（HTTP ' + r.status + '）：当前 DSH 可能还是旧服务端代码，重启后再试');
          return;
        }
        const deleted = Array.isArray(data.deleted) ? data.deleted : [];
        for (const p of deleted) cleared.delete(p);
        persist();
        const hitCurrent = currentFile && deleted.includes(currentFile.path);
        toast(deleted.length ? '已删除 ' + deleted.length + ' 条导出记录' : '没有删除成功：' + ((data.failed && data.failed[0] && data.failed[0].error) || '未知原因'));
        closeManager();
        if (hitCurrent) {
          currentFile = null;
          cleared.clear();
          store.lastPath = '';
          persist();
          const button = document.getElementById('btnClear');
          if (button) button.click();
        }
        await reload(false);
      } catch (e) {
        toast('删除失败：' + ((e && e.message) || e));
      }
    });
    await reload(true);
    return true;
  }

  function init() {
    bindEvents();
    bindAiEvents();
    renderWordList();
    updateEmptyState();
    updateScope();
    void loadFavorites();
    // 快照优先：自带数据时不再走 ?data= 自动载入
    if (bootFromSnapshot()) return console.log('%c评论分析台（快照模式）已就绪', 'color:#e0a94a;font-weight:600');

    // 嵌入 DSH（?embed=1）：自动列出并载入服务端本地导出文件
    if (new URLSearchParams(location.search).get('embed') === '1') {
      void bootEmbed();
      return console.log('%c评论分析台（DSH 嵌入模式）已就绪', 'color:#e0a94a;font-weight:600');
    }

    // 若页面地址带 ?data=<url 或 相对路径>，尝试自动载入（便于本地服务直接打开）
    try {
      const params = new URLSearchParams(location.search);
      const auto = params.get('data');
      if (auto) {
        fetch(auto, { cache: 'no-store' }).then((r) => {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.text();
        }).then((text) => {
          const n = /\.csv($|\?)/i.test(auto) ? ingestCsv(text, auto.split('/').pop()) : ingestJson(text, auto.split('/').pop());
          if (n > 0) {
            state.sources.push(auto);
            updateScope();
            updateEmptyState();
            $('#btnClear').disabled = false;
            refreshAll();
            toast(`自动载入 ${n} 条评论`);
          }
        }).catch((err) => {
          console.warn('自动载入失败', err);
          toast('自动载入失败：' + err.message + '（可手动选文件）');
        });
      }
    } catch (e) { /* ignore */ }
    console.log('%c评论分析台已就绪', 'color:#e0a94a;font-weight:600', '· 选择导出的 JSON/CSV 即可');
  }

  // 便于自动化测试 / 二次开发
  window.CommentViewer = {
    setLoading: setLoading,
    buildSkeletons: buildSkeletons,
    buildDigest: buildDigest,
    runAiExplain: runAiExplain,
    cleanToken,
    applyWordLists,
    setWordLists: (keep, block) => {
      state.kwKeep = parseWordList(keep);
      state.kwBlock = parseWordList(block);
      const k = $('#kwKeep'), b = $('#kwBlock');
      if (k) k.value = state.kwKeep.join(',');
      if (b) b.value = state.kwBlock.join(',');
      refreshAll();
    },
    state,
    loadFiles,
    ingestJson,
    ingestCsv,
    filtered,
    buildWords,
    tokensOf,
    profileOf,
    videoUrl,
    openDrawer,
    closeDrawer,
    renderTable,
    refreshAll,
    readXlsxRows,
    ingestTaobaoRows,
    ingestXlsx,
    EXPORT_COLS,
    exportRows,
    topicLabelOf,
    sentimentOf,
    annotateSentiment,
    sentimentStats,
    buildTopics,
    renderInsights,
    syncInsightHeights,
    baseFiltered,
    SENT_LABEL,
    exportFilteredCsv,
    exportFilteredJson,
    healthOf, renderHealth,
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
