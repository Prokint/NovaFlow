# -*- coding: utf-8 -*-
"""生成一个**完整的淘宝素材包**（= 我们「没素材包」场景的成品）。

用法：
  python build_pack.py --listing <listing.json> --pack-dir <素材包目录> [--profile <profile.json>]

产物结构（正是 `pack` 模式要求的形状）：

```
<素材包目录>/
├─ 商品信息.xlsx            ← sheet「淘宝」：R1 类目来源 / R2 表头 / R4 JSON 元数据 / R5+ 数据行
└─ 淘宝/<商品号>/
   ├─ 1比1主图/  1比1主图_01.jpg…
   ├─ 3比4主图/  3比4主图_01.jpg…
   ├─ 宝贝详情/  详情_01.jpg…
   ├─ 规格图片/  （保留原名）
   ├─ 白底图/    白底图_01.jpg
   └─ 商品视频/  xxx.mp4
```

`商品信息.xlsx` 的列 = **类目属性**（R4 里带 {"key": 属性名, "required": ...}）+ SKU 列
（`颜色分类` / 第二个规格列 / 价格 / 数量 / 商家编码 / 规格图片文件名）。
tb_build.py 会据此产出 product.json + SKU 导入表，tb_prep_assets.js 再把图拷进 img/。
"""
import argparse
import io
import json
import os
import re
import shutil
import sys
import subprocess

import openpyxl
from openpyxl.styles import Font, PatternFill

IMG = re.compile(r"\.(jpe?g|png|webp|gif|bmp)$", re.I)
VID = re.compile(r"\.(mp4|mov|mkv|webm)$", re.I)
HEAD_FILL = PatternFill("solid", fgColor="DDEBF7")


def list_files(src, rex):
    if not src:
        return []
    if isinstance(src, list):
        return [p for p in map(str, src) if os.path.exists(p) and rex.search(p)]
    p = str(src)
    if not os.path.exists(p):
        return []
    if os.path.isdir(p):
        return [os.path.join(p, f) for f in sorted(os.listdir(p)) if rex.search(f)]
    return [p] if rex.search(p) else []


def copy_into(src_list, dst_dir, prefix, limit=None):
    os.makedirs(dst_dir, exist_ok=True)
    n = 0
    for f in (src_list[:limit] if limit else src_list):
        ext = os.path.splitext(f)[1].lower()
        shutil.copyfile(f, os.path.join(dst_dir, f"{prefix}{n + 1:02d}{ext}"))
        n += 1
    return n


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--listing", required=True, help="listing.json（tb_ego_build_product 用的那份）")
    ap.add_argument("--pack-dir", required=True, help="素材包目录（不存在会自动建）")
    ap.add_argument("--profile", default="", help="可选：类目 profile JSON（提供 必填标记）")
    ap.add_argument("--dim2", default="", help="可选：第二个规格列名（如 地毯尺寸/款式）；不给就按 listing.dimensions 或官方模板推）")
    ap.add_argument("--template", default="", help="可选：该类目**官方 SKU 导入模板**（会一起放进素材包，SKU 导入必填）")
    ap.add_argument("--audience", default="tb", choices=("tb", "user"),
                    help="tb=内部 tb_build 格式（默认）；user=**给用户填的素材包**（商品信息.xlsx 是 4-sheet 待填表）")
    ap.add_argument("--profile-json", default="", help="audience=user 时用：类目 profile JSON（生成待填表用）")
    ap.add_argument("--allow-no-template", action="store_true",
                    help="仅内部调试：允许产出**不含官方 SKU 模板**的草稿包（不可直接交付；默认拿不到模板就拒绝产包）")
    a = ap.parse_args()

    # ★ 官方模板常是「.xls 名字、其实是 xlsx 内容」（文件头 50 4B）→ openpyxl 见 .xls 直接拒读，
    #   而 build_pack 之前会**静默降级**成「直接拷空模板」→ 包里模板只有表头、没预填 SKU，
    #   下游看起来就像「模板没下载到」。这里先按内容纠正后缀，两处分支都受益（2026-11-17 实测踩到）。
    def normalize_tpl(p):
        if not p or not os.path.exists(p):
            return p
        try:
            with open(p, "rb") as fh:
                magic = fh.read(2)
            if magic == b"PK" and str(p).lower().endswith(".xls"):
                new = str(p)[:-4] + ".xlsx"
                shutil.copyfile(p, new)
                print("   ↻ 模板后缀按内容纠正：.xls → .xlsx（%s）" % os.path.basename(new))
                return new
        except Exception:
            pass
        return p

    if a.template:
        a.template = normalize_tpl(a.template)

    L = json.load(io.open(a.listing, encoding="utf-8"))
    # 先加载 profile（两种 audience 都要用；之前放在分支后面 → 用户包里拿不到 catId 的坑）
    prof = {}
    pj = a.profile_json or a.profile
    if pj and os.path.exists(pj):
        p = json.load(io.open(pj, encoding="utf-8"))
        prof = p.get("profile") or p

    # ══ audience=user：只产一份「给用户填的素材包」 ══
    if a.audience == "user":
        pack_u = os.path.abspath(a.pack_dir)
        pid_u = str(L.get("id") or "TB-PACK-01")
        os.makedirs(pack_u, exist_ok=True)
        # ① 先确定官方 SKU 模板（有就不在 商品信息.xlsx 里放 SKU sheet；没有就放，保证 SKU 数据有地方填）
        tpl_u = a.template
        if not tpl_u:
            try:
                import glob
                catid = str(prof.get("catId") or L.get("catid") or "")
                cands = sorted(glob.glob(os.path.join(os.path.expanduser("~"), ".dsh", "taobao-ego", "output", "_downloads", "SKU模板_*.xlsx")))
                pick = [c for c in cands if catid and ("SKU模板_" + catid + "_") in os.path.basename(c)]
                tpl_u = pick[-1] if pick else ""
            except Exception:
                tpl_u = ""
        # ② 商品信息.xlsx 待填表（已知数据预填，用户只补空）
        prof_json = a.profile_json or a.profile
        xlsx_u = os.path.join(pack_u, "商品信息.xlsx")
        if prof_json and os.path.exists(prof_json):
            pybin = sys.executable
            sub = [pybin, "-X", "utf8", os.path.join(os.path.dirname(os.path.abspath(__file__)), "category_profile_xlsx.py"),
                   "--profile", prof_json, "--out", xlsx_u, "--listing", os.path.abspath(a.listing)]
            if tpl_u:
                sub.append("--no-sku-sheet")
            subprocess.run(sub, check=True)
        else:
            raise SystemExit("audience=user 需要 --profile-json（类目 profile），否则生成不出待填表")
        # ② 图片目录：建空目录 + 放说明（用户自己往里丢图）
        sub_dirs = {"1比1主图": "1:1 主图（≥1 张，最多 5 张；比例 1:1）",
                    "3比4主图": "3:4 主图（可选；没有就留空，会自动跳过）",
                    "宝贝详情": "详情图（可选；建议 ≥5 张）",
                    "白底图": "白底图（可选；1 张 800×800，纯白背景）",
                    "商品视频": "商品视频（可选；mp4/mov，5 秒–5 分钟）",
                    "规格图片": "规格图（可选；文件名里带颜色名即可自动对应）"}
        for dname, note in sub_dirs.items():
            d = os.path.join(pack_u, "淘宝", pid_u, dname)
            os.makedirs(d, exist_ok=True)
            io.open(os.path.join(d, "把图放这里.txt"), "w", encoding="utf-8", newline="\n").write(note + "\n")
        # ③ 官方 SKU 模板：放进包里（SKU 导入必填）
        tpl_out_u = None
        sku_tpl_ok = None
        tpl_u = a.template
        if not tpl_u:
            try:
                import glob
                catid = str(prof.get("catId") or L.get("catid") or "")
                cands = sorted(glob.glob(os.path.join(os.path.expanduser("~"), ".dsh", "taobao-ego", "output", "_downloads", "SKU模板_*.xlsx")))
                pick = [c for c in cands if catid and ("SKU模板_" + catid + "_") in os.path.basename(c)]
                # ★ 类目对不上就**不要**拿别的类目模板（列名不同，导入必炸）→ 留空，运行时再按类目下载
                tpl_u = pick[-1] if pick else ""
            except Exception:
                tpl_u = ""
        if tpl_u and os.path.exists(tpl_u):
            tpl_dir_u = os.path.join(pack_u, "SKU模板")
            os.makedirs(tpl_dir_u, exist_ok=True)
            tpl_out_u = os.path.join(tpl_dir_u, os.path.basename(tpl_u))
            tpl_ok = False
            try:
                fill = [sys.executable, "-X", "utf8", os.path.join(os.path.dirname(os.path.abspath(__file__)), "fill_sku_template.py"),
                        "--template", tpl_u, "--listing", os.path.abspath(a.listing), "--out", tpl_out_u]
                subprocess.run(fill, check=True)
                tpl_ok = True
                print("   ✓ SKU 模板已预填（用户直接在 SKU模板/ 那份里改）")
            except Exception as e:
                shutil.copyfile(tpl_u, tpl_out_u)
                print("   ❌ SKU 模板预填失败（这只是空模板，用户必须自己一行行填！原因：", e, "）")
            # ★ 预填完必须**自检**：表里除表头外至少要有 1 行数据，否则等于给用户一张空表
            try:
                import openpyxl as _oxl
                _wb = _oxl.load_workbook(tpl_out_u, data_only=True)
                _ws = _wb.worksheets[0]
                _rows = sum(1 for r in _ws.iter_rows(min_row=2) if any(c.value not in (None, "") for c in r))
                if _rows < 1:
                    print("   ❌ SKU 模板里没有任何 SKU 行（表头之外是空的）→ 这个包不能直接交付")
                    tpl_ok = False
                else:
                    print("   ✓ SKU 模板自检：%d 行 SKU 已写入" % _rows)
            except Exception as e:
                print("   ⚠ SKU 模板自检读不出来：", e)
            sku_tpl_ok = tpl_ok
        else:
            # ★ 用户口径（2026-11-17）：**素材包才是交付物，官方 SKU 模板是硬前提**。
            #   拿不到该类目官方模板 → 不出包（也不退化成「把 SKU 填在 SKU sheet 里凑合」），
            #   先回去修下载/换入口，拿到模板再产包。
            if not a.allow_no_template:
                print("❌ 该类目官方 SKU 模板没取到 → 拒绝产包（官方模板是必填项：SKU 只能填在它里面）")
                print("   请先：① tb_ego_category_profile(exportXlsx) 自动下载该类目模板；")
                print("        ② 或发品页「批量导入 → 下载模版」；③ 再重跑 build_pack")
                print("   确需先出一份无模板的草稿（仅内部调试），加 --allow-no-template")
                sys.exit(3)
            print("⚠ --allow-no-template：本次产包**不含官方模板**，SKU 需另填在 SKU sheet（不可直接交付）")
        # ④ 一份 README 说明
        sku_note = ("3) **SKU 填在「SKU模板/」那份官方模板里**（一行一个规格组合：颜色分类/款式·尺寸/价格/数量/商家编码；已预填可改）。"
                    if tpl_out_u else
                    "3) ⚠ 本包缺官方 SKU 模板（--allow-no-template 草稿模式）→ 不可直接交付，先补模板")
        io.open(os.path.join(pack_u, "怎么用.txt"), "w", encoding="utf-8", newline="\n").write(
            "淘宝上架素材包（给用户填）\n"
            "\n"
            "1) 商品信息.xlsx：填「基本信息」「属性」两个 sheet（亮黄=要填，浅绿=已预填可改）。\n"
            "   内容不确定的（标题/价格/库存/规格）跟 agent 讨论后再填。\n"
            "2) 图片：把图放到「淘宝/<商品号>/」下对应目录（1:1主图 必填，其它可选）。\n"
            + sku_note + "\n"
            + "4) 填完告诉 agent 一声，它会读回来直接上架（只填空、不提交）。\n")
        print(json.dumps({"ok": True, "audience": "user", "packDir": pack_u, "xlsx": xlsx_u,
                          "productDir": os.path.join(pack_u, "淘宝", pid_u),
                          "skuTemplate": tpl_out_u}, ensure_ascii=False))
        return 0

    pid = str(L.get("id") or "TB-PACK-01")
    pack = os.path.abspath(a.pack_dir)
    sub = os.path.join(pack, "淘宝", pid)
    dirs = {k: os.path.join(sub, v) for k, v in {
        "main": "1比1主图", "threeToFour": "3比4主图", "detail": "宝贝详情",
        "spec": "规格图片", "white": "白底图", "video": "商品视频",
    }.items()}
    for d in dirs.values():
        if os.path.isdir(d):
            shutil.rmtree(d, ignore_errors=True)
        os.makedirs(d, exist_ok=True)

    images = L.get("images") or {}
    n_main = copy_into(list_files(images.get("main"), IMG), dirs["main"], "1比1主图_", limit=5)
    n_34 = copy_into(list_files(images.get("threeToFour"), IMG), dirs["threeToFour"], "3比4主图_", limit=5)
    n_detail = copy_into(list_files(images.get("detail"), IMG), dirs["detail"], "详情_")
    n_white = copy_into(list_files(images.get("white"), IMG), dirs["white"], "白底图_", limit=1)

    # 规格图：显式映射（颜色→文件）优先；否则整个目录拷进来，靠 product.json 的 spec_images 对上
    spec_map = {}
    spec_src = images.get("spec")
    if isinstance(spec_src, dict):
        for color, path in spec_src.items():
            fs = list_files(path, IMG)
            if not fs:
                continue
            f = fs[0]
            dst = os.path.join(dirs["spec"], os.path.basename(f))
            shutil.copyfile(f, dst)
            spec_map[color] = os.path.basename(dst)
    else:
        # 目录形式：拷进来，并按「颜色里的中文片段」建立 颜色→文件名 映射
        # （否则 product.json 没有 spec_images，规格图那步会 no_file）
        tokens = lambda c: [t for t in re.split(r"[^\u4e00-\u9fa5]+", str(c)) if len(t) >= 2]
        colors0 = L.get("colors") or sorted({(sk.get("color") or "") for sk in (L.get("skus") or []) if sk.get("color")})
        for f in list_files(spec_src, IMG):
            base = os.path.basename(f)
            shutil.copyfile(f, os.path.join(dirs["spec"], base))
            stem = os.path.splitext(base)[0]
            for c in colors0:
                if c in stem or any(t in stem for t in tokens(c)):
                    spec_map.setdefault(c, base)
                    break

    videos = list_files(images.get("video"), VID)
    n_video = 0
    for f in videos[:1]:
        shutil.copyfile(f, os.path.join(dirs["video"], os.path.basename(f)))
        n_video += 1

    # ── 商品信息.xlsx ──
    title = str(L.get("title") or "")
    brand = str(L.get("brand") or "无品牌")
    attrs = dict(L.get("attributes") or {})
    attrs.pop("品牌", None)
    skus = L.get("skus") or []
    colors = L.get("colors") or sorted({s.get("color") for s in skus if s.get("color")})
    dims = L.get("dimensions") or []
    # ★ 单层类目（页面 `SKU模式 · 【颜色分类】单层展示`）：模板里的 尺寸（长×宽）/厚度 只是每个 SKU 的
    #   属性列，**不是**第二层规格 → 不拆第二维（否则 2 行被拆成 4 行，平台只建一层 → 对账失败）
    single_dim = len(dims) == 1
    dim2 = a.dim2 or (dims[1] if len(dims) >= 2 else "")
    # 还没给：从官方 SKU 模板（_downloads 缓存 / 素材包自带）的表头里找「第二个规格列」。
    # ★ 先看 listing 的 SKU 行里有没有**直接用官方模板列名当 key** 的维度值
    #   （如「窗帘尺寸+加工方式」——用户版素材包转内部格式时就是这么带的）。
    #   之前只按「第一个不像数值属性的列」猜，窗帘类目会猜成「成品宽度」→ 尺寸值整列丢失。
    EXCL = ("颜色分类", "价格", "数量", "商家编码", "商品条形码", "库存", "规格图片文件名", "规格图片")
    NUMERIC_ATTRS = ("厚度", "宽度", "长度", "高度", "重量", "中层厚度", "底背材质")
    tpl_head = []
    if not dim2:
        try:
            import glob
            cands = sorted(glob.glob(os.path.join(os.path.expanduser("~"), ".dsh", "taobao-ego", "output", "_downloads", "SKU模板_*.xlsx")))
            catid = str((prof.get("catId") or L.get("catid") or ""))
            pick = [c for c in cands if catid and ("SKU模板_" + catid + "_") in os.path.basename(c)]
            if not pick and a.template and os.path.exists(a.template):
                pick = [a.template]
            if pick:
                wbt = openpyxl.load_workbook(pick[-1], data_only=True)
                wst = wbt.worksheets[0]
                tpl_head = [str(wst.cell(1, c).value or "").strip() for c in range(1, wst.max_column + 1)]
        except Exception:
            tpl_head = []
        if not single_dim:
            # ① SKU 行里自带同名维度值的列（最可靠）
            for h in tpl_head:
                if not h or h in EXCL:
                    continue
                if any(isinstance(s.get(h), str) and str(s.get(h)).strip() for s in skus):
                    dim2 = h
                    break
            # ② 否则取模板里第一个「不像数值属性的规格列」
            if not dim2:
                for h in tpl_head:
                    if h and h not in EXCL and h not in NUMERIC_ATTRS:
                        dim2 = h
                        break
    # ★ 单层类目：模板里的「尺寸（长×宽）」/「厚度」等列 = **每个 SKU 自己的属性列**，
    #   要把它们作为普通列带进 tb 表（否则下游写官方模板时这些值会整列丢失）
    props_cols = []
    if single_dim and tpl_head and skus:
        for k in skus[0].keys():
            if k in EXCL or k in ("color", "style", "price", "stock", "code", "spec", "src", "barcode"):
                continue
            if k in tpl_head:
                props_cols.append(k)
        if props_cols:
            print("   SKU 每个规格自己的属性列 =「%s」" % "、".join(props_cols))
    # ★ 单层类目（dims 只有一项）：**绝不**补默认「款式」——否则会和属性列「款式」撞名，
    #   下游 tb_build 会把属性值当规格 → 对账出现「浅灰-平放式」这种错 key（实测 2026-11-16）
    if not dim2 and not single_dim:
        dim2 = "款式"
    if dim2:
        print("   SKU 第二个规格列 =「%s」" % dim2)

    # 必填标记：来自 profile（有就给）
    required = set(prof.get("必填属性") or [])

    attr_cols = list(attrs.keys())
    # 单层类目：把「每个 SKU 自己的属性列」插在 颜色分类 之后（价格/数量/编码之前）
    sku_cols = ["颜色分类"] + ([dim2] if dim2 else []) + list(props_cols) + ["价格", "数量", "商家编码", "规格图片文件名"]
    header = ["宝贝标题"] + attr_cols + sku_cols
    meta_json = {"宝贝标题": {"key": "title", "required": True}}
    for c in attr_cols:
        meta_json[c] = {"key": c, "required": (c in required)}
    meta_json["颜色分类"] = {"key": "颜色分类", "parentKey": "sku", "required": True}
    if dim2:
        meta_json[dim2] = {"key": dim2, "parentKey": "sku", "required": False}
    # parentKey 用 skuProp：下游 tb_build 只把 parentKey=sku 当「规格维度」，这些当行内属性
    for c in props_cols:
        meta_json[c] = {"key": c, "parentKey": "skuProp", "required": False}
    for c in ("价格", "数量", "商家编码", "规格图片文件名"):
        meta_json[c] = {"key": f"skuParam_{c}", "parentKey": "sku", "required": False}

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "淘宝"
    cat_src = f"淘宝 | 素材包（自动生成）| {prof.get('catText') or L.get('cat') or ''} | cateId={prof.get('catId') or L.get('catid') or ''}"
    ws.cell(1, 1).value = cat_src            # R1 类目来源（tb_build 用它写 category_source）
    for i, h in enumerate(header, 1):
        ws.cell(2, i).value = h              # R2 表头
        ws.cell(2, i).font = Font(bold=True)
        ws.cell(2, i).fill = HEAD_FILL
    for i, h in enumerate(header, 1):
        ws.cell(4, i).value = json.dumps(meta_json.get(h, {"key": h}), ensure_ascii=False)
    # 第 5 行 = 属性值 + 第一行 SKU；之后每行一个 SKU
    def write_sku_row(r, sku, first=False):
        for i, h in enumerate(header, 1):
            if h == "宝贝标题":
                ws.cell(r, i).value = title if first else None
            elif h in attrs:
                ws.cell(r, i).value = (brand if h == "品牌" else attrs[h]) if first else None
            elif h == "颜色分类":
                ws.cell(r, i).value = sku.get("color")
            elif h == dim2:
                # ★ 第二维的值：优先取 SKU 行里同名字段（如「窗帘尺寸+加工方式」），再退回通用 style
                v = sku.get(dim2)
                if v in (None, ""):
                    v = sku.get("style")
                ws.cell(r, i).value = v
            elif h == "价格":
                ws.cell(r, i).value = sku.get("price")
            elif h == "数量":
                ws.cell(r, i).value = sku.get("stock")
            elif h == "商家编码":
                ws.cell(r, i).value = sku.get("code")
            elif h in props_cols:
                # 单层类目：每个 SKU 自己的属性值（尺寸（长×宽）/厚度 …）
                ws.cell(r, i).value = sku.get(h)
            elif h == "规格图片文件名":
                ws.cell(r, i).value = spec_map.get(sku.get("color")) or (sku.get("spec") if isinstance(sku.get("spec"), str) else None)

    r = 5
    if not skus:
        skus = [{"color": (colors[0] if colors else ""), "style": "", "price": L.get("listPrice") or 0, "stock": 0, "code": ""}]
    for idx, s in enumerate(skus):
        write_sku_row(r + idx, s, first=(idx == 0))

    for i, h in enumerate(header, 1):
        width = 46 if h == "宝贝标题" else (26 if h in ("颜色分类", dim2) else 16)
        ws.column_dimensions[openpyxl.utils.get_column_letter(i)].width = width
    ws.freeze_panes = "A5"

    # 填写说明 sheet
    ws2 = wb.create_sheet("填写说明")
    for line in [
        ["淘宝素材包（自动生成）", ""],
        ["", ""],
        ["R1", "类目来源（tb_build 写进 product.json 的 category_source）"],
        ["R2", "表头：宝贝标题 / 类目属性（R4 的 key 就是发布页属性名）/ SKU 列"],
        ["R4", "每列的 JSON 元数据（key、required、parentKey=sku）——tb_build 靠它识别哪些是属性、哪些是 SKU 列"],
        ["R5+", "第 5 行是「属性值 + 第一行 SKU」，之后每行一个 SKU"],
        ["", ""],
        ["图片目录", "淘宝/<商品号>/1比1主图 · 3比4主图 · 宝贝详情 · 规格图片 · 白底图 · 商品视频"],
        ["跑法", "tb_ego_run_listing({ pack: '<素材包目录>', catid, cat })；插件会先跑 tb_build.py + tb_prep_assets.js"],
    ]:
        ws2.append(line)
    ws2.column_dimensions["A"].width = 14
    ws2.column_dimensions["B"].width = 110

    xlsx = os.path.join(pack, "商品信息.xlsx")
    wb.save(xlsx)

    # ── 官方 SKU 模板：一起放进素材包（SKU 导入必填，用户/agent 照着它填） ──
    tpl_out = None
    tpl_src = a.template
    if not tpl_src:
        try:
            import glob
            catid = str(prof.get("catId") or L.get("catid") or "")
            cands = sorted(glob.glob(os.path.join(os.path.expanduser("~"), ".dsh", "taobao-ego", "output", "_downloads", "SKU模板_*.xlsx")))
            pick = [c for c in cands if catid and ("SKU模板_" + catid + "_") in os.path.basename(c)]
            tpl_src = pick[-1] if pick else ""
        except Exception:
            tpl_src = ""
    if tpl_src and os.path.exists(tpl_src):
        tpl_dir = os.path.join(pack, "SKU模板")
        os.makedirs(tpl_dir, exist_ok=True)
        tpl_out = os.path.join(tpl_dir, os.path.basename(tpl_src))
        shutil.copyfile(tpl_src, tpl_out)

    print(json.dumps({
        "ok": True,
        "packDir": pack,
        "xlsx": xlsx,
        "productDir": sub,
        "images": {"1比1": n_main, "3比4": n_34, "详情": n_detail, "白底": n_white, "视频": n_video, "规格图": len(spec_map) if spec_map else "目录拷贝"},
        "columns": header,
        "skuRows": len(skus),
        "skuTemplatePrefilled": (sku_tpl_ok if a.audience == "user" else None),
        "skuTemplate": tpl_out,
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
