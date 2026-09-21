#!/usr/bin/env python3
"""Flopik – live "fails" breakdown after every raid pull, from the WoW combat log into Google Sheets.

    python flopik.py                     # follow the newest WoWCombatLog*.txt, upload every finished pull
    python flopik.py --from-start        # also process pulls already in the current log file (started mid-raid)
    python flopik.py --replay FILE       # process a whole log (backfill an older raid night), then exit
    python flopik.py --no-upload         # console + local JSONL only (no Sheets)
    python flopik.py --boss 3421         # only this encounter ID (default: every boss)

Follows the active combat log (WoW opens a new ``Logs/WoWCombatLog-MMDDYY_HHMMSS.txt`` per
session, so the tool always switches to the newest file), buffers the events of the running
encounter and on ENCOUNTER_END evaluates the boss's metrics from bosses.py (per-player deaths
for every boss, Tempest hits on Sszorak, Eternal Venom stacks vs. orbs on Twin Fangs, …).
The result is printed, appended to ``pulls.jsonl`` and POSTed to the Apps Script web app
(doPost p=flopik, same URL + token as sim_runner.py: tools/roster/sim_runner.config.json or
flopik.config.json next to this script), which writes it into the "Flopik" sheet tab – one
row per player plus one summary row per pull. web/flopik.html reads that tab (gviz CSV).

Config keys (flopik.config.json): webapp_url, token, logs (Logs folder), cutoff (default death cutoff
for bosses without their own), poll (seconds, default 1).
"""
import argparse
import collections
import datetime
import glob
import io
import json
import os
import sys
import time
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import parse_line, nm, clusters, HIT_EVENTS   # noqa: E402
from bosses import BOSSES                                  # noqa: E402

if sys.platform == "win32":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

HERE = os.path.dirname(os.path.abspath(__file__))
CONFIG_CANDIDATES = [os.path.join(HERE, "flopik.config.json"),
                     os.path.join(HERE, "..", "roster", "sim_runner.config.json")]
LOG_DIR_CANDIDATES = [os.environ.get("WOW_LOGS"),
                      os.path.join(HERE, "..", "..", "..", "_retail_", "Logs"),
                      os.path.join(HERE, "..", "..", "..", "..", "_retail_", "Logs"),
                      r"C:\Program Files (x86)\World of Warcraft\_retail_\Logs"]
JSONL = os.path.join(HERE, "pulls.jsonl")
DIFFICULTY = {14: "Normal", 15: "Heroic", 16: "Mythic", 17: "LFR"}

DEATH_COL = {"k": "deaths", "l": "Smrti", "cls": "deaths", "hot": [1, 2], "hotAll": [3, 5], "agg": "sum"}


def keep_tokens(boss):
    """Substrings a log line must contain to be worth parsing for this boss (speed on 1–2 GB logs)."""
    toks = ["UNIT_DIED", "ENCOUNTER_"]
    for m in boss.get("metrics", []):
        toks += ["," + i + "," for i in m["ids"] + m.get("cast_ids", [])]
    if boss.get("analyze"):
        toks += list(boss["analyze"].KEEP)
    return tuple(toks)


# ----------------------------------------------------------------- analysis ----

def eval_metric(m, ev, players):
    """-> ({guid: value}, casts) for a declarative metric."""
    per = collections.defaultdict(list)
    casts = 0
    for t, f in ev:
        if len(f) <= 10:
            continue
        if f[0] == "SPELL_CAST_SUCCESS" and f[9] in m.get("cast_ids", []):
            casts += 1
        if f[9] not in m["ids"]:
            continue
        if m["kind"] == "hits" and f[0] in HIT_EVENTS and f[5].startswith("Player-"):
            per[f[5]].append(t)
        elif m["kind"] == "debuff" and f[0] in ("SPELL_AURA_APPLIED", "SPELL_AURA_APPLIED_DOSE") and f[5].startswith("Player-"):
            per[f[5]].append(t)
        elif m["kind"] == "casts" and f[0] == "SPELL_CAST_SUCCESS" and f[1].startswith("Player-"):
            per[f[1]].append(t)
    if m["kind"] == "hits":
        vals = {g: clusters(ts, m["window"]) for g, ts in per.items()}
    else:
        vals = {g: len(ts) for g, ts in per.items()}
    return vals, casts if m.get("cast_ids") else None


def analyze_pull(pull, boss, default_cutoff):
    ev, st = pull["ev"], pull["start"]
    dur = (pull["end"] - st).total_seconds()
    names = {}
    for t, f in ev:
        if len(f) > 6:
            if f[1].startswith("Player-"):
                names[f[1]] = nm(f[2])
            if f[5].startswith("Player-"):
                names[f[5]] = nm(f[6])
    deaths = [(t, f[5], nm(f[6])) for t, f in ev if f[0] == "UNIT_DIED" and len(f) > 6 and f[5].startswith("Player-")]
    cutoff_n = boss.get("cutoff", default_cutoff)
    ctx = {"cutoff_n": cutoff_n, "deaths": deaths, "names": names}
    res = {"date": st.strftime("%Y-%m-%d"), "start": st.strftime("%H:%M:%S"), "dur": round(dur),
           "boss": boss["name"], "bossKey": boss["key"], "bossId": pull["bossId"], "difficulty": pull["difficulty"],
           "kill": pull["kill"], "deaths": len(deaths), "cutoff": None,
           "deathList": [{"n": n, "t": round((t - st).total_seconds())} for t, _, n in deaths]}
    if boss.get("analyze"):
        out = boss["analyze"].analyze(pull, ctx)
        res.update({k: out[k] for k in ("cols", "legend", "description", "stats", "summary", "players", "cutoff")})
        rows = {r["name"]: r for r in res["players"]}
    else:
        cut_t = deaths[cutoff_n - 1][0] if cutoff_n and len(deaths) >= cutoff_n else pull["end"]
        if cutoff_n and len(deaths) >= cutoff_n:
            res["cutoff"] = round((cut_t - st).total_seconds())
        evc = [(t, f) for t, f in ev if t <= cut_t]
        rows = {n: {"name": n, "died": False} for n in set(names.values())}
        cols, legend, stats, summary = [], [], [], {"cutoffN": cutoff_n}
        for m in boss.get("metrics", []):
            vals, casts = eval_metric(m, evc, names)
            for g, n in names.items():
                rows[n][m["k"]] = rows[n].get(m["k"], 0) + vals.get(g, 0)
            col = {"k": m["k"], "l": m["l"], "agg": "sum"}
            if m.get("avoid"):
                col["avoid"] = 1
            for opt in ("hot", "hotAll"):
                if m.get(opt):
                    col[opt] = m[opt]
            cols.append(col)
            if m.get("note"):
                legend.append("<b>%s</b> – %s." % (m["l"], m["note"]))
            total = sum(vals.values())
            if casts is not None:
                summary[m["k"] + "Casts"] = casts
                stats.append({"l": m["l"], "v": total, "cls": "bad" if total else "", "agg": "sum",
                              "s": "%d zásahů z %d castů" % (total, casts)})
            else:
                stats.append({"l": m["l"], "v": total, "cls": "bad" if total else "", "agg": "sum"})
        res.update({"cols": cols, "legend": legend, "description": "", "stats": stats, "summary": summary})
    # deaths for every boss (whole pull, not only up to the cutoff) + died marker
    for n in rows:
        rows[n]["deaths"] = 0
    for t, g, n in deaths:
        row = rows.setdefault(n, {"name": n, "died": False, "deaths": 0})
        row["deaths"] += 1
        if res["cutoff"] is None or (t - st).total_seconds() <= res["cutoff"]:
            row["died"] = True
    if boss.get("analyze"):
        res["players"] += [r for r in rows.values() if r not in res["players"]]
    else:
        res["players"] = sorted(rows.values(), key=lambda r: (-r["deaths"], r["name"]))
    if not any(c["k"] == "deaths" for c in res["cols"]):
        res["cols"] = res["cols"] + [DEATH_COL]
    first = deaths[0] if deaths else None
    res["stats"].insert(0, {"l": "Smrti", "v": len(deaths), "cls": "bad" if deaths else "", "agg": "sum",
                            "s": ("první %s v %d:%02d" % (first[2], int((first[0] - st).total_seconds()) // 60, int((first[0] - st).total_seconds()) % 60)) if first else "nikdo neumřel"})
    return res


def print_pull(res, label):
    cols = [c for c in res["cols"]]
    hdr = f"  {'Hráč':<14}" + "".join(f"{c['l'][:9]:>10}" for c in cols)
    cut = f"  |  cutoff t+{res['cutoff']}s" if res["cutoff"] is not None else ""
    print(f"\n{'=' * max(70, len(hdr))}\n{label}  {res['boss']} {res['difficulty']}  {res['date']} {res['start']}  délka {res['dur']}s"
          f"{'  KILL' if res['kill'] else '  wipe'}  |  úmrtí: {res['deaths']}{cut}")
    print("  " + "  ".join(f"{s['l']}: {s['v']}" + (f" ({s['s']})" if s.get("s") else "") for s in res["stats"]))
    print(hdr)
    print("  " + "-" * (len(hdr) - 2))
    tot = collections.Counter()
    for r in res["players"]:
        print(f"  {r['name']:<14}" + "".join(f"{r.get(c['k'], 0):>10}" for c in cols) + ("  †" if r.get("died") else ""))
        for c in cols:
            tot[c["k"]] += r.get(c["k"], 0) or 0
    print(f"  {'CELKEM':<14}" + "".join(f"{tot[c['k']]:>10}" if c.get("agg") != "max" else f"{'':>10}" for c in cols))
    sys.stdout.flush()


# ------------------------------------------------------------------- upload ----

def load_config(explicit_url, explicit_token):
    cfg = {}
    for path in CONFIG_CANDIDATES:
        if os.path.isfile(path):
            with open(path, encoding="utf-8") as f:
                c = json.load(f)
            for k in ("api_url", "api_token", "webapp_url", "token", "logs", "cutoff", "poll"):
                if c.get(k) and not cfg.get(k):
                    cfg[k] = c[k]
    if explicit_url:
        cfg["api_url"] = explicit_url
    if explicit_token:
        cfg["api_token"] = explicit_token
    cfg["api_url"] = os.environ.get("ES_API_URL", "").strip() or cfg.get("api_url") or "https://eternal-shadows.vitek-poor.workers.dev"
    cfg["api_token"] = os.environ.get("ES_API_TOKEN", "").strip() or cfg.get("api_token") or ""
    return cfg


def upload_pull(cfg, res, tries=4):
    """POST /api/flopik/pulls (Worker API, databáze) – stejný tvar pullu jako z Warcraft Logs runneru."""
    body = json.dumps({"pull": res}, ensure_ascii=False).encode("utf-8")
    last = ""
    for attempt in range(tries):
        try:
            req = urllib.request.Request(cfg["api_url"].rstrip("/") + "/api/flopik/pulls", data=body,
                                         headers={"Content-Type": "application/json", "Authorization": "Bearer " + cfg["api_token"], "User-Agent": "flopik/1.0"})
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.loads(r.read().decode("utf-8", "replace"))
        except urllib.error.HTTPError as e:
            last = f"HTTP {e.code} {e.read().decode('utf-8', 'replace')[:160]}"
            if 400 <= e.code < 500 and e.code != 429:
                break
        except (urllib.error.URLError, ValueError, OSError) as e:
            last = str(e)
        time.sleep(2 + 3 * attempt)
    return {"ok": False, "error": last}


def save_jsonl(res):
    with open(JSONL, "a", encoding="utf-8") as f:
        f.write(json.dumps(res, ensure_ascii=False) + "\n")


# ------------------------------------------------------------- encounters -----

class EncounterTracker:
    """Feed combat log lines; on_pull(result, n) is called for each finished tracked encounter."""

    def __init__(self, on_pull, default_cutoff, only_boss=0):
        self.on_pull, self.default_cutoff, self.only_boss = on_pull, default_cutoff, only_boss
        self.cur = None
        self.keep = ()
        self.count = 0

    def feed(self, line):
        if self.cur is None:
            if "ENCOUNTER_START" not in line:
                return
        elif not any(k in line for k in self.keep):
            return
        p = parse_line(line)
        if not p:
            return
        t, f = p
        if f[0] == "ENCOUNTER_START":
            enc = int(f[1]) if f[1].isdigit() else 0
            if self.only_boss and enc != self.only_boss:
                print(f"[{t:%H:%M:%S}] {f[2]} – ignoruji (sleduji jen ID {self.only_boss})")
                self.cur = None
                return
            boss = BOSSES.get(enc) or {"key": "enc%d" % enc, "name": f[2].strip('"'), "metrics": []}
            diff = int(f[3]) if len(f) > 3 and f[3].isdigit() else 0
            self.cur = {"start": t, "ev": [], "boss": boss, "bossId": enc, "difficulty": DIFFICULTY.get(diff, str(diff))}
            self.keep = keep_tokens(boss)
            print(f"[{t:%H:%M:%S}] pull začal: {boss['name']} {self.cur['difficulty']}"
                  + ("" if enc in BOSSES else " (boss není v bosses.py – jen smrti)"))
            sys.stdout.flush()
        elif f[0] == "ENCOUNTER_END":
            if not self.cur:
                return
            self.cur["end"] = t
            self.cur["kill"] = len(f) > 5 and f[5] == "1"
            self.count += 1
            res = analyze_pull(self.cur, self.cur["boss"], self.default_cutoff)
            self.cur = None
            self.on_pull(res, self.count)
        else:
            self.cur["ev"].append((t, f))


def newest_log(log_dir):
    files = glob.glob(os.path.join(log_dir, "WoWCombatLog*.txt"))
    return max(files, key=os.path.getmtime) if files else None


def find_log_dir(explicit):
    for d in ([explicit] if explicit else []) + LOG_DIR_CANDIDATES:
        if d and os.path.isdir(d):
            return os.path.abspath(d)
    sys.exit("Složka Logs nenalezena – zadej --logs \"G:\\World of Warcraft\\_retail_\\Logs\" (nebo env WOW_LOGS / config \"logs\").")


def follow(log_dir, tracker, from_start, poll):
    """Tail the newest WoWCombatLog*.txt forever; switch when WoW opens a newer file."""
    path = newest_log(log_dir)
    while not path:
        print(f"V {log_dir} zatím není žádný WoWCombatLog*.txt – zapni /combatlog ve hře, čekám…")
        time.sleep(5)
        path = newest_log(log_dir)
    fh = open(path, "rb")
    if not from_start:
        fh.seek(0, os.SEEK_END)
    print(f"Sleduji {path}" + (" (od začátku souboru)" if from_start else " (od aktuálního konce)") + ". Ctrl+C ukončí.")
    sys.stdout.flush()
    partial = b""
    last_scan = time.time()
    while True:
        chunk = fh.read(1 << 20)
        if chunk:
            lines = (partial + chunk).split(b"\n")
            partial = lines.pop()          # incomplete tail (WoW may flush mid-line)
            for raw in lines:
                tracker.feed(raw.decode("utf-8", "replace"))
            continue
        if time.time() - last_scan >= 5:
            last_scan = time.time()
            newer = newest_log(log_dir)
            if newer and newer != path:
                rest = fh.read()           # drain what is left of the old file, then move on
                for raw in (partial + rest).split(b"\n"):
                    if raw:
                        tracker.feed(raw.decode("utf-8", "replace"))
                fh.close()
                path, partial = newer, b""
                fh = open(path, "rb")
                tracker.cur = None
                print(f"[{datetime.datetime.now():%H:%M:%S}] nový log: {path}")
                sys.stdout.flush()
                continue
        time.sleep(poll)


def main():
    ap = argparse.ArgumentParser(description="Flopik – live raid pull fails from the combat log into Google Sheets")
    ap.add_argument("--replay", metavar="FILE", help="process a whole combat log and exit (backfill)")
    ap.add_argument("--logs", metavar="DIR", help="WoW _retail_/Logs folder (default: config / autodetect / env WOW_LOGS)")
    ap.add_argument("--from-start", action="store_true", help="live mode: also process pulls already in the current file")
    ap.add_argument("--boss", type=int, default=0, help="only this encounter ID (default: every boss)")
    ap.add_argument("--cutoff", type=int, help="default death cutoff for bosses without their own (default 0 = whole pull)")
    ap.add_argument("--no-upload", action="store_true", help="do not send to Google Sheets")
    ap.add_argument("--min-dur", type=int, default=30, help="pulls shorter than this (s) are printed but not uploaded (default 30)")
    ap.add_argument("--webapp-url")
    ap.add_argument("--token")
    args = ap.parse_args()

    cfg = load_config(args.webapp_url, args.token)
    if not args.no_upload and not cfg.get("api_token"):
        sys.exit("Chybí api_token (tools/roster/sim_runner.config.json nebo tools/flopik/flopik.config.json = secret API_TOKEN Workeru), "
                 "nebo použij --no-upload. Token: menu tabulky Simy → Token pro sim_runner.py…")
    default_cutoff = args.cutoff if args.cutoff is not None else int(cfg.get("cutoff", 0))

    def on_pull(res, n):
        print_pull(res, f"PULL {n}")
        save_jsonl(res)
        if res["dur"] < args.min_dur:
            print(f"  – pull kratší než {args.min_dur} s, do tabulky se nezapisuje")
        elif not args.no_upload:
            r = upload_pull(cfg, res)
            if r.get("ok"):
                print(f"  ✔ Sheets: {res['boss']} {res['date']} pull {r.get('pull')} ({r.get('rows')} řádků) – flopik.html se do minuty obnoví")
            else:
                print(f"  ⚠ Sheets: {r.get('error') or r}")
        sys.stdout.flush()

    tracker = EncounterTracker(on_pull, default_cutoff, args.boss)
    if args.replay:
        with open(args.replay, "rb") as fh:
            for raw in fh:
                tracker.feed(raw.decode("utf-8", "replace"))
        print(f"\nHotovo: {tracker.count} pullů.")
        return
    try:
        follow(find_log_dir(args.logs or cfg.get("logs")), tracker, args.from_start, float(cfg.get("poll", 1)))
    except KeyboardInterrupt:
        print("\nKonec.")


if __name__ == "__main__":
    main()
