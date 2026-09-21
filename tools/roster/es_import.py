#!/usr/bin/env python3
"""
es_import.py – jednorázové přenosy z guildovní Google tabulky do databáze (Worker API).

  python es_import.py roster          # list "Roster" (Hráč | Main char | Main classa | Main role | | Alt char | Alt classa | Alt role | Poznámka,
                                      #   řádek LAVIČKA = začátek lavičky) → PUT /api/roster; spec postav se doplní z posledních simů
  python es_import.py absence         # list "Absence přehled" (Hráč × datumy "čt 10.9.", buňky X / pozdě) → POST /api/absence/import
  python es_import.py roster --dry-run

Token: env ES_API_TOKEN nebo "api_token" v sim_runner.config.json (stejně jako sim_results.py).
"""
import argparse
import csv
import io
import re
import sys
from datetime import date, datetime, timedelta, timezone

import requests

import sim_results as sr

ROSTER_TAB = "Roster"
ABSENCE_TAB = "Absence přehled"
CZ_WEEKDAYS = "po|út|st|čt|pá|so|ne"


def gviz_rows(sheet_id, tab):
    url = f"https://docs.google.com/spreadsheets/d/{sheet_id}/gviz/tq?tqx=out:csv&headers=1&sheet={requests.utils.quote(tab)}"
    r = requests.get(url, timeout=120)
    r.raise_for_status()
    return list(csv.reader(io.StringIO(r.text)))


def import_roster(api, sheet_id, dry_run):
    rows = gviz_rows(sheet_id, ROSTER_TAB)
    head = [h.strip().lower() for h in rows[0]]

    def col(name, required=True):
        n = name.lower()
        if n not in head:
            if required:
                sys.exit(f"Roster nemá sloupec '{name}' (má: {rows[0]})")
            return None
        return head.index(n)

    ip, im, imc, imr = col("Hráč"), col("Main char"), col("Main classa"), col("Main role")
    ia, iac, iar, inote = col("Alt char"), col("Alt classa"), col("Alt role"), col("Poznámka", False)
    isp, iasp = col("Main spec", False), col("Alt spec", False)
    # spec z posledních simů (report per character + spec, nejnovější vyhrává)
    specs = {}
    try:
        for p in sorted(api.results().get("reports") or [], key=lambda p: p.get("simmed_at") or ""):
            specs[p["character_key"]] = p["spec"]
    except Exception as err:  # noqa: BLE001
        sr.log(f"specy ze simů se nenačetly: {err}")
    players, bench = [], False
    for r in rows[1:]:
        cell = lambda i: r[i].strip() if i is not None and i < len(r) else ""
        player = cell(ip)
        if not player:
            continue
        if re.match(r"^lavi[čc]ka", player, re.I):
            bench = True
            continue
        main, alt = cell(im), cell(ia)
        if not main:
            continue
        chars = [{"name": main, "class": cell(imc), "role": cell(imr).lower() or "dps", "spec": cell(isp) or specs.get(sr.name_key(main), ""), "main": True}]
        if alt and sr.name_key(alt) != sr.name_key(main):
            chars.append({"name": alt, "class": cell(iac), "role": cell(iar).lower() or chars[0]["role"], "spec": cell(iasp) or specs.get(sr.name_key(alt), ""), "main": False})
        players.append({"name": player, "bench": bench, "note": cell(inote), "characters": chars})
    sr.log(f"Roster: {len(players)} hráčů ({sum(1 for p in players if p['bench'])} na lavičce), {sum(len(p['characters']) for p in players)} postav")
    for p in players:
        print(f"  {'[L] ' if p['bench'] else ''}{p['name']:<14} " + " | ".join(f"{c['name']} ({c['class']}, {c['role']}{', ' + c['spec'] if c['spec'] else ''})" for c in p["characters"]))
    if dry_run:
        return
    api.require_token()
    r = requests.put(f"{api.url}/api/roster", headers=api._headers(), data=sr.json.dumps({"players": players}, ensure_ascii=False).encode("utf-8"), timeout=120)
    print(api._check(r, "roster"))


def header_date(text, today):
    """"čt 10.9." / "10.9.2026" / "2026-09-10" → date (rok bez udání = nejblíž dnešku)."""
    t = str(text or "").strip()
    m = re.search(r"(\d{4})-(\d{2})-(\d{2})", t)
    if m:
        return date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
    m = re.search(r"(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})?", t)
    if not m:
        return None
    d, mo = int(m.group(1)), int(m.group(2))
    if m.group(3):
        return date(int(m.group(3)), mo, d)
    cands = []
    for k in (-1, 0, 1):
        try:
            cands.append(date(today.year + k, mo, d))
        except ValueError:
            pass
    return min(cands, key=lambda c: abs((c - today).days)) if cands else None


def import_absence(api, sheet_id, dry_run):
    rows = gviz_rows(sheet_id, ABSENCE_TAB)
    if not rows or not re.match(r"^hr[aá][čc]", rows[0][0].strip(), re.I):
        sys.exit(f"List '{ABSENCE_TAB}' nemá očekávanou hlavičku: {rows[0][:5] if rows else rows}")
    today = datetime.now(timezone.utc).date()
    dates = {}
    for i, h in enumerate(rows[0][1:], start=1):
        d = header_date(h, today)
        if d:
            dates[i] = d
    marks = []
    for r in rows[1:]:
        player = (r[0] if r else "").strip()
        if not player:
            continue
        for i, d in dates.items():
            v = r[i].strip().lower() if i < len(r) else ""
            if not v:
                continue
            typ = "late" if v.startswith("poz") else "absent"
            marks.append({"player": player, "date": d.isoformat(), "type": typ})
    sr.log(f"Absence přehled: {len(dates)} datumů, {len(marks)} záznamů")
    for m in marks[:15]:
        print("  ", m)
    if dry_run:
        return
    api.require_token()
    r = requests.post(f"{api.url}/api/absence/import", headers=api._headers(), data=sr.json.dumps({"marks": marks}).encode("utf-8"), timeout=120)
    print(api._check(r, "absence import"))


def main():
    ap = argparse.ArgumentParser(description="Import z Google tabulky do databáze")
    ap.add_argument("what", choices=["roster", "absence"])
    ap.add_argument("--sheet-id", default=sr.SHEET_ID)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    api = sr.EsApi.from_config()
    if args.what == "roster":
        import_roster(api, args.sheet_id, args.dry_run)
    else:
        import_absence(api, args.sheet_id, args.dry_run)


if __name__ == "__main__":
    main()
