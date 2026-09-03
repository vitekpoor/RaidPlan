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
  WEEK_OFFSET           0 = the week of the next upcoming raid day (default):
                        a Tuesday run reports Wed/Thu/Sun of the same week,
                        a Sunday run the coming week. 1 = one week later,
                        -1 = one week earlier.
  SHOW_NOT_CONFIRMED    "true"/"false" (default false) — an empty cell means
                        the player is coming; set true to also list players
                        with no entry on any raid day
  DISCORD_MENTIONS      optional JSON {"Hase": "123456789012345678", ...}
                        (sheet name -> Discord user id); mentions.json next
                        to this script is read as a fallback
  MENTION_SECTIONS      which sections mention people: "unavailable,late"
                        (default), "none", or add "unconfirmed"
  REPORT_TITLE          default "DOCHÁZKA NA RAID" (cs) / "RAID AVAILABILITY" (en)
  REPORT_LANG           "cs" (default) or "en" — language of the Discord message
  LINEUP_GID            tab gid of the "Boss sestavy" lineups (default
                        731845282); "none" disables the lineup lookup.
                        Unavailable/late players get a line listing the boss
                        lineups they are in; a boss whose date falls on a day
                        they miss is flagged with ⚠️.

Command line (for testing):
  python attendance.py --dry-run            print the message, send nothing
  python attendance.py --date 2026-09-06    pretend today is that date
  python attendance.py --csv file.csv       parse a local CSV instead of the sheet
  python attendance.py --lineups-csv f.csv  local CSV for the lineup tab
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
DEFAULT_LINEUP_GID = "731845282"
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
MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
               "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

# Message texts. REPORT_LANG picks the language; Czech is the default.
STRINGS = {
    "cs": {
        "weekdays": ["po", "út", "st", "čt", "pá", "so", "ne"],
        "title": "DOCHÁZKA NA RAID",
        "next_week": "PŘÍŠTÍ TÝDEN",
        "this_week": "TENTO TÝDEN",
        "unavailable": "NEPŘIJDOU",
        "late": "PŘIJDOU POZDĚ",
        "unconfirmed": "NEPOTVRZENO",
        "unconfirmed_note": "(žádný záznam na raidové dny)",
        "nobody_party": "• nikdo 🎉",
        "nobody": "• nikdo",
        "everyone": "• všichni odpověděli",
        "raid_days": "RAIDOVÉ DNY",
        "no_column": "  ⚠️ sloupec v tabulce ještě neexistuje",
        "in_lineups": "  ↳ v sestavě: {bosses}",
        "check_sheet": "ZKONTROLUJ TABULKU",
        "unknown_value": "nerozpoznaná hodnota: {what}",
        "and_more": "• … a dalších {n}",
        "dup_date": "duplicitní sloupec s datem {cell!r}",
        "not_a_date": "hlavička {cell!r} není datum — sloupec ignorován",
        "dup_player": "duplicitní řádek hráče {name!r} — sloučeno",
        "lineup_no_rows": "sestavy: nenalezeny očíslované řádky hráčů",
        "lineup_bad_date": "sestava {boss}: nečitelné datum {date!r}",
        "lineups_failed": "sestavy bossů nezkontrolovány: {err}",
        "no_raid_columns": "žádný z raidových dnů nemá v tabulce sloupec — "
                           "nikdo zatím nemohl nic zadat",
        "failed": "🚨 **BOT DOCHÁZKY SELHAL**\n{err}\n"
                  "(report nebyl vytvořen — zkontroluj tabulku / log workflow)",
    },
    "en": {
        "weekdays": ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
        "title": "RAID AVAILABILITY",
        "next_week": "NEXT WEEK",
        "this_week": "THIS WEEK",
        "unavailable": "UNAVAILABLE",
        "late": "ARRIVING LATE",
        "unconfirmed": "NOT CONFIRMED",
        "unconfirmed_note": "(no entry for any raid day)",
        "nobody_party": "• nobody 🎉",
        "nobody": "• nobody",
        "everyone": "• everyone has responded",
        "raid_days": "RAID DAYS",
        "no_column": "  ⚠️ no column in the sheet yet",
        "in_lineups": "  ↳ in lineups: {bosses}",
        "check_sheet": "CHECK THE SHEET",
        "unknown_value": "unrecognized value: {what}",
        "and_more": "• … and {n} more",
        "dup_date": "duplicate date column {cell!r}",
        "not_a_date": "header {cell!r} is not a date — column ignored",
        "dup_player": "duplicate player row {name!r} — merged",
        "lineup_no_rows": "lineup tab: no numbered player rows found",
        "lineup_bad_date": "lineup {boss}: cannot read date {date!r}",
        "lineups_failed": "boss lineups not checked: {err}",
        "no_raid_columns": "none of the raid days has a column in the sheet — "
                           "nobody could have reported anything for this week yet",
        "failed": "🚨 **RAID ATTENDANCE BOT FAILED**\n{err}\n"
                  "(no report was generated — check the sheet / workflow log)",
    },
}
LANG = "cs"


def T(key, **kw):
    """Text in the selected language."""
    return STRINGS[LANG][key].format(**kw) if kw else STRINGS[LANG][key]

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
    """'čt 10.9.' / 'Thu 10.9.' — matches the sheet's own d.M. style."""
    return f"{T('weekdays')[d.weekday()]} {d.day}.{d.month}."


def week_label(monday, sunday):
    """cs: '7.–13. 9.' or '28. 9. – 4. 10.'; en: '7–13 Sep' or '28 Sep – 4 Oct'."""
    if LANG == "cs":
        if monday.month == sunday.month:
            return f"{monday.day}.–{sunday.day}. {monday.month}."
        return f"{monday.day}. {monday.month}. – {sunday.day}. {sunday.month}."
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


def target_week(today, weekdays, offset=0):
    """(monday, sunday) of the week that contains the next raid day AFTER
    `today`. Run on Tuesday -> this week's Wed/Thu/Sun; run on Sunday (a
    raid day itself) -> the coming week. offset shifts by whole weeks."""
    d = today + dt.timedelta(days=1)
    while d.weekday() not in weekdays:
        d += dt.timedelta(days=1)
    monday = d - dt.timedelta(days=d.weekday()) + dt.timedelta(days=7 * offset)
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
                warnings.append(T("dup_date", cell=cell.strip()))
            dates[i] = d
        elif cell.strip():
            warnings.append(T("not_a_date", cell=cell.strip()))
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
            warnings.append(T("dup_player", name=name))
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


def parse_lineups(csv_text, reference):
    """Boss sestavy tab -> ([(boss_header, date_or_None, [player names])], warnings)

    Layout: row 1 = "NN Boss" headers (column A is a label column), a row
    whose column A says "Datum" (or whose cells parse as dates) holds the
    raid date per boss, rows whose column A is a slot number 1..N hold the
    players."""
    rows = list(csv.reader(io.StringIO(csv_text)))
    if len(rows) < 3:
        raise ReportError("lineup tab has fewer than 3 rows")
    header = rows[0]
    boss_cols = [(i, h.strip()) for i, h in enumerate(header)
                 if i > 0 and re.match(r"^\d{1,2}\s+\S", h.strip())]
    if not boss_cols:
        raise ReportError("lineup tab has no 'NN Boss' headers in row 1")
    slot_rows = [r for r in rows[1:] if r and r[0].strip().isdigit()]
    date_row = next((r for r in rows[1:] if r and norm(r[0]) in ("datum", "date")), None)
    if date_row is None:
        date_row = next((r for r in rows[1:] if r and not r[0].strip().isdigit()
                         and any(parse_header_date(c, reference) for c in r[1:])), [])
    warnings = []
    if not slot_rows:
        warnings.append(T("lineup_no_rows"))
    lineups = []
    for i, boss in boss_cols:
        date_txt = date_row[i].strip() if i < len(date_row) else ""
        date = parse_header_date(date_txt, reference) if date_txt else None
        if date_txt and not date:
            warnings.append(T("lineup_bad_date", boss=boss, date=date_txt))
        players = [r[i].strip() for r in slot_rows if i < len(r) and r[i].strip()]
        lineups.append((boss, date, players))
    return lineups, warnings


def lineups_by_player(lineups):
    """{norm(player): [(boss_header, date)]}"""
    out = {}
    for boss, date, players in lineups:
        for p in players:
            out.setdefault(norm(p), []).append((boss, date))
    return out


# --------------------------------------------------------------------------
# report
# --------------------------------------------------------------------------

def build_report(dates, players, raid_dates, warnings, lineups=None):
    """-> dict with lists for the message. lineups: {norm(name): [(boss, date)]}
    -> report["lineups"][(section, name)] = [(boss, date, clashes)] for absent/late players."""
    lineups = lineups or {}
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
    in_lineups = {}  # (section, name) -> [(boss, date, clashes_with_that_players_days)]
    for section, entries in (("unavailable", unavailable), ("late", late)):
        for name, ds in entries:
            hits = lineups.get(norm(name))
            if hits:
                in_lineups[(section, name)] = [(boss, date, date in ds) for boss, date in hits]
    return {
        "lineups": in_lineups,
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
                   show_unconfirmed, title, today=None):
    def who(name, section):
        uid = mentions.get(norm(name))
        if uid and section in mention_sections:
            return f"{name} <@{uid}>"
        return name

    def days(ds):
        return " / ".join(day_label(d) for d in ds)

    def lineup_lines(name, section):
        hits = report["lineups"].get((section, name))
        if not hits:
            return []
        parts = []
        for boss, date, clash in hits:
            when = f" ({day_label(date)})" if date else ""
            parts.append(f"⚠️ **{boss}{when}**" if clash else f"{boss}{when}")
        return [T("in_lineups", bosses=", ".join(parts))]

    lines = [f"📋 **{title or T('title')}**", "━━━━━━━━━━━━━━━━━━━━", "",
             f"📅 **{T('this_week' if today and monday <= today <= sunday else 'next_week')}"
             f" · {week_label(monday, sunday).upper()}**", ""]

    lines.append(f"❌ **{T('unavailable')}**")
    if report["unavailable"]:
        for n, ds in report["unavailable"]:
            lines.append(f"• {who(n, 'unavailable')} — {days(ds)}")
            lines += lineup_lines(n, "unavailable")
    else:
        lines.append(T("nobody_party"))
    lines.append("")

    lines.append(f"⏰ **{T('late')}**")
    if report["late"]:
        for n, ds in report["late"]:
            lines.append(f"• {who(n, 'late')} — {days(ds)}")
            lines += lineup_lines(n, "late")
    else:
        lines.append(T("nobody"))
    lines.append("")

    if show_unconfirmed:
        lines.append(f"⚠️ **{T('unconfirmed')}** {T('unconfirmed_note')}")
        if report["unconfirmed"]:
            lines += [f"• {who(n, 'unconfirmed')}" for n in report["unconfirmed"]]
        else:
            lines.append(T("everyone"))
        lines.append("")

    lines.append(f"👥 **{T('raid_days')}**")
    for d in raid_dates:
        tag = T("no_column") if d in report["missing_days"] else ""
        lines.append(f"• {day_label(d)}{tag}")

    notes = list(report["warnings"])
    if report["unknown"]:
        notes += [T("unknown_value", what=u) for u in report["unknown"]]
    if notes:
        lines += ["", f"🔎 **{T('check_sheet')}**"] + [f"• {n}" for n in notes[:15]]
        if len(notes) > 15:
            lines.append(T("and_more", n=len(notes) - 15))
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
    ap.add_argument("--lineups-csv", help="read the boss lineups from this CSV file")
    ap.add_argument("--week-offset", type=int, default=None,
                    help="override WEEK_OFFSET (0 = week of the next raid day, "
                         "1 = a week later, -1 = a week earlier)")
    args = ap.parse_args(argv)

    global LANG
    LANG = norm(env("REPORT_LANG", "cs"))
    if LANG not in STRINGS:
        print(f"REPORT_LANG {LANG!r} unknown — using cs", file=sys.stderr)
        LANG = "cs"
    webhook = env("DISCORD_WEBHOOK_URL")
    tz = ZoneInfo(env("TIMEZONE", DEFAULT_TIMEZONE))
    today = (dt.date.fromisoformat(args.date) if args.date
             else dt.datetime.now(tz).date())
    offset = args.week_offset if args.week_offset is not None else int(env("WEEK_OFFSET", "0"))
    if not webhook and not args.dry_run:
        sys.exit("DISCORD_WEBHOOK_URL is not set (use --dry-run to test without it).")

    try:
        weekdays = parse_weekdays(env("RAID_WEEKDAYS", DEFAULT_RAID_WEEKDAYS))
        monday, sunday = target_week(today, weekdays, offset)
        raid_dates = [monday + dt.timedelta(days=w) for w in weekdays]
        print(f"today={today} ({STRINGS['en']['weekdays'][today.weekday()]}), reporting week "
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

        lineup_gid = env("LINEUP_GID", DEFAULT_LINEUP_GID)
        lineups = {}
        if args.lineups_csv or norm(lineup_gid) not in ("none", "off", "0", "false"):
            try:
                if args.lineups_csv:
                    with open(args.lineups_csv, encoding="utf-8-sig") as f:
                        lu_text = f.read()
                else:
                    lu_text = fetch_csv(env("SHEET_ID", DEFAULT_SHEET_ID), lineup_gid)
                lu, lu_warn = parse_lineups(lu_text, reference=monday)
                warnings += lu_warn
                lineups = lineups_by_player(lu)
                print(f"{len(lu)} boss lineups: " + ", ".join(
                    f"{b} ({d or 'no date'})" for b, d, _ in lu))
            except ReportError as e:
                warnings.append(T("lineups_failed", err=e))

        report = build_report(dates, players, raid_dates, warnings, lineups)
        if len(report["missing_days"]) == len(raid_dates):
            report["warnings"].append(T("no_raid_columns"))

        mentions = load_mentions()
        sections = {s.strip() for s in norm(env("MENTION_SECTIONS", "unavailable,late")).split(",")}
        if "none" in sections:
            sections = set()
        message = format_message(
            report, monday, sunday, raid_dates, mentions, sections,
            show_unconfirmed=env_bool("SHOW_NOT_CONFIRMED", False),
            title=env("REPORT_TITLE"), today=today)
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
        err = T("failed", err=e)
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
