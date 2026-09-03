#!/usr/bin/env python3
"""
attendance.py — weekly raid attendance report: Google Sheet -> Discord webhook.

Reads the absence matrix (players x date columns; "X" = unavailable,
"pozdě" = arriving late, empty = coming) from a Google Sheet,
picks the raid days (Wed/Thu/Sun by default) of the upcoming Monday-Sunday
week and posts a summary to Discord.

Configuration is via environment variables (GitHub Actions secrets/vars):

  DISCORD_WEBHOOK_URL   required unless --dry-run
  SHEET_ID              Google Sheet id (default: the guild wishlist sheet)
  SHEET_GID             tab gid of the absence matrix (default 521369072)
  RAID_WEEKDAYS         comma list, default "wed,thu,sun" (en or cs names)
  TIMEZONE              default "Europe/Prague"
  WEEK_OFFSET           0 = the week starting on the NEXT Monday (default),
                        -1 = the current week, 1 = the week after next
  SHOW_NOT_CONFIRMED    "true"/"false" (default false) — an empty cell means
                        the player is coming; set true to also list players
                        with no entry on any raid day
  DISCORD_MENTIONS      optional JSON {"Hase": "123456789012345678", ...}
                        (sheet name -> Discord user id); mentions.json next
                        to this script is read as a fallback
  MENTION_SECTIONS      which sections mention people: "unavailable,late"
                        (default), "none", or add "unconfirmed"
  REPORT_TITLE          default "RAID AVAILABILITY"

Command line (for testing):
  python attendance.py --dry-run            print the message, send nothing
  python attendance.py --date 2026-09-06    pretend today is that date
  python attendance.py --csv file.csv       parse a local CSV instead of the sheet
"""

import argparse
import csv
import datetime as dt
import io
import json
import os
import re
import sys
import unicodedata
import urllib.error
import urllib.request
from zoneinfo import ZoneInfo

DEFAULT_SHEET_ID = "1CUG3oyufoNs5CrY68WMJVVHLJz-52uFQMuOtv5q3ECI"
DEFAULT_SHEET_GID = "521369072"
DEFAULT_TIMEZONE = "Europe/Prague"
DEFAULT_RAID_WEEKDAYS = "wed,thu,sun"
DISCORD_LIMIT = 2000  # characters per webhook message

WEEKDAY_NAMES = {  # accepted spellings -> Monday=0 .. Sunday=6
    "mon": 0, "monday": 0, "po": 0, "pondeli": 0,
    "tue": 1, "tuesday": 1, "ut": 1, "utery": 1,
    "wed": 2, "wednesday": 2, "st": 2, "streda": 2,
    "thu": 3, "thursday": 3, "ct": 3, "ctvrtek": 3,
    "fri": 4, "friday": 4, "pa": 4, "patek": 4,
    "sat": 5, "saturday": 5, "so": 5, "sobota": 5,
    "sun": 6, "sunday": 6, "ne": 6, "nedele": 6,
}
WEEKDAY_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
               "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

UNAVAILABLE, LATE, UNKNOWN = "unavailable", "late", "unknown"


class ReportError(Exception):
    """Something that makes the report untrustworthy — reported to Discord."""


# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------

def norm(text):
    """Lowercase, strip diacritics and surrounding whitespace."""
    s = unicodedata.normalize("NFKD", text or "")
    return "".join(c for c in s if not unicodedata.combining(c)).strip().lower()


def env(name, default=None):
    v = os.environ.get(name)
    return v if v not in (None, "") else default


def env_bool(name, default):
    v = env(name)
    if v is None:
        return default
    return norm(v) in ("1", "true", "yes", "y", "on", "ano")


def day_label(d):
    """'Wed 9.9.' — matches the sheet's own d.M. style."""
    return f"{WEEKDAY_SHORT[d.weekday()]} {d.day}.{d.month}."


def week_label(monday, sunday):
    """'7–13 Sep' or '28 Sep – 4 Oct'."""
    if monday.month == sunday.month:
        return f"{monday.day}–{sunday.day} {MONTH_SHORT[monday.month - 1]}"
    return (f"{monday.day} {MONTH_SHORT[monday.month - 1]} – "
            f"{sunday.day} {MONTH_SHORT[sunday.month - 1]}")


# --------------------------------------------------------------------------
# dates
# --------------------------------------------------------------------------

def parse_weekdays(spec):
    days = []
    for tok in re.split(r"[,\s;]+", spec.strip()):
        if not tok:
            continue
        key = norm(tok)
        if key not in WEEKDAY_NAMES:
            raise ReportError(f"RAID_WEEKDAYS: unknown weekday {tok!r}")
        if WEEKDAY_NAMES[key] not in days:
            days.append(WEEKDAY_NAMES[key])
    if not days:
        raise ReportError("RAID_WEEKDAYS is empty")
    return sorted(days)


def target_week(today, offset=0):
    """(monday, sunday) of the week starting on the next Monday after
    `today` (a Sunday run therefore reports on the week starting tomorrow;
    a Monday run reports on the FOLLOWING week). offset shifts by weeks."""
    days_ahead = (7 - today.weekday()) % 7 or 7
    monday = today + dt.timedelta(days=days_ahead + 7 * offset)
    return monday, monday + dt.timedelta(days=6)


DATE_PATTERNS = [
    # 9.9., 9. 9., 09.09.2026, 9.9.26
    re.compile(r"(?<!\d)(\d{1,2})\.\s*(\d{1,2})\.?\s*(\d{4}|\d{2})?(?!\d)"),
    # 2026-09-09
    re.compile(r"(?<!\d)(\d{4})-(\d{1,2})-(\d{1,2})(?!\d)"),
    # 9/9/2026, 09/09/26  (day/month — Czech sheet)
    re.compile(r"(?<!\d)(\d{1,2})/(\d{1,2})/(\d{4}|\d{2})(?!\d)"),
]


def parse_header_date(text, reference):
    """Date in a column header, or None. Headers without a year get the
    year that puts the date closest to `reference` (handles Dec/Jan)."""
    text = (text or "").strip()
    if not text:
        return None
    m = DATE_PATTERNS[1].search(text)
    if m:
        y, mo, d = (int(x) for x in m.groups())
        return _safe_date(y, mo, d)
    m = DATE_PATTERNS[0].search(text) or DATE_PATTERNS[2].search(text)
    if not m:
        return None
    d, mo, y = m.group(1), m.group(2), m.group(3)
    d, mo = int(d), int(mo)
    if y:
        y = int(y)
        if y < 100:
            y += 2000
        return _safe_date(y, mo, d)
    candidates = [_safe_date(reference.year + k, mo, d) for k in (-1, 0, 1)]
    candidates = [c for c in candidates if c]
    if not candidates:
        return None
    return min(candidates, key=lambda c: abs((c - reference).days))


def _safe_date(y, mo, d):
    try:
        return dt.date(y, mo, d)
    except ValueError:
        return None


# --------------------------------------------------------------------------
# sheet
# --------------------------------------------------------------------------

def fetch_csv(sheet_id, gid):
    url = (f"https://docs.google.com/spreadsheets/d/{sheet_id}/export"
           f"?format=csv&gid={gid}")
    req = urllib.request.Request(url, headers={"User-Agent": "raid-attendance/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            body = r.read()
            ctype = r.headers.get("Content-Type", "")
    except urllib.error.HTTPError as e:
        raise ReportError(f"Google Sheets returned HTTP {e.code} for gid {gid} — "
                          "is the sheet shared as 'Anyone with the link can view'?")
    except urllib.error.URLError as e:
        raise ReportError(f"Cannot reach Google Sheets: {e.reason}")
    if "text/html" in ctype:
        raise ReportError("Google Sheets answered with a login page — the sheet "
                          "is not readable without signing in. Share it as "
                          "'Anyone with the link can view'.")
    return body.decode("utf-8-sig", "replace")


def parse_matrix(csv_text, reference):
    """-> (header_dates: {col_index: date}, players: [(name, [cells])], warnings)

    Column 0 holds player names; every other header cell that parses as a
    date becomes a date column. Duplicate player names are merged (a marker
    in either row counts)."""
    rows = list(csv.reader(io.StringIO(csv_text)))
    rows = [r for r in rows if any(c.strip() for c in r)]
    if len(rows) < 2:
        raise ReportError("The sheet tab is empty (no header + player rows).")
    header = rows[0]
    dates = {}
    warnings = []
    for i, cell in enumerate(header[1:], start=1):
        d = parse_header_date(cell, reference)
        if d:
            if d in dates.values():
                warnings.append(f"duplicate date column {cell.strip()!r}")
            dates[i] = d
        elif cell.strip():
            warnings.append(f"header {cell.strip()!r} is not a date — column ignored")
    if not dates:
        raise ReportError("No date columns found in the header row: "
                          + ", ".join(repr(c) for c in header[:12]))

    players, index = [], {}
    for r in rows[1:]:
        name = (r[0] if r else "").strip()
        if not name:
            continue
        key = norm(name)
        cells = [(r[i].strip() if i < len(r) else "") for i in range(len(header))]
        if key in index:
            warnings.append(f"duplicate player row {name!r} — merged")
            merged = players[index[key]][1]
            for i, v in enumerate(cells):
                if v and not merged[i]:
                    merged[i] = v
            continue
        index[key] = len(players)
        players.append((name, cells))
    if not players:
        raise ReportError("No player rows found under the header.")
    return dates, players, warnings


def classify(value):
    """Cell text -> UNAVAILABLE / LATE / None (empty) / UNKNOWN."""
    v = norm(value)
    if not v:
        return None
    if v in ("x", "xx", "n", "ne", "no", "nepřijdu", "neprijdu", "absent", "-", "❌"):
        return UNAVAILABLE
    if "pozd" in v or "late" in v or "later" in v or "⏰" in v:
        return LATE
    if v.startswith("x"):
        return UNAVAILABLE
    return UNKNOWN


# --------------------------------------------------------------------------
# report
# --------------------------------------------------------------------------

def build_report(dates, players, raid_dates, warnings):
    """-> dict with lists for the message."""
    col_of = {d: i for i, d in dates.items()}
    missing_days = [d for d in raid_dates if d not in col_of]
    present_days = [d for d in raid_dates if d in col_of]

    unavailable, late, unconfirmed, unknown = [], [], [], []
    for name, cells in players:
        days_x, days_late = [], []
        for d in present_days:
            status = classify(cells[col_of[d]])
            if status == UNAVAILABLE:
                days_x.append(d)
            elif status == LATE:
                days_late.append(d)
            elif status == UNKNOWN:
                unknown.append(f"{name} — {day_label(d)}: {cells[col_of[d]]!r}")
        if days_x:
            unavailable.append((name, days_x))
        if days_late:
            late.append((name, days_late))
        if not days_x and not days_late:
            unconfirmed.append(name)
    return {
        "unavailable": unavailable,
        "late": late,
        "unconfirmed": unconfirmed,
        "unknown": unknown,
        "missing_days": missing_days,
        "present_days": present_days,
        "warnings": list(warnings),
    }


def load_mentions():
    raw = env("DISCORD_MENTIONS")
    if not raw:
        path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "mentions.json")
        if os.path.exists(path):
            with open(path, encoding="utf-8-sig") as f:
                raw = f.read()
    if not raw:
        return {}
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as e:
        raise ReportError(f"DISCORD_MENTIONS is not valid JSON: {e}")
    return {norm(k): str(v).strip() for k, v in data.items()
            if str(v).strip() and not str(k).startswith("_")}


def format_message(report, monday, sunday, raid_dates, mentions, mention_sections,
                   show_unconfirmed, title):
    def who(name, section):
        uid = mentions.get(norm(name))
        if uid and section in mention_sections:
            return f"{name} <@{uid}>"
        return name

    def days(ds):
        return " / ".join(day_label(d) for d in ds)

    lines = [f"📋 **{title}**", "━━━━━━━━━━━━━━━━━━━━", "",
             f"📅 **NEXT WEEK · {week_label(monday, sunday).upper()}**", ""]

    lines.append("❌ **UNAVAILABLE**")
    if report["unavailable"]:
        lines += [f"• {who(n, 'unavailable')} — {days(ds)}" for n, ds in report["unavailable"]]
    else:
        lines.append("• nobody 🎉")
    lines.append("")

    lines.append("⏰ **ARRIVING LATE**")
    if report["late"]:
        lines += [f"• {who(n, 'late')} — {days(ds)}" for n, ds in report["late"]]
    else:
        lines.append("• nobody")
    lines.append("")

    if show_unconfirmed:
        lines.append("⚠️ **NOT CONFIRMED** (no entry for any raid day)")
        if report["unconfirmed"]:
            lines += [f"• {who(n, 'unconfirmed')}" for n in report["unconfirmed"]]
        else:
            lines.append("• everyone has responded")
        lines.append("")

    lines.append("👥 **RAID DAYS**")
    for d in raid_dates:
        tag = "  ⚠️ no column in the sheet yet" if d in report["missing_days"] else ""
        lines.append(f"• {day_label(d)}{tag}")

    notes = list(report["warnings"])
    if report["unknown"]:
        notes += [f"unrecognized value: {u}" for u in report["unknown"]]
    if notes:
        lines += ["", "🔎 **CHECK THE SHEET**"] + [f"• {n}" for n in notes[:15]]
        if len(notes) > 15:
            lines.append(f"• … and {len(notes) - 15} more")
    return "\n".join(lines)


# --------------------------------------------------------------------------
# discord
# --------------------------------------------------------------------------

def split_message(text, limit=DISCORD_LIMIT):
    """Split on line boundaries so no chunk exceeds Discord's limit."""
    chunks, cur = [], ""
    for line in text.split("\n"):
        if len(line) > limit:
            line = line[:limit - 1] + "…"
        if len(cur) + len(line) + 1 > limit:
            chunks.append(cur)
            cur = line
        else:
            cur = line if not cur else f"{cur}\n{line}"
    if cur:
        chunks.append(cur)
    return chunks


def send_discord(webhook, text, mention_ids=()):
    for chunk in split_message(text):
        payload = {
            "content": chunk,
            "allowed_mentions": {"users": sorted(set(mention_ids))[:100]},
        }
        req = urllib.request.Request(
            webhook, data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json",
                     "User-Agent": "raid-attendance/1.0"}, method="POST")
        try:
            urllib.request.urlopen(req, timeout=30).read()
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", "replace")[:300]
            raise ReportError(f"Discord webhook rejected the message: HTTP {e.code} {body}")


# --------------------------------------------------------------------------
# main
# --------------------------------------------------------------------------

def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dry-run", action="store_true", help="print, do not send")
    ap.add_argument("--date", help="pretend today is YYYY-MM-DD (testing)")
    ap.add_argument("--csv", help="read this CSV file instead of the Google Sheet")
    ap.add_argument("--week-offset", type=int, default=None,
                    help="override WEEK_OFFSET (0 = next week, -1 = this week)")
    args = ap.parse_args(argv)

    webhook = env("DISCORD_WEBHOOK_URL")
    tz = ZoneInfo(env("TIMEZONE", DEFAULT_TIMEZONE))
    today = (dt.date.fromisoformat(args.date) if args.date
             else dt.datetime.now(tz).date())
    offset = args.week_offset if args.week_offset is not None else int(env("WEEK_OFFSET", "0"))
    if not webhook and not args.dry_run:
        sys.exit("DISCORD_WEBHOOK_URL is not set (use --dry-run to test without it).")

    try:
        weekdays = parse_weekdays(env("RAID_WEEKDAYS", DEFAULT_RAID_WEEKDAYS))
        monday, sunday = target_week(today, offset)
        raid_dates = [monday + dt.timedelta(days=w) for w in weekdays]
        print(f"today={today} ({WEEKDAY_SHORT[today.weekday()]}), reporting week "
              f"{monday}..{sunday}, raid days {[str(d) for d in raid_dates]}")

        if args.csv:
            with open(args.csv, encoding="utf-8-sig") as f:
                csv_text = f.read()
        else:
            csv_text = fetch_csv(env("SHEET_ID", DEFAULT_SHEET_ID),
                                 env("SHEET_GID", DEFAULT_SHEET_GID))
        dates, players, warnings = parse_matrix(csv_text, reference=monday)
        print(f"{len(players)} players, {len(dates)} date columns "
              f"({min(dates.values())} .. {max(dates.values())})")

        report = build_report(dates, players, raid_dates, warnings)
        if len(report["missing_days"]) == len(raid_dates):
            report["warnings"].append(
                "none of the raid days has a column in the sheet — nobody could "
                "have reported anything for this week yet")

        mentions = load_mentions()
        sections = {s.strip() for s in norm(env("MENTION_SECTIONS", "unavailable,late")).split(",")}
        if "none" in sections:
            sections = set()
        message = format_message(
            report, monday, sunday, raid_dates, mentions, sections,
            show_unconfirmed=env_bool("SHOW_NOT_CONFIRMED", False),
            title=env("REPORT_TITLE", "RAID AVAILABILITY"))
        mention_ids = [mentions[norm(n)] for n, _ in report["unavailable"] + report["late"]
                       if norm(n) in mentions]
        mention_ids += [mentions[norm(n)] for n in report["unconfirmed"] if norm(n) in mentions]

        print("\n" + message + "\n")
        if args.dry_run:
            print("(dry run — nothing sent)")
            return 0
        send_discord(webhook, message, mention_ids)
        print("Sent to Discord.")
        return 0

    except ReportError as e:
        err = f"🚨 **RAID ATTENDANCE BOT FAILED**\n{e}\n(no report was generated — check the sheet / workflow log)"
        print(err, file=sys.stderr)
        if webhook and not args.dry_run:
            try:
                send_discord(webhook, err)
            except ReportError as e2:
                print(f"also failed to report the error to Discord: {e2}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    sys.exit(main())
