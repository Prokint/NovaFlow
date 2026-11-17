#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""上传前的 SKU 导入表自检（防止平台报「未检测到有效销售规格」/ 0 行 / 行数对不上）。

用法：
  python check_sku_template.py --product <product.json> --xlsx <sku_import_官方模板.xlsx>

退出码：0 = 通过；2 = 有问题（problems 里写明）
输出（stdout 最后一行 JSON）：
  {"ok":bool,"rows":N,"specCols":[{"name":"颜色分类","values":["米白","浅灰"]}],
   "priceCol":"价格","stockCol":"数量","problems":[...],"warnings":[...]}
"""
import argparse
import json
import os
import sys

import openpyxl

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

# 这些列是「控制列」，不算规格维度
CONTROL = {"价格", "单价", "售价", "数量", "库存", "现货库存", "商家编码", "规格编码", "编码",
           "商品条形码", "条形码", "图片", "标题", "宝贝描述", "白底图", "商品视频"}
CTRL_SKU_KEYS = {"color", "style", "price", "stock", "code", "barcode", "spec", "src"}
MIN_SPEC_RATIO = 0.8


def norm(v):
    return str(v).strip() if v is not None else ""


def load_product(path):
    with open(path, encoding="utf-8") as f:
        p = json.load(f)
    colors = [str(c).strip() for c in (p.get("colors") or []) if str(c).strip()]
    values = set(colors)
    dims = [str(d) for d in (p.get("dimensions") or [])]
    for s in p.get("skus") or []:
        c, st = norm(s.get("color")), norm(s.get("style"))
        if c:
            values.add(c)
        if st:
            values.add(st)
        for k, v in s.items():
            if k in CTRL_SKU_KEYS:
                continue
            if isinstance(v, str) and v.strip():
                values.add(v.strip())
    return p, colors, values, dims


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--product", required=True, help="product.json")
    ap.add_argument("--xlsx", required=True, help="待上传的 SKU 导入表")
    a = ap.parse_args()

    if not a.product or not os.path.exists(a.product):
        print(json.dumps({"ok": True, "skipped": "no_product", "file": a.xlsx}, ensure_ascii=False))
        return 0
    prod, colors, values, dims = load_product(a.product)
    wb = openpyxl.load_workbook(a.xlsx, data_only=True)
    ws = next((s for s in wb.worksheets if "hide" not in s.title.lower()), wb.worksheets[0])
    head = [norm(ws.cell(1, c).value) for c in range(1, ws.max_column + 1)]
    rows = []
    for r in range(2, ws.max_row + 1):
        vals = [norm(ws.cell(r, c).value) for c in range(1, ws.max_column + 1)]
        if any(vals):
            rows.append(vals)

    problems, warnings = [], []
    spec_cols = []
    price_col = stock_col = ""
    if len(head) < 3:
        problems.append("表头少于 3 列，不像 SKU 导入表")

    for i, h in enumerate(head):
        if not h:
            continue
        filled = [r[i] for r in rows if i < len(r) and r[i]]
        if not filled:
            continue
        if h in ("价格", "单价", "售价", "拼单价") and not price_col:
            price_col = h
            continue
        if h in ("数量", "库存", "现货库存") and not stock_col:
            stock_col = h
            continue
        if h in CONTROL:
            continue
        hit = sum(1 for v in filled if v in values or any(v == c for c in colors))
        if filled and hit / len(filled) >= MIN_SPEC_RATIO:
            spec_cols.append({"name": h, "values": sorted(set(filled))})

    if not rows:
        problems.append("表里没有任何数据行（只填了表头）")
    if not spec_cols:
        problems.append("没有任何「规格列」有值（颜色/尺寸列是空的）→ 平台会报「未检测到有效销售规格」")
    else:
        for sc in spec_cols:
            if len(sc["values"]) < 1:
                problems.append("规格列「%s」没有有效值" % sc["name"])
        # 注：单层类目 2 色 2 行时「每行值都不同」是**正常**的，不当警告（以前误报过）
    if not price_col:
        problems.append("没有价格列（价格/单价/售价）")
    elif any(not r[head.index(price_col)] for r in rows):
        problems.append("价格列「%s」有空值" % price_col)
    if not stock_col:
        warnings.append("没有数量/库存列（平台可能按默认库存建）")

    # 颜色 × 尺寸 的完整矩阵检查（同一组合重复出现 = 行浪费，平台会对不上账）
    key_cols = []
    for sc in spec_cols[:2]:
        key_cols.append(head.index(sc["name"]))
    if key_cols:
        dup = []
        seen = {}
        for idx, r in enumerate(rows):
            k = tuple(r[c] for c in key_cols)
            if any(not x for x in k):
                continue
            if k in seen:
                dup.append((idx + 2, k))
            seen[k] = idx + 2
        if dup:
            problems.append("有 %d 行是重复的规格组合（如第 %s 行）→ 先去掉重复行再导入"
                            % (len(dup), "、".join(str(x[0]) for x in dup[:6])))

    ok = not problems
    print(json.dumps({
        "ok": ok,
        "rows": len(rows),
        "specCols": spec_cols,
        "priceCol": price_col,
        "stockCol": stock_col,
        "productColors": colors[:8],
        "dimensions": dims,
        "problems": problems,
        "warnings": warnings,
        "header": head,
        "file": a.xlsx,
    }, ensure_ascii=False))
    return 0 if ok else 2


if __name__ == "__main__":
    sys.exit(main())
