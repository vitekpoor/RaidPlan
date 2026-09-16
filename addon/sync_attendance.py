#!/usr/bin/env python3
"""Push attendance records written by the ES Attendance addon into the "Docházka" sheet tab.

    python sync_attendance.py            # send records not sent yet (state in .synced.json)
    python sync_attendance.py --all      # resend every record
    python sync_attendance.py --dry-run  # show what would be sent

The addon stores each record (one per day, later writes overwrite) in
WTF/Account/<account>/SavedVariables/ESAttendance.lua as an ``export`` string
``ESA1|2026-09-16|20:05|Player=1:Char|Player=0|…|?=UnknownChar``. WoW writes the file on
logout or /reload, so run this after the raid (or /reload first). The string is POSTed to
the Apps Script web app (doPost p=esattendance, same URL + token as sim_runner.py, taken
from tools/roster/sim_runner.config.json or from es_attendance.config.json next to this
script), which creates/overwrites the date column in the sheet.
"""
import argparse
import glob
import hashlib
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
CONFIG_CANDIDATES = [os.path.join(HERE, "es_attendance.config.json"),
                     os.path.join(HERE, "..", "tools", "roster", "sim_runner.config.json")]
STATE_FILE = os.path.join(HERE, ".synced.json")
WOW_CANDIDATES = [os.environ.get("WOW_RETAIL"),
                  os.path.join(HERE, "..", "..", "_retail_"),
                  os.path.join(HERE, "..", "..", "..", "_retail_")]


def load_config():
    for path in CONFIG_CANDIDATES:
        if os.path.isfile(path):
            with open(path, encoding="utf-8") as f:
                cfg = json.load(f)
            if cfg.get("webapp_url") and cfg.get("token"):
                return cfg
    sys.exit("No config with webapp_url + token found (es_attendance.config.json or "
             "tools/roster/sim_runner.config.json). Token: sheet menu Simy → Token pro sim_runner.py…")


def saved_variables_files(explicit):
    if explicit:
        return [explicit]
    for root in WOW_CANDIDATES:
        if root and os.path.isdir(root):
            files = glob.glob(os.path.join(root, "WTF", "Account", "*", "SavedVariables", "ESAttendance.lua"))
            if files:
                return files
    sys.exit("ESAttendance.lua not found under WTF/Account/*/SavedVariables – open the addon in "
             "game once and /reload, or pass --file.")


_LUA_ESC = {"n": "\n", "t": "\t", "r": "\r", "\\": "\\", '"': '"', "'": "'"}


def lua_unescape(s):
    """Undo the escapes WoW uses in SavedVariables (\\124 for '|', \\", \\\\, \\n)."""
    def repl(m):
        e = m.group(1)
        if e.isdigit():
            return chr(int(e))
        return _LUA_ESC.get(e, e)
    return re.sub(r"\\(\d{1,3}|.)", repl, s)


def read_records(path):
    """-> {date: export_string}; only the export strings are needed."""
    with open(path, encoding="utf-8", errors="replace") as f:
        text = f.read()
    records = {}
    for m in re.finditer(r'\["export"\]\s*=\s*"((?:[^"\\]|\\.)*)"', text):
        export = lua_unescape(m.group(1))
        parts = export.split("|")
        if len(parts) >= 3 and parts[0] == "ESA1":
            records[parts[1]] = export
    return records


def load_state():
    try:
        with open(STATE_FILE, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def save_state(state):
    with open(STATE_FILE, "w", encoding="utf-8") as f:
        json.dump(state, f, indent=1, ensure_ascii=False, sort_keys=True)


def post(cfg, export, tries=4):
    body = json.dumps({"p": "esattendance", "token": cfg["token"], "record": export}).encode("utf-8")
    req = urllib.request.Request(cfg["webapp_url"], data=body,
                                 headers={"Content-Type": "application/json"}, method="POST")
    last = None
    for attempt in range(tries):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                raw = r.read().decode("utf-8", "replace")
            if raw.lstrip().startswith("{"):
                return json.loads(raw)
            last = "non-JSON answer (%s…)" % raw.strip()[:80]
        except urllib.error.HTTPError as e:
            last = "HTTP %s" % e.code
        except (urllib.error.URLError, OSError, ValueError) as e:  # noqa: PERF203
            last = str(e)
        time.sleep(2 * (attempt + 1))
    return {"ok": False, "error": last or "no answer"}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--all", action="store_true", help="resend every record, not only new/changed ones")
    ap.add_argument("--dry-run", action="store_true", help="print records, do not send")
    ap.add_argument("--file", help="path to SavedVariables/ESAttendance.lua")
    ap.add_argument("--date", help="send only this yyyy-mm-dd record")
    args = ap.parse_args()
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except AttributeError:
        pass

    cfg = None if args.dry_run else load_config()
    state = load_state()
    records = {}
    for path in saved_variables_files(args.file):
        records.update(read_records(path))
        print("Read %d record(s) from %s" % (len(records), path))
    if args.date:
        records = {d: e for d, e in records.items() if d == args.date}
    if not records:
        print("Nothing to send.")
        return

    sent = failed = skipped = 0
    for date in sorted(records):
        export = records[date]
        digest = hashlib.sha1(export.encode("utf-8")).hexdigest()
        if not args.all and state.get(date) == digest:
            skipped += 1
            continue
        present = sum(1 for p in export.split("|")[3:] if "=1" in p and not p.startswith("?="))
        if args.dry_run:
            print("%s %s – %d present: %s" % (date, export.split("|")[2], present, export[:120] + ("…" if len(export) > 120 else "")))
            continue
        res = post(cfg, export)
        if res.get("ok"):
            state[date] = digest
            save_state(state)
            sent += 1
            print("✔ %s – %s" % (date, res.get("message", "written")))
        else:
            failed += 1
            print("✖ %s – %s" % (date, res.get("error") or res.get("message") or "unknown error"))
    if not args.dry_run:
        print("Done: %d sent, %d failed, %d unchanged." % (sent, failed, skipped))
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
