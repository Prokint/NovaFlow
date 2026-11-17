/**
 * 手工造数据：一份极简 listing.json + 图片目录 → `product.json` + `img/{1x1,3x4,detail,spec,white,video}`。
 *
 * 用途：用户**没有素材包**（没有 商品信息.xlsx / 淘宝目录），只有图片 + 口头给的标题/价格/库存/规格时，
 * 先把数据拼成技能认识的形状，再走 `product` 模式上架。
 *
 * listing.json 形状（能少写就少写，缺的会报出来）：
 * {
 *   "id": "T00016",
 *   "title": "商品标题 ≤30 汉字",
 *   "cat": "居家布艺 > 地毯", "catid": "50000582",
 *   "brand": "无品牌",
 *   "attributes": { "货号": "XXX-50cm", "风格": "简约现代" },
 *   "colors": ["米白"], "styles": ["50x100cm"],
 *   "listPrice": 19.9,
 *   "skus": [{ "color": "米白", "style": "50x100cm", "price": 19.9, "stock": 100, "code": "..." }],
 *   "images": {
 *     "main":   "D:/pics/main",     // 目录或文件数组；取前 5 张
 *     "threeToFour": "D:/pics/3x4", // 可选
 *     "detail": "D:/pics/detail",   // 目录或文件数组
 *     "white":  "D:/pics/white",    // 可选，1 张
 *     "video":  "D:/v.mp4",         // 可选
 *     "spec": { "米白": "D:/pics/spec/white.jpg" }  // 颜色 → 文件；也可给目录（按颜色名匹配）
 *   }
 * }
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, extname, join, resolve } from 'node:path'

const IMG = /\.(jpe?g|png|webp)$/i
const VID = /\.(mp4|mov|mkv|webm)$/i

/** 目录 → 文件列表（按名字排序）；数组原样返回；单文件包成数组。 */
const listFiles = (input, re) => {
  if (!input) return []
  if (Array.isArray(input)) return input.map(String).filter((p) => existsSync(p)).filter((p) => re.test(p))
  const p = String(input)
  if (!existsSync(p)) return []
  if (statSync(p).isDirectory()) return readdirSync(p).filter((f) => re.test(f)).sort().map((f) => join(p, f))
  return re.test(p) ? [p] : []
}

/** 文件名安全化：颜色/款式里可能有 `/ \\ : * ? " < > |` 之类不能进路径的字符。 */
const safeName = (s) => String(s || '').replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim()

const freshDir = (dir) => {
  mkdirSync(dir, { recursive: true })
  for (const f of readdirSync(dir)) {
    try {
      rmSync(join(dir, f), { force: true })
    } catch {}
  }
}

const copyAs = (src, dstDir, name) => {
  mkdirSync(dstDir, { recursive: true })
  const dst = join(dstDir, name)
  copyFileSync(src, dst)
  return dst
}

/**
 * 生成 product.json + img/。
 * @param listing - 见文件头说明
 * @param options - `{ out }`（输出目录；默认 `~/.dsh/taobao-ego/output/<id>`）
 * @returns `{ ok, product, img:{...}, 缺什么:[], 提示:[] }`
 */
export function buildProductFromListing(listing = {}, options = {}) {
  const id = String(listing.id || '').trim() || 'T-' + new Date().toISOString().slice(0, 10).replace(/-/g, '')
  const out = resolve(String(options.out || listing.out || join(process.env.USERPROFILE || '.', '.dsh', 'taobao-ego', 'output', id)))
  const 缺什么 = []
  const 提示 = []

  // ---- 标题 ----
  const title = String(listing.title || '').trim()
  if (!title) 缺什么.push('title（商品标题）')
  else {
    const chars = [...title].length
    const hanzi = (title.match(/[\u4e00-\u9fa5]/g) || []).length
    if (hanzi > 30 || chars > 60) 提示.push(`标题 ${hanzi} 个汉字 / ${chars} 字符，超过平台上限（30 汉字 / 60 字符）→ 请缩短`)
  }

  // ---- SKU ----
  const rawSkus = Array.isArray(listing.skus) ? listing.skus : []
  if (!rawSkus.length) 缺什么.push('skus（至少 1 行：color/style/price/stock/code）')
  const skus = rawSkus.map((s) => ({
    color: String(s.color || '').trim(),
    style: String(s.style || '').trim(),
    price: Number(s.price || 0),
    stock: Number(s.stock || 0),
    code: String(s.code || '').trim(),
    // ★ 其余键原样保留：官方 SKU 模板里那些类目专属列（厚度/宽度/长度/底背材质…）
    //   会按同名列自动填进去（fill_sku_template.py 读 s.get(<列名>) 或 attributes)
    ...Object.fromEntries(
      Object.entries(s).filter(([k, v]) => !['color', 'style', 'price', 'stock', 'code'].includes(k) && v !== undefined && v !== null && v !== ''),
    ),
  }))
  const badSku = skus.findIndex((s) => !s.color || !s.style || !(s.price > 0) || !(s.stock >= 0))
  if (badSku >= 0) 缺什么.push(`skus[${badSku}] 字段不全（color/style/price/stock 必填）`)

  const colors = [...new Set(skus.map((s) => s.color).filter(Boolean))]
  const styles = [...new Set(skus.map((s) => s.style).filter(Boolean))]
  for (const c of colors) {
    if (!skus.some((s) => s.color === c && s.stock > 0)) 提示.push(`颜色「${c}」没有任何有库存 SKU`)
  }

  // ---- 一口价 ----
  const prices = skus.map((s) => s.price).filter((p) => p > 0)
  let listPrice = Number(listing.listPrice || 0)
  if (prices.length) {
    const set = new Set(prices.map((p) => Number(p.toFixed(2))))
    const want = Number(listPrice.toFixed(2))
    if (!listPrice || !set.has(want)) {
      提示.push(`一口价 ${listPrice || '(未给)'} 不在 SKU 价格集合 ${[...set].join('/')} 里 → 已自动取最高价 ${Math.max(...prices)}`)
      listPrice = Math.max(...prices)
    }
  } else {
    缺什么.push('listPrice（一口价；必须等于某个有库存 SKU 的价）')
  }

  // ---- 图片 ----
  const imgDir = join(out, 'img')
  const d1 = join(imgDir, '1x1')
  const d34 = join(imgDir, '3x4')
  const dd = join(imgDir, 'detail')
  const ds = join(imgDir, 'spec')
  const dw = join(imgDir, 'white')
  const dv = join(imgDir, 'video')
  for (const d of [d1, d34, dd, ds, dw, dv]) freshDir(d)

  const images = listing.images || {}
  const mainFiles = listFiles(images.main, IMG).slice(0, 5)
  if (!mainFiles.length) 缺什么.push('images.main（1:1 主图，至少 1 张；平台必填）')
  else if (listFiles(images.main, IMG).length > 5) 提示.push(`1:1 主图给了 ${listFiles(images.main, IMG).length} 张，平台上限 5 → 只取前 5 张`)

  const mainCopied = mainFiles.map((f, i) => copyAs(f, d1, `1比1主图_${String(i + 1).padStart(2, '0')}${extname(f).toLowerCase()}`))
  const threeFiles = listFiles(images.threeToFour, IMG).slice(0, 5)
  const threeCopied = threeFiles.map((f, i) => copyAs(f, d34, `3比4主图_${String(i + 1).padStart(2, '0')}${extname(f).toLowerCase()}`))
  const detailFiles = listFiles(images.detail, IMG)
  const detailCopied = detailFiles.map((f, i) => copyAs(f, dd, `详情_${String(i + 1).padStart(2, '0')}${extname(f).toLowerCase()}`))
  const whiteFiles = listFiles(images.white, IMG).slice(0, 1)
  const whiteCopied = whiteFiles.map((f, i) => copyAs(f, dw, `白底图_${String(i + 1).padStart(2, '0')}${extname(f).toLowerCase()}`))
  const videoFiles = listFiles(images.video, VID).slice(0, 1)
  const videoCopied = videoFiles.map((f) => copyAs(f, dv, basename(f)))
  if (!detailFiles.length) 提示.push('没有详情图（pages 允许不传，但展示效果差）')
  if (!threeFiles.length) 提示.push('没有 3:4 主图 → 该步会自动跳过')
  if (!whiteFiles.length) 提示.push('没有白底图 → 该步会自动跳过')
  if (!videoFiles.length) 提示.push('没有商品视频 → 该步会自动跳过')

  // ---- 规格图（颜色 → 文件）----
  const specImages = {}
  const specInput = images.spec
  if (specInput && typeof specInput === 'object' && !Array.isArray(specInput)) {
    for (const [color, p] of Object.entries(specInput)) {
      const f = listFiles(p, IMG)[0]
      if (!f) {
        提示.push(`规格图映射里「${color}」的文件不存在：${p}`)
        continue
      }
      // ★ 保留**原文件名**（只做非法字符安全化）：规格图那步靠文件名搜索定位图片，
      //   用颜色拼长名字反而搜不到（DT 的 ⭕/⭐/【】 颜色名实测只填上 3/9）
      const dst = copyAs(f, ds, safeName(basename(f)))
      specImages[color] = basename(dst)
    }
  } else {
    const files = listFiles(specInput, IMG)
    for (const f of files) {
      const stem = basename(f, extname(f))
      // 颜色名里常带 emoji/【】/长描述，而图片名只写「规格图-4-浅灰」→ 用「颜色里的中文片段」匹配
      const tokensOf = (c) => String(c).split(/[^\u4e00-\u9fa5]+/).map((t) => t.trim()).filter((t) => t.length >= 2)
      const color =
        colors.find((c) => stem.includes(c)) ||
        colors.find((c) => tokensOf(c).some((t) => stem.includes(t)))
      if (!color) continue
      // ★ 保留**原文件名**（只做非法字符安全化）：规格图那步靠文件名搜索定位图片，
      //   用颜色拼长名字反而搜不到（DT 的 ⭕/⭐/【】 颜色名实测只填上 3/9）
      const dst = copyAs(f, ds, safeName(basename(f)))
      specImages[color] = basename(dst)
    }
  }
  for (const c of colors) {
    if (!specImages[c]) 提示.push(`颜色「${c}」没有规格图（规格图步会跳过这个颜色）`)
  }

  // ---- product.json ----
  const attributes = {
    品牌: String(listing.brand || '无品牌'),
    货号: String((listing.attributes && listing.attributes['货号']) || listing.code || `${id}-01`),
    ...((listing.attributes && typeof listing.attributes === 'object') ? listing.attributes : {}),
    发货时间: String((listing.attributes && listing.attributes['发货时间']) || '48小时内发货'),
  }

  const product = {
    product_id: id,
    category_source: `手工录入 | ${listing.catid ? 'cateId=' + listing.catid : ''} ${listing.cat || ''} ${listing.cat ? '' : '（类目需在 run-config/工具参数里给 catid+cat）'}`.trim(),
    title,
    brand_hint: String(listing.brand || '无品牌'),
    attributes,
    attributes_unsupported: {},
    required_attributes: ['品牌', '货号'],
    dimensions: Array.isArray(listing.dimensions) && listing.dimensions.length ? listing.dimensions : ['颜色分类', '款式'],
    list_price: listPrice,
    price_set: [...new Set(prices.map((p) => Number(p.toFixed(2))))].sort((a, b) => a - b),
    colors,
    styles,
    spec_images: specImages,
    skus: skus.map((s) => ({ ...s, src: '手工录入' })),
    source_note: `手工录入 ${skus.length} 行（${colors.length} 色 × ${styles.length} 款）`,
  }

  mkdirSync(out, { recursive: true })
  writeFileSync(join(out, 'product.json'), JSON.stringify(product, null, 1), 'utf8')

  const ok = 缺什么.length === 0
  return {
    ok,
    productDir: out,
    productJson: join(out, 'product.json'),
    img: {
      '1x1': mainCopied.length,
      '3x4': threeCopied.length,
      detail: detailCopied.length,
      white: whiteCopied.length,
      video: videoCopied.length,
      spec: Object.keys(specImages).length,
    },
    spec_images: specImages,
    一口价: listPrice,
    价格集合: product.price_set,
    缺什么,
    提示,
    next: ok
      ? '用 tb_ego_run_listing({ space, product: "' + join(out, 'product.json').replace(/\\/g, '/') + '", catid, cat, saveDraft:false }) 上架'
      : '把「缺什么」补齐后重跑本工具（只补数据，不动页面）',
  }
}

/** 从文件读 listing.json 并生成。 */
export function buildProductFromFile(listingPath, options = {}) {
  const p = resolve(String(listingPath || ''))
  if (!existsSync(p)) return { ok: false, why: 'listing_not_found', listingPath: p }
  let listing
  try {
    listing = JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, ''))
  } catch (e) {
    return { ok: false, why: 'bad_listing_json', 错误: String((e && e.message) || e), listingPath: p }
  }
  return buildProductFromListing(listing, options)
}

export default { buildProductFromListing, buildProductFromFile }
