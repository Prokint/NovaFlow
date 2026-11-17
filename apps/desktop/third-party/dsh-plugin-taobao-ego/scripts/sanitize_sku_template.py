#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
把「官方 SKU 模板」里**非规格列**的取值清空，只保留规格维度 + 价格/库存/编码。

为什么需要：淘宝「批量导入」的 AI 识别会把**任何有值的列**当成销售属性。
如果模板里 图案/材质/面层工艺/标题 这类属性列也带值，就会识别出
「图案 × 材质 × 面层工艺 × 颜色分类」多个维度，导入后 SKU 表行数和规格全乱
（实测：PE-001 模板 16 行填了 图案/材质/面层工艺 → 导入后只读到 1 行）。

用法：
  python scripts/sanitize_sku_template.py --product <product.json> --xlsx <sku_import_官方模板.xlsx> [--out <新文件>]
  python scripts/sanitize_sku_template.py --product ... --xlsx ... --dry   # 只打印判定，不写

判定规则：
  · 价格 / 库存 / 数量 / 商家编码 / 商品条形码      → 永远保留
  · 图片 / 标题 / 宝贝描述 / 白底图 / 商品视频       → 永远清空
  · 其余列：看它的值能否匹配 product.json 的 colors / styles
      - 单元格 = 某个 color 或某个 style，或 = "color-style"，或同时包含 color 与 style → 记 1 分
      - 非空单元格中 ≥80% 命中 → 判定为**规格列**，保留；否则清空
"""
import argparse
import json
import sys

import openpyxl

# Windows 控制台/ego 继承的代码页可能是 GBK；颜色值里有 emoji（⭕）会直接把 print 打成 UnicodeEncodeError
try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass

ALWAYS_KEEP = {"价格", "库存", "数量", "商家编码", "商品条形码"}
ALWAYS_BLANK = {"图片", "标题", "宝贝描述", "白底图", "商品视频", "图文描述"}
CTRL_SKU_KEYS = {"color", "style", "price", "stock", "code", "barcode", "spec", "src"}


def load_product(path):
    """返回 (product, colors, styles, spec_values)。

    ★ styles 不只是 product.styles：第二个规格维度的值在各类目里叫法不同
      （款式/地毯尺寸/窗帘尺寸+加工方式…），常以**自定义字段**挂在 sku 行上，
      所以要把 sku 行里除通用字段外的所有字符串值一并收进来当「规格值」。
      否则窗帘这类目会把「窗帘尺寸+加工方式」列判定成非规格列 → 整列被清空 →
      平台报「未检测到有效销售规格」。
    """
    with open(path, encoding="utf-8") as f:
        p = json.load(f)
    colors = [str(c) for c in (p.get("colors") or []) if c]
    styles = [str(s) for s in (p.get("styles") or []) if s]
    spec_values = set(styles)
    for s in p.get("skus") or []:
        c, st = str(s.get("color") or ""), str(s.get("style") or "")
        if c and c not in colors:
            colors.append(c)
        if st and st not in styles:
            styles.append(st)
        spec_values.add(st)
        # 类目专属的第二个维度（listing 里以官方模板列名为 key）
        for k, v in s.items():
            if k in CTRL_SKU_KEYS:
                continue
            if isinstance(v, str) and v.strip():
                spec_values.add(v.strip())
                if v.strip() not in styles:
                    styles.append(v.strip())
    spec_values.discard("")
    return p, colors, styles, spec_values


def norm(v):
    return str(v).strip() if v is not None else ""


def matches_spec(value, colors, styles):
    v = norm(value)
    if not v:
        return False
    if v in colors or v in styles:
        return True
    for c in colors:
        for s in styles:
            for sep in ("-", "/", " ", "，"):
                if v == c + sep + s:
                    return True
            if c and s and c in v and s in v:
                return True
    return False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--product", required=True, help="product.json 路径")
    ap.add_argument("--xlsx", required=True, help="sku_import_官方模板.xlsx 路径")
    ap.add_argument("--out", default="", help="输出路径（默认原地改，会先备份 .bak-时间戳）")
    ap.add_argument("--dry", action="store_true", help="只打印判定，不写文件")
    ap.add_argument("--check", action="store_true", help="只检查：需要清理时退出码 1，否则 0（编排层用）")
    ap.add_argument("--spec-cols", default="", help="明确指定规格列（逗号分隔，如 '颜色分类,窗帘尺寸+加工方式'）：这些列永不清理")
    args = ap.parse_args()

    _, colors, styles, spec_values = load_product(args.product)
    forced = {x.strip() for x in (args.spec_cols or "").split(",") if x.strip()}
    wb = openpyxl.load_workbook(args.xlsx)
    ws = wb.active
    hdr = [norm(c.value) for c in ws[1]]
    rows = list(ws.iter_rows(min_row=2))

    keep, blank = [], []
    for i, h in enumerate(hdr):
        if not h:
            blank.append((i, "(空表头)"))
            continue
        if h in ALWAYS_KEEP:
            keep.append((i, h, "白名单"))
            continue
        if h in ALWAYS_BLANK:
            blank.append((i, h))
            continue
        if h in forced:
            keep.append((i, h, "调用方指定为规格列"))
            continue
        vals = [norm(r[i].value) for r in rows]
        filled = [v for v in vals if v]
        if not filled:
            continue  # 本来就没值，不动
        hit = sum(1 for v in filled if matches_spec(v, colors, styles))
        ratio = hit / len(filled)
        if ratio >= 0.8:
            keep.append((i, h, "规格列 %d/%d 命中" % (hit, len(filled))))
        else:
            blank.append((i, h))

    print("product colors =", colors[:8], "| styles =", styles[:8])
    print("headers =", hdr)
    for i, h, why in keep:
        print("  保留  %-12s %s" % (h, why))
    for i, h in blank:
        print("  清空  %-12s %s" % (h, "（非规格列，带值会被 AI 识别成额外尺寸）" if h else ""))

    if args.check:
        needs = [h for i, h in blank if any(norm(r[i].value) for r in rows)]
        if needs:
            print("需要清理非规格列：" + "、".join(str(x or "(空表头)") for x in needs))
            return 1
        print("模板无需清理")
        return 0

    # ★ 安全闸：清完以后如果**一个规格列都不剩值**，平台必定报「未检测到有效销售规格」→ 宁可不写
    if blank:
        kept_has_value = any(any(norm(r[i].value) for r in rows)
                             for i, h, _ in keep if h not in ALWAYS_KEEP)
        if not kept_has_value:
            print("★ 清理后没有任何规格列还有值 → 平台会报「未检测到有效销售规格」→ 拒绝执行")
            print("  请检查颜色/尺寸列是否真的填了，或用 --spec-cols 指定规格列")
            return 3

    if args.dry:
        print("--dry：未写文件")
        return 0

    if not blank:
        print("没有需要清空的列")
        return 0

    import copy
    import shutil
    import time

    out = args.out or args.xlsx
    if out == args.xlsx:
        bak = args.xlsx + ".bak-" + time.strftime("%Y%m%d-%H%M%S")
        shutil.copy2(args.xlsx, bak)
        print("已备份：", bak)

    for i, h in blank:
        for r in ws.iter_rows(min_row=2):
            r[i].value = None
    wb.save(out)
    print("已写入：", out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
