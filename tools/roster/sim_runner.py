#!/usr/bin/env python3
"""
sim_runner.py – automatický Raidbots Droptimizer pro frontu "Sim fronta".

Co dělá (jeden spuštěný příkaz, pak se jen čeká):
  1. stáhne čekající řádky z Google Sheets (JSON API web appu, ?p=simapi),
  2. pro každý řádek otevře v Chromiu DVA panely s Raidbots Droptimizerem:
     raid ("Season 2 Raids", Mythic) a Mythic+ ("Mythic+ Dungeons", All Dungeons,
     "+10 Vault"), oba s "Upgrade up to" Myth 6/6 – takže se raidové i dungeonové
     itemy srovnávají na stejném (maximálním) ilvl. Vloží SimC string, klikne Run –
     až `parallel` simů najednou (výchozí 10),
  3. hlídá všechny běžící reporty (…/simbot/report/<id>) a jak který doběhne,
  4. nahlásí ho zpět do Sheets (action=done&kind=raid|mplus) – Apps Script
     zapíše výsledky do listu "Sim výsledky" a raidový report zkusí nahrát do
     wowaudit – a zároveň report rozparsuje a uloží do databáze (Cloudflare D1
     přes Worker API, sim_results.py; env ES_API_TOKEN) – z ní čte stránka Simy,
  5. když má postava hotový raid i M+ report, pustí třetí sim: Raidbots Top Gear
     (kind "topgear") – z obou Droptimizerů vezme pro každý slot nejlepší raidový
     a nejlepší M+ item (jen kladné upgrady, nejvýš `topgear_max_items`), přidá je
     do SimC stringu jako "Gear from Bags", v Top Gearu je zaškrtne a nechá
     Raidbots najít nejlepší kombinaci ("best overall" řádek na stránce Simy).
     Řádek je ✅, až když jsou hotové všechny tři reporty; když některý selže,
     při dalším běhu se dosimuje jen ten chybějící.
  6. u každé postavy (i bez Great Vaultu v SimC stringu) běží navíc "HC raid"
     Droptimizer (kind "raidhc"): Season 2 Raids, obtížnost "Heroic Vault"
     (Myth 1/6) + Upgrade up to Myth 6/6 = všechny raidové itemy max 334. Bonus
     roll na HC (a na mythic bossech, které zabíjíme) dává mythic ilvl, ale max
     334 – jen poslední mythic bossové dropí 344 base, a tam bonus roll ještě
     dlouho nepůjde. Stránka Simy proto doporučení bonus rollu (a srovnání
     "vzít z vaultu vs. nechat si bonus roll", když hráč vault poslal) počítá
     z tohohle reportu, ne z plného mythic Droptimizeru.
  Každý řádek fronty = postava + spec; výsledky jiného specu téže postavy se
  nepřepisují (Apps Script je drží zvlášť).

Kolik simů Raidbots pustí najednou, určuje účet (Premium tier); když další
sim odmítne, runner řádek vrátí do fronty a dál posílá jen tolik, kolik
skutečně běží.

Healery (holy/disc/resto/mistweaver/preservation) Droptimizer neumí – ty
runner prohání QE Live Upgrade Finderem (questionablyepic.com): vybere spec,
Import Gear → SimC, obtížnost (raid Mythic, M+ +10), GO!; report je hotový hned
a obsahuje raid i dungeony najednou (kind=qe = oba).

Řádky se stavem ⚠ chyba, kde chybu zapsal sim_runner, se při dalším běhu
zkusí znovu automaticky.

Prohlížeč používá vlastní trvalý profil (.raidbots_profile/), takže
přihlášení do Raidbots (Premium) i nastavení Droptimizeru se pamatují.

Použití (v tools/roster/):
  python sim_runner.py setup        # uloží URL web appu + token (menu Simy → Token pro sim_runner.py…)
  python sim_runner.py login        # otevře prohlížeč, přihlas se do Raidbots, pak Enter
  python sim_runner.py login --export   # …a navíc uloží přihlášení do raidbots_state.json (secret pro GitHub Actions)
  python sim_runner.py pending      # jen vypíše, kolik řádků čeká
  python sim_runner.py discord-rooms  # bot vypíše místnosti hráčů (kategorie "Players") a pošle je do listu "Discord"
  python sim_runner.py discord-test --character Akka   # testovací zpráva do místnosti hráče (bot)
  python sim_runner.py              # zpracuje frontu

Online (bez PC): .github/workflows/sims.yml spouští tenhle skript v GitHub Actions
každou hodinu a na kliknutí (menu Simy → Spustit simy online, tlačítko na hubu).
Konfigurace přes env: SIM_WEBAPP_URL, SIM_API_TOKEN, SIM_STORAGE_STATE (cesta
k JSON z `login --export`), volitelně SIM_PARALLEL, SIM_UPGRADE, SIM_MPLUS=0 (vypne
druhý, dungeonový Droptimizer), SIM_TOPGEAR=0 (vypne Top Gear), SIM_RAIDHC=0 (vypne
HC raid Droptimizer pro bonus roll). Místo (nebo vedle)
uložené session jde použít RAIDBOTS_EMAIL + RAIDBOTS_PASSWORD – když skript zjistí,
že není přihlášený, přihlásí se e-mailem a heslem na https://www.raidbots.com/auth.
Discord: DISCORD_BOT_TOKEN (+ DISCORD_GUILD_ID pro discord-rooms). Discord blokuje bot API
z Google serverů, proto zprávy do místností hráčů posílá runner: když Apps Script u `done`
vrátí `notify` (kanál, zmínka, text), runner ji pošle a nahlásí action=notified.
  python sim_runner.py --parallel 3 # max 3 simy najednou (výchozí 10)
  python sim_runner.py --no-mplus   # jen raidový Droptimizer (bez Mythic+ dungeonů)
  python sim_runner.py --no-topgear # bez třetího simu (Top Gear z nejlepších itemů)
  python sim_runner.py --no-raidhc  # bez HC raid Droptimizeru (doporučení bonus rollu / srovnání s vaultem)
  python sim_runner.py --dry-run    # všechno kromě kliknutí na Run (kontrola nastavení)
  python sim_runner.py --row 7      # jen konkrétní řádek listu
  python sim_runner.py --headless   # bez okna prohlížeče

Vyžaduje: pip install playwright requests && python -m playwright install chromium
"""

import argparse
import json
import os
import re
import sys
import time
import unicodedata
from collections import deque
from datetime import datetime
from pathlib import Path

import requests

import sim_results   # výsledky simů → databáze (Cloudflare D1 přes Worker API), tools/roster/sim_results.py

HERE = Path(__file__).resolve().parent
CONFIG_PATH = HERE / "sim_runner.config.json"
PROFILE_DIR = HERE / ".raidbots_profile"
LOG_DIR = HERE / "sim_runner_logs"

DROPTIMIZER_URL = "https://www.raidbots.com/simbot/droptimizer"
TOPGEAR_URL = "https://www.raidbots.com/simbot/topgear"
AUTH_URL = "https://www.raidbots.com/auth"
REPORT_RE = re.compile(r"raidbots\.com/simbot/report/([A-Za-z0-9]{10,40})")
GOLD = "rgb(255, 187, 51)"  # barva rámečku vybraného zdroje / obtížnosti
RED = "rgb(255, 80, 80)"     # Top Gear: zaškrtnutá karta, které chybí protějšek (off hand bez main handu)
INCLUDED = (GOLD, RED)

HEALER_SPECS = {"holy", "discipline", "restoration", "mistweaver", "preservation"}

# hlášky Raidbots, když účet nesmí pustit další sim souběžně
LIMIT_RE = re.compile(r"(?i)already (have|running)|sim(ulation)? (is )?(already )?in progress|"
                      r"one sim at a time|concurrent|too many|wait for your|queue is full|limit")

DEFAULTS = {
    "webapp_url": "",
    "token": "",
    "source": "Season 2 Raids",
    "difficulty": "Mythic",
    "upgrade": "max",        # Droptimizer "Upgrade up to": max = plně upgradnuté (Myth 6/6), base = bez upgradů
    "mplus": True,           # druhý Droptimizer: Mythic+ dungeony (kind "mplus")
    "mplus_source": "Mythic+ Dungeons",
    "mplus_dungeons": "All Dungeons",   # dlaždice pod zdrojem (výchozí vybraná)
    "mplus_difficulty": "+10 Vault",    # Myth track (318) – s upgrade "max" = Myth 6/6 jako raid
    "raidhc": True,          # u každé postavy další raidový Droptimizer (kind "raidhc") = základ pro bonus roll
    "raidhc_difficulty": "Heroic Vault",   # dlaždice "Heroic Vault / Myth 1/6" + upgrade max = všechno 334 Myth 6/6
                             # (bonus roll na HC dává mythic item, ale max 334; poslední mythic bossové dropí 344 base)
    "topgear": True,         # třetí sim: Top Gear z nejlepších raid + M+ itemů (kind "topgear")
    "topgear_max_items": 16, # nejvýš tolik kandidátů (nejlepší raid + nejlepší M+ na slot, seřazeno podle upgradu);
                             # odškrtnuté slabé nasazené kusy drží počet kombinací nízko, tak si můžeme dovolit skoro vše
    "topgear_min_gain": 0.1, # kandidát musí mít aspoň tolik % upgradu v Droptimizeru
    "topgear_max_combos": 20000,   # když Raidbots hlásí víc kombinací, uber nejslabší kandidáty
    "topgear_weapon_min_gain": -6, # zbraně (main hand / off hand) jdou do Top Gearu skoro vždy – Droptimizer simuje
                                   # 1H bez správného off-handu, takže pár 1H + OH ukáže až kombinace
    "topgear_min_items": 4,        # při ubírání kandidátů kvůli limitu kombinací nejít pod tolik itemů
    "topgear_replace_gap": 10,     # nasazený kus o >= tolik ilvl horší než kandidát ve slotu se v Top Gearu odškrtne
                                   # (méně kombinací, víc místa pro další itemy); zbraně se neodškrtávají
    "parallel": 10,          # kolik simů posílat najednou (každý ve vlastním panelu)
    "sim_timeout_min": 60,   # maximální čekání na jeden sim
    "poll_seconds": 15,
}


def log(msg):
    print(f"[{datetime.now():%H:%M:%S}] {msg}", flush=True)


def strip_accents(s):
    return "".join(c for c in unicodedata.normalize("NFD", s) if unicodedata.category(c) != "Mn").lower()


class SubmitLimit(Exception):
    """Raidbots odmítl další souběžný sim – řádek zkusíme později."""


SIMC_HEAD_RE = re.compile(r'^(deathknight|demonhunter|druid|evoker|hunter|mage|monk|paladin|priest|rogue|shaman|warlock|warrior)="([^"\n]+)"\s*$', re.M | re.I)


def simc_name(simc):
    m = SIMC_HEAD_RE.search(simc)
    return m.group(2).strip() if m else ""


def simc_class(simc):
    m = SIMC_HEAD_RE.search(simc)
    return m.group(1).lower() if m else ""


# QE Live "Current Spec" podle SimC classy+specu (healeři)
QE_SPECS = {
    ("druid", "restoration"): "Restoration Druid",
    ("shaman", "restoration"): "Restoration Shaman",
    ("priest", "holy"): "Holy Priest",
    ("priest", "discipline"): "Discipline Priest",
    ("paladin", "holy"): "Holy Paladin",
    ("monk", "mistweaver"): "Mistweaver Monk",
    ("evoker", "preservation"): "Preservation Evoker",
}
QE_URL = "https://questionablyepic.com/live/upgradefinder"
QE_REPORT_RE = re.compile(r"questionablyepic\.com/live/upgradereport/([A-Za-z0-9_-]{6,80})")


# ------------------------------------------------------------- Top Gear ----

PROFILESET_LINE_RE = re.compile(r'^profileset\."([^"]+)"\+?=(.*)$', re.M)


def fetch_report(report_id):
    """data.json + celý SimC vstup. POZOR: data.json má v simbot.input jen první chunk
    profilesetů (např. 8 ze 101) – kompletní řádky itemů jsou v reports/<id>/input.txt."""
    r = requests.get(f"https://www.raidbots.com/reports/{report_id}/data.json", timeout=180)
    r.raise_for_status()
    data = r.json()
    try:
        t = requests.get(f"https://www.raidbots.com/reports/{report_id}/input.txt", timeout=180)
        if t.ok and "profileset." in t.text:
            data["_input"] = t.text
    except requests.RequestException:
        pass
    return data


def report_id_from_url(url):
    m = REPORT_RE.search(str(url or ""))
    return m.group(1) if m else ""


WEAPON_SLOTS = ("main_hand", "off_hand")
SLOT_GROUP = {"finger": "rings", "trinket": "trinkets"}   # skupiny karet v Top Gearu (id karty "rings-1/item")


def slot_group(slot):
    base = re.sub(r"[12]$", "", str(slot))
    return SLOT_GROUP.get(base, base)


def slot_group_of_card(card_group):
    """Skupina karty z DOM id Top Gearu ("mainHand", "offHand", "rings", "trinkets", "head"…) → skupina
    kandidáta (slot_group). camelCase → snake_case, "rings"/"trinkets" zůstávají."""
    snake = re.sub(r"([A-Z])", lambda m: "_" + m.group(1).lower(), str(card_group or ""))
    return slot_group(snake)


def droptimizer_best_per_slot(data, kind, min_gain, weapon_min_gain=None):
    """Z Droptimizer data.json vrátí {slot: kandidát} – nejlepší item na slot s upgradem
    >= min_gain % (zbraně >= weapon_min_gain, protected=True – Top Gear je nesmí vyhodit).
    Kandidát nese přesný SimC řádek itemu z profilesetu (včetně bonus_id pro Myth 6/6,
    enchant, gem), takže ho jde vložit do Top Gearu jako item z bagu."""
    sim = data.get("sim") or {}
    base = float((((sim.get("players") or [{}])[0].get("collected_data") or {}).get("dps") or {}).get("mean") or 0)
    if not base:
        raise RuntimeError("v reportu chybí základní DPS")
    # profileset může mít víc řádků (1H main hand + doplňkový off hand, když je nasazená 2H) – všechny
    lines = {}
    for name, line in PROFILESET_LINE_RE.findall(data.get("_input") or (data.get("simbot") or {}).get("input") or ""):
        lines.setdefault(name, []).append(line.strip())
    # itemLibrary má set kus vícekrát (token z každého bosse + katalyzátorové verze, tags ["catalyst"],
    # sourceItem = zdrojový item); klíč id/zdroj, samotné id jako záloha
    lib, lib_cat = {}, {}
    for it in (((data.get("simbot") or {}).get("meta") or {}).get("itemLibrary") or []):
        iid = str(it.get("id"))
        if "catalyst" in [str(t).lower() for t in (it.get("tags") or [])]:
            lib_cat[(iid, str((it.get("sourceItem") or {}).get("id")))] = it
        else:
            lib.setdefault(iid, it)
        lib.setdefault(iid, it)
    best = {}
    for r in (sim.get("profilesets") or {}).get("results") or []:
        parts = str(r.get("name") or "").split("/")
        if len(parts) < 7:
            continue
        # poslední pole = zdrojový item katalyzátoru (set kus se staty ne-setového itemu jiného bosse)
        cat_src = parts[10] if len(parts) > 10 and parts[10].isdigit() else ""
        ls = lines.get(r["name"]) or []
        line = next((l for l in ls if re.match(rf"^{re.escape(parts[6])}=,", l)), ls[0] if ls else None)
        if not line:
            continue
        extras = []
        for l in ls:
            if l == line or not re.match(r"^[a-z_0-9]+=,id=\d+", l):
                continue
            em = re.match(r"^([a-z_0-9]+)=,id=(\d+)", l); eb = re.search(r"bonus_id=([\d/]+)", l)
            extras.append({"slot": re.sub(r"[12]$", "", em.group(1)), "id": em.group(2), "line": l,
                           "bonus": set(eb.group(1).split("/")) if eb else set(),
                           "name": lib.get(em.group(2), {}).get("name") or f"#{em.group(2)}"})
        gain = (float(r.get("mean") or 0) - base) / base * 100
        slot = parts[6]
        base_slot = re.sub(r"[12]$", "", slot)
        weapon = base_slot in WEAPON_SLOTS
        if gain < (weapon_min_gain if (weapon and weapon_min_gain is not None) else min_gain):
            continue
        cur = best.get(base_slot)
        if cur and cur["gain"] >= gain:
            continue
        m = re.search(r"id=(\d+)", line)
        bonus = re.search(r"bonus_id=([\d/]+)", line)
        it = (lib_cat.get((parts[3], cat_src)) if cat_src else None) or lib.get(parts[3], {})
        name = it.get("name") or f"#{parts[3]}"
        if cat_src:
            name += " (katalyzátor z " + (lib.get(cat_src, {}).get("name") or (it.get("sourceItem") or {}).get("name") or f"#{cat_src}") + ")"
        best[base_slot] = {"kind": kind, "slot": base_slot, "group": slot_group(base_slot), "gain": gain,
                           "id": m.group(1) if m else parts[3], "protected": weapon,
                           "ilvl": int(it.get("itemLevel") or parts[4] or 0),
                           "bonus": set(bonus.group(1).split("/")) if bonus else set(),
                           "name": name, "line": line, "extras": extras}
    return best


def topgear_candidates(raid_data, mplus_data, cfg):
    """Nejlepší raidový a nejlepší M+ item na slot, seřazené podle upgradu, nejvýš topgear_max_items
    (+ zbraně navíc: nejlepší main hand a off hand z každého zdroje, protected)."""
    min_gain = float(cfg.get("topgear_min_gain", 0.1))
    wmin = float(cfg.get("topgear_weapon_min_gain", -6))
    cands = []
    if raid_data:
        cands += droptimizer_best_per_slot(raid_data, "raid", min_gain, wmin).values()
    if mplus_data:
        cands += droptimizer_best_per_slot(mplus_data, "mplus", min_gain, wmin).values()
    weapons = sorted([c for c in cands if c["protected"]], key=lambda c: -c["gain"])
    others = sorted([c for c in cands if not c["protected"]], key=lambda c: -c["gain"])[: int(cfg.get("topgear_max_items", 16))]
    chosen = sorted(others + weapons, key=lambda c: -c["gain"])
    # doplňkové itemy z profilesetu (off hand k 1H kandidátovi) – také zaškrtnout, jinak by 1H neměl pár
    seen = {(c["id"], frozenset(c["bonus"])) for c in chosen}
    for c in list(chosen):
        for e in c.get("extras", []):
            key = (e["id"], frozenset(e["bonus"]))
            if key in seen:
                continue
            seen.add(key)
            chosen.append({"kind": c["kind"], "slot": e["slot"], "group": slot_group(e["slot"]), "gain": c["gain"], "id": e["id"],
                           "protected": True, "ilvl": 0, "bonus": e["bonus"], "name": e["name"] + " (doplněk k " + c["name"] + ")",
                           "line": e["line"], "extras": [], "companion": True})
    return chosen


def equipped_items(raid_data):
    """Nasazený gear z Droptimizer reportu (simbot.meta.rawFormData.simcItems):
    {skupina karet: [{id, ilvl, bonus:set}]} – klíče mainHand/offHand/finger1… → main_hand/rings…"""
    si = (((raid_data or {}).get("simbot") or {}).get("meta") or {}).get("rawFormData", {}).get("simcItems") or {}
    out = {}
    for key, it in si.items():
        if not isinstance(it, dict) or not it.get("id"):
            continue
        slot = re.sub(r"(?<!^)(?=[A-Z])", "_", str(key)).lower()   # mainHand → main_hand
        if slot in ("tabard", "shirt"):
            continue
        out.setdefault(slot_group(slot), []).append({"id": str(it["id"]), "ilvl": int(it.get("itemLevel") or 0),
                                                      "bonus": set(str(b) for b in (it.get("bonusList") or []))})
    return out


def strip_bags(simc):
    """Odstraní hráčův blok "### Gear from Bags" (aby v Top Gearu nebyly cizí kopie itemů);
    vault blok a ostatní části zůstávají."""
    lines = simc.replace("\r", "").split("\n")
    out, skip = [], False
    for l in lines:
        if re.match(r"^###\s*Gear from Bags", l, re.I):
            skip = True
            continue
        if skip and (re.match(r"^###", l) or re.match(r"^#\s*(Checksum|Saved Loadout|talents=)", l, re.I) or re.match(r"^[a-z_]+=", l)):
            skip = False
        if not skip:
            out.append(l)
    return "\n".join(out)


def topgear_input(simc, cands):
    """SimC string + kandidáti jako itemy z bagu (Raidbots je v Top Gearu nabídne k zaškrtnutí)."""
    block = "\n".join(f"# {c['name']}\n# {c['line']}" for c in cands)
    return strip_bags(simc).rstrip() + "\n\n### Gear from Bags\n" + block + "\n"


# ---------------------------------------------------------------- config ----

def load_config():
    cfg = dict(DEFAULTS)
    if CONFIG_PATH.exists():
        cfg.update(json.loads(CONFIG_PATH.read_text(encoding="utf-8")))
    cfg["webapp_url"] = os.environ.get("SIM_WEBAPP_URL", cfg["webapp_url"])
    cfg["token"] = os.environ.get("SIM_API_TOKEN", cfg["token"])
    # databáze výsledků (Worker API): env ES_API_URL / ES_API_TOKEN, nebo klíče api_url / api_token v configu
    cfg["api_url"] = os.environ.get("ES_API_URL", "").strip() or cfg.get("api_url") or sim_results.DEFAULT_API_URL
    cfg["api_token"] = os.environ.get("ES_API_TOKEN", "").strip() or cfg.get("api_token") or ""
    if os.environ.get("SIM_PARALLEL", "").strip().isdigit():
        cfg["parallel"] = int(os.environ["SIM_PARALLEL"])
    if os.environ.get("SIM_UPGRADE", "").strip():
        cfg["upgrade"] = os.environ["SIM_UPGRADE"].strip()
    if os.environ.get("SIM_MPLUS", "").strip():
        cfg["mplus"] = os.environ["SIM_MPLUS"].strip().lower() not in ("0", "false", "no", "off")
    if os.environ.get("SIM_TOPGEAR", "").strip():
        cfg["topgear"] = os.environ["SIM_TOPGEAR"].strip().lower() not in ("0", "false", "no", "off")
    if os.environ.get("SIM_RAIDHC", "").strip():
        cfg["raidhc"] = os.environ["SIM_RAIDHC"].strip().lower() not in ("0", "false", "no", "off")
    return cfg


KINDS = {"raid": "raid", "mplus": "M+", "qe": "raid+M+", "topgear": "Top Gear", "raidhc": "HC raid"}


def kind_label(kind):
    return KINDS.get(kind, kind)


def cmd_setup(cfg):
    print("Nastavení sim_runner.py – hodnoty najdeš v Sheets: menu Simy → Token pro sim_runner.py…")
    print("Web app URL = stejná …/exec adresa, na které hráči mají formulář absence / simu.")
    url = input(f"Web app URL [{cfg['webapp_url'] or '-'}]: ").strip() or cfg["webapp_url"]
    token = input(f"Token [{'(uložený)' if cfg['token'] else '-'}]: ").strip() or cfg["token"]
    source = input(f"Raidbots zdroj [{cfg['source']}]: ").strip() or cfg["source"]
    diff = input(f"Obtížnost [{cfg['difficulty']}]: ").strip() or cfg["difficulty"]
    par = input(f"Simů najednou [{cfg['parallel']}]: ").strip() or cfg["parallel"]
    mp = input(f"Druhý Droptimizer na Mythic+ dungeony (a/n) [{'a' if cfg.get('mplus', True) else 'n'}]: ").strip().lower()
    if mp:
        cfg["mplus"] = mp.startswith(("a", "y", "1"))
    if not url or not token:
        sys.exit("Chybí URL nebo token.")
    url = url.split("?")[0]
    if not url.endswith("/exec"):
        print("Pozor: URL web appu obvykle končí na /exec.")
    cfg.update({"webapp_url": url, "token": token, "source": source, "difficulty": diff, "parallel": int(par)})
    CONFIG_PATH.write_text(json.dumps(cfg, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"Uloženo do {CONFIG_PATH.name} (soubor je v .gitignore).")
    api = SheetApi(cfg)
    try:
        rows = api.queue()
    except requests.HTTPError as err:
        code = err.response.status_code if err.response is not None else "?"
        print(f"Web app odpověděl HTTP {code}.")
        if code == 404:
            print("Tohle není adresa nasazené web appy. Použij stejnou …/exec adresu, na které hráči mají")
            print("formulář absence / simu (Apps Script → Nasadit → Spravovat nasazení), a spusť setup znovu.")
        return
    except Exception as err:  # noqa: BLE001
        print(f"Spojení selhalo: {err}")
        print("Zkontroluj token (menu Simy → Token pro sim_runner.py…) a že je web app nasazená v nové verzi.")
        return
    print(f"Spojení OK – ve frontě čeká {len(rows)} řádků.")


# ------------------------------------------------------------- Sheets API ----

class SheetApi:
    def __init__(self, cfg):
        if not cfg["webapp_url"] or not cfg["token"]:
            if os.environ.get("GITHUB_ACTIONS"):
                sys.exit("Chybí secrets SIM_WEBAPP_URL / SIM_API_TOKEN – repo → Settings → Secrets and variables → Actions → New repository secret.")
            sys.exit("Není nastavené URL/token – spusť: python sim_runner.py setup")
        self.url = cfg["webapp_url"]
        self.token = cfg["token"]

    RETRY_STATUS = (404, 429, 500, 502, 503, 504)   # Google občas vrátí 404 z googleusercontent echo nebo 5xx – zkusit znovu

    def _request(self, action, method="get", params=None, body=None, timeout=90, tries=4):
        """GET/POST na web app s opakováním: Apps Script odpovídá přes 302 na script.googleusercontent.com,
        které občas vrátí 404 / 5xx / HTML stránku Googlu místo výstupu skriptu. Vrací parsovaný JSON
        (i s ok:false – to řeší volající)."""
        last = ""
        for attempt in range(tries):
            if method == "post":
                r = requests.post(self.url, data=body, headers={"Content-Type": "text/plain;charset=utf-8"}, timeout=timeout, allow_redirects=True)
            else:
                r = requests.get(self.url, params=params, timeout=timeout, allow_redirects=True)
            text = r.text
            if r.status_code < 400 and not text.lstrip().startswith("<"):
                try:
                    return r.json()
                except ValueError:
                    last = f"HTTP {r.status_code}, ne JSON: {text[:160]}"
            elif r.status_code in self.RETRY_STATUS or text.lstrip().startswith("<"):
                plain = re.sub(r"<script.*?</script>|<style.*?</style>", " ", text, flags=re.S)
                plain = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", plain)).strip()
                last = f"HTTP {r.status_code} {plain[:160]}"
            else:
                r.raise_for_status()
            if attempt < tries - 1:
                wait = 3 * (attempt + 1)
                log(f"   web app ({action}): {last[:90]} – pokus {attempt + 1}/{tries}, čekám {wait} s")
                time.sleep(wait)
        raise RuntimeError(f"Web app neodpověděl správně ani po {tries} pokusech ({action}): {last}")

    def call(self, action, **params):
        q = {"p": "simapi", "token": self.token, "action": action}
        q.update({k: v for k, v in params.items() if v is not None})
        data = self._request(action, "get", params=q)
        if not data.get("ok"):
            raise RuntimeError(f"simapi/{action}: {data.get('error') or data.get('message') or data}")
        return data

    def queue(self):
        return self.call("queue")["rows"]

    def running(self, row, character, url, kind="raid"):
        return self.call("running", row=row, character=character, url=url, kind=kind)

    def done(self, row, character, url, kind="raid"):
        """kind: raid | mplus | raidhc | topgear (Raidbots) | qe (QE Live – raid i dungeony v jednom reportu)."""
        return self._request("done", "get", params={"p": "simapi", "token": self.token, "action": "done",
                                                    "row": row, "character": character, "url": url, "kind": kind}, timeout=120)

    def error(self, row, character, note):
        return self.call("error", row=row, character=character, note=note[:500])

    def notified(self, row, character, result):
        """Výsledek Discord zprávy poslané runnerem (nahradí „⏳“ v poznámce řádku)."""
        return self.call("notified", row=row, character=character, result=result[:160])

    def post(self, action, **body):
        """POST JSON na web app (doPost, p=simapi) – pro větší data (seznam Discord kanálů)."""
        body.update({"p": "simapi", "token": self.token, "action": action})
        data = self._request(action, "post", body=json.dumps(body).encode("utf-8"), timeout=120)
        if not data.get("ok"):
            raise RuntimeError(f"simapi/{action}: {data.get('error') or data.get('message') or data}")
        return data

    def note(self, row, character, note):
        return self.call("note", row=row, character=character, note=note[:500])


# --------------------------------------------------------------- Raidbots ----

class Raidbots:
    """Jedno Chromium s trvalým profilem; každý sim běží ve vlastním panelu (page)."""

    def __init__(self, cfg, headless=False, storage_state=None):
        """storage_state = cesta k JSON z `login --export` (GitHub Actions: cookies + localStorage
        místo trvalého profilu). Bez něj se použije trvalý profil .raidbots_profile/."""
        from playwright.sync_api import sync_playwright
        self.cfg = cfg
        self._pw = sync_playwright().start()
        self._browser = None
        args = ["--disable-blink-features=AutomationControlled"]
        viewport = {"width": 1280, "height": 1800}
        if storage_state:
            self._browser = self._pw.chromium.launch(headless=headless, args=args)
            self.ctx = self._browser.new_context(storage_state=storage_state, viewport=viewport)
        else:
            PROFILE_DIR.mkdir(exist_ok=True)
            self.ctx = self._pw.chromium.launch_persistent_context(
                str(PROFILE_DIR), headless=headless, viewport=viewport, args=args)
        self.ctx.set_default_timeout(30000)
        self.home = self.ctx.pages[0] if self.ctx.pages else self.ctx.new_page()

    def export_state(self, path):
        """Uloží cookies + localStorage (přihlášení Raidbots, nastavení Droptimizeru) do JSON."""
        self.ctx.storage_state(path=str(path))

    def close(self):
        try:
            self.ctx.close()
            if self._browser:
                self._browser.close()
        finally:
            self._pw.stop()

    def new_tab(self):
        return self.ctx.new_page()

    # -- helpers --
    @staticmethod
    def text(page):
        return page.evaluate("() => document.body.innerText")

    @staticmethod
    def screenshot(page, name):
        LOG_DIR.mkdir(exist_ok=True)
        path = LOG_DIR / f"{datetime.now():%Y%m%d_%H%M%S}_{name}.png"
        try:
            page.screenshot(path=str(path), full_page=True)
            log(f"   screenshot: {path}")
        except Exception:
            pass

    def logged_in(self):
        self.home.goto(DROPTIMIZER_URL, wait_until="domcontentloaded")
        self.home.wait_for_timeout(2500)
        ok = "LOGIN" not in self.text(self.home)[:400].upper()
        # Raidbots sem obnoví minulou postavu – vypadá to jako druhý sim, tak panel vyprázdníme
        try:
            self.home.goto("about:blank")
        except Exception:
            pass
        return ok

    def login_with_password(self, email, password):
        """Přihlášení e-mailem a heslem na https://www.raidbots.com/auth (formulář
        #loginEmail / #loginPassword / #loginSubmit; stránka má formulář dvakrát – desktop
        a mobil – proto .first). Vrací True, když je po přihlášení Droptimizer bez LOGIN."""
        page = self.home
        page.goto(AUTH_URL, wait_until="domcontentloaded")
        page.locator("#loginEmail").first.wait_for(state="visible", timeout=20000)
        page.locator("#loginEmail").first.fill(email)
        page.locator("#loginPassword").first.fill(password)
        page.locator("#loginSubmit").first.click()
        try:
            page.wait_for_url(lambda u: "/auth" not in u, timeout=20000)
        except Exception:
            # zůstali jsme na /auth – vypsat důvod (špatné heslo apod.)
            body = self.text(page)
            m = re.search(r"(?im)^.*(invalid|incorrect|error|wrong|not found|too many).*$", body)
            log("Raidbots login se nepovedl" + (f": {m.group(0).strip()}" if m else " (stránka zůstala na /auth)."))
            self.screenshot(page, "login-failed")
            return False
        page.wait_for_timeout(1500)
        return self.logged_in()

    @staticmethod
    def settle(page, ms=1500):
        """Stránka animuje přechody – chvíli počkat, než se kliká."""
        try:
            page.wait_for_load_state("networkidle", timeout=8000)
        except Exception:
            pass
        page.wait_for_timeout(ms)

    @staticmethod
    def tile(page, label):
        """Dlaždice zdroje/obtížnosti = <p> s textem uvnitř klikatelného <div>."""
        return page.locator("p.Text", has_text=re.compile(rf"^\s*{re.escape(label)}\s*$")).first

    @staticmethod
    def tile_selected(page, label):
        return page.evaluate(
            """(label) => { const p = Array.from(document.querySelectorAll('p.Text')).find(e => e.innerText.trim() === label);
                 if (!p) return null; let box = p.parentElement; for (let i = 0; i < 3 && box; i++) {
                   const cs = getComputedStyle(box);
                   if (cs.borderTopStyle !== 'none' && parseFloat(cs.borderTopWidth) > 0) return cs.borderTopColor;
                   box = box.parentElement; }
                 return null; }""", label)

    def select_tile(self, page, label, what):
        t = self.tile(page, label)
        if t.count() == 0:
            raise RuntimeError(f"{what} „{label}“ na stránce není")
        if self.tile_selected(page, label) != GOLD:
            try:
                t.click(timeout=5000)
            except Exception:
                # animace/překryv – klikni přes DOM na klikatelný rámeček dlaždice
                t.evaluate("el => (el.closest('div[style*=\"cursor: pointer\"]') || el.parentElement).click()")
            self.settle(page, 1200)
        if self.tile_selected(page, label) != GOLD:
            raise RuntimeError(f"nepodařilo se vybrat {what} „{label}“")

    # -- main flow --
    def set_editor(self, page, simc):
        """Nahradí obsah CodeMirror editoru (přes CM6 API; fallback klávesnice)."""
        editor = page.locator(".cm-content").first
        if not editor.is_visible():
            page.get_by_role("button", name="SIMC ADDON").click()
            self.settle(page, 800)
            editor = page.locator(".cm-content").first
        ok = editor.evaluate(
            """(el, text) => { const v = el.cmView && el.cmView.view; if (!v) return false;
                 v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text } }); return true; }""", simc)
        if not ok:
            # klik k hornímu okraji – střed vysokého obsahu může ležet mimo viditelnou část editoru
            editor.click(position={"x": 10, "y": 10})
            page.keyboard.press("Control+A")
            page.keyboard.press("Delete")
            page.keyboard.insert_text(simc)

    def load_simc(self, page, simc, url=DROPTIMIZER_URL, ready="#instanceList"):
        """url/ready: Droptimizer (#instanceList) nebo Top Gear (div.item = karty itemů)."""
        page.goto(url, wait_until="domcontentloaded")
        self.settle(page)
        # Raidbots si pamatuje minulý vstup (profil / storage state), takže na stránce
        # může být karta a seznam zdrojů ještě od předchozí postavy – a když je to ta
        # samá postava (nebo se jmenuje jako účet v hlavičce), kontrola jména ji
        # nerozezná. Proto editor nejdřív vyprázdníme a počkáme, až stará karta zmizí.
        if page.locator(ready).count():
            self.set_editor(page, "")
            try:
                page.wait_for_function("(sel) => !document.querySelector(sel)", arg=ready, timeout=15000)
            except Exception:
                log("   (stará karta postavy nezmizela, pokračuji)")
            page.wait_for_timeout(500)
        self.set_editor(page, simc)
        # Čekáme, až karta postavy (mimo editor) ukáže jméno z vloženého stringu,
        # existuje seznam zdrojů a zmizí "Loading character…".
        name = simc_name(simc)
        deadline = time.time() + 60
        last = ""
        while True:
            info = page.evaluate(
                """(sel) => { const c = document.body.cloneNode(true);
                     c.querySelectorAll('.cm-editor').forEach(e => e.remove());
                     const t = c.innerText || ''; return { text: t, list: !!document.querySelector(sel) }; }""", ready)
            last = info["text"]
            loading = re.search(r"(?i)loading character", last)
            if info["list"] and not loading and (not name or name.upper() in last.upper()):
                break
            if time.time() > deadline:
                hint = ""
                for line in last.splitlines():
                    if re.search(r"error|invalid|unable|could not|not supported|unsupported", line, re.I):
                        hint = line.strip()[:200]
                        break
                if loading:
                    hint = hint or "stále „Loading character…“"
                elif name and name.upper() not in last.upper():
                    hint = hint or f"karta postavy neukazuje „{name}“"
                raise RuntimeError("Raidbots nenačetl postavu ze SimC stringu" + (f": {hint}" if hint else ""))
            page.wait_for_timeout(1000)
        self.settle(page, 1000)

    def set_upgrade_level(self, page):
        """„Upgrade up to“ (react-select). cfg upgrade: "max" = plně upgradnuté (Myth 6/6),
        "base" = bez upgradů, nebo text volby (např. "Myth 4/6")."""
        want = str(self.cfg.get("upgrade", "max")).strip().lower()
        if want in ("", "base", "none", "0"):
            return
        hidden = page.locator("input[name=upgradeLevel]")
        if hidden.count() == 0:
            raise RuntimeError("na stránce není volba „Upgrade up to“")
        wrapper = hidden.locator("xpath=..")
        current = re.sub(r"\s+", " ", wrapper.inner_text()).strip()
        if want == "max" and re.search(r"\b(\d+)/\1\b", current):
            log(f"   upgrade: {current} (už nastaveno)")
            return
        # react-select: viditelná hodnota překrývá input, tak klikáme na celý control
        # (a když to nejde, otevřeme nabídku klávesnicí)
        control = wrapper.locator("div[class*='-control']").first
        control.scroll_into_view_if_needed()
        try:
            control.click(timeout=5000)
        except Exception:
            wrapper.locator("[role=combobox]").first.focus()
            page.keyboard.press("ArrowDown")
        page.wait_for_timeout(700)
        opts = page.locator("[id*='-option-']")
        texts = [re.sub(r"\s+", " ", opts.nth(i).inner_text()).strip() for i in range(opts.count())]
        if not texts:
            raise RuntimeError("„Upgrade up to“ nenabídl žádné volby")
        idx = None
        if want == "max":
            # plně upgradnutá volba "N/N", jinak nejvyšší ilvl
            full = [i for i, t in enumerate(texts) if re.search(r"\b(\d+)/\1\b", t)]
            if full:
                idx = full[0]
            else:
                lv = [(int(m.group(1)), i) for i, t in enumerate(texts) if (m := re.match(r"(\d{3})", t))]
                idx = max(lv)[1] if lv else None
        else:
            idx = next((i for i, t in enumerate(texts) if want in t.lower()), None)
        if idx is None:
            page.keyboard.press("Escape")
            raise RuntimeError(f"„Upgrade up to“ nemá volbu „{want}“ (nabídka: {', '.join(texts)})")
        opt = opts.nth(idx)
        opt.scroll_into_view_if_needed()
        try:
            opt.click(timeout=5000)
        except Exception:
            opt.evaluate("el => el.click()")
        page.wait_for_timeout(1500)
        shown = re.sub(r"\s+", " ", wrapper.inner_text()).strip()
        if want == "max" and not re.search(r"\b(\d+)/\1\b", shown):
            raise RuntimeError(f"„Upgrade up to“ se nepřepnulo na max (ukazuje „{shown}“)")
        log(f"   upgrade: {shown}")

    def configure(self, page, kind="raid"):
        """kind "raid": zdroj + obtížnost z configu. kind "mplus": zdroj "Mythic+ Dungeons",
        dlaždice "All Dungeons", obtížnost "+10 Vault" (Myth track). kind "raidhc": raidový
        zdroj + dlaždice "Heroic Vault" (Myth 1/6) – s upgradem max je všechno 334.
        Přepnutí zdroje resetuje "Upgrade up to" na "Base level", proto se max nastavuje
        až po dlaždicích."""
        if kind == "raidhc":
            self.select_tile(page, self.cfg["source"], "zdroj")
            self.select_tile(page, self.cfg.get("raidhc_difficulty", "Heroic Vault"), "obtížnost")
            self.set_upgrade_level(page)
            return
        if kind == "mplus":
            self.select_tile(page, self.cfg["mplus_source"], "zdroj")
            dung = self.cfg.get("mplus_dungeons")
            if dung and self.tile(page, dung).count():
                self.select_tile(page, dung, "dungeony")
            self.select_tile(page, self.cfg["mplus_difficulty"], "obtížnost")
            self.set_upgrade_level(page)
            return
        self.select_tile(page, self.cfg["source"], "zdroj")
        self.select_tile(page, self.cfg["difficulty"], "obtížnost")
        self.set_upgrade_level(page)
        # ověření přes vygenerovaný SimC vstup (profilesety nesou "raid-mythic" apod.)
        want = "raid-" + self.cfg["difficulty"].lower()
        body = self.text(page)
        if "raid-" in body and want not in body:
            raise RuntimeError(f"vstup pro sim neobsahuje {want}")

    def run(self, page, button=r"run droptimizer"):
        """Klikne Run (Droptimizer "RUN DROPTIMIZER", Top Gear "FIND TOP GEAR") a vrátí
        (report_id, url). SubmitLimit = účet nesmí pustit další sim."""
        before = self.text(page)
        page.get_by_role("button", name=re.compile(button, re.I)).click()
        deadline = time.time() + 120
        while time.time() < deadline:
            m = REPORT_RE.search(page.url)
            if m:
                return m.group(1), f"https://www.raidbots.com/simbot/report/{m.group(1)}"
            body = self.text(page)
            if body != before:
                new_lines = [l for l in body.splitlines() if l.strip() and l not in before]
                hit = next((l for l in new_lines if LIMIT_RE.search(l)), None)
                if hit:
                    raise SubmitLimit(hit.strip()[:200])
            page.wait_for_timeout(1000)
        body = self.text(page)
        m = re.search(r"(?im)^.*(error|limit|premium|login|sign in).*$", body)
        raise RuntimeError("po kliknutí na Run se neobjevil report" + (f": {m.group(0).strip()[:200]}" if m else ""))

    # -- Top Gear (třetí sim z nejlepších raid + M+ itemů) --
    @staticmethod
    def topgear_combos(page):
        """Z řádku "ITERATIONS: 6,480,000 / 5,500,000 (1,296 COMBINATIONS)" u tlačítka FIND TOP GEAR
        vrátí (kombinace, iterace, limit iterací účtu) – cokoli None, když řádek chybí."""
        body = Raidbots.text(page)
        m = re.search(r"ITERATIONS:\s*([\d,]+)\s*/\s*([\d,]+)\s*\(([\d,]+)\s+COMBINATIONS?\)", body, re.I)
        if m:
            return int(m.group(3).replace(",", "")), int(m.group(1).replace(",", "")), int(m.group(2).replace(",", ""))
        m = re.search(r"\(([\d,]+)\s+COMBINATIONS?\)", body, re.I)
        return (int(m.group(1).replace(",", "")) if m else None), None, None

    def topgear_boxes(self, page, item_id):
        """Karty itemu (div.item) s daným ID – nasazený kus, kopie z bagu, kandidát z Droptimizeru…
        Wowhead odkaz karty je "item=ID?bonus=…", ale u zbraní bez bonusů jen "item=ID" (nic za ID)."""
        return page.locator(", ".join(f'div.item:has(a[href{op}"item={item_id}{tail}"])'
                                      for op, tail in (("*=", "?"), ("*=", "&"), ("*=", "#"), ("*=", "/"), ("$=", ""))))

    def topgear_include(self, page, cand):
        """Zaškrtne v Top Gearu náš kandidát: mezi kartami s jeho ID vezme ŠEDOU (nezahrnutou)
        kopii, nejraději tu, jejíž wowhead odkaz nese naše bonus_id (Myth 6/6). Zlatou
        (= nasazený/zahrnutý item) nechává být – odškrtnutí jediného itemu ve slotu by
        Raidbots položilo ("unable to generate valid combinations")."""
        boxes = self.topgear_boxes(page, cand["id"])
        n = boxes.count()
        if not n:
            return False
        info = [(i, boxes.nth(i).evaluate("el => getComputedStyle(el).borderTopColor"),
                 boxes.nth(i).locator("a[href*='wowhead.com/item=']").first.get_attribute("href") or "") for i in range(n)]
        gray = [x for x in info if x[1] not in INCLUDED]
        if not gray:
            return True   # už zahrnutý (např. nasazený stejný kus, nebo červený off hand čekající na main hand)
        def bonus_ok(href):
            m = re.search(r"bonus=([\d:]+)", href)
            have = set(m.group(1).split(":")) if m else set()
            return cand["bonus"] <= have
        pick = next((x for x in gray if bonus_ok(x[2])), gray[0])
        box = boxes.nth(pick[0])
        box.scroll_into_view_if_needed()
        # klik do levého horního rohu karty – uprostřed bývá odkaz na Wowhead (u zbraní přes celou šířku),
        # ten by jen otevřel nový panel a kartu nepřepnul
        try:
            box.click(timeout=5000, position={"x": 6, "y": 6})
        except Exception:
            box.evaluate("el => el.click()")
        page.wait_for_timeout(400)
        if box.evaluate("el => getComputedStyle(el).borderTopColor") in INCLUDED:
            return True
        box.evaluate("el => el.click()")   # záloha: syntetický klik přímo na kartu
        page.wait_for_timeout(500)
        ok = box.evaluate("el => getComputedStyle(el).borderTopColor") in INCLUDED
        if not ok:
            log(f"   Top Gear: karta {cand['name']} ({cand['id']}) se nedá zaškrtnout (rámeček {box.evaluate('el => getComputedStyle(el).borderTopColor')})")
        return ok

    def topgear_exclude(self, page, cand):
        """Odškrtne zlatou kartu kandidáta (ne nasazený kus – ten má jiné bonus_id)."""
        boxes = self.topgear_boxes(page, cand["id"])
        for i in range(boxes.count()):
            b = boxes.nth(i)
            href = b.locator("a[href*='wowhead.com/item=']").first.get_attribute("href") or ""
            m = re.search(r"bonus=([\d:]+)", href)
            have = set(m.group(1).split(":")) if m else set()
            if b.evaluate("el => getComputedStyle(el).borderTopColor") == GOLD and cand["bonus"] and cand["bonus"] <= have and boxes.count() > 1:
                b.click()
                page.wait_for_timeout(400)
                return True
        return False

    def gold_cards(self, page):
        """Zahrnuté (zlaté) karty: [{card, group, item, bonus:set}] – card = DOM id "head-0/item"."""
        return page.evaluate("""(gold) => Array.from(document.querySelectorAll('div.item')).filter(e => getComputedStyle(e).borderTopColor === gold).map(e => {
            const a = e.querySelector('a[href*="wowhead.com/item="]'); const m = a && /item=(\\d+)\\?bonus=([\\d:]*)/.exec(a.getAttribute('href'));
            return { card: e.id, group: e.id.split('-')[0], item: m ? m[1] : '', bonus: m && m[2] ? m[2].split(':') : [] }; })""", GOLD)

    def topgear_drop_equipped(self, page, included, equipped):
        """Odškrtne nasazené kusy, které jsou o >= topgear_replace_gap ilvl horší než kandidát ve
        stejné skupině (Droptimizer už řekl, že kandidát je lepší) – každý ušetří polovinu
        kombinací. Ve skupině musí zůstat dost karet (prsteny/trinkety 2, jinak 1); zbraně se
        nechávají (2H vs. 1H + OH řeší až Top Gear). Vrací počet odškrtnutých."""
        gap = int(self.cfg.get("topgear_replace_gap", 10))
        if not equipped or gap <= 0:
            return 0
        dropped = 0
        for group, eqs in equipped.items():
            if group in WEAPON_SLOTS:
                continue
            cand = [c for c in included if c["group"] == group]
            if not cand:
                continue
            best_ilvl = max(c["ilvl"] for c in cand)
            need = 2 if group in ("rings", "trinkets") else 1
            for eq in sorted(eqs, key=lambda e: e["ilvl"]):
                if not eq["ilvl"] or best_ilvl - eq["ilvl"] < gap:
                    continue
                gold = [g for g in self.gold_cards(page) if g["group"] == group]
                if len(gold) - 1 < need:
                    break
                card = next((g for g in gold if g["item"] == eq["id"] and (not eq["bonus"] or eq["bonus"] <= set(g["bonus"]))), None) \
                    or next((g for g in gold if g["item"] == eq["id"]), None)
                if not card:
                    continue
                before = self.topgear_combos(page)
                el = page.locator("[id='" + card["card"] + "']").first
                try:
                    el.click(timeout=5000)
                except Exception:
                    el.evaluate("el => el.click()")
                page.wait_for_timeout(700)
                if "unable to generate valid combinations" in self.text(page).lower():
                    el.click()   # vrátit zpět
                    page.wait_for_timeout(500)
                    continue
                dropped += 1
                after = self.topgear_combos(page)
                log(f"   Top Gear: odškrtávám nasazený {group} ({eq['ilvl']} ilvl, kandidát {best_ilvl}) – kombinací {before[0] or '?'} → {after[0] or '?'}")
        return dropped

    def setup_topgear(self, page, simc, cands, equipped=None):
        """Načte string s kandidáty do Top Gearu, zaškrtne je, odškrtne slabé nasazené kusy a ohlídá
        limit kombinací/iterací. Vrací (zahrnutí kandidáti, počet kombinací)."""
        self.load_simc(page, topgear_input(simc, cands), url=TOPGEAR_URL, ready="div.item")
        included = []
        # off hand (doplněk k 1H zbrani) zaškrtnout PŘED main handem: s nasazenou 2H zbraní Raidbots 1H kartu
        # nepustí, dokud není vybraný off hand (ten je do té doby červený = čeká na protějšek)
        order = sorted(cands, key=lambda c: 0 if c["group"] == "off_hand" else 1)
        for c in order:
            if self.topgear_include(page, c):
                included.append(c)
            else:
                log(f"   Top Gear: item {c['name']} ({c['id']}) se nepodařilo zahrnout (karta chybí nebo nejde zaškrtnout), vynechávám")
                if c["group"] in WEAPON_SLOTS or c.get("protected"):
                    # diagnostika: jaké karty zbraní Raidbots v Top Gearu vůbec ukazuje
                    cards = page.evaluate("""() => Array.from(document.querySelectorAll('div.item')).filter(e => /hand|weapon|ranged/i.test(e.id))
                        .map(e => { const a = e.querySelector('a[href*="wowhead.com/item="]'); return e.id + ':' + (a ? a.getAttribute('href').split('wowhead.com/')[1] : '?'); })""")
                    log(f"   Top Gear: karty zbraní na stránce: {', '.join(cards) if cards else 'žádné'}")
        page.wait_for_timeout(1200)
        self.topgear_drop_equipped(page, included, equipped)
        combos, iters, cap = self.topgear_combos(page)
        for _ in range(8):   # počítadlo se někdy vykreslí se zpožděním
            if combos is not None:
                break
            page.wait_for_timeout(500)
            combos, iters, cap = self.topgear_combos(page)
        limit = int(self.cfg.get("topgear_max_combos", 20000))
        min_items = int(self.cfg.get("topgear_min_items", 4))
        unable = "unable to generate valid combinations"
        # moc kombinací / iterací nad limit účtu → ubírej nejslabší kandidáty (zbraně až nakonec);
        # bez počítadla (Raidbots ho při obřím počtu kombinací neukazuje) také ubírat – ale jen dokud
        # ve skupině zbude dost zlatých karet (prsteny/trinkety 2, jinak 1): odškrtnutý nasazený kus +
        # poslední kandidát = prázdný slot = "unable to generate valid combinations"
        def too_many():
            return combos is None or (combos and combos > limit) or (iters and cap and iters > cap)
        def removable(c, gold):
            need = 2 if c["group"] in ("rings", "trinkets") else 1
            in_group = [g for g in gold if slot_group_of_card(g["group"]) == c["group"]]
            return len(in_group) - 1 >= need
        keep = set()   # kandidáti, které nejde odebrat (jediný item ve slotu)
        none_streak = 0
        while too_many() and len(included) > min_items:
            gold = self.gold_cards(page)
            pool = [c for c in included if id(c) not in keep and removable(c, gold)]
            if not pool:
                log(f"   Top Gear: {combos} kombinací / {iters} iterací (limit {cap}) je moc, ale žádný kandidát už nejde odebrat (každý je jediný ve svém slotu)")
                break
            weakest = min(pool, key=lambda c: (c["protected"], c["gain"]))
            log(f"   Top Gear: {combos} kombinací / {iters} iterací (limit {cap}) je moc, vynechávám {weakest['name']}")
            before = (combos, iters)
            self.topgear_exclude(page, weakest)
            # počítadlo se přepočítává se zpožděním – počkat, až se změní (max ~6 s)
            for _ in range(12):
                page.wait_for_timeout(500)
                combos, iters, cap = self.topgear_combos(page)
                if (combos, iters) != before and combos is not None:
                    break
                if unable in self.text(page).lower():
                    break
            if unable in self.text(page).lower():
                # bez toho itemu je slot prázdný → vrátit zpět a dál ho nechat být
                log(f"   Top Gear: bez {weakest['name']} Raidbots nemá platnou kombinaci – vracím ho zpět")
                self.topgear_include(page, weakest)
                keep.add(id(weakest))
                page.wait_for_timeout(700)
                combos, iters, cap = self.topgear_combos(page)
                continue
            included.remove(weakest)
            if combos is None:
                none_streak += 1
                if none_streak >= 3:
                    log("   Top Gear: počítadlo kombinací se neukazuje ani po třech úbytcích – dál neubírám")
                    break
            else:
                none_streak = 0
        if unable in self.text(page).lower():
            raise RuntimeError("Top Gear: Raidbots hlásí „unable to generate valid combinations“")
        btn = page.get_by_role("button", name=re.compile(r"find top gear", re.I))
        if btn.count() and btn.first.is_disabled():
            raise RuntimeError(f"Top Gear: tlačítko FIND TOP GEAR je neaktivní ({combos} kombinací, {iters}/{cap} iterací)")
        log(f"   Top Gear: {len(included)} itemů, {combos} kombinací, {iters}/{cap} iterací")
        return included, combos

    # -- report polling (neblokující, volá se v cyklu pro všechny běžící) --
    @staticmethod
    def report_ready(report_id):
        """data.json reportu je veřejný a existuje až po dokončení simu."""
        data_url = f"https://www.raidbots.com/reports/{report_id}/data.json"
        try:
            r = requests.head(data_url, timeout=30, allow_redirects=True)
            if r.status_code == 200:
                r2 = requests.get(data_url, timeout=120)
                return r2.status_code == 200 and '"sim"' in r2.text[:200000]
        except requests.RequestException:
            pass
        return False

    @staticmethod
    def job_state(report_id):
        try:
            j = requests.get(f"https://www.raidbots.com/api/job/{report_id}", timeout=30)
            if j.ok:
                jj = j.json()
                job = jj.get("job", jj)
                state = str(job.get("state") or job.get("status") or "")
                prog = job.get("progress")
                if isinstance(prog, (int, float)):
                    state += f" {prog:.0f}%"
                return state
        except (requests.RequestException, ValueError):
            pass
        return ""

    def report_failed(self, page):
        try:
            body = self.text(page)
        except Exception:
            return ""
        m = re.search(r"(?i)simulation (failed|error)|sim failed|encountered an error", body)
        return m.group(0) if m else ""

    # -- QE Live Upgrade Finder (healeři) --
    @staticmethod
    def js_click(page, text):
        """Klik přes DOM na tlačítko s daným textem (spodní lišta QE bývá pod cookie banerem)."""
        return page.evaluate(
            "(t) => { const b = Array.from(document.querySelectorAll('button')).find(b => b.innerText.trim() === t);"
            " if (!b || b.disabled) return false; b.click(); return true; }", text)

    def run_qe(self, page, simc, qe_spec, dry_run=False):
        """QE Live: vybere spec, importuje SimC, zkontroluje obtížnost a klikne GO!. Vrátí URL reportu."""
        page.goto(QE_URL, wait_until="domcontentloaded")
        self.settle(page, 2000)
        # 1) Current Spec (musí být před importem, jinak QE gear nepřevezme)
        combo = page.locator("div[role=combobox], div[role=button]").filter(has_text=re.compile("Druid|Priest|Shaman|Paladin|Monk|Evoker")).first
        if combo.count() == 0:
            raise RuntimeError("QE Live: nenašel jsem výběr specu")
        if qe_spec not in combo.inner_text():
            combo.click()
            page.wait_for_timeout(800)
            opt = page.locator("[role=listbox] [role=option], li[role=option]").filter(has_text=qe_spec).first
            if opt.count() == 0:
                page.keyboard.press("Escape")
                raise RuntimeError(f"QE Live: spec „{qe_spec}“ není v nabídce")
            opt.click()
            page.wait_for_timeout(1200)
        # 2) Import Gear
        page.locator("button", has_text=re.compile("import gear", re.I)).first.click(timeout=10000)
        page.wait_for_timeout(1000)
        page.locator("[role=dialog] textarea").first.fill(simc)
        page.wait_for_timeout(500)
        page.locator("[role=dialog] button", has_text=re.compile("submit", re.I)).first.click()
        page.wait_for_timeout(2500)
        name = simc_name(simc)
        body = self.text(page)
        if name and name not in body:
            raise RuntimeError(f"QE Live nepřevzal gear – na stránce není „{name}“ (sedí spec {qe_spec}?)")
        # 3) obtížnost (toggle s aria-pressed)
        diff = self.cfg["difficulty"]
        btn = page.locator("button", has_text=re.compile(rf"^\s*{re.escape(diff)}\s*$")).first
        if btn.count() and btn.get_attribute("aria-pressed") != "true":
            btn.click()
            page.wait_for_timeout(600)
        if btn.count() and btn.get_attribute("aria-pressed") != "true":
            raise RuntimeError(f"QE Live: nepodařilo se vybrat obtížnost „{diff}“")
        # Mythic+ klíč (+10 = Myth track) a typy "Upgraded"/"Bonus Roll" (dungeonový item
        # na 334 = Myth 6/6 je v QE pod dropType "bonus"); ve výchozím stavu zapnuté, jen pojistka
        for label in (self.cfg.get("qe_mplus_key", "+10"), "Bonus Roll", "Upgraded"):
            t = page.locator("button", has_text=re.compile(r"^\s*" + re.escape(label) + r"\s*$")).first
            if t.count() and t.get_attribute("aria-pressed") == "false":
                t.click()
                page.wait_for_timeout(500)
        if dry_run:
            return None
        # 4) GO! – výpočet je v prohlížeči, URL se hned změní na /live/upgradereport/<id>
        if not self.js_click(page, "GO!"):
            raise RuntimeError("QE Live: tlačítko GO! není aktivní")
        try:
            page.wait_for_url(QE_REPORT_RE, timeout=60000)
        except Exception:
            raise RuntimeError("QE Live: po GO! se neobjevil report")
        m = QE_REPORT_RE.search(page.url)
        return f"https://questionablyepic.com/live/upgradereport/{m.group(1)}"


# ------------------------------------------------------------------- main ----

def cmd_login(cfg, export=None):
    rb = Raidbots(cfg, headless=False)
    try:
        rb.home.goto(AUTH_URL, wait_until="domcontentloaded")
        print("V otevřeném okně se přihlas do Raidbots (Premium účet).")
        print("Případně si v Droptimizeru nastav Simulation Options (Patchwerk, 1 boss, 5 min, High Precision) – pamatují se.")
        input("Až budeš hotový, stiskni Enter tady v konzoli… ")
        ok = rb.logged_in()
        print("Přihlášení: OK" if ok else "Pozor: stránka stále ukazuje LOGIN – nejsi přihlášený.")
        if export:
            rb.export_state(export)
            print(f"\nPřihlášení uloženo do {export}.")
            print("Pro GitHub Actions: obsah souboru vlož do secretu RAIDBOTS_STORAGE_STATE")
            print(f"(repo → Settings → Secrets and variables → Actions). Soubor je v .gitignore, necommituj ho.")
    finally:
        rb.close()


# ---------- Discord (bot API – z GitHubu, Google servery Discord blokuje) ----------
DISCORD_API = "https://discord.com/api/v10"


def discord_headers():
    token = os.environ.get("DISCORD_BOT_TOKEN", "").strip()
    if not token:
        raise RuntimeError("chybí env DISCORD_BOT_TOKEN")
    return {"Authorization": f"Bot {token}", "Content-Type": "application/json"}


def discord_post(channel_id, text, user_id=""):
    payload = {"content": text, "allowed_mentions": {"users": [user_id] if user_id else []}}
    r = requests.post(f"{DISCORD_API}/channels/{channel_id}/messages", headers=discord_headers(),
                      data=json.dumps(payload).encode("utf-8"), timeout=60)
    if r.status_code >= 300:
        raise RuntimeError(f"Discord HTTP {r.status_code}: {r.text[:160]}")


def handle_notify(api, row, res):
    """Apps Script u `done` vrátí notify={channelId,userId,text,player}, když má zprávu poslat bot z runneru."""
    n = res.get("notify") if isinstance(res, dict) else None
    if not n or not n.get("channelId"):
        return
    character = row["character"]
    try:
        discord_post(n["channelId"], n.get("text") or f"Simy pro {character} jsou hotové.", n.get("userId") or "")
        result = f"Discord ✔ {n.get('player') or ''} (bot)".strip()
        log(f"   {character}: Discord zpráva poslána do místnosti {n.get('player') or n['channelId']}")
    except Exception as err:  # noqa: BLE001
        result = f"Discord ✖ {str(err)[:120]}"
        log(f"   ⚠ {character}: Discord zpráva selhala: {err}")
    try:
        api.notified(row["row"], character, result)
    except Exception as err:  # noqa: BLE001
        log(f"   (výsledek Discord zprávy se nezapsal: {err})")


def cmd_discord_rooms(cfg):
    """Bot vypíše kanály serveru a pošle je Apps Scriptu, který naplní list "Discord" (místnosti hráčů)."""
    guild = os.environ.get("DISCORD_GUILD_ID", "").strip()
    if not guild:
        sys.exit("chybí env DISCORD_GUILD_ID (ID Discord serveru)")
    h = discord_headers()
    me = requests.get(f"{DISCORD_API}/users/@me", headers=h, timeout=60)
    me.raise_for_status()
    ch = requests.get(f"{DISCORD_API}/guilds/{guild}/channels", headers=h, timeout=60)
    if ch.status_code >= 300:
        sys.exit(f"Discord HTTP {ch.status_code}: {ch.text[:200]} – je bot pozvaný na server {guild}?")
    channels = ch.json()
    # jen co Apps Script potřebuje: kategorie + textové kanály, z oprávnění jen členové (type 1) s allow
    slim = []
    for c in channels:
        if c.get("type") not in (0, 4, 5):
            continue
        slim.append({"id": c.get("id"), "name": c.get("name"), "type": c.get("type"), "parent_id": c.get("parent_id"),
                     "permission_overwrites": [{"id": o.get("id"), "type": o.get("type"), "allow": o.get("allow")}
                                               for o in (c.get("permission_overwrites") or []) if int(o.get("type", 0)) == 1]})
    log(f"Discord: {len(slim)} kanálů na serveru {guild}, bot {me.json().get('username')}")
    api = SheetApi(cfg)
    res = api.post("rooms", guild=guild, me=me.json().get("id", ""), channels=slim)
    print(res.get("message") or res)


def cmd_discord_test(cfg, character):
    """Testovací Discord zpráva pro postavu: Apps Script ji připraví (notify_test), bot z runneru pošle."""
    if not character:
        sys.exit("chybí --character (nebo env DISCORD_TEST_CHARACTER)")
    api = SheetApi(cfg)
    res = api.call("notify_test", character=character)
    n = res.get("notify")
    tgt = res.get("target") or {}
    log(f"{character} → hráč {tgt.get('player') or '?'}; " + (res.get("note") or ""))
    if not n or not n.get("channelId"):
        sys.exit("Apps Script nevrátil zprávu pro bota – hráč nemá v listu Discord Kanál URL (nebo má webhook, pak se poslalo přímo).")
    discord_post(n["channelId"], n.get("text") or f"Test: {character}", n.get("userId") or "")
    log(f"Testovací zpráva poslána do místnosti {n.get('player') or n['channelId']}.")


def cmd_pending(cfg):
    """Jen spočítá frontu (GitHub Actions: přeskočí instalaci Chromia, když není co dělat)."""
    api = SheetApi(cfg)
    rows = api.queue()
    n = len(rows)
    print(f"Ve frontě: {n}" + (": " + ", ".join(f"{r['character']} ({r['spec']})" for r in rows) if n else ""))
    out = os.environ.get("GITHUB_OUTPUT")
    if out:
        with open(out, "a", encoding="utf-8") as f:
            f.write(f"count={n}\n")


def rkey(row):
    return f"{row['character']} (ř.{row['row']})"


_db_warned = False


def store_db(cfg, row, url, kind):
    """Po hotovém simu uložit výsledky i do databáze (Worker API, sim_results.py). Bez tokenu jen upozorní;
    chyba nikdy nezastaví běh – Sheets zápis (api.done) proběhl nezávisle."""
    global _db_warned
    if not cfg.get("api_token"):
        if not _db_warned:
            log("   DB: ES_API_TOKEN / api_token není nastavený – výsledky jdou jen do Sheets")
            _db_warned = True
        return
    es = sim_results.EsApi(cfg["api_url"], cfg["api_token"])
    tag = f"{row['character']} [{kind_label(kind)}]"
    if kind == "topgear-skip":
        try:
            es.delete(row["character"], row["spec"], "topgear")
            log(f"   {tag}: DB – starý Top Gear řádek smazán (nic není upgrade)")
        except Exception as err:  # noqa: BLE001
            log(f"   ⚠ {tag}: DB smazání Top Gearu selhalo: {err}")
        return
    res = sim_results.store_report(es, row["character"], row["spec"], url, kind)
    log(f"   {tag}: DB {'✅ ' + res['message'] if res['ok'] else '⚠ ' + res['message']}")


def fail_row(api, row, msg):
    log(f"   ⚠ {row['character']}: {msg}")
    try:
        api.error(row["row"], row["character"], f"sim_runner: {msg}")
    except Exception as err2:  # noqa: BLE001
        log(f"   (nepodařilo se zapsat chybu do Sheets: {err2})")


def qe_row(rb, api, row, dry_run):
    """Healer: QE Live Upgrade Finder – hotovo během pár sekund, rovnou upload."""
    character = row["character"]
    qe_spec = QE_SPECS.get((simc_class(row["simc"]), row["spec"].lower()))
    if not qe_spec:
        fail_row(api, row, f"healer spec {row['spec']} – nevím, jaký spec vybrat v QE Live")
        return "error"
    page = rb.new_tab()
    try:
        url = rb.run_qe(page, row["simc"], qe_spec, dry_run)
        if dry_run:
            rb.screenshot(page, f"dryrun_qe_{strip_accents(character)}")
            log(f"   {character}: dry-run QE Live ({qe_spec}) – import OK, GO! nekliknuto")
            return "dry"
        log(f"   {character}: QE Live report {url}")
        res = api.done(row["row"], character, url, "qe")
        log(f"   {character}: {res.get('message') or res}")
        store_db(rb.cfg, row, url, "qe")
        return "done" if res.get("ok") else "error"
    except Exception as err:  # noqa: BLE001
        rb.screenshot(page, f"error_qe_{strip_accents(character)}")
        fail_row(api, row, str(err).splitlines()[0][:300])
        return "error"
    finally:
        page.close()


def submit_row(rb, api, row, kind, dry_run):
    """Otevře panel, nahraje SimC, nastaví (raid / mplus) a klikne Run. Vrací dict aktivního simu nebo None."""
    character = row["character"]
    tag = f"{character} [{kind_label(kind)}]"
    page = rb.new_tab()
    try:
        rb.load_simc(page, row["simc"])
        rb.configure(page, kind)
        if dry_run:
            rb.screenshot(page, f"dryrun_{kind}_{strip_accents(character)}")
            log(f"   {tag}: dry-run – nastavení OK, Run nekliknuto")
            page.close()
            return None
        report_id, url = rb.run(page)
        log(f"   {tag}: spuštěno {url}")
        try:
            api.running(row["row"], character, url, kind)
        except Exception as err:  # noqa: BLE001
            log(f"   (stav 🔄 se nezapsal: {err})")
        return {"row": row, "kind": kind, "page": page, "id": report_id, "url": url,
                "deadline": time.time() + rb.cfg["sim_timeout_min"] * 60, "state": ""}
    except SubmitLimit:
        page.close()
        raise
    except Exception as err:  # noqa: BLE001
        rb.screenshot(page, f"error_{kind}_{strip_accents(character)}")
        page.close()
        fail_row(api, row, f"[{kind_label(kind)}] " + str(err).splitlines()[0][:300])
        return None


def submit_topgear(rb, api, row, reports, dry_run):
    """Třetí sim: Top Gear z nejlepších raid + M+ itemů. reports = {"raid": id, "mplus": id}."""
    character = row["character"]
    tag = f"{character} [Top Gear]"
    try:
        raid = fetch_report(reports["raid"]) if reports.get("raid") else None
        mplus = fetch_report(reports["mplus"]) if reports.get("mplus") else None
    except Exception as err:  # noqa: BLE001
        fail_row(api, row, f"[Top Gear] nejde stáhnout data.json Droptimizerů: {str(err)[:200]}")
        return None
    cands = topgear_candidates(raid, mplus, rb.cfg)
    equipped = equipped_items(raid) or equipped_items(mplus)
    if len(cands) < 1:
        log(f"   {tag}: žádný item není upgrade – Top Gear není potřeba")
        try:
            api.note(row["row"], character, "Top Gear: žádný kandidát (nic není upgrade)")
            res = api.done(row["row"], character, "", "topgear-skip")
            handle_notify(api, row, res)
            log(f"   {tag}: {res.get('message') or res}")
        except Exception as err:  # noqa: BLE001
            log(f"   (poznámka se nezapsala: {err})")
        store_db(rb.cfg, row, "", "topgear-skip")
        return None
    log(f"   {tag}: kandidáti: " + ", ".join(f"{c['name']} ({kind_label(c['kind'])} {c['gain']:+.2f}%{', zbraň' if c['protected'] else ''})" for c in cands if not c.get("companion")))
    page = rb.new_tab()
    try:
        included, combos = rb.setup_topgear(page, row["simc"], cands, equipped)
        log(f"   {tag}: zaškrtnuto {len(included)} itemů, {combos if combos is not None else '?'} kombinací")
        if not included:
            raise RuntimeError("Top Gear: žádný kandidát se nepodařilo zaškrtnout")
        if dry_run:
            rb.screenshot(page, f"dryrun_topgear_{strip_accents(character)}")
            log(f"   {tag}: dry-run – nastavení OK, Find Top Gear nekliknuto")
            page.close()
            return None
        report_id, url = rb.run(page, r"find top gear")
        log(f"   {tag}: spuštěno {url}")
        try:
            api.running(row["row"], character, url, "topgear")
        except Exception as err:  # noqa: BLE001
            log(f"   (stav 🔄 se nezapsal: {err})")
        return {"row": row, "kind": "topgear", "page": page, "id": report_id, "url": url,
                "deadline": time.time() + rb.cfg["sim_timeout_min"] * 60, "state": ""}
    except SubmitLimit:
        page.close()
        raise
    except Exception as err:  # noqa: BLE001
        rb.screenshot(page, f"error_topgear_{strip_accents(character)}")
        page.close()
        fail_row(api, row, "[Top Gear] " + str(err).splitlines()[0][:300])
        return None


def finish_sim(rb, api, sim):
    row, character = sim["row"], sim["row"]["character"]
    tag = f"{character} [{kind_label(sim['kind'])}]"
    log(f"   {tag}: sim hotový, zapisuji výsledky…")
    try:
        res = api.done(row["row"], character, sim["url"], sim["kind"])
        log(f"   {tag}: {res.get('message') or res}")
        ok = bool(res.get("ok"))
        handle_notify(api, row, res)
    except Exception as err:  # noqa: BLE001
        log(f"   ⚠ {character}: upload selhal: {err}")
        ok = False
    store_db(rb.cfg, row, sim["url"], sim["kind"])
    sim["page"].close()
    return "done" if ok else "error"


def cmd_run(cfg, args):
    api = SheetApi(cfg)
    rows = api.queue()
    if args.row:
        rows = [r for r in rows if r["row"] == args.row]
    if args.max:
        rows = rows[:args.max]
    if not rows:
        log("Fronta je prázdná – nic k simování.")
        return
    log(f"Ve frontě: {len(rows)} řádků: " + ", ".join(f"{r['character']} ({r['spec']})" for r in rows))

    results = {}
    todo = deque()   # (row, kind) – raid i M+ Droptimizer za každou postavu; hotové reporty se přeskočí
    healers = []
    want_mplus = bool(cfg.get("mplus", True))
    want_topgear = bool(cfg.get("topgear", True))
    want_raidhc = bool(cfg.get("raidhc", True))   # u každého řádku (i bez vaultu) – z HC reportu je doporučení bonus rollu
    # hotové Droptimizer reporty postavy (z listu i z tohohle běhu) – až jsou oba, jede Top Gear
    reports = {}
    def topgear_ready(row):
        r = reports.get(row["row"], {})
        return want_topgear and not row.get("report_topgear") and r.get("raid") and (r.get("mplus") or not want_mplus)
    for row in rows:
        if not row["simc"].strip():
            fail_row(api, row, "prázdný SimC string")
            results[rkey(row)] = "error"
        elif row["spec"].lower() in HEALER_SPECS:
            healers.append(row)
        else:
            reports[row["row"]] = {k: report_id_from_url(row.get("report_" + k)) for k in ("raid", "mplus") if row.get("report_" + k)}
            kinds = [k for k in ("raid", "mplus") if (k == "raid" or want_mplus) and not row.get("report_" + k)]
            if want_raidhc and not row.get("report_raidhc"):
                kinds.append("raidhc")
            for k in kinds:
                todo.append((row, k))
            if not kinds:
                if topgear_ready(row):
                    todo.append((row, "topgear"))
                else:
                    log(f"   {row['character']}: všechny reporty už existují, nic k simování (řádek {row['row']})")
    if not todo and not healers:
        log("Hotovo: " + ", ".join(f"{k}: {v}" for k, v in results.items()))
        return

    parallel = max(1, args.parallel or int(cfg.get("parallel", 10)))
    state = args.storage_state or os.environ.get("SIM_STORAGE_STATE") or None
    if state and not Path(state).is_file():
        sys.exit(f"Soubor s přihlášením Raidbots neexistuje: {state}")
    rb = Raidbots(cfg, headless=args.headless, storage_state=state)
    active = []
    try:
        if todo and not rb.logged_in():
            email, password = os.environ.get("RAIDBOTS_EMAIL", "").strip(), os.environ.get("RAIDBOTS_PASSWORD", "")
            if email and password:
                log("V Raidbots nejsi přihlášený – přihlašuji e-mailem a heslem (RAIDBOTS_EMAIL)…")
                if rb.login_with_password(email, password):
                    log("Přihlášení do Raidbots: OK")
                else:
                    log("Pozor: přihlášení e-mailem selhalo – simy poběží bez Premium (pomalejší fronta, jen 1 sim).")
            else:
                log("Pozor: v Raidbots nejsi přihlášený (běží to bez Premium – pomalejší fronta a jen 1 sim). Přihlášení: python sim_runner.py login, nebo env RAIDBOTS_EMAIL + RAIDBOTS_PASSWORD")
        for row in healers:
            log(f"▶ {row['character']} ({row['spec']}) – řádek {row['row']} – healer → QE Live")
            results[rkey(row)] = qe_row(rb, api, row, args.dry_run)
        if todo:
            log(f"Posílám až {parallel} simů najednou ({'raid + M+' if want_mplus else 'jen raid'} Droptimizer"
                f"{' + Top Gear' if want_topgear else ''}{' + HC raid' if want_raidhc else ''} za postavu).")
        while todo or active:
            # 1) doplnit běžící simy do limitu
            while todo and len(active) < parallel:
                row, kind = todo.popleft()
                key = f"{rkey(row)} {kind_label(kind)}"
                log(f"▶ {row['character']} ({row['spec']}) – řádek {row['row']} – {kind_label(kind)}")
                try:
                    if kind == "topgear":
                        sim = submit_topgear(rb, api, row, reports.get(row["row"], {}), args.dry_run)
                    else:
                        sim = submit_row(rb, api, row, kind, args.dry_run)
                except SubmitLimit as lim:
                    todo.appendleft((row, kind))
                    parallel = max(1, len(active))
                    log(f"   Raidbots nepustil další sim ({lim}); dál jedu s {parallel} najednou.")
                    if not active:
                        log("   Žádný sim neběží a Raidbots přesto odmítá – čekám 60 s a zkusím znovu.")
                        time.sleep(60)
                    break
                if sim:
                    active.append(sim)
                elif args.dry_run:
                    results[key] = "dry"
                else:
                    results[key] = "error"
            if not active:
                continue
            # 2) zkontrolovat běžící
            time.sleep(cfg["poll_seconds"])
            still = []
            for sim in active:
                ch = sim["row"]["character"]
                key = f"{rkey(sim['row'])} {kind_label(sim['kind'])}"
                tagk = f"[{kind_label(sim['kind'])}] "
                if rb.report_ready(sim["id"]):
                    results[key] = finish_sim(rb, api, sim)
                    if results[key] == "done" and sim["kind"] in ("raid", "mplus"):
                        reports.setdefault(sim["row"]["row"], {})[sim["kind"]] = sim["id"]
                        if topgear_ready(sim["row"]):
                            sim["row"]["report_topgear"] = "pending"   # ať se nezařadí dvakrát
                            todo.append((sim["row"], "topgear"))
                            log(f"   {ch}: raid i M+ hotové → řadím Top Gear")
                    continue
                failed = rb.report_failed(sim["page"])
                if failed:
                    rb.screenshot(sim["page"], f"simfail_{sim['kind']}_{strip_accents(ch)}")
                    sim["page"].close()
                    fail_row(api, sim["row"], tagk + f"Raidbots hlásí chybu simulace ({failed}) {sim['url']}")
                    results[key] = "error"
                    continue
                if time.time() > sim["deadline"]:
                    sim["page"].close()
                    fail_row(api, sim["row"], tagk + f"sim nedoběhl do {cfg['sim_timeout_min']} minut {sim['url']}")
                    results[key] = "error"
                    continue
                state = rb.job_state(sim["id"])
                if state and state != sim["state"]:
                    log(f"   {ch} {tagk}: {state}")
                    sim["state"] = state
                still.append(sim)
            active = still
            log(f"   běží {len(active)}, ve frontě {len(todo)}")
    finally:
        if args.keep_open:
            input("Prohlížeč nechávám otevřený – Enter zavře… ")
        rb.close()
    log("Hotovo: " + ", ".join(f"{k}: {v}" for k, v in results.items()))


def main():
    ap = argparse.ArgumentParser(description="Raidbots Droptimizer runner pro Sim frontu")
    ap.add_argument("command", nargs="?", default="run", choices=["run", "setup", "login", "pending", "discord-rooms", "discord-test"])
    ap.add_argument("--character", help="(discord-test) postava, pro kterou poslat testovací Discord zprávu")
    ap.add_argument("--parallel", type=int, help="kolik simů najednou, každý ve vlastním panelu (výchozí z configu, 10)")
    ap.add_argument("--storage-state", metavar="FILE", help="JSON s přihlášením Raidbots z `login --export` (jinak env SIM_STORAGE_STATE / trvalý profil)")
    ap.add_argument("--export", nargs="?", const=str(HERE / "raidbots_state.json"), metavar="FILE",
                    help="(login) po přihlášení uložit cookies/localStorage do souboru pro GitHub Actions")
    ap.add_argument("--dry-run", action="store_true", help="vše kromě kliknutí na Run Droptimizer")
    ap.add_argument("--no-mplus", action="store_true", help="jen raidový Droptimizer, bez Mythic+ dungeonů")
    ap.add_argument("--no-topgear", action="store_true", help="bez třetího simu (Top Gear z nejlepších itemů)")
    ap.add_argument("--no-raidhc", action="store_true", help="bez HC raid Droptimizeru (doporučení bonus rollu / srovnání s vaultem)")
    ap.add_argument("--headless", action="store_true", help="bez okna prohlížeče")
    ap.add_argument("--row", type=int, help="zpracovat jen řádek listu N")
    ap.add_argument("--max", type=int, help="nejvýše N řádků")
    ap.add_argument("--keep-open", action="store_true", help="po skončení nechat prohlížeč otevřený")
    args = ap.parse_args()
    cfg = load_config()
    if args.no_mplus:
        cfg["mplus"] = False
    if args.no_topgear:
        cfg["topgear"] = False
    if args.no_raidhc:
        cfg["raidhc"] = False
    if args.command == "setup":
        cmd_setup(cfg)
    elif args.command == "login":
        cmd_login(cfg, args.export)
    elif args.command == "pending":
        cmd_pending(cfg)
    elif args.command == "discord-rooms":
        cmd_discord_rooms(cfg)
    elif args.command == "discord-test":
        cmd_discord_test(cfg, (args.character or os.environ.get("DISCORD_TEST_CHARACTER", "")).strip())
    else:
        cmd_run(cfg, args)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nPřerušeno.")
