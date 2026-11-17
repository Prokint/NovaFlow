#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
把 img/1x1 里的主图**中心裁**成 3:4，输出到 img/3x4/（只裁不拉伸，比例严格 3:4）。

为什么需要：素材包常常只有 1:1 主图；淘宝 3:4 主图区要求宽高比 3:4（推荐 1440x1920 以上）。
中心裁比「加白边」更稳（不会出现白边被判为图片瑕疵）。

用法：
  python scripts/crop_3x4.py --src <img/1x1> --dst <img/3x4> [--limit 5] [--quality 92]
"""
import argparse
import os
import sys

from PIL import Image

EXTS = (".jpg", ".jpeg", ".png", ".webp")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True)
    ap.add_argument("--dst", required=True)
    ap.add_argument("--limit", type=int, default=5, help="最多生成几张（淘宝 1:1/3:4 主图上限都是 5）")
    ap.add_argument("--quality", type=int, default=92)
    args = ap.parse_args()

    if not os.path.isdir(args.src):
        print("★ 源目录不存在：" + args.src)
        return 2
    files = sorted(f for f in os.listdir(args.src) if f.lower().endswith(EXTS))
    if not files:
        print("★ 源目录里没有图片：" + args.src)
        return 2

    os.makedirs(args.dst, exist_ok=True)
    done = 0
    for name in files:
        if done >= args.limit:
            break
        im = Image.open(os.path.join(args.src, name))
        im = im.convert("RGB")
        w, h = im.size
        target_w = max(1, round(h * 3 / 4))
        if target_w >= w:
            # 图太窄：先按高度补宽（极少见），仍保持 3:4
            new_w = target_w
            canvas = Image.new("RGB", (new_w, h), (255, 255, 255))
            canvas.paste(im, ((new_w - w) // 2, 0))
            out = canvas
        else:
            left = (w - target_w) // 2
            out = im.crop((left, 0, left + target_w, h))
        stem = os.path.splitext(name)[0]
        dst = os.path.join(args.dst, stem + ".jpg")
        out.save(dst, "JPEG", quality=args.quality, optimize=True)
        print("  裁 %s  %sx%s → %sx%s" % (name, w, h, out.size[0], out.size[1]))
        done += 1

    print("✓ 生成 %d 张 3:4 主图 → %s" % (done, args.dst))
    return 0


if __name__ == "__main__":
    sys.exit(main())
