#!/usr/bin/env node
/**
 * 素材准备：把素材包里的图拷进工作目录 `output\<商品号>\img\{1x1,detail,spec}`，
 * 并把「规格图片」**按颜色**挑一张重命名成 `<商品号>规格图-<颜色>.jpg`
 * （供 `tb_fill_spec_images.js` 用；带商品前缀是为了避免跨商品撞名 —— 实测踩过）。
 *
 * 用法：
 *   node scripts/tb_prep_assets.js --pack "<你的素材包>" --product output/PE-001/product.json
 *   （可选 --sub "<淘宝下的目录名>"；不传就取淘宝目录下的第一个子目录）
 * 参数全 ASCII / 从 product.json 读颜色 → 中文不经 CLI（PS 传中文会乱码）。
 */
const fs = require('fs');
const path = require('path');

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  if (i === -1) return dflt;
  const v = process.argv[i + 1];
  return (v === undefined || v.startsWith('--')) ? true : v;
}
const PACK = String(arg('pack', ''));
if (!PACK) { console.error('需要 --pack "<素材包根目录>"'); process.exit(2); }
const PRODUCT_PATH = path.resolve(String(arg('product', 'output/MZB-001/product.json')));
const PRODUCT = JSON.parse(fs.readFileSync(PRODUCT_PATH, 'utf8'));
const ID = String(arg('id', PRODUCT.product_id));
const COLORS = (PRODUCT.colors || []).map(String);

const TB = path.join(PACK, '淘宝');
if (!fs.existsSync(TB)) { console.error('素材包里没有「淘宝」目录:', TB); process.exit(2); }
let SUB = String(arg('sub', ''));
if (!SUB) {
  const ds = fs.readdirSync(TB).filter((d) => fs.statSync(path.join(TB, d)).isDirectory());
  SUB = ds[0];
}
const SRC = path.join(TB, SUB);
const DST = path.join(path.dirname(path.resolve(PRODUCT_PATH)), 'img');
console.log('源:', SRC);
console.log('目标:', DST, '| 颜色:', COLORS.join('/'));

const MAP = {
  '1比1主图': '1x1',
  '3比4主图': '3x4',
  '宝贝详情': 'detail',
  '规格图片': 'spec',
  'SKU搜索主图': 'skusearch',
  // ★ 白底图 / 商品视频 也要拷（否则 pack 模式把这两类素材丢掉）
  '白底图': 'white',
  '商品视频': 'video',
};
// 只认图片：素材目录里可能放说明文件（.txt/.md），原来把它们也算进"张数"，
// 会让人以为已经准备了图（实测：模板里一个「把图放这里.txt」被报成「1x1: 1 个」）。
const IMG_RE = /\.(jpe?g|png|webp|gif|bmp)$/i;
const KEEP_RE = /\.(jpe?g|png|webp|gif|bmp|mp4|mov|mkv|webm)$/i;
for (const [k, v] of Object.entries(MAP)) {
  const s = path.join(SRC, k);
  const d = path.join(DST, v);
  fs.mkdirSync(d, { recursive: true });
  let n = 0;
  if (fs.existsSync(s)) {
    for (const f of fs.readdirSync(s)) {
      if (!KEEP_RE.test(f)) continue;
      const sp = path.join(s, f);
      if (fs.statSync(sp).isFile()) { fs.copyFileSync(sp, path.join(d, f)); n++; }
    }
  }
  console.log(`  ${k} -> ${v}: ${n} 个`);
}

// 规格图：按颜色挑一张（同色多张取文件名排序第一张），重命名成 `<ID>规格图-<颜色>.<ext>`
// ★ 若 product.json 带了 spec_images（素材包「规格图片文件名」列的显式映射）→ 以它为准：
//   实测颜色值是长营销文案（含 emoji / `/` / 空格）时，靠「文件名包含颜色名」永远猜不中，
//   而且那种值也做不了文件名 —— 所以这时**不重命名**，直接用素材包里的原名。
const specDir = path.join(DST, 'spec');
const all = fs.readdirSync(specDir);
const SPEC_MAP = PRODUCT.spec_images || {};
if (Object.keys(SPEC_MAP).length) {
  let miss = 0;
  for (const [c, f] of Object.entries(SPEC_MAP)) {
    if (all.includes(String(f))) console.log(`  spec ✓ ${c.slice(0, 14)} -> ${f}`);
    else { console.log(`  spec ✗ 映射里的文件不在目录：${f}`); miss++; }
  }
  console.log(`spec: 显式映射 ${Object.keys(SPEC_MAP).length} 个颜色，缺 ${miss} 个（不按颜色名重命名）`);
} else {
  for (const c of COLORS) {
    const hit = all.filter((f) => f.includes(c)).sort()[0];
    if (!hit) { console.log(`  ⚠ 没找到颜色「${c}」的规格图`); continue; }
    const out = path.join(specDir, `${ID}规格图-${c}${path.extname(hit)}`);
    fs.copyFileSync(path.join(specDir, hit), out);
    console.log(`  spec: …${hit.slice(-28)} -> ${path.basename(out)}`);
  }
  console.log('spec 里的规格图:', fs.readdirSync(specDir).filter((f) => f.includes('规格图-')).join(', '));
}
