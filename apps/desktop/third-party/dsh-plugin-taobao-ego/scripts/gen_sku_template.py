# -*- coding: utf-8 -*-
"""按 product.json 生成 SKU 导入表（**官方模板下载失败时的兜底**，列名取自 product.json 的 dimensions）。

用法：
  python gen_sku_template.py --product <product.json> --out <xlsx> [--header '["颜色分类","款式","价格","数量","商家编码"]']

注意：
- 首选仍是**平台官方模板**（每个类目的列名/规格维度都不一样，官方模板最准）。
- 本脚本只在「点下载模版拿不到文件」时兜底：用 product.json 里的 dimensions 当规格列，
  其余列（价格/数量/商家编码）按官方通用口径填。列名可能与类目官方模板不完全一致，
  调用方应把这一点明确报给用户。
"""
import argparse
import io
import json
import sys

import openpyxl


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--product", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--header", default="")
    a = ap.parse_args()

    d = json.load(io.open(a.product, encoding="utf-8"))
    dims = d.get("dimensions") or ["颜色分类", "款式"]
    head = None
    if a.header:
        try:
            head = json.loads(a.header)
        except Exception:
            head = None
    if not head or not isinstance(head, list):
        head = [dims[0] if dims else "颜色分类"]
        if len(dims) >= 2:
            head.append(dims[1])
        head += ["价格", "数量", "商家编码"]

    # 映射：规格列 → 取 color/style
    spec_cols = [c for c in head if c not in ("价格", "数量", "商家编码", "商品条形码")]
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "AI批量上传"
    for i, h in enumerate(head, 1):
        ws.cell(1, i).value = h

    idx = {h: i for i, h in enumerate(head, 1)}
    def put(row, name, value):
        if name in idx:
            ws.cell(row, idx[name]).value = value

    r = 2
    for s in d.get("skus") or []:
        if len(spec_cols) >= 2:
            put(r, spec_cols[0], s.get("color"))
            put(r, spec_cols[1], s.get("style"))
        elif len(spec_cols) == 1:
            put(r, spec_cols[0], f'{s.get("color")}-{s.get("style")}')
        put(r, "价格", s.get("price"))
        put(r, "数量", s.get("stock"))
        put(r, "商家编码", s.get("code"))
        r += 1
    wb.save(a.out)
    print(json.dumps({"ok": True, "out": a.out, "rows": r - 2, "header": head}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
