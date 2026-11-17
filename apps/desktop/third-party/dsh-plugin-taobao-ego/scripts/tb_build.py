#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
淘宝上架 · 数据管道（第一步）：素材包 → **SKU 导入表** + `product.json`

为什么先做 SKU 表：淘宝发布页有「批量导入 → AI识别导入」，直接吃表格（示例表头
`颜色分类 | 价格 | 库存 | …`）。若它能识别我们的表，就能一步顶掉
「+创建规格 → 逐个规格值 → SKU 表逐行填」三块（见 references/ops-notes.md）。

数据来源与口径（都写进报告，便于复查）：
- SKU 行：`--sku-sheet`（默认「淘宝」）；若 `--merge-from` 指定了另一张 sheet（如「拼多多」），
  则把「对得上但源表缺的 (颜色, 款式) 组合」补齐进来（实测 MZB-001：淘宝 54 行 ⊂ 拼多多 72 行，
  且两边价格口径一致 → 补齐不引入新口径）
- 价格：淘宝 sheet 的「★ 价格」；补齐行用 `--price-source`（默认「拼单价」）
- 一口价：`--list-price`（**必须落在 SKU 价格集合里**，门禁 6）——不传则取最低 SKU 价并提示

用法：
  python scripts/tb_build.py --xlsx "<素材包>\\发品excel\\MZB-001.xlsx" --product-id MZB-001 \
      --out output\\MZB-001 --merge-from 拼多多 --price-source 拼单价 --list-price 83.8
"""
import argparse
import json
import os
import re
import sys
import collections

try:
    import openpyxl
    from openpyxl.styles import Font
except Exception as e:
    print("需要 openpyxl：%s" % e)
    sys.exit(2)


def find_sheet(wb, name):
    if name in wb.sheetnames:
        return wb[name]
    return None


def col_map(ws):
    """R3 子表头优先，其次 R2；返回 {归一化标签: 列号}"""
    import re

    def norm(s):
        return re.sub(r"[\s★☆]", "", str(s or "")).strip()

    m = {}
    for c in range(1, ws.max_column + 1):
        lab = None
        for cand in (ws.cell(3, c).value, ws.cell(2, c).value):
            if cand is not None and str(cand).strip():
                lab = norm(cand)
                break
        if lab and lab not in m:
            m[lab] = c
    return m


def rows_of(ws, data_start=5):
    out = []
    for r in range(data_start, ws.max_row + 1):
        vals = [ws.cell(r, c).value for c in range(1, ws.max_column + 1)]
        if any(v not in (None, "") for v in vals):
            out.append((r, vals))
    return out


def parse_taobao_dim(v):
    """淘宝 sheet 的「颜色分类」是「色 + 款式」的组合值。
    实测两种写法：① `米白-宽30cm长1米`（「-」分隔）；② `白色 宽50厘米*长3米【一面就够】`（**空格**分隔）。"""
    s = str(v).strip()
    if "-" in s:
        a, b = s.split("-", 1)
        return a.strip(), b.strip()
    parts = s.split(None, 1)          # 按第一个空白切
    if len(parts) == 2 and 0 < len(parts[0]) <= 6:
        return parts[0], parts[1].strip()
    return s, ""


def main():
    ap = argparse.ArgumentParser()
    # ⚠️ 素材库路径含中文与 Unicode 细空格（\u2005），经 PowerShell 传 CLI 参数会乱码 →
    #    这几个参数支持用环境变量传：TB_XLSX / TB_TEMPLATE / TB_MERGE_FROM / TB_SKU_SHEET
    ap.add_argument("--xlsx", default=os.environ.get("TB_XLSX"), help="素材包的 商品信息.xlsx（或环境变量 TB_XLSX）")
    ap.add_argument("--product-id", required=True)
    ap.add_argument("--out", required=True, help="输出目录")
    ap.add_argument("--sku-sheet", default=os.environ.get("TB_SKU_SHEET") or "淘宝")
    ap.add_argument("--merge-from", default=os.environ.get("TB_MERGE_FROM"), help="补齐用的另一个 sheet（如 拼多多）")
    ap.add_argument("--price-source", default="拼单价", help="补齐行的价格口径")
    ap.add_argument("--list-price", type=float, default=None, help="一口价（必须 ∈ SKU 价格集合）")
    ap.add_argument("--from-template", default=os.environ.get("TB_TEMPLATE"), help="官方下载的 SKU 模板（xls/xlsx）；用它当表头与容器")

    ap.add_argument("--stock", type=int, default=None, help="覆盖库存（默认取源）")
    ap.add_argument("--size-sort", choices=("source", "natural"), default="source",
                    help="尺寸排列：source=照源表顺序；natural=按数值排（宽度优先，如 30x100→30x200→40x100）")
    a = ap.parse_args()
    if not a.xlsx:
        print("★ 需要 --xlsx，或用环境变量 TB_XLSX 指向素材包 excel")
        sys.exit(2)
    # 用户拍板的口径**优先于素材包**（例：TB_ATTR_OVERRIDE="主体材质=仿剑麻;货号=xxx"）
    # 也走环境变量：中文键值经 CLI 传会乱码
    overrides = {}
    for pair in os.environ.get("TB_ATTR_OVERRIDE", "").split(";"):
        if "=" in pair:
            k, v = pair.split("=", 1)
            if k.strip():
                overrides[k.strip()] = v.strip()

    wb = openpyxl.load_workbook(a.xlsx, data_only=True)
    ws = find_sheet(wb, a.sku_sheet)
    if ws is None:
        print("★ 找不到 sheet「%s」；现有：%s" % (a.sku_sheet, wb.sheetnames))
        sys.exit(2)
    cm = col_map(ws)
    need = ["颜色分类", "价格", "数量"]
    for n in need:
        if n not in cm:
            print("★ sheet「%s」缺列「%s」；实际列：%s" % (a.sku_sheet, n, sorted(cm.keys())))
            sys.exit(2)
    # 款式列名各版本不同。★ 实测类目差异很大：猫抓板那版没有独立尺寸列（两维并进「颜色分类」），
    #    地毯类目（50000582）的官方模板则**自带「地毯尺寸」列** → 不认出来就会把尺寸丢掉、
    #    并硬拼进颜色分类（变成一层规格，与页面上「颜色分类 × 地毯尺寸」两层不符）。
    #    「三维尺寸」排在最后：它有值时通常和「地毯尺寸」重复，优先用后者。
    STYLE_KEYS = ("款式", "地毯尺寸", "尺寸", "尺码", "规格", "三维尺寸")
    style_col = next((cm[k] for k in STYLE_KEYS if k in cm), None)
    # ★ 类目差异极大（实测：款式分类 / 窗帘尺寸+加工方式 / 地毯尺寸 …），靠关键词必翻车 →
    #   先认 R4 元数据里的 SKU 维度列（parentKey=sku 且 key 不以 skuParam_ 开头、且不是颜色分类）。
    tpl_dims = []
    for c in range(1, ws.max_column + 1):
        raw4 = ws.cell(4, c).value
        if not raw4 or "{" not in str(raw4):
            continue
        try:
            am4 = json.loads(str(raw4))
        except Exception:
            continue
        k4 = str(am4.get("key") or "")
        if am4.get("parentKey") != "sku" or not k4 or k4.startswith("skuParam_") or k4 == "颜色分类":
            continue
        lab = next((v for kk, v in cm.items() if kk == k4 or kk.replace("★", "") == k4), None)
        if lab:
            tpl_dims.append(lab)
    if tpl_dims:
        style_col = tpl_dims[0]
    if style_col is None:
        # 老素材包没有 R4 元数据 → 退回关键词，但用「包含」匹配（"款式" ⊂ "款式分类"、"尺寸" ⊂ "窗帘尺寸+加工方式"）
        CTRL = ("颜色分类", "价格", "数量", "库存", "商家编码", "商品条形码", "规格图片文件名")
        style_col = next((cm[h] for h in cm
                          if h not in CTRL and any(k in h for k in STYLE_KEYS)), None)
    # ★ 第二个规格维度的**真实名字**（模板里叫什么就叫什么，如「窗帘尺寸+加工方式」），
    #   后面写官方模板 / 写 product.json 都靠它定位，不要再硬写成「款式」。
    dim_name = next((kk for kk, vv in cm.items() if vv == style_col), "") if style_col else ""
    # ★ 如果素材包带了 R4 元数据（我们生成的包都有），**只认** metadata 里真正标了 parentKey=sku 的维度列；
    #   一个都没有 → 说明是单层类目，绝不能退回去按关键词把「款式」这种**属性列**当规格
    #   （实测卫浴地垫：款式=平放式 → 被当成第二维 → 对账 浅灰-平放式 vs 页面 浅灰）
    has_r4 = any("{" in str(ws.cell(4, c).value or "") and "parentKey" in str(ws.cell(4, c).value) for c in range(1, ws.max_column + 1))
    if has_r4 and not tpl_dims:
        style_col = None if style_col not in (None, *tpl_dims) else style_col
        style_col = None
        dim_name = ""
    if dim_name:
        print("①b 第二个规格维度 =「%s」" % dim_name)

    skus = []
    for r, vals in rows_of(ws):
        raw = vals[cm["颜色分类"] - 1]
        if raw in (None, ""):
            continue
        has_style = bool(style_col) and vals[style_col - 1] not in (None, "")
        if has_style:
            # ★ 有**独立尺寸列** → 颜色必须**逐字取原值**，不能走 parse_taobao_dim：
            #   那个函数是给「颜色-款式」挤在一列的老格式用的，它会按空格切分，把
            #   `⭕安全0异味 ▪ 0甲醛 ▪ 甄选母婴级材质✅` 截成 `⭕安全0异味`（实测踩到）。
            color, style = str(raw).strip(), str(vals[style_col - 1]).strip()
        else:
            color, style = parse_taobao_dim(raw)
        price = vals[cm["价格"] - 1]
        qty = vals[cm["数量"] - 1]
        code = vals[cm["商家编码"] - 1] if "商家编码" in cm else None
        spec = vals[cm["规格图片文件名"] - 1] if "规格图片文件名" in cm else None
        # ★ 每个 SKU 自己的属性列（官方模板里的 尺寸（长×宽）/厚度/底背材质 … 在**单层类目**下就是这类）：
        #   一并带上，写官方模板时才不会把「60×90cm」这种值丢掉
        props = {}
        for h, ci in cm.items():
            if h in ("颜色分类", "价格", "数量", "库存", "商家编码", "商品条形码", "规格图片文件名", "宝贝标题"):
                continue
            v = vals[ci - 1]
            if v not in (None, ""):
                props[h] = v
        skus.append({"color": color, "style": style, "price": price,
                     "stock": a.stock or qty, "code": code, "spec": spec, "props": props, "src": a.sku_sheet})
    print("① %s sheet：%d 行" % (a.sku_sheet, len(skus)))

    # 补齐：从另一张 sheet 引入 (color, style) 缺失的组合
    if a.merge_from:
        wb2 = wb  # 同文件内的另一张 sheet
        ws2 = find_sheet(wb2, a.merge_from)
        if ws2 is None:
            print("⚠ 找不到补齐 sheet「%s」，跳过补齐" % a.merge_from)
        else:
            cm2 = col_map(ws2)
            key_col = next((cm2[k] for k in ("颜色", "颜色分类", "色") if k in cm2), None)
            st2 = next((cm2[k] for k in ("款式", "尺寸", "尺码", "规格") if k in cm2), None)
            pr2 = cm2.get(a.price_source)
            qty2 = next((cm2[k] for k in ("库存", "数量", "现货库存") if k in cm2), None)
            code2 = cm2.get("规格编码") or cm2.get("商家编码")
            have = {(s["color"], s["style"]) for s in skus}
            added = []
            for r, vals in rows_of(ws2):
                if key_col is None or st2 is None:
                    break
                c = vals[key_col - 1]
                st = vals[st2 - 1]
                if c in (None, "") or st in (None, ""):
                    continue
                k = (str(c).strip(), str(st).strip())
                if k in have:
                    continue
                if pr2 is None:
                    print("★ 补齐需要价格列「%s」，该 sheet 里没有" % a.price_source)
                    break
                added.append({"color": k[0], "style": k[1],
                              "price": vals[pr2 - 1],
                              "stock": a.stock or (vals[qty2 - 1] if qty2 else 100),
                              "code": (vals[code2 - 1] if code2 else None),
                              "src": "%s(补齐)" % a.merge_from})
                have.add(k)
            # 先按 (color, style) 排序，保证颜色成组、款式有序
            skus += added
            print("② 从「%s」补齐：%d 行（口径 %s）" % (a.merge_from, len(added), a.price_source))

    # 排序：颜色按首次出现，款式按源顺序（或 --size-sort natural 重排）
    color_order = list(collections.OrderedDict.fromkeys(s["color"] for s in skus))
    style_order = list(collections.OrderedDict.fromkeys(s["style"] for s in skus))
    if a.size_sort == "natural":
        # ★ 用户口径（门禁 7）：尺寸按**宽度优先**排（30→40→60），不按源表顺序（源表是长度优先）
        def _sk(st):
            m = re.match(r"\s*(\d+)\D+(\d+)", str(st))
            return (int(m.group(1)), int(m.group(2))) if m else (10 ** 9, 0)
        style_order = sorted(style_order, key=_sk)
        print("③b 尺寸按自然序重排（宽度优先）：%s" % style_order)
    skus.sort(key=lambda s: (color_order.index(s["color"]), style_order.index(s["style"])))

    prices = sorted({s["price"] for s in skus if isinstance(s["price"], (int, float))})
    print("③ SKU 共 %d 行 | 颜色 %d 种 | 款式 %d 种 | 价格档 %d 个：%s"
          % (len(skus), len(color_order), len(style_order), len(prices), prices))

    # ---- 规格图映射（颜色 → 规格图文件名）----
    # ★ 用素材包 Excel 的「规格图片文件名」列做**显式映射**，比按「文件名里包含颜色名」猜可靠：
    #   实测颜色值是长营销文案（含 emoji、`/`、空格）时，按子串永远猜不中，
    #   而且文件名里也放不下这种值（tb_prep_assets / tb_fill_spec_images 原来的猜法）。
    spec_images = {}
    for s in skus:
        if s.get("spec") not in (None, ""):
            spec_images.setdefault(s["color"], str(s["spec"]).strip())
    if spec_images:
        print("③c 规格图映射：%d 个颜色（来自素材包「规格图片文件名」列）" % len(spec_images))

    list_price = a.list_price
    if list_price is None:
        list_price = prices[0] if prices else None
        print("   一口价未传 → 取最低 SKU 价 %s（门禁 6：一口价必须等于某个有库存 SKU 价）" % list_price)
    elif list_price not in prices:
        print("★ 一口价 %s **不在** SKU 价格集合里 → 平台会报错（门禁 6）；价格集合：%s" % (list_price, prices))
        sys.exit(3)
    else:
        print("④ 一口价 %s ∈ 价格集合 ✓" % list_price)

    os.makedirs(a.out, exist_ok=True)
    # ---- SKU 导入表（给「批量导入 → AI识别导入」用）----
    xlsx_out = os.path.join(a.out, "sku_import.xlsx")
    wb2 = openpyxl.Workbook()
    ws2 = wb2.active
    ws2.title = "sku"
    head = ["颜色分类", "款式", "价格", "库存", "商家编码"]
    ws2.append(head)
    for c in range(1, len(head) + 1):
        ws2.cell(1, c).font = Font(bold=True)
    for s in skus:
        ws2.append([s["color"], s["style"], s["price"], s["stock"], s["code"]])
    ws2.column_dimensions["A"].width = 12
    ws2.column_dimensions["B"].width = 18
    wb2.save(xlsx_out)
    print("→ SKU 导入表: %s（%d 行 + 表头）" % (xlsx_out, len(skus)))

    # ---- 类目属性（发布页要填的那些）----
    # 素材包「淘宝」sheet 的表头就是**发布页的属性名**（现场与 sell-field-p-<id> 逐个匹配、读回校验）
    ATTR_LABELS = ["导购标题", "品牌", "型号", "主体材质", "安全认证", "包装规格", "表面涂层材质",
                   "层数结构", "多猫承载量", "核心功能", "环保认证", "货号", "可替换内芯",
                   "展开长度", "展开宽度", "折叠后厚度", "支撑结构", "重量", "重量(单位)", "适用猫体型",
                   # 墙纸/墙布类目常用（PE木纹实测需要「计价单位」「计价单位(单位)」等）
                   "计价单位", "计价单位(单位)", "宝贝类型", "采购地", "库存类型", "功能", "适用空间",
                   "风格", "是否定制", "图案", "材质", "面层工艺", "表面材质", "型号", "发货时间"]
    attributes = {}
    # ★ 首选：**按 R4 的 JSON key 元数据自动判定**类目属性列 —— key 是中文属性名、且**没有 parentKey**
    #   （有 parentKey 的是 SKU 列，如 `颜色分类`/`地毯尺寸`；`title`/`price`/`skuParam_p-*` 是内部 key）。
    #   实测硬编码白名单会漏：地毯类目（50000582）的 编织工艺 / 可定制性 / 售卖方式 / 适用场景 /
    #   主图案类型 / 产地 都不在名单里 → 页面必填项填不上。
    auto = []
    required_attrs = []          # ★ R4 里 required=true 的属性名 → 填表时"匹配不上"才判失败
    for c in range(1, ws.max_column + 1):
        raw = ws.cell(4, c).value
        if not raw or "{" not in str(raw):
            continue
        try:
            am = json.loads(str(raw))
        except Exception:
            continue
        k = str(am.get("key") or "")
        if not k or am.get("parentKey"):
            continue
        if not re.match(r"^[\u4e00-\u9fa5][\u4e00-\u9fa5A-Za-z0-9()（）/、]*$", k):
            continue
        if am.get("required") is True:
            required_attrs.append(k)
        v = ws.cell(5, c).value
        if v not in (None, ""):
            attributes[k] = v
            auto.append(k)
    # 兜底：老表 R4 元数据不全时，再用白名单补一遍
    for lab in ATTR_LABELS:
        if lab in cm and lab not in attributes:
            v = ws.cell(5, cm[lab]).value
            if v not in (None, ""):
                attributes[lab] = v
    # 用户拍板的口径优先（overrides 在上面解析：TB_ATTR_OVERRIDE="主体材质=仿剑麻"）
    # ★ 值给空（`主图案类型=`）＝**明确不上这个属性**（如可选值里没有源值、用户选择留空）→ 删掉它。
    #   注意不能留成空字符串：填表脚本会把空串丢进下拉的搜索框，而 `includes('')` 恒真 → 会点中第一个选项。
    if overrides:
        for k, v in overrides.items():
            if v == "":
                if attributes.pop(k, None) is not None:
                    print("⑥b 用户口径：移除属性「%s」" % k)
            else:
                attributes[k] = v
        print("⑥b 用户口径覆盖：%s" % overrides)
    print("⑥ 类目属性（元数据自动识别 %d 个 + 白名单兜底，最终进 product.json）：%s" % (len(auto), attributes if attributes else "（无）"))

    # ---- product.json（留档 + 后续步骤用）----
    meta = {
        "product_id": a.product_id,
        "category_source": str(ws.cell(1, 1).value),
        "title": ws.cell(5, find_col_title(cm)).value if "宝贝标题" in cm else None,
        "brand_hint": ws.cell(5, cm["品牌"] - 1).value if "品牌" in cm else None,
        "attributes": attributes,
        # ★ 必填属性名单（来自素材包 R4 的 required 元数据）。填表脚本据此决定
        #   「源值不在本类目可选值里」时是**警告跳过**（选填）还是**判失败**（必填）。
        "required_attributes": required_attrs,
        "dimensions": (["颜色分类", dim_name] if dim_name else ["颜色分类"]),
        "list_price": list_price,
        "price_set": prices,
        "colors": color_order,
        "styles": style_order,
        "spec_images": spec_images,
        "skus": skus,
        "source_note": "SKU 来自「%s」%d 行%s" % (
            a.sku_sheet, sum(1 for s in skus if s["src"] == a.sku_sheet),
            ("，另从「%s」补齐 %d 行（%s）" % (a.merge_from, sum(1 for s in skus if s["src"] != a.sku_sheet), a.price_source)) if a.merge_from else ""),
    }

    # ---- 若给了官方模板：复制它、按其表头追加行（★ 这是推荐做法：列名以平台为准）----
    if a.from_template:
        import shutil
        tpl_out = os.path.join(a.out, "sku_import_官方模板.xlsx")
        ext = os.path.splitext(a.from_template)[1].lower()
        tmp_tpl = a.from_template
        if ext == ".xls":      # 实测：平台给的是 xlsx 改的 .xls 后缀，改名即可读
            tmp_tpl = os.path.join(a.out, "_tpl_as_xlsx.xlsx")
            shutil.copy2(a.from_template, tmp_tpl)
        wbt = openpyxl.load_workbook(tmp_tpl, data_only=True)
        sheet = next((s for s in wbt.sheetnames if "AI批量上传" in s and "hide" not in s), wbt.sheetnames[0])
        wst = wbt[sheet]
        head = [str(wst.cell(1, c).value or "").strip() for c in range(1, wst.max_column + 1)]
        print("⑤ 官方模板 sheet「%s」表头：%s" % (sheet, head))
        col = {h: i + 1 for i, h in enumerate(head) if h}
        # ★ 模板自带独立尺寸列（实测地毯类目 50000582 有「地毯尺寸」列）→ 尺寸**单独填**，
        #   平台会据此建成第二层规格；没独立尺寸列的老类目（如猫抓板）才把两维并进「颜色分类」。
        tpl_style = next((h for h in STYLE_KEYS if h in col), None)
        # ★ 同上：模板的第二个规格列名各类目不同（款式分类 / 窗帘尺寸+加工方式 / 地毯尺寸…）
        #   先认 R4 元数据，再用「包含」关键词兜底；颜色分类/价格/数量/编码 永远不算规格列。
        CTRL = ("颜色分类", "价格", "数量", "库存", "商家编码", "商品条形码", "规格图片文件名")
        sku_dims = []
        for c in range(1, wst.max_column + 1):
            raw4 = wst.cell(4, c).value
            if not raw4 or "{" not in str(raw4):
                continue
            try:
                am4 = json.loads(str(raw4))
            except Exception:
                continue
            k4 = str(am4.get("key") or "")
            if am4.get("parentKey") != "sku" or not k4 or k4.startswith("skuParam_") or k4 in CTRL:
                continue
            if k4 in col:
                sku_dims.append(k4)
        tpl_style = next((h for h in sku_dims if h in col), None)
        if tpl_style is None and dim_name:
            # ★ 用素材包里的**真实维度名**去官方模板里找同名列（最准：「窗帘尺寸+加工方式」逐字同名）
            tpl_style = next((h for h in head
                              if h and h not in CTRL and (dim_name in h or h in dim_name)), None)
        if tpl_style is None:
            tpl_style = next((h for h in head
                              if h and h not in CTRL and any(k in h for k in STYLE_KEYS)), None)
        print("⑤b 官方模板尺寸列：%s" % (tpl_style or "（无 → 两维并入颜色分类）"))
        # ★ 幂等：模板里若已经带着上次填的 SKU 行（复跑/素材包自带已填好的模板），先清掉再填，
        #   否则会翻倍成 2 倍行且混入「米白-」这种脏值（实测：平台报「未检测到有效销售规格」）
        # ★ 颜色列名各类目不同（实测有「颜色分类」「颜色」两种）——之前硬编码 `col["颜色分类"]`，
        #   遇到叫「颜色」的模板时颜色一个都写不进去 → 上传表只剩尺寸列 → 自检判「重复组合」、
        #   平台也会报「未检测到有效销售规格」（2026-11-17 文化墙贴 201884208 实测踩到）
        COLOR_COLS = ("颜色分类", "颜色", "色", "颜色款式")
        tpl_color = next((h for h in COLOR_COLS if h in col), None)
        if not tpl_color:
            print("★ 官方模板里找不到颜色列（表头 =", head, "）→ 颜色将无法写入")
        if wst.max_row > 1:
            wst.delete_rows(2, wst.max_row - 1)
        r0 = wst.max_row + 1
        for i, s in enumerate(skus):
            rr = r0 + i
            if tpl_color:
                cv = s["color"]
                if not tpl_style and str(s.get("style") or "").strip():
                    cv = "%s-%s" % (s["color"], s["style"])
                wst.cell(rr, col[tpl_color]).value = cv
            if tpl_style:
                # ★ 单层类目下模板的「尺寸（长×宽）」是**每个 SKU 的属性列** → 值来自 props，而不是 style
                v = (s.get("props") or {}).get(tpl_style)
                if v in (None, ""):
                    v = s.get(tpl_style)
                if v in (None, ""):
                    v = s.get("style")
                if v not in (None, ""):
                    wst.cell(rr, col[tpl_style]).value = v
            if "价格" in col:  wst.cell(rr, col["价格"]).value = s["price"]
            if "数量" in col:  wst.cell(rr, col["数量"]).value = s["stock"]
            if "商家编码" in col: wst.cell(rr, col["商家编码"]).value = s["code"]
            if "商品条形码" in col: wst.cell(rr, col["商品条形码"]).value = s.get("barcode")
            # ★ 模板里**其它属性列**（图案 / 材质 / 面层工艺 …）就是**类目属性** → 用素材包的值一并填上
            #   （用户 2026-10-10 指出：这些列本来就该出现在导入表里，不必去页面上一个个选下拉）
            for h, ci in col.items():
                if h in ("颜色分类", "颜色", "价格", "数量", "商家编码", "商品条形码") or h == tpl_color or h == tpl_style:
                    continue
                # ① 先按行取「该 SKU 自己的属性值」（尺寸（长×宽）/厚度 这类），② 再退回类目属性整体值
                pv = (s.get("props") or {}).get(h)
                if pv not in (None, ""):
                    wst.cell(rr, ci).value = pv
                    continue
                if attributes.get(h) not in (None, ""):
                    wst.cell(rr, ci).value = attributes[h]
        wbt.save(tpl_out)
        print("→ 照官方模板填好的文件: %s（表头 %s，追加 %d 行）" % (tpl_out, head, len(skus)))
    pj = os.path.join(a.out, "product.json")
    with open(pj, "w", encoding="utf-8") as fh:
        json.dump(meta, fh, ensure_ascii=False, indent=1)
    print("→ product.json: %s" % pj)


def find_col_title(cm):
    for k in ("宝贝标题", "商品标题", "标题"):
        if k in cm:
            return cm[k]
    return 1


if __name__ == "__main__":
    main()
