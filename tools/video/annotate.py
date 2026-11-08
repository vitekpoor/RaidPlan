#!/usr/bin/env python3
"""Annotate a raid video for tactics: callout boxes with text, arrows, highlight
circles and freeze-frame pauses, rendered with ffmpeg.

    python tools/video/annotate.py INPUT.mp4 CALLOUTS.json OUTPUT.mp4
        [--preview 4:50 5:10]     render only this source-time window (quick check)
        [--encoder nvenc|x264]    default nvenc (falls back to x264 when unavailable)
        [--audio N]               which audio track of the recording (0 = first), default 0
        [--keep-png DIR]          keep the generated overlay PNGs
        [--dry-run]               print the ffmpeg command only

CALLOUTS.json
{
  "font": "C:/Windows/Fonts/arialbd.ttf",        optional, title font
  "font_text": "C:/Windows/Fonts/arial.ttf",     optional, body font
  "style": {"color": "#ffd23c", "title_size": 40, "text_size": 30},   optional overrides
  "callouts": [
    {
      "at": "4:57",            source time (m:ss, m:ss.s or seconds) when the callout appears
      "pause": 4,              seconds the video freezes on that frame (0 / omitted = no pause)
      "show": 5,               seconds the callout stays visible after the pause (default 5)
      "title": "Venomous Heart",
      "text": "Přerušit cast!\nKick: Hase → Zireael",
      "arrow": [1380, 670],    point the arrow points to (optional)
      "circle": [1380, 670, 70],   highlight ring x, y, radius (optional)
      "box": [700, 150],       top-left of the box; omit = auto next to the arrow target;
                               or "top" / "bottom" / "center" for a centred banner
      "width": 520,            box width (default 560)
      "color": "#ff5050"       per-callout accent colour (optional)
    }
  ]
}
Times are source-video times; the script shifts everything after each pause itself.
"""
import argparse
import json
import math
import os
import shutil
import subprocess
import sys
import tempfile

from PIL import Image, ImageDraw, ImageFont

FPS = 30


def find_ffmpeg():
    for name in ("ffmpeg", "ffmpeg.exe"):
        p = shutil.which(name)
        if p:
            return p
    base = os.path.expandvars(r"%LOCALAPPDATA%\Microsoft\WinGet\Packages")
    if os.path.isdir(base):
        for d in os.listdir(base):
            if d.startswith("Gyan.FFmpeg"):
                for sub in os.listdir(os.path.join(base, d)):
                    cand = os.path.join(base, d, sub, "bin", "ffmpeg.exe")
                    if os.path.isfile(cand):
                        return cand
    sys.exit("ffmpeg not found (winget install Gyan.FFmpeg)")


def parse_time(v):
    if isinstance(v, (int, float)):
        return float(v)
    sec = 0.0
    for p in str(v).strip().split(":"):
        sec = sec * 60 + float(p.replace(",", "."))
    return sec


def hex_rgb(h, a=255):
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4)) + (a,)


def load_font(path, size):
    try:
        return ImageFont.truetype(path, size)
    except OSError:
        return ImageFont.load_default()


def wrap(draw, text, font, max_w):
    lines = []
    for para in text.split("\n"):
        cur = ""
        for w in para.split(" "):
            cand = (cur + " " + w).strip()
            if draw.textlength(cand, font=font) <= max_w or not cur:
                cur = cand
            else:
                lines.append(cur)
                cur = w
        lines.append(cur)
    return lines


def draw_arrow(draw, p0, p1, color, width=8, head=34):
    dx, dy = p1[0] - p0[0], p1[1] - p0[1]
    length = math.hypot(dx, dy) or 1
    ux, uy = dx / length, dy / length
    shaft_end = (p1[0] - ux * head * 0.6, p1[1] - uy * head * 0.6)
    draw.line([p0, shaft_end], fill=(0, 0, 0, 220), width=width + 6)   # dark outline
    draw.line([p0, shaft_end], fill=color, width=width)
    base = (p1[0] - ux * head, p1[1] - uy * head)
    px, py = -uy, ux
    hw = head * 0.6
    tri = [p1, (base[0] + px * hw, base[1] + py * hw), (base[0] - px * hw, base[1] - py * hw)]
    draw.polygon(tri, fill=color, outline=(0, 0, 0, 220), width=3)


def render_overlay(c, W, H, fonts, style):
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    color = hex_rgb(c.get("color", style["color"]))
    pad = style["pad"]
    width = int(c.get("width", style["width"]))
    title = c.get("title", "")
    text = c.get("text", "")
    f_title, f_text = fonts["title"], fonts["text"]

    inner = width - 2 * pad
    lines_t = wrap(d, title, f_title, inner) if title else []
    lines_b = wrap(d, text, f_text, inner) if text else []
    lh_t = int(style["title_size"] * 1.25)
    lh_b = int(style["text_size"] * 1.3)
    h = 2 * pad + lh_t * len(lines_t) + lh_b * len(lines_b) + (10 if lines_t and lines_b else 0)

    circle = c.get("circle")
    target = c.get("arrow")
    if target is None and circle:
        target = circle[:2]

    box = c.get("box")
    margin = 40
    if isinstance(box, str):
        x = (W - width) // 2
        y = {"top": 60, "bottom": H - h - 60}.get(box, (H - h) // 2)
    elif box:
        x, y = int(box[0]), int(box[1])
    elif target:
        tx, ty = target
        gap = 150
        cands = [(tx - width - gap, ty - h - gap // 2), (tx + gap, ty - h - gap // 2),
                 (tx - width - gap, ty + gap // 2), (tx + gap, ty + gap // 2),
                 (tx - width // 2, ty - h - gap), (tx - width // 2, ty + gap)]
        x, y = next(((cx, cy) for cx, cy in cands
                     if margin <= cx <= W - width - margin and margin <= cy <= H - h - margin),
                    cands[0])
    else:
        x, y = margin, margin
    x = max(margin, min(W - width - margin, x))
    y = max(margin, min(H - h - margin, y))

    if circle:
        cx, cy, r = circle
        d.ellipse([cx - r - 3, cy - r - 3, cx + r + 3, cy + r + 3], outline=(0, 0, 0, 200), width=style["ring"] + 6)
        d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=color, width=style["ring"])
    if c.get("arrow") is not None:
        tx, ty = target
        anchors = [(x, y + h / 2), (x + width, y + h / 2), (x + width / 2, y), (x + width / 2, y + h),
                   (x, y), (x + width, y), (x, y + h), (x + width, y + h)]
        p0 = min(anchors, key=lambda p: math.hypot(p[0] - tx, p[1] - ty))
        p1 = (tx, ty)
        if circle:  # stop at the ring
            r = circle[2] + 6
            dx, dy = tx - p0[0], ty - p0[1]
            L = math.hypot(dx, dy) or 1
            p1 = (tx - dx / L * r, ty - dy / L * r)
        draw_arrow(d, p0, p1, color, style["arrow"], style["head"])

    d.rounded_rectangle([x - 3, y - 3, x + width + 3, y + h + 3], radius=style["radius"] + 3, fill=(0, 0, 0, 160))
    d.rounded_rectangle([x, y, x + width, y + h], radius=style["radius"],
                        fill=hex_rgb(style["fill"], style["fill_alpha"]), outline=color, width=style["border"])
    cy = y + pad
    for ln in lines_t:
        d.text((x + pad, cy), ln, font=f_title, fill=color)
        cy += lh_t
    if lines_t and lines_b:
        cy += 10
    for ln in lines_b:
        d.text((x + pad, cy), ln, font=f_text, fill=hex_rgb(style["text_color"]))
        cy += lh_b
    return img


def probe(ffmpeg, path):
    ffprobe = os.path.join(os.path.dirname(ffmpeg), "ffprobe" + (".exe" if ffmpeg.endswith(".exe") else ""))
    out = subprocess.check_output([ffprobe, "-v", "error", "-select_streams", "v:0", "-show_entries",
                                   "stream=width,height", "-of", "csv=p=0", path], text=True).strip()
    w, h = out.split(",")[:2]
    return int(w), int(h)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("input")
    ap.add_argument("callouts")
    ap.add_argument("output")
    ap.add_argument("--preview", nargs=2, metavar=("FROM", "TO"))
    ap.add_argument("--encoder", default="nvenc", choices=["nvenc", "x264"])
    ap.add_argument("--audio", type=int, default=0)
    ap.add_argument("--mix", help="mix several audio tracks with gains in dB instead of --audio, e.g. 1:-4,2:+10 "
                                  "(Archon: 0 = game+mic, 1 = game only, 2 = microphone)")
    ap.add_argument("--keep-png")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--list", action="store_true", help="print original-video time -> output time of every callout")
    a = ap.parse_args()

    if a.list:
        with open(a.callouts, encoding="utf-8") as f:
            spec = json.load(f)
        cs = sorted(spec["callouts"], key=lambda c: parse_time(c["at"]))
        off = 0.0
        mm = lambda s: f"{int(s // 60)}:{s % 60:04.1f}"
        print(f"{'#':>2}  {'original':>8}  {'in output':>9}  {'resumes':>8}  pause  title")
        for i, c in enumerate(cs, 1):
            at, p = parse_time(c["at"]), float(c.get("pause", 0) or 0)
            print(f"{i:>2}  {mm(at):>8}  {mm(at + off):>9}  {mm(at + off + p):>8}  {p:>5.1f}  {c.get('title', '')}")
            off += p
        print(f"output is {off:.1f}s longer than the original")
        return

    ffmpeg = find_ffmpeg()
    with open(a.callouts, encoding="utf-8") as f:
        spec = json.load(f)
    W, H = probe(ffmpeg, a.input)

    style = {"color": "#ffd23c", "fill": "#101418", "fill_alpha": 215, "text_color": "#ffffff",
             "title_size": 40, "text_size": 30, "pad": 22, "width": 560, "radius": 14, "border": 4,
             "arrow": 8, "head": 34, "ring": 6}
    style.update(spec.get("style", {}))
    fonts = {"title": load_font(spec.get("font", r"C:\Windows\Fonts\arialbd.ttf"), style["title_size"]),
             "text": load_font(spec.get("font_text", r"C:\Windows\Fonts\arial.ttf"), style["text_size"])}

    t0, t1 = (parse_time(a.preview[0]), parse_time(a.preview[1])) if a.preview else (0.0, None)
    callouts = []
    for c in spec["callouts"]:
        at = parse_time(c["at"]) - t0
        if at < 0 or (t1 is not None and at > t1 - t0):
            continue
        callouts.append(dict(c, _at=at, _pause=float(c.get("pause", 0) or 0), _show=float(c.get("show", 5))))
    callouts.sort(key=lambda c: c["_at"])

    pngdir = a.keep_png or tempfile.mkdtemp(prefix="annotate_")
    os.makedirs(pngdir, exist_ok=True)

    # timeline: output time = source time + all pauses before it
    offset = 0.0
    inserted = 0
    loops, overlays, cuts = [], [], []
    for i, c in enumerate(callouts):
        start_out = c["_at"] + offset
        end_out = start_out + c["_pause"] + c["_show"]
        if c["_pause"] > 0:
            frame = round(c["_at"] * FPS)
            n = round(c["_pause"] * FPS)
            # loop inserts the copies *before* frame `start`, so start = frame + 1 holds `frame`
            loops.append(f"loop=loop={n}:size=1:start={frame + 1 + inserted}")
            inserted += n
            cuts.append((c["_at"], c["_pause"]))
            offset += c["_pause"]
        png = os.path.join(pngdir, f"callout_{i:02d}.png")
        render_overlay(c, W, H, fonts, style).save(png)
        overlays.append((png, start_out, end_out))

    cmd = [ffmpeg, "-hide_banner", "-y", "-stats", "-loglevel", "error"]
    if a.preview:
        cmd += ["-ss", f"{t0:.3f}", "-to", f"{t1:.3f}"]
    cmd += ["-i", a.input]
    for png, _, _ in overlays:
        cmd += ["-i", png]

    fc = ["[0:v]" + ",".join([f"fps={FPS}"] + loops) + "[v0]"]
    cur = "v0"
    for k, (png, s, e) in enumerate(overlays):
        fc.append(f"[{cur}][{k + 1}:v]overlay=0:0:enable='between(t,{s:.3f},{e:.3f})'[v{k + 1}]")
        cur = f"v{k + 1}"
    fc.append(f"[{cur}]format=yuv420p[vout]")

    aidx = f"[0:a:{a.audio}]"
    if a.mix:  # e.g. 1:-4,2:+10 -> game -4 dB, mic +10 dB, limiter against clipping
        parts = [p.split(":") for p in a.mix.split(",")]
        for k, (trk, gain) in enumerate(parts):
            fc.append(f"[0:a:{int(trk)}]volume={float(gain):+.1f}dB[mx{k}]")
        fc.append("".join(f"[mx{k}]" for k in range(len(parts))) +
                  f"amix=inputs={len(parts)}:normalize=0,alimiter=limit=0.95:level=0[amix]")
        aidx = "[amix]"
    if cuts:  # source pieces + silence during the pauses
        fc.append(f"{aidx}asplit={len(cuts) + 1}" + "".join(f"[as{k}]" for k in range(len(cuts) + 1)))
        pieces, prev = [], 0.0
        for k, (t, p) in enumerate(cuts):
            fc.append(f"[as{k}]atrim=start={prev:.3f}:end={t:.3f},asetpts=PTS-STARTPTS[ap{k}]")
            fc.append(f"anullsrc=r=48000:cl=stereo:d={p:.3f}[az{k}]")
            pieces += [f"[ap{k}]", f"[az{k}]"]
            prev = t
        k = len(cuts)
        fc.append(f"[as{k}]atrim=start={prev:.3f},asetpts=PTS-STARTPTS[ap{k}]")
        pieces.append(f"[ap{k}]")
        fc.append("".join(pieces) + f"concat=n={len(pieces)}:v=0:a=1[aout]")
        amap = "[aout]"
    else:
        amap = aidx

    cmd += ["-filter_complex", ";".join(fc), "-map", "[vout]", "-map", amap]
    enc = {"nvenc": ["-c:v", "h264_nvenc", "-preset", "p5", "-tune", "hq", "-rc", "vbr", "-cq", "23",
                     "-b:v", "0", "-maxrate", "40M", "-bufsize", "80M"],
           "x264": ["-c:v", "libx264", "-preset", "veryfast", "-crf", "21"]}
    tail = ["-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", a.output]

    print(f"{len(callouts)} callouts, {len(cuts)} pauses (+{offset:.1f}s), overlays in {pngdir}")
    if a.dry_run:
        print(" ".join(f'"{x}"' if " " in x else x for x in cmd + enc[a.encoder] + tail))
        return
    r = subprocess.run(cmd + enc[a.encoder] + tail)
    if r.returncode and a.encoder == "nvenc":
        print("nvenc failed, retrying with libx264")
        r = subprocess.run(cmd + enc["x264"] + tail)
    if not a.keep_png:
        shutil.rmtree(pngdir, ignore_errors=True)
    sys.exit(r.returncode)


if __name__ == "__main__":
    main()
