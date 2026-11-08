#!/usr/bin/env python3
"""Title card (intro frame / YouTube thumbnail) in the Eternal Shadows site look.

    python tools/video/intro.py OUT.png --title "Ula'tek, the Serpent Goddess" --sub "Mythic · taktika"
        [--backdrop FRAME.png]   screenshot used as a darkened, blurred background (optional)
        [--logo web/assets/images/apple-touch-icon.png]
        [--note "The Venomous Abyss · kill 8. 11. 2026"]
"""
import argparse

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont

W, H = 1920, 1080
ACCENT = (63, 214, 138)
INK = (228, 234, 230)
MUTED = (139, 150, 143)


def font(name, size):
    for cand in (name, "C:/Windows/Fonts/" + name):
        try:
            return ImageFont.truetype(cand, size)
        except OSError:
            pass
    return ImageFont.load_default()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("out")
    ap.add_argument("--title", required=True)
    ap.add_argument("--sub", default="Mythic · taktika")
    ap.add_argument("--guild", default="ETERNAL SHADOWS")
    ap.add_argument("--note", default="")
    ap.add_argument("--backdrop")
    ap.add_argument("--logo", default="web/assets/images/apple-touch-icon.png")
    a = ap.parse_args()

    img = Image.new("RGB", (W, H), (10, 12, 11))
    if a.backdrop:
        bg = Image.open(a.backdrop).convert("RGB").resize((W, H)).filter(ImageFilter.GaussianBlur(14))
        bg = Image.blend(bg, Image.new("RGB", (W, H), (10, 12, 11)), 0.72)
        img.paste(bg)
    # vignette + green glow bottom-left
    glow = Image.new("RGB", (W, H), (0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.ellipse([-500, 300, 1100, 1500], fill=(16, 54, 34))
    glow = glow.filter(ImageFilter.GaussianBlur(180))
    img = Image.blend(img, Image.new("RGB", (W, H), (0, 0, 0)), 0.25)
    img = ImageChops.add(img, glow)

    d = ImageDraw.Draw(img)
    # accent frame line
    d.rectangle([80, 80, W - 80, H - 80], outline=(36, 42, 39), width=2)
    d.rectangle([80, 80, 86, H - 80], fill=ACCENT)

    # logo
    x = 160
    try:
        logo = Image.open(a.logo).convert("RGBA").resize((150, 150), Image.LANCZOS)
        img.paste(logo, (x, 150), logo)
        d.text((x + 180, 178), a.guild, font=font("seguibl.ttf", 56), fill=INK)
        d.text((x + 182, 246), "raid taktiky", font=font("segoeui.ttf", 30), fill=MUTED)
    except OSError:
        d.text((x, 170), a.guild, font=font("seguibl.ttf", 56), fill=INK)

    # title block
    f_sub = font("segoeuib.ttf", 48)
    f_title = font("seguibl.ttf", 108)
    y = 470
    d.text((x, y), a.sub.upper(), font=f_sub, fill=ACCENT)
    y += 80
    # shrink title to fit
    size = 108
    while d.textlength(a.title, font=font("seguibl.ttf", size)) > W - 2 * x and size > 56:
        size -= 4
    f_title = font("seguibl.ttf", size)
    d.text((x + 4, y + 4), a.title, font=f_title, fill=(0, 0, 0))
    d.text((x, y), a.title, font=f_title, fill=(255, 255, 255))
    y += size + 50
    d.rectangle([x, y, x + 220, y + 6], fill=ACCENT)
    y += 40
    d.text((x, y), "Video s popisky mechanik – u každé důležité mechaniky se video zastaví a šipka ukáže, co dělat.",
           font=font("segoeui.ttf", 34), fill=INK)
    if a.note:
        d.text((x, H - 150), a.note, font=font("segoeui.ttf", 28), fill=MUTED)

    img.save(a.out)
    print("saved", a.out)


if __name__ == "__main__":
    main()
