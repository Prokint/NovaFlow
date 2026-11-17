# -*- coding: utf-8 -*-
"""把类目资料 + 已知数据导出成**给用户填的** 商品信息.xlsx（素材包里那份）。

用法：
  python category_profile_xlsx.py --profile <profile.json> --out <商品信息.xlsx> [--listing <listing.json>]

5 个 sheet（顺序=用户阅读顺序）：
  1. 怎么填     步骤 + 颜色图例 + 本类目介绍
  2. 类目要求   属性名 / 是否必填 / 当前值 / 可选值 / 说明（不列控件类型）
  3. 基本信息   字段 / 填写 / 说明（图片行写清"图放哪"）
  4. 属性       属性名 / 是否必填 / 值 / 可选值
  5. SKU        颜色 / 款式 / 价格 / 库存 / 商家编码

颜色约定：亮黄=必须由你填；浅绿=已自动填好（可改）；橙=必填行。
"""
import argparse
import io
import json
import os
import sys

import openpyxl
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter
from openpyxl.worksheet.datavalidation import DataValidation

C_HEAD = "1F4E78"
C_HEAD_FONT = "FFFFFF"
C_FILL_ME = "FFF2A8"       # 待填：亮黄
C_FILL_ME_REQ = "FFC000"   # 待填且必填：橙
C_PREFILL = "E2EFDA"       # 已预填：浅绿
C_REQ_TAG = "FFD966"       # 必填标记：橙黄

THIN = Side(style="thin", color="BFBFBF")
BORDER = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)
BOLD = Font(bold=True)
HEAD_FONT = Font(bold=True, color=C_HEAD_FONT, size=11)
TITLE_FONT = Font(bold=True, size=14, color=C_HEAD)
NOTE_FONT = Font(size=10, color="595959")


def head_row(ws, row, labels, widths):
    for i, lab in enumerate(labels, 1):
        c = ws.cell(row, i, lab)
        c.font = HEAD_FONT
        c.fill = PatternFill("solid", fgColor=C_HEAD)
        c.alignment = Alignment(horizontal="center", vertical="center")
        c.border = BORDER
    for i, w in enumerate(widths, 1):
        ws.column_dimensions[get_column_letter(i)].width = w
    ws.row_dimensions[row].height = 22


def thin_row(ws, row, ncol):
    for i in range(1, ncol + 1):
        ws.cell(row, i).border = BORDER


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--profile", required=True, help="类目 profile JSON（tb_ego_category_profile 输出）")
    ap.add_argument("--out", required=True, help="输出 xlsx（素材包里的 商品信息.xlsx）")
    ap.add_argument("--listing", default="", help="可选：listing.json —— 已知数据先预填（用户只补空）")
    ap.add_argument("--no-sku-sheet", action="store_true", help="不生成 SKU sheet（SKU 数据改填在 SKU模板/ 那份官方模板里）")
    a = ap.parse_args()

    prof = {}
    if a.profile and os.path.exists(a.profile):
        p = json.load(io.open(a.profile, encoding="utf-8"))
        prof = p.get("profile") or p
    L = {}
    if a.listing and os.path.exists(a.listing):
        L = json.load(io.open(a.listing, encoding="utf-8"))

    media = prof.get("媒体要求") or {}
    parsed = media.get("解析") or {}
    required = set(prof.get("必填属性") or [])
    attrs = prof.get("属性") or []
    cat_text = prof.get("catText") or L.get("cat") or ""
    cat_id = prof.get("catId") or L.get("catid") or ""

    wb = openpyxl.Workbook()

    # ══════════ 1. 怎么填 ══════════
    ws0 = wb.active
    ws0.title = "怎么填"
    ws0["A1"] = "淘宝上架素材包 · 商品信息（照着这 5 步填）"
    ws0["A1"].font = TITLE_FONT
    ws0.merge_cells("A1:B1")
    head_row(ws0, 3, ["步骤", "要做的事"], [18, 100])
    steps = [
        ("① 基本信息", "填「商品标题 / 货号 / 一口价」；品牌和类目已预填，一般不用改。"),
        ("② 属性", "「属性」sheet 里亮黄的格子 = 本类目必填属性：从右边「可选值」挑一个填进去（候选少的有下拉可选）。"),
        ("③ SKU", ("SKU 填在 **SKU模板/ 里的那份官方模板**（本类目官方导入表）：一行一个规格组合，颜色 / 尺寸·款式 / 价格 / 数量 / 商家编码。价格要与「一口价」里的某个值一致。"
                   if a.no_sku_sheet else
                   "「SKU」sheet 一行一个规格组合：颜色 / 款式（或尺寸）/ 价格 / 库存 / 商家编码。价格要与「一口价」里的某个值一致。")),
        ("④ 图片", "把图放进 淘宝\\<商品号>\\ 下对应目录：1比1主图（必填，≤5 张）、3比4主图、宝贝详情、规格图片、白底图、商品视频。"),
        ("⑤ 填完", "告诉 agent 一声：它读这份表 + 图片目录后直接上架（只填空、不提交，「提交宝贝信息」由你自己点）。"),
    ]
    r = 4
    for k, v in steps:
        ws0.cell(r, 1, k).font = BOLD
        ws0.cell(r, 2, v).alignment = Alignment(wrap_text=True, vertical="top")
        ws0.row_dimensions[r].height = 34
        thin_row(ws0, r, 2)
        r += 1

    r += 1
    ws0.cell(r, 1, "颜色图例").font = BOLD
    for i, (color, text) in enumerate([
        (C_FILL_ME, "亮黄：**必须由你填**"),
        (C_FILL_ME_REQ, "橙色：必填项，且还没填"),
        (C_PREFILL, "浅绿：已自动填好（可以改）"),
    ], start=1):
        c = ws0.cell(r + i, 1, "")
        c.fill = PatternFill("solid", fgColor=color)
        c.border = BORDER
        ws0.cell(r + i, 2, text)
        thin_row(ws0, r + i, 2)

    r = r + 4
    ws0.cell(r, 1, "本类目").font = BOLD
    ws0.cell(r, 2, f"{cat_text}（catId {cat_id}）")
    r += 1
    ws0.cell(r, 1, "图片/视频要求").font = BOLD
    ws0.cell(r, 2, "1:1 主图 比例 1:1、最多 {n1} 张；3:4 主图 比例 3:4、至多 {n34} 张；白底图 {w}；视频 {d}、比例 {r}、最多 {nv} 个".format(
        n1=parsed.get("1:1最多张数") or 5, n34=parsed.get("3:4最多张数") or 5,
        w=parsed.get("白底尺寸") or "800x800", d=parsed.get("视频时长") or "5秒-5分钟",
        r=(parsed.get("视频比例") or "1:1/3:4/9:16").strip(" ,"), nv=parsed.get("视频最多") or 5))
    ws0.cell(r, 2).alignment = Alignment(wrap_text=True, vertical="top")
    ws0.row_dimensions[r].height = 30

    # ══════════ 2. 类目要求 ══════════
    ws1 = wb.create_sheet("类目要求")
    ws1["A1"] = "这个类目发布页要求填哪些属性 / 每个能选什么（仅参考，不用改）"
    ws1["A1"].font = TITLE_FONT
    ws1.merge_cells("A1:E1")
    head_row(ws1, 3, ["属性名", "是否必填", "当前值", "可选值", "说明"], [22, 12, 22, 74, 46])
    r = 4
    for at in attrs:
        opts = at.get("可选值") or []
        opts_text = (" / ".join(opts[:12]) + (f" …共 {len(opts)} 项" if len(opts) > 12 else "")) if opts else ""
        req = at.get("name") in required or bool(at.get("required"))
        ws1.cell(r, 1, at.get("name"))
        c2 = ws1.cell(r, 2, "必填" if req else "选填")
        if req:
            c2.fill = PatternFill("solid", fgColor=C_REQ_TAG)
            c2.font = Font(bold=True, color="C00000")
        ws1.cell(r, 3, at.get("current") or "")
        ws1.cell(r, 4, opts_text).alignment = Alignment(wrap_text=True, vertical="top")
        ws1.cell(r, 5, (at.get("hint") or "")[:80]).font = NOTE_FONT
        ws1.row_dimensions[r].height = 28
        thin_row(ws1, r, 5)
        r += 1
    r += 1
    ws1.cell(r, 1, "图片/视频要求（页面原文）").font = BOLD
    r += 1
    for key in ("1:1", "3:4", "白底图", "商品视频"):
        if media.get(key):
            ws1.cell(r, 1, key)
            ws1.cell(r, 4, str(media.get(key))[:220]).alignment = Alignment(wrap_text=True, vertical="top")
            ws1.row_dimensions[r].height = 40
            thin_row(ws1, r, 5)
            r += 1

    # ══════════ 3. 基本信息 ══════════
    ws2 = wb.create_sheet("基本信息")
    ws2["A1"] = "基本信息（亮黄格子请填写；浅绿已自动填好，可改）"
    ws2["A1"].font = TITLE_FONT
    ws2.merge_cells("A1:C1")
    head_row(ws2, 3, ["字段", "填写（★ 请填这里）", "说明"], [22, 52, 76])
    n1 = parsed.get("1:1最多张数") or 5
    n34 = parsed.get("3:4最多张数") or 5
    wbg = parsed.get("白底尺寸") or "800x800"
    vdur = parsed.get("视频时长") or "5秒-5分钟"
    vratio = (parsed.get("视频比例") or "1:1/3:4/9:16").strip(" ,")
    # 规格维度：页面优先 → listing 声明兜底（来源写清楚，别让下游误以为是页面确认过的）
    _dims = [str(x).strip() for x in (prof.get("规格维度") or []) if str(x).strip()]
    if _dims:
        _dims_value = " × ".join(_dims)
        _dims_note = "页面「销售信息」读到的规格层；SKU 行数 = 各维度取值组合"
    else:
        _dims = [str(x).strip() for x in ((L.get("dimensions") or [])) if str(x).strip()]
        if _dims:
            _dims_value = " × ".join(_dims)
            _dims_note = "页面未读到（新建商品还没建 SKU），此为素材包声明值；如与页面不符请以此处为准并改 SKU 行数"
        else:
            _dims_value = ""
            _dims_note = "页面未读到、也没声明 → 请填：如「颜色分类」或「颜色分类 × 尺寸」，并保证 SKU 行数 = 各维度取值组合"
    rows = [
        ("商品标题", L.get("title") or "", "≤30 个汉字（60 字符）"),
        ("品牌", L.get("brand") or "无品牌", "必须是该店已申请的；没有就保持「无品牌」"),
        ("货号", (L.get("attributes") or {}).get("货号") or "", "商家编码/货号，任意唯一值"),
        ("一口价", L.get("listPrice") if L.get("listPrice") else "",
         "必须等于某个有库存 SKU 的价格（见 {}）".format("SKU模板/ 里的官方模板" if a.no_sku_sheet else "「SKU」sheet")),
        # ★ 一口价与 SKU 价格必须一致，否则平台报「一口价不在 SKU 价格集合里」
        ("类目路径", cat_text, "已自动填好（run_listing 的 cat 参数）"),
        ("类目ID", cat_id, "已自动填好（catid 参数）"),
        # ★ 规格维度以页面「销售信息」为准：单层类目（只有颜色分类）时，模板里的
        #   尺寸（长×宽）/厚度 是每个 SKU 的属性列，**不要**当成第二层规格拆行。
        #   页面读不到（新建商品还没建 SKU 时销售信息没有 `SKU模式` 那段）→ 退回 listing 的声明，
        #   并在说明里标出来源，避免下游把它当成「页面确认过」。
        ("规格维度", _dims_value, _dims_note),
        ("1:1主图目录", "", f"把图放进 淘宝\\<商品号>\\1比1主图（≥1 张，最多 {n1} 张，比例 1:1）"),
        ("3:4主图目录", "", f"把图放进 淘宝\\<商品号>\\3比4主图（可选，至多 {n34} 张，比例 3:4）"),
        ("详情图目录", "", "把图放进 淘宝\\<商品号>\\宝贝详情（可选，建议 ≥5 张）"),
        ("白底图目录", "", f"把图放进 淘宝\\<商品号>\\白底图（可选，1 张 {wbg}）"),
        ("商品视频文件", "", f"把视频放进 淘宝\\<商品号>\\商品视频（可选，{vdur}、比例 {vratio}）"),
        ("规格图目录", "", "把图放进 淘宝\\<商品号>\\规格图片（可选；文件名带颜色名即可）"),
    ]
    r = 4
    for k, v, note in rows:
        ws2.cell(r, 1, k).font = BOLD
        cell = ws2.cell(r, 2, v)
        if v not in (None, ""):
            cell.fill = PatternFill("solid", fgColor=C_PREFILL)
        else:
            cell.fill = PatternFill("solid", fgColor=C_FILL_ME)
            cell.font = BOLD
            note = "★ 必须由你提供 → " + note
        ws2.cell(r, 3, note).font = NOTE_FONT
        ws2.cell(r, 3).alignment = Alignment(wrap_text=True, vertical="top")
        ws2.row_dimensions[r].height = 30
        thin_row(ws2, r, 3)
        r += 1

    # ══════════ 4. 属性 ══════════
    ws3 = wb.create_sheet("属性")
    ws3["A1"] = "类目属性（橙色=必填且未填、亮黄=选填；值从右侧可选值里挑）"
    ws3["A1"].font = TITLE_FONT
    ws3.merge_cells("A1:D1")
    head_row(ws3, 3, ["属性名", "是否必填", "值（★ 请填这里）", "可选值"], [26, 12, 30, 88])
    r = 4
    for at in attrs:
        name = at.get("name")
        req = name in required or bool(at.get("required"))
        opts = at.get("可选值") or []
        ws3.cell(r, 1, name)
        c2 = ws3.cell(r, 2, "必填" if req else "选填")
        if req:
            c2.fill = PatternFill("solid", fgColor=C_REQ_TAG)
            c2.font = Font(bold=True, color="C00000")
        vcell = ws3.cell(r, 3, "")
        pref = (L.get("attributes") or {}).get(name)
        if pref not in (None, ""):
            vcell.value = pref
            vcell.fill = PatternFill("solid", fgColor=C_PREFILL)
        else:
            vcell.fill = PatternFill("solid", fgColor=C_FILL_ME_REQ if req else C_FILL_ME)
            vcell.font = BOLD
        ws3.cell(r, 4, " / ".join(opts[:60])).font = NOTE_FONT
        ws3.cell(r, 4).alignment = Alignment(wrap_text=True, vertical="top")
        ws3.row_dimensions[r].height = 26
        thin_row(ws3, r, 4)
        if 1 <= len(opts) <= 6:
            formula = '"' + ",".join(str(x).replace('"', "'") for x in opts) + '"'
            if len(formula) <= 250:
                dv = DataValidation(type="list", formula1=formula, allow_blank=True, showDropDown=False)
                dv.errorTitle = "值不在可选范围"
                dv.error = "请从下拉里选（可选项见 D 列）"
                ws3.add_data_validation(dv)
                dv.add(vcell)
        r += 1

    # ══════════ 5. SKU（默认不生成：SKU 填在 SKU模板/ 那份里） ══════════
    if a.no_sku_sheet:
        wb.save(a.out)
        print(json.dumps({
            "ok": True, "out": a.out,
            "sheets": ["怎么填", "类目要求", "基本信息", "属性"],
            "属性行数": len(attrs), "必填属性": sorted(required),
            "sku": "SKU 不在本表，填在 SKU模板/ 那份官方模板里",
        }, ensure_ascii=False))
        return 0
    ws4 = wb.create_sheet("SKU")
    ws4["A1"] = "SKU（一行一个规格组合；亮黄格子都要填，价格要与一口价里的某个值一致）"
    ws4["A1"].font = TITLE_FONT
    ws4.merge_cells("A1:E1")
    head_row(ws4, 3, ["颜色（★必填）", "款式/尺寸（★必填）", "价格（★必填）", "库存（★必填）", "商家编码"], [30, 30, 12, 12, 34])
    skus = (L.get("skus") or [])[:12]
    r = 4
    for i in range(14):
        sku = skus[i] if i < len(skus) else None
        if sku:
            ws4.cell(r, 1, sku.get("color"))
            ws4.cell(r, 2, sku.get("style"))
            ws4.cell(r, 3, sku.get("price"))
            ws4.cell(r, 4, sku.get("stock"))
            ws4.cell(r, 5, sku.get("code"))
            for c in range(1, 6):
                ws4.cell(r, c).fill = PatternFill("solid", fgColor=C_PREFILL)
        else:
            for c in range(1, 6):
                ws4.cell(r, c).fill = PatternFill("solid", fgColor=C_FILL_ME)
        thin_row(ws4, r, 5)
        ws4.row_dimensions[r].height = 20
        r += 1

    wb.save(a.out)
    print(json.dumps({
        "ok": True,
        "out": a.out,
        "sheets": ["怎么填", "类目要求", "基本信息", "属性", "SKU"],
        "属性行数": len(attrs),
        "必填属性": sorted(required),
        "预填": {"标题": bool(L.get("title")), "SKU行": len(L.get("skus") or [])},
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
