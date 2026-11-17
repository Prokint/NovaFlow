# -*- coding: utf-8 -*-
"""读回素材包里的 `商品信息.xlsx`（+ 官方 SKU 模板）→ 生成 listing.json。

用法：
  python listing_xlsx_to_json.py --xlsx <商品信息.xlsx> --out <listing.json>
        [--images-base <淘宝/<商品号>>] [--sku-template <SKU模板/xxx.xlsx>]

约定（与 build_pack / category_profile_xlsx 产出的表一致）：
  · 表头不一定在第 1 行（我们的表：第 1 行标题、第 3 行才是表头）→ 按关键字找表头行
  · 「基本信息」：字段 / 填写（+说明）
  · 「属性」：属性名 / 是否必填 / 值（+可选值）
  · SKU：**优先**从 --sku-template（官方 SKU 模板）读；没有才落回「SKU」sheet
"""
import argparse
import io
import json
import os
import re
import sys

import openpyxl

SKU_HEAD_KEYS = ("颜色分类", "颜色", "色")
DIM2_KEYS = ("款式", "地毯尺寸", "尺寸", "尺码", "规格")
PRICE_KEYS = ("价格", "单价", "售价", "拼单价")
STOCK_KEYS = ("数量", "库存", "现货库存")
CODE_KEYS = ("商家编码", "规格编码", "编码")


def cell(v):
    return "" if v is None else str(v).strip()


def find_header_row(ws, keys, scan=10):
    for r in range(1, min(ws.max_row, scan) + 1):
        vals = [cell(ws.cell(r, c).value) for c in range(1, ws.max_column + 1)]
        if any(any(k in v for k in keys) for v in vals if v):
            return r, vals
    return None, []


def col_index(head, keys):
    # 表头可能带后缀（如「颜色（★必填）」「款式/尺寸（★必填）」）→ 用「包含」匹配
    for k in keys:
        for i, h in enumerate(head):
            if k in (h or ""):
                return i
    return None


def to_num(raw):
    raw = cell(raw)
    if not raw:
        return 0
    try:
        return float(raw) if "." in raw else int(float(raw))
    except Exception:
        return 0


def read_basic(wb, listing, 缺什么, 提示):
    if "基本信息" not in wb.sheetnames:
        缺什么.append("缺少 sheet「基本信息」")
        return
    ws = wb["基本信息"]
    hr, head = find_header_row(ws, ("字段",))
    if hr is None:
        缺什么.append("「基本信息」找不到表头行（应有「字段/填写」）")
        return
    c_key = col_index(head, ("字段",)) or 0
    c_val = col_index(head, ("填写", "填写（★ 请填这里）"))
    if c_val is None:
        c_val = 1
    kv = {}
    for r in range(hr + 1, ws.max_row + 1):
        k = cell(ws.cell(r, c_key + 1).value)
        v = cell(ws.cell(r, c_val + 1).value)
        if k:
            kv[k] = v
    listing["title"] = kv.get("商品标题", "")
    listing["brand"] = kv.get("品牌") or "无品牌"
    listing["cat"] = kv.get("类目路径", "")
    listing["catid"] = kv.get("类目ID", "")
    # ★ 规格维度以**页面**为准（pack 生成时会写进来）：单层类目（如「颜色分类」一层）下，
    #   官方模板里的 尺寸（长×宽）/厚度 只是每个 SKU 自己的属性列，不能当成第二层规格拆行。
    dims_raw = kv.get("规格维度", "")
    if dims_raw:
        parts = [x.strip() for x in re.split(r"[×xX]|、|,|，", dims_raw) if x.strip()]
        if parts:
            listing["dimensions"] = parts
    if kv.get("货号"):
        listing["attributes"]["货号"] = kv["货号"]
    if kv.get("一口价"):
        try:
            listing["listPrice"] = float(kv["一口价"])
        except Exception:
            提示.append("一口价不是数字：%s" % kv.get("一口价"))
    imgs = {
        "main": kv.get("1:1主图目录", ""),
        "threeToFour": kv.get("3:4主图目录", ""),
        "detail": kv.get("详情图目录", ""),
        "white": kv.get("白底图目录", ""),
        "spec": kv.get("规格图目录", ""),
        "video": kv.get("商品视频文件", ""),
    }
    listing["images"] = {k: v for k, v in imgs.items() if v}
    if not listing["title"]:
        缺什么.append("基本信息.商品标题 未填")


def read_attrs(wb, listing, 缺什么):
    if "属性" not in wb.sheetnames:
        缺什么.append("缺少 sheet「属性」")
        return
    ws = wb["属性"]
    hr, head = find_header_row(ws, ("属性名",))
    if hr is None:
        缺什么.append("「属性」找不到表头行（应有「属性名/值」）")
        return
    c_name = col_index(head, ("属性名",)) or 0
    c_val = col_index(head, ("值", "值（★ 请填这里）"))
    if c_val is None:
        c_val = 2
    for r in range(hr + 1, ws.max_row + 1):
        name = cell(ws.cell(r, c_name + 1).value)
        val = cell(ws.cell(r, c_val + 1).value)
        if name and val:
            listing["attributes"][name] = val


def read_sku_sheet(wb, listing, 缺什么):
    if "SKU" not in wb.sheetnames:
        缺什么.append("SKU 数据缺失：既没给 --sku-template，也没有 sheet「SKU」")
        return
    ws = wb["SKU"]
    hr, head = find_header_row(ws, SKU_HEAD_KEYS)
    if hr is None:
        缺什么.append("「SKU」找不到表头（应有「颜色」）")
        return
    c_color = col_index(head, SKU_HEAD_KEYS)
    c_style = col_index(head, DIM2_KEYS)
    c_price = col_index(head, PRICE_KEYS)
    c_stock = col_index(head, STOCK_KEYS)
    c_code = col_index(head, CODE_KEYS)
    for r in range(hr + 1, ws.max_row + 1):
        color = cell(ws.cell(r, c_color + 1).value)
        if not color:
            continue
        listing["skus"].append({
            "color": color,
            "style": cell(ws.cell(r, c_style + 1).value) if c_style is not None else "",
            "price": to_num(ws.cell(r, c_price + 1).value) if c_price is not None else 0,
            "stock": to_num(ws.cell(r, c_stock + 1).value) if c_stock is not None else 0,
            "code": cell(ws.cell(r, c_code + 1).value) if c_code is not None else "",
        })


def read_sku_template(path, listing, 缺什么):
    wbt = openpyxl.load_workbook(path, data_only=True)
    wst = wbt.worksheets[0]
    hr, head = find_header_row(wst, SKU_HEAD_KEYS)
    if hr is None:
        缺什么.append("SKU 模板找不到「颜色分类」列（表头：%s）" % [cell(c.value) for c in wst[1]])
        return
    dims = listing.get("dimensions")
    c_color = col_index(head, SKU_HEAD_KEYS)
    # ★ 规格维度以页面为准（pack 里「规格维度」那一行）：
    #   · 拿到了 1 个维度 → 单层类目，尺寸/厚度等列**只是每个 SKU 的属性列**，不拆行
    #   · 拿到了 ≥2 个 → 多层，第二维按名字找列
    #   · 没拿到（老素材包）→ 保持老行为（按 DIM2_KEYS 猜），避免把窗帘这类多层的 pulling 成单层
    if dims is None:
        c_style = col_index(head, DIM2_KEYS)
    elif len(dims) >= 2:
        c_style = col_index(head, DIM2_KEYS) or next(
            (i for i, h in enumerate(head) if h and any(d in h or h in d for d in dims[1:] if d != "颜色分类")), None
        )
    else:
        c_style = None
    c_price = col_index(head, PRICE_KEYS)
    c_stock = col_index(head, STOCK_KEYS)
    c_code = col_index(head, CODE_KEYS)
    skip = {c_color, c_style, c_price, c_stock, c_code}
    extra_cols = [h for h in head if h and head.index(h) not in skip and h not in ("商品条形码", "条形码")]
    for r in range(hr + 1, wst.max_row + 1):
        color = cell(wst.cell(r, c_color + 1).value)
        if not color:
            continue
        row = {
            "color": color,
            "style": cell(wst.cell(r, c_style + 1).value) if c_style is not None else "",
            "price": to_num(wst.cell(r, c_price + 1).value) if c_price is not None else 0,
            "stock": to_num(wst.cell(r, c_stock + 1).value) if c_stock is not None else 0,
            "code": cell(wst.cell(r, c_code + 1).value) if c_code is not None else "",
        }
        for h in extra_cols:
            v = cell(wst.cell(r, head.index(h) + 1).value)
            if v:
                row[h] = v
        listing["skus"].append(row)


def apply_images_base(listing, images_base):
    if not images_base:
        return
    base_map = {"main": "1比1主图", "threeToFour": "3比4主图", "detail": "宝贝详情",
                "spec": "规格图片", "white": "白底图", "video": "商品视频"}
    imgs = dict(listing.get("images") or {})
    for k, sub in base_map.items():
        if imgs.get(k):
            continue
        cand = os.path.join(images_base, sub)
        if os.path.isdir(cand) and any(f for f in os.listdir(cand) if not f.endswith(".txt")):
            imgs[k] = cand
    listing["images"] = imgs


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--xlsx", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--images-base", default="")
    ap.add_argument("--sku-template", default="")
    a = ap.parse_args()

    if not os.path.exists(a.xlsx):
        print(json.dumps({"ok": False, "why": "xlsx_not_found", "xlsx": a.xlsx}, ensure_ascii=False))
        return 1

    wb = openpyxl.load_workbook(a.xlsx, data_only=True)
    缺什么 = []
    提示 = []
    listing = {"attributes": {}, "skus": [], "images": {}}

    read_basic(wb, listing, 缺什么, 提示)
    read_attrs(wb, listing, 缺什么)

    if a.sku_template and not os.path.exists(a.sku_template):
        提示.append("SKU 模板不存在，改用 商品信息.xlsx 的 SKU sheet：%s" % a.sku_template)
    if a.sku_template and os.path.exists(a.sku_template):
        try:
            read_sku_template(a.sku_template, listing, 缺什么)
        except Exception as e:
            缺什么.append("读 SKU 模板失败：%s" % e)
    else:
        read_sku_sheet(wb, listing, 缺什么)

    apply_images_base(listing, a.images_base)

    listing["colors"] = sorted({s["color"] for s in listing["skus"] if s.get("color")})
    listing["styles"] = sorted({s["style"] for s in listing["skus"] if s.get("style")})
    # ★ 必须覆盖「颜色 × 款式」全组合：平台识别后按矩阵生成行，缺的组合会被补成价格/库存为空 →
    #   「对账多 2 行」判定失败（实测踩到）。缺就明确报出来，让用户/agent 补齐。
    have = {(s.get("color"), s.get("style")) for s in listing["skus"]}
    missing = [(c, st) for c in listing["colors"] for st in listing["styles"] if (c, st) not in have]
    if missing:
        缺什么.append("SKU 缺组合 %d 个（平台会按矩阵补齐并留空价格/库存 → 导入后对账失败）：%s" % (
            len(missing), "；".join("%s / %s" % (c, st) for c, st in missing[:6])) + (" …" if len(missing) > 6 else ""))

    for k, v in (listing.get("images") or {}).items():
        if not os.path.exists(v):
            缺什么.append("图片路径不存在：[%s] %s" % (k, v))

    io.open(a.out, "w", encoding="utf-8", newline="\n").write(json.dumps(listing, ensure_ascii=False, indent=1))
    print(json.dumps({
        "ok": len(缺什么) == 0,
        "out": a.out,
        "skus": len(listing["skus"]),
        "colors": len(listing["colors"]),
        "styles": len(listing["styles"]),
        "attributes": len(listing["attributes"]),
        "images": {k: ("dir" if os.path.isdir(v) else "file") for k, v in (listing.get("images") or {}).items()},
        "缺什么": 缺什么,
        "提示": 提示,
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
