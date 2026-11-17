# -*- coding: utf-8 -*-
"""把 product.json 的数据写进**官方模板**（保留官方表头/类目专属列），供上架时导入。

用法：
  python fill_sku_template.py --template <官方模板xlsx> --product <product.json> --out <xlsx>

映射规则：
- 颜色 → 官方模板里名为「颜色分类 / 颜色 / 色」的列
- 款式/尺寸 → 优先用 product.json.dimensions[1]（如 地毯尺寸），否则取除颜色列外第一个「规格类」列
- 价格 → 价格 / 单价；库存 → 数量 / 库存；编码 → 商家编码 / 规格编码
- 其它列（厚度/宽度/长度/底背材质…）→ 若 product.skus 或 product.attributes 里有同名字段就填，否则留空

输出 JSON：{"ok":true,"out":...,"rows":N,"specCols":[...],"unfilledCols":[...]}
"""
import argparse
import io
import json
import sys

import openpyxl

COL_ALIASES = {
    "color": ["颜色分类", "颜色", "色", "颜色款式"],
    "price": ["价格", "单价", "售价", "拼单价"],
    "stock": ["数量", "库存", "现货库存"],
    "code": ["商家编码", "规格编码", "编码"],
    "barcode": ["商品条形码", "条形码"],
}
# 这些列属于「规格/数值」列，不当作款式列
NON_SPEC = {"价格", "数量", "商家编码", "商品条形码", "条形码", "库存", "单价", "售价", "拼单价", "规格编码", "编码"}


def find_col(head, aliases):
    for a in aliases:
        for i, h in enumerate(head):
            if h and a in h:
                return i
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--template", required=True)
    ap.add_argument("--product", default="", help="product.json（与 --listing 二选一）")
    ap.add_argument("--listing", default="", help="listing.json（含 color/style/price/stock/code，与 --product 二选一）")
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    if not a.product and not a.listing:
        print(json.dumps({"ok": False, "why": "need_product_or_listing"}, ensure_ascii=False))
        return 1
    d = json.load(io.open(a.product or a.listing, encoding="utf-8"))
    wb = openpyxl.load_workbook(a.template)
    ws = wb.worksheets[0]
    head = [str(ws.cell(1, c).value or "").strip() for c in range(1, ws.max_column + 1)]

    c_color = find_col(head, COL_ALIASES["color"])
    c_price = find_col(head, COL_ALIASES["price"])
    c_stock = find_col(head, COL_ALIASES["stock"])
    c_code = find_col(head, COL_ALIASES["code"])
    c_barcode = find_col(head, COL_ALIASES["barcode"])

    # 款式/尺寸列：
    #   ① **product/listing 的 dimensions[1]**（用户/agent 明确声明的第二维名）→ 最准
    #   ② sku 行里「直接用官方模板列名」的自定义键（如 窗帘尺寸+加工方式）
    #   ③ 否则取「颜色分类」右边那一列（官方模板的规格列通常紧跟颜色：… colors, 地毯尺寸, 价格 …）
    #   ④ 再否则第一个非数值属性列
    #   ⚠️ ①必须排在②前面：否则 listing 里恰好带了 `具体规格` 这种键时，会把值写进 `具体规格`、
    #      而真正声明的 `规格` 列留空（实测 2026-11-17 桌布类目踩到）
    NUMERIC_ATTRS = {"厚度", "宽度", "长度", "高度", "重量", "中层厚度", "底背材质", "材质", "工艺"}
    skus = d.get("skus") or []
    dims = d.get("dimensions") or []
    style_name = dims[1] if len(dims) >= 2 else ""
    c_style = None
    # ① dimensions[1]：先精确、再包含
    if style_name:
        c_style = head.index(style_name) if style_name in head else None
        if c_style is None:
            c_style = next((i for i, h in enumerate(head)
                            if h and (style_name in h or h in style_name) and h not in NON_SPEC and h not in NUMERIC_ATTRS
                            and i != c_color), None)
    # ② SKU 行里的自定义维度键（除通用字段外的字符串键）
    CTRL_KEYS = {"color", "style", "price", "stock", "code", "barcode", "spec", "src"}
    if c_style is None:
        for s in skus:
            for k, v in s.items():
                if k in CTRL_KEYS or not isinstance(v, str) or not v.strip():
                    continue
                hit = next((i for i, h in enumerate(head) if h and h == k), None)
                if hit is not None and head[hit] not in NON_SPEC:
                    c_style = hit
                    break
            if c_style is not None:
                break
    if c_style is None and c_color is not None:
        nxt = c_color + 1
        if nxt < len(head) and head[nxt] and head[nxt] not in NON_SPEC and head[nxt] not in NUMERIC_ATTRS:
            c_style = nxt
    if c_style is None:
        for i, h in enumerate(head):
            if not h or h in NON_SPEC or h in NUMERIC_ATTRS:
                continue
            if c_color is not None and i == c_color:
                continue
            c_style = i
            break
    if c_style is not None:
        style_name = head[c_style]

    # 其余列：product.json 里同名字段能填就填（颜色/款式/价格那些不重复处理）
    attrs = d.get("attributes") or {}
    unfilled = []
    for i, h in enumerate(head):
        if not h or i in (c_color, c_style, c_price, c_stock, c_code, c_barcode):
            continue
        has = any(isinstance(s.get(h), (str, int, float)) and str(s.get(h)).strip() for s in skus) or h in attrs
        if not has:
            unfilled.append(h)

    # ★ 幂等：模板里若已有上次填的数据行（含官方模板的空行），先清掉再填，避免行数翻倍/脏值残留
    if ws.max_row > 1:
        ws.delete_rows(2, ws.max_row - 1)

    r = 2
    for s in skus:
        if c_color is not None:
            ws.cell(r, c_color + 1).value = s.get("color")
        if c_style is not None:
            v = s.get(style_name)
            if v in (None, ""):
                v = s.get("style")
            if v not in (None, ""):
                ws.cell(r, c_style + 1).value = v
        if c_price is not None:
            ws.cell(r, c_price + 1).value = s.get("price")
        if c_stock is not None:
            ws.cell(r, c_stock + 1).value = s.get("stock")
        if c_code is not None:
            ws.cell(r, c_code + 1).value = s.get("code")
        if c_barcode is not None:
            ws.cell(r, c_barcode + 1).value = s.get("barcode")
        # 其余列：sku 里有就填
        for i, h in enumerate(head):
            if not h or i in (c_color, c_style, c_price, c_stock, c_code, c_barcode):
                continue
            v = s.get(h)
            if v is None:
                v = attrs.get(h)
            if v not in (None, ""):
                ws.cell(r, i + 1).value = v
        r += 1

    wb.save(a.out)
    print(json.dumps({
        "ok": True,
        "out": a.out,
        "rows": r - 2,
        "specCols": [x for x in [head[c_color] if c_color is not None else None, style_name if c_style is not None else None] if x],
        "unfilledCols": unfilled,
        "header": head,
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
