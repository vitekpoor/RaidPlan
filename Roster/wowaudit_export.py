# -*- coding: utf-8 -*-
"""
wowaudit wishlist export – stáhne wishlisty celého týmu přes wowaudit API
a udělá z nich tabulky "kdo chce co a o kolik % je to upgrade".

Zdroj: GET https://api.wowaudit.com/v1/wishlists  (Authorization: Bearer <API key>)
API klíč: wowaudit -> tým -> Settings -> API (vidí jen admin týmu).

Použití:
  python wowaudit_export.py --key <API_KEY>            # nebo env WOWAUDIT_API_KEY
  python wowaudit_export.py --difficulty heroic         # normal | heroic | mythic
                                                        # (default: auto = obtížnost zapnutá v týmu)
  python wowaudit_export.py --config "Overall"          # název droptimizer konfigurace
                                                        # ("Overall" = vážený průměr všech, default)
  python wowaudit_export.py --instance "Venomous"       # filtr názvu raidu (substring)
  python wowaudit_export.py --min 0.5                   # skryj upgrady pod 0.5 %
  python wowaudit_export.py --json dump.json            # ulož surovou odpověď API
  python wowaudit_export.py --from-json dump.json       # pracuj offline z uloženého dumpu

Výstupy (vedle skriptu):
  wowaudit_wishes.csv     – dlouhá tabulka: 1 řádek = hráč × item × spec
  wowaudit_by_item.csv    – 1 řádek = item, sloupec zájemci "Hráč (spec) 1.23%" seřazení sestupně
  wowaudit_by_player.csv  – 1 řádek = hráč × boss, jeho itemy z toho bosse
  wowaudit_report.html    – barevná tabulka podle itemů pro vložení do Sheets / Discordu
"""

import argparse
import csv
import html
import json
import os
import sys
import urllib.error
import urllib.request

API_URL = "https://api.wowaudit.com/v1/wishlists"
HERE = os.path.dirname(os.path.abspath(__file__))


def fetch(key):
    req = urllib.request.Request(API_URL, headers={
        "Authorization": f"Bearer {key}",
        "Accept": "application/json",
        "User-Agent": "wowaudit_export.py",
    })
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")
        sys.exit(f"HTTP {e.code} z wowaudit API: {body[:300]}")


def flatten(data, difficulty, config, instance_filter):
    """Vrátí seznam dictů: player, spec, item, item_id, slot, boss, instance,
    pct (upgrade v % podle simu, může být None), upgrade (manuální label
    huge/big/small/tiny nebo None), manual, comment, outdated, config."""
    rows = []
    for ch in data.get("characters", []):
        player = ch["name"]
        # Dvě podoby odpovědi: docs ukazují characters[].wishlists[] (víc Droptimizer
        # konfigurací), živé API bez konfigurací vrací rovnou characters[].instances[].
        wishlists = ch.get("wishlists")
        if wishlists is None:
            wishlists = [{"name": "Overall", "instances": ch.get("instances") or []}]
        # preferuj vyžádanou konfiguraci; když neexistuje, vezmi všechny
        chosen = [w for w in wishlists if w.get("name") == config] or wishlists
        for wl in chosen:
            cfg = wl.get("name") or "?"
            for inst in wl.get("instances") or []:
                iname = inst.get("name") or ""
                if instance_filter and instance_filter.lower() not in iname.lower():
                    continue
                for diff in inst.get("difficulties") or []:
                    if diff.get("difficulty") != difficulty:
                        continue
                    wlist = diff.get("wishlist") or {}
                    if "encounters" not in wlist:      # docs varianta: wishlist.wishlist
                        wlist = wlist.get("wishlist") or {}
                    for enc in wlist.get("encounters") or []:
                        boss = enc.get("name") or ""
                        for it in enc.get("items") or []:
                            wishes = it.get("wishes") or []
                            if not wishes:
                                continue
                            for w in wishes:
                                rows.append({
                                    "player": player,
                                    "spec": w.get("specialization") or "",
                                    "item": it.get("name") or "",
                                    "item_id": it.get("id"),
                                    "slot": it.get("slot") or "",
                                    "boss": boss,
                                    "instance": iname,
                                    "pct": w.get("percentage"),
                                    "upgrade": w.get("upgrade"),
                                    "manual": bool(w.get("manually_edited")),
                                    "comment": w.get("comment") or "",
                                    "outdated": bool(w.get("outdated")),
                                    "config": cfg,
                                    "when": w.get("timestamp") or "",
                                })
    return rows


def fmt_pct(r):
    if r["pct"] is not None:
        return f"{r['pct']:.2f}%"
    return r["upgrade"] or ("manual" if r["manual"] else "")


def write_long(rows, path):
    with open(path, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.writer(f, delimiter=";")
        w.writerow(["Hráč", "Spec", "Item", "Item ID", "Slot", "Boss", "Raid",
                    "Upgrade %", "Label", "Manuálně", "Poznámka", "Zastaralé", "Konfigurace", "Čas"])
        for r in sorted(rows, key=lambda r: (r["boss"], r["item"], -(r["pct"] or 0))):
            w.writerow([r["player"], r["spec"], r["item"], r["item_id"] or "", r["slot"], r["boss"],
                        r["instance"], "" if r["pct"] is None else f"{r['pct']:.2f}",
                        r["upgrade"] or "", "ano" if r["manual"] else "", r["comment"],
                        "ano" if r["outdated"] else "", r["config"], r["when"]])


def group_by_item(rows):
    items = {}
    for r in rows:
        if not r["item"]:
            continue
        key = (r["boss"], r["item"])
        items.setdefault(key, {"slot": r["slot"], "wishes": []})["wishes"].append(r)
    for v in items.values():
        v["wishes"].sort(key=lambda r: -(r["pct"] or 0))
    return items


def write_by_item(items, path):
    with open(path, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.writer(f, delimiter=";")
        w.writerow(["Boss", "Item", "Slot", "Počet zájemců", "Součet %", "Zájemci (seřazeno podle upgradu)"])
        for (boss, item), v in sorted(items.items(), key=lambda kv: (kv[0][0], -len(kv[1]["wishes"]))):
            ws = v["wishes"]
            total = sum(r["pct"] or 0 for r in ws)
            names = ", ".join(f"{r['player']} ({r['spec']}) {fmt_pct(r)}" for r in ws)
            w.writerow([boss, item, v["slot"], len(ws), f"{total:.2f}", names])


def write_by_player(rows, path):
    by = {}
    for r in rows:
        by.setdefault((r["player"], r["boss"]), []).append(r)
    with open(path, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.writer(f, delimiter=";")
        w.writerow(["Hráč", "Boss", "Itemy (upgrade %)"])
        for (player, boss), rs in sorted(by.items()):
            rs.sort(key=lambda r: -(r["pct"] or 0))
            w.writerow([player, boss, ", ".join(f"{r['item']} {fmt_pct(r)}" for r in rs if r["item"])])


def write_html(items, path, difficulty, config):
    def color(pct):
        if pct is None:
            return "#dddddd"
        if pct >= 3:
            return "#57bb8a"
        if pct >= 1.5:
            return "#a8d08d"
        if pct >= 0.5:
            return "#ffd966"
        return "#f4cccc"

    out = [f"<h3>wowaudit wishlist – {html.escape(difficulty)} – {html.escape(config)}</h3>",
           "<table border=1 cellpadding=4 style='border-collapse:collapse;font-family:Arial;font-size:12px'>",
           "<tr style='background:#444;color:#fff'><th>Boss</th><th>Item</th><th>Slot</th><th>#</th><th>Zájemci</th></tr>"]
    for (boss, item), v in sorted(items.items(), key=lambda kv: (kv[0][0], -len(kv[1]["wishes"]))):
        cells = "".join(
            f"<span style='display:inline-block;margin:1px 3px;padding:1px 5px;border-radius:3px;"
            f"background:{color(r['pct'])}'>{html.escape(r['player'])} <small>{html.escape(r['spec'])}</small> "
            f"<b>{html.escape(fmt_pct(r))}</b>{' ⚠' if r['outdated'] else ''}</span>"
            for r in v["wishes"])
        out.append(f"<tr><td>{html.escape(boss)}</td><td>{html.escape(item)}</td><td>{html.escape(v['slot'])}</td>"
                   f"<td align=center>{len(v['wishes'])}</td><td>{cells}</td></tr>")
    out.append("</table><p>Zelená ≥3 %, světle zelená ≥1.5 %, žlutá ≥0.5 %, červená &lt;0.5 %, "
               "šedá = ruční zápis bez simu, ⚠ = zastaralý report.</p>")
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(out))


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--key", default=os.environ.get("WOWAUDIT_API_KEY"), help="wowaudit team API key")
    ap.add_argument("--difficulty", default="auto", choices=["auto", "normal", "heroic", "mythic"])
    ap.add_argument("--config", default="Overall", help="droptimizer konfigurace (default Overall)")
    ap.add_argument("--instance", default="", help="filtr názvu raidu (substring)")
    ap.add_argument("--min", type=float, default=0.0, help="minimální upgrade v %% (manuální zápisy zůstávají)")
    ap.add_argument("--json", help="ulož surovou odpověď API do souboru")
    ap.add_argument("--from-json", help="načti surovou odpověď ze souboru místo API")
    a = ap.parse_args()

    if a.from_json:
        with open(a.from_json, encoding="utf-8") as f:
            data = json.load(f)
    else:
        if not a.key:
            sys.exit("Chybí API klíč: --key nebo env WOWAUDIT_API_KEY")
        data = fetch(a.key)
        if a.json:
            with open(a.json, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False, indent=1)

    if a.difficulty == "auto":
        present = []
        for ch in data.get("characters", []):
            for wl in ch.get("wishlists") or [{"instances": ch.get("instances") or []}]:
                for inst in wl.get("instances") or []:
                    for df in inst.get("difficulties") or []:
                        if df.get("difficulty") not in present:
                            present.append(df.get("difficulty"))
        a.difficulty = "heroic" if "heroic" in present else (present[0] if present else "heroic")
        print(f"Obtížnosti v datech: {', '.join(present) or '-'} -> použito {a.difficulty}")
    rows = flatten(data, a.difficulty, a.config, a.instance)
    rows = [r for r in rows if r["pct"] is None or r["pct"] >= a.min]
    configs = sorted({r["config"] for r in rows if r["config"]})
    items = group_by_item(rows)

    write_long(rows, os.path.join(HERE, "wowaudit_wishes.csv"))
    write_by_item(items, os.path.join(HERE, "wowaudit_by_item.csv"))
    write_by_player(rows, os.path.join(HERE, "wowaudit_by_player.csv"))
    write_html(items, os.path.join(HERE, "wowaudit_report.html"), a.difficulty, a.config)

    players = {r["player"] for r in rows if r["item"]}
    all_chars = [c["name"] for c in data.get("characters", [])]
    no_wl = sorted(n for n in all_chars if n not in players)
    print(f"Charakterů v týmu: {len(all_chars)}, s nahraným reportem: {len(players)}")
    print(f"Konfigurace v datech: {', '.join(configs) or '-'} (použito: {a.config})")
    print(f"Itemů s alespoň jedním zájemcem ({a.difficulty}): {len(items)}, přání celkem: "
          f"{sum(1 for r in rows if r['item'])}")
    if no_wl:
        print("Bez reportu:", ", ".join(no_wl))
    print("Výstupy: wowaudit_wishes.csv, wowaudit_by_item.csv, wowaudit_by_player.csv, wowaudit_report.html")


if __name__ == "__main__":
    main()
