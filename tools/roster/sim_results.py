#!/usr/bin/env python3
"""
sim_results.py – výsledky simů do databáze (Cloudflare D1 přes Worker API).

Nahrazuje list "Sim výsledky" v Google Sheets: Raidbots Droptimizer / Top Gear a QE Live
reporty se tady rozparsují (stejná logika jako storeSimResults_ v class_loot_dropdowns.gs)
a pošlou na Worker (worker/index.js, POST /api/sims/results). Platí poslední sim na postavu
+ spec + původ (Raid | M+ | Top Gear | Raid HC). Stránka Simy (loot.html) čte GET /api/sims/results.

Použití (v tools/roster/):
  python sim_results.py store --character Akka --spec destruction --kind raid --url https://www.raidbots.com/simbot/report/<id>
        kind: raid | mplus | raidhc | topgear (Raidbots) | qe (QE Live = raid i M+ z jednoho reportu)
  python sim_results.py rebuild [--character Akka] [--origin topgear]   # znovu stáhne a rozparsuje uložené reporty (čas simu zůstává)
  python sim_results.py import-sheet                 # jednorázově: list "Sim výsledky" (gviz CSV) → databáze
  python sim_results.py import-extras                # jednorázově: listy "Vault", "Cresty", "Discord" → databáze
  python sim_results.py show [--character Akka]      # výpis, co v databázi je
  python sim_results.py migrate                      # založí tabulky (POST /api/admin/migrate)

Konfigurace: env ES_API_URL (výchozí https://eternal-shadows.vitek-poor.workers.dev) a ES_API_TOKEN
(= secret API_TOKEN Workeru), nebo klíče "api_url" / "api_token" v sim_runner.config.json.
sim_runner.py tenhle modul volá po každém hotovém simu (vedle zápisu do Sheets).
"""
import argparse
import csv
import io
import json
import os
import re
import sys
import unicodedata
from collections import OrderedDict
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import requests

HERE = Path(__file__).resolve().parent
CONFIG_PATH = HERE / "sim_runner.config.json"
DEFAULT_API_URL = "https://eternal-shadows.vitek-poor.workers.dev"
SHEET_ID = "1CUG3oyufoNs5CrY68WMJVVHLJz-52uFQMuOtv5q3ECI"
SHEET_TAB = "Sim výsledky"
SHEET_TZ = ZoneInfo("Europe/Prague")   # časy v listu píše Apps Script v časové zóně tabulky

ORIGIN_LABEL = {"raid": "Raid", "mplus": "M+", "topgear": "Top Gear", "raidhc": "Raid HC"}   # sloupec "Původ" v listu
LABEL_ORIGIN = {v: k for k, v in ORIGIN_LABEL.items()}
KIND_LABEL = {"raid": "raid", "mplus": "M+", "qe": "raid+M+", "topgear": "Top Gear", "raidhc": "HC raid"}
# Raidbots inventoryType → slot (nesimované itemy z encounterItems nemají profileset)
INV_SLOT = {1: "head", 2: "neck", 3: "shoulder", 5: "chest", 20: "chest", 6: "waist", 7: "legs", 8: "feet", 9: "wrist",
            10: "hands", 11: "finger", 12: "trinket", 13: "one_hand", 14: "off_hand", 15: "back", 16: "back", 17: "two_hand",
            21: "main_hand", 22: "off_hand", 23: "off_hand", 26: "ranged"}

RAIDBOTS_RE = re.compile(r"raidbots\.com/(?:simbot/report|reports)/([A-Za-z0-9]{10,40})")
QE_RE = re.compile(r"questionablyepic\.com/(?:live/upgradereport|live/report|api/upgrades)/([A-Za-z0-9_-]{6,80})")
PROFILESET_RE = re.compile(r'^profileset\."([^"]+)"\+?=(.*)$', re.M)


def log(msg):
    print(f"[{datetime.now():%H:%M:%S}] {msg}", flush=True)


def name_key(s):
    """= simNameKey_: bez diakritiky, malá písmena, trim."""
    return "".join(c for c in unicodedata.normalize("NFD", str(s or "")) if unicodedata.category(c) != "Mn").lower().strip()


def spec_key(s):
    """= simSpecKey_: jen malá písmena a-z."""
    return re.sub(r"[^a-z]", "", str(s or "").lower())


def parse_report_link(s):
    """→ {"id", "kind": "raidbots" | "qe", "url"} nebo None (stejné tvary jako parseReportLink_ v gs)."""
    s = str(s or "").strip()
    m = RAIDBOTS_RE.search(s)
    if m:
        return {"id": m.group(1), "kind": "raidbots", "url": f"https://www.raidbots.com/simbot/report/{m.group(1)}"}
    m = QE_RE.search(s)
    if m:
        return {"id": m.group(1), "kind": "qe", "url": f"https://questionablyepic.com/live/upgradereport/{m.group(1)}"}
    if re.fullmatch(r"[A-Za-z0-9]{10,40}", s):
        return {"id": s, "kind": "raidbots", "url": f"https://www.raidbots.com/simbot/report/{s}"}
    return None


def _num(v, default=None):
    if v is None or v == "":
        return default
    try:
        return float(str(v).replace(" ", "").replace(" ", "").replace(",", "."))
    except ValueError:
        return default


def _rnd(x):
    """Zaokrouhlení jako Math.round (půlky nahoru)."""
    return int(x + 0.5) if x >= 0 else -int(-x + 0.5)


def pct_of(mean, base):
    return _rnd((mean - base) / base * 10000) / 100


# ---------------------------------------------------------------- parsery ----

def fetch_json(url, timeout=180):
    r = requests.get(url, timeout=timeout)
    if r.status_code != 200:
        raise RuntimeError(f"HTTP {r.status_code} {url}")
    return r.json()


def fetch_raidbots(report_id):
    return fetch_json(f"https://www.raidbots.com/reports/{report_id}/data.json")


def fetch_raidbots_input(report_id, data):
    """Kompletní SimC vstup: data.json má v simbot.input jen první chunk profilesetů."""
    text = str((data.get("simbot") or {}).get("input") or "")
    try:
        t = requests.get(f"https://www.raidbots.com/reports/{report_id}/input.txt", timeout=180)
        if t.ok and "profileset." in t.text:
            text = t.text
    except requests.RequestException:
        pass
    return text


def fetch_qe(report_id):
    d = fetch_json(f"https://questionablyepic.com/api/getUpgradeReport.php?reportID={requests.utils.quote(report_id)}")
    if isinstance(d, str):   # QE vrací JSON zabalený ve stringu
        d = json.loads(d)
    return d


def base_dps(d):
    sim = d.get("sim") or {}
    players = sim.get("players") or [{}]
    base = _num((((players[0] or {}).get("collected_data") or {}).get("dps") or {}).get("mean"), 0)
    if not base:
        raise RuntimeError("v reportu chybí základní DPS")
    return base


def equipped_ilvl(d):
    """Průměrný ilvl nasazeného gearu (16 slotů, 2H zbraň dvakrát) – jako equippedIlvl_ v gs."""
    gear = ((((d or {}).get("sim") or {}).get("players") or [{}])[0] or {}).get("gear") or {}
    total, n, has_off = 0.0, 0, False
    for slot, it in gear.items():
        il = _num((it or {}).get("ilevel"), 0)
        if not il or il <= 0:
            continue
        if slot == "off_hand":
            has_off = True
        if slot in ("shirt", "tabard"):
            continue
        total += il
        n += 1
    mh = gear.get("main_hand") or {}
    if not has_off and _num(mh.get("ilevel"), 0) > 0:
        total += _num(mh.get("ilevel"))
        n += 1
    return _rnd(total / n * 10) / 10 if n else None


def is_catalyst_item(it):
    tags = [str(t).lower() for t in (it.get("tags") or [])]
    if "catalyst" in tags:
        return True
    src = it.get("sourceItem") or {}
    return bool(it.get("redirected_base_stats") and src.get("id") and not it.get("fromToken"))


def parse_raidbots(d, include_worn=False):
    """Droptimizer data.json → řádky {kind raid|mplus, bossId, boss, itemId, item, slot, ilvl, base, value, diff, pct,
    catalystId, catalystFrom, charIlvl, worn}. Port simResultsFromRaidbots_ (včetně katalyzátoru a nasazených itemů)."""
    base = base_dps(d)
    meta = (d.get("simbot") or {}).get("meta") or {}
    lib, lib_any = {}, {}
    for it in meta.get("itemLibrary") or []:
        if not it or it.get("id") is None:
            continue
        iid = str(it["id"])
        cat = str((it.get("sourceItem") or {}).get("id") or "") if is_catalyst_item(it) else ""
        lib[f"{iid}/{it.get('encounterId')}/{cat}"] = it
        lib.setdefault(f"{iid}//{cat}", it)
        lib_any.setdefault(iid, it)
    bosses, instances = {}, {}
    for inst in meta.get("instanceLibrary") or []:
        if inst and inst.get("id") is not None:
            instances[str(inst["id"])] = inst.get("name") or ""
        for e in (inst or {}).get("encounters") or []:
            bosses[str(e.get("id"))] = e.get("name")
    results = ((d.get("sim") or {}).get("profilesets") or {}).get("results") or []
    best = OrderedDict()
    for r in results:
        p = str(r.get("name") or "").split("/")
        if len(p) < 7:
            continue
        kind = "raid" if p[2].startswith("raid") else "mplus"
        item_id = p[3]
        catalyst_id = p[10] if len(p) > 10 and re.fullmatch(r"\d+", p[10]) else ""
        mean = _num(r.get("mean"), 0)
        enc_id, inst_id = int(_num(p[1], 0)), int(_num(p[0], 0))
        it = lib.get(f"{item_id}/{p[1]}/{catalyst_id}") or lib.get(f"{item_id}//{catalyst_id}") or lib_any.get(item_id) or {}
        src_item = it.get("sourceItem") or {}
        if catalyst_id and str(src_item.get("id") or "") != catalyst_id:
            src_item = lib_any.get(catalyst_id) or {}
        if kind == "mplus" and not inst_id > 0:
            for x in it.get("sources") or []:
                if x and _num(x.get("instanceId"), 0) > 0 and instances.get(str(x["instanceId"])):
                    inst_id = int(x["instanceId"])
                    break
        boss_id = enc_id if kind == "raid" else inst_id
        key = f"{kind}/{item_id}/{boss_id}/{catalyst_id}"
        if key in best and best[key]["value"] >= mean:
            continue
        if kind == "raid":
            boss = bosses.get(str(enc_id)) or ("Trash" if enc_id == -97 else "") or (it.get("encounter") or {}).get("name") or ""
        else:
            boss = ((inst_id > 0 and instances.get(str(inst_id))) or (it.get("encounter") or {}).get("name")
                    or (it.get("instance") or {}).get("name") or instances.get(str(inst_id)) or "")
        best[key] = {
            "kind": kind, "bossId": boss_id, "boss": boss,
            "itemId": int(item_id), "item": it.get("name") or "", "slot": re.sub(r"[12]$", "", p[6]),
            "ilvl": int(_num(it.get("itemLevel"), 0) or _num(p[4], 0) or 0) or None,
            "base": _rnd(base), "value": _rnd(mean), "diff": _rnd(mean - base), "pct": pct_of(mean, base),
            "catalystId": int(catalyst_id) if catalyst_id else None,
            "catalystFrom": (src_item.get("name") or "") if catalyst_id else "",
        }
    char_ilvl = equipped_ilvl(d)
    out = sorted(best.values(), key=lambda x: -x["pct"])
    for row in out:
        row["charIlvl"] = char_ilvl
        row["worn"] = False
    if include_worn:
        simmed, max_ilvl = set(), 0
        for r in results:
            p = str(r.get("name") or "").split("/")
            if len(p) < 7:
                continue
            simmed.add(f"{p[3]}/{p[1]}")
            if not (len(p) > 10 and re.fullmatch(r"\d+", p[10])):
                simmed.add(f"{p[3]}/-100")
            max_ilvl = max(max_ilvl, int(_num(p[4], 0)))
        for it in meta.get("encounterItems") or []:
            if not it or it.get("id") is None:
                continue
            for src in it.get("sources") or []:
                enc_id = int(_num(src.get("encounterId"), 0))
                if f"{it['id']}/{enc_id}" in simmed:
                    continue
                out.append({
                    "kind": "raid", "bossId": enc_id if enc_id > 0 else None, "boss": (bosses.get(str(enc_id)) or "") if enc_id > 0 else "",
                    "itemId": int(it["id"]), "item": it.get("name") or "", "slot": INV_SLOT.get(int(_num(it.get("inventoryType"), 0)), ""),
                    "ilvl": max_ilvl or None, "base": _rnd(base), "value": _rnd(base), "diff": 0, "pct": 0.0,
                    "catalystId": None, "catalystFrom": "", "charIlvl": char_ilvl, "worn": True,
                })
    return out


def parse_qe(d):
    """QE Live report → řádky (raid = dropType max; dungeon = nejvyšší ilvl varianta). Port simResultsFromQe_."""
    best = {}
    for r in d.get("results") or []:
        loc = str(r.get("dropLoc") or "")
        kind = "raid" if loc == "Raid" else ("mplus" if re.search(r"dungeon", loc, re.I) else "")
        if not kind:
            continue
        typ = str(r.get("dropType") or "drop")
        if kind == "raid" and typ != "max":
            continue
        pct, raw, level = _num(r.get("percDiff"), 0), _num(r.get("rawDiff"), 0), int(_num(r.get("level"), 0))
        key = f"{kind}/{r.get('item')}"
        cur = best.get(key)
        if cur and ((cur["ilvl"] or 0) > level or ((cur["ilvl"] or 0) == level and cur["pct"] >= pct)):
            continue
        base = _rnd(raw / (pct / 100)) if (pct and raw) else None
        best[key] = {
            "kind": kind, "bossId": None, "boss": "", "itemId": int(_num(r.get("item"), 0)), "item": "", "slot": "",
            "ilvl": level or None, "base": base, "value": (base + _rnd(raw)) if base is not None else None,
            "diff": _rnd(raw), "pct": _rnd(pct * 100) / 100, "catalystId": None, "catalystFrom": "", "charIlvl": None, "worn": False,
        }
    return sorted(best.values(), key=lambda x: -x["pct"])


def parse_topgear(d, input_text, names):
    """Top Gear report → jeden souhrnný řádek (nejlepší "Combo N" vs. základ). names: itemId → název
    (z raid/M+ řádků postavy – Top Gear report itemLibrary nemá). Port simResultsFromTopgear_."""
    base = base_dps(d)
    results = ((d.get("sim") or {}).get("profilesets") or {}).get("results") or []
    best = max(results, key=lambda r: _num(r.get("mean"), 0), default=None)
    if not best:
        return []
    equipped = {}
    for line in input_text.split("\n"):
        if line.startswith("profileset."):
            continue
        m = re.match(r"^([a-z_0-9]+)=,(id=.*)$", line.strip(), re.I)
        if m:
            equipped[m.group(1).lower()] = m.group(2)
    changed = []
    for m in PROFILESET_RE.finditer(input_text):
        if m.group(1) != best.get("name"):
            continue
        it = re.match(r"^([a-z_0-9]+)=,(id=(\d+).*)$", m.group(2).strip(), re.I)
        if not it or equipped.get(it.group(1).lower()) == it.group(2):
            continue
        changed.append({"slot": it.group(1).lower(), "id": int(it.group(3))})
    mean = _num(best.get("mean"), 0)
    return [{
        "kind": "topgear", "bossId": None, "boss": "Top Gear",
        "itemId": "|".join(str(c["id"]) for c in changed),
        "item": " + ".join(names.get(str(c["id"])) or f"#{c['id']}" for c in changed),
        "slot": str(len(changed)), "ilvl": None, "charIlvl": equipped_ilvl(d),
        "base": _rnd(base), "value": _rnd(mean), "diff": _rnd(mean - base), "pct": pct_of(mean, base),
        "catalystId": None, "catalystFrom": "", "worn": False,
    }]


# ------------------------------------------------------------------- API ----

class EsApi:
    """Worker API (worker/index.js). Zápis vyžaduje token."""

    def __init__(self, url=None, token=None):
        self.url = (url or DEFAULT_API_URL).rstrip("/")
        self.token = token or ""

    @classmethod
    def from_config(cls, cfg=None):
        cfg = cfg or {}
        if not cfg and CONFIG_PATH.exists():
            try:
                cfg = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
            except ValueError:
                cfg = {}
        url = os.environ.get("ES_API_URL", "").strip() or cfg.get("api_url") or DEFAULT_API_URL
        token = os.environ.get("ES_API_TOKEN", "").strip() or cfg.get("api_token") or ""
        return cls(url, token)

    def _headers(self):
        h = {"Content-Type": "application/json; charset=utf-8"}
        if self.token:
            h["Authorization"] = f"Bearer {self.token}"
        return h

    def _check(self, r, what):
        try:
            data = r.json()
        except ValueError:
            raise RuntimeError(f"{what}: HTTP {r.status_code}, ne JSON: {r.text[:160]}")
        if r.status_code >= 400 or not data.get("ok"):
            raise RuntimeError(f"{what}: HTTP {r.status_code} {data.get('error') or data}")
        return data

    def require_token(self):
        if not self.token:
            raise RuntimeError("chybí token API (env ES_API_TOKEN nebo \"api_token\" v sim_runner.config.json)")

    def health(self):
        return self._check(requests.get(f"{self.url}/api/health", timeout=60), "health")

    def migrate(self):
        self.require_token()
        return self._check(requests.post(f"{self.url}/api/admin/migrate", headers=self._headers(), timeout=120), "migrate")

    def results(self, character=None):
        params = {"character": character} if character else None
        return self._check(requests.get(f"{self.url}/api/sims/results", params=params, timeout=120), "results")

    def store(self, reports):
        """reports: [{character, spec, origin, source, reportUrl, charIlvl, simmedAt, rows: [...]}]"""
        self.require_token()
        return self._check(requests.post(f"{self.url}/api/sims/results", headers=self._headers(),
                                         data=json.dumps({"reports": reports}, ensure_ascii=False).encode("utf-8"), timeout=120), "store")

    def import_extras(self, body):
        """body: {vault: [...], crests: [...], discord: [...]} – každý uvedený seznam nahradí svou tabulku."""
        self.require_token()
        return self._check(requests.post(f"{self.url}/api/sims/extras", headers=self._headers(),
                                         data=json.dumps(body, ensure_ascii=False).encode("utf-8"), timeout=120), "import-extras")

    def delete(self, character, spec=None, origin=None):
        self.require_token()
        params = {"character": character}
        if spec:
            params["spec"] = spec
        if origin:
            params["origin"] = origin
        return self._check(requests.delete(f"{self.url}/api/sims/results", params=params, headers=self._headers(), timeout=120), "delete")


def item_names_for(api, character):
    """itemId → název z uložených raid/M+ řádků postavy (pro Top Gear souhrn)."""
    names = {}
    try:
        for r in api.results(character).get("rows") or []:
            if r.get("origin") in ("raid", "mplus", "raidhc") and r.get("itemId") and r.get("item"):
                names[str(r["itemId"])] = r["item"]
    except Exception as err:  # noqa: BLE001
        log(f"   názvy itemů pro Top Gear se nenačetly: {err}")
    return names


def build_reports(character, spec, link, kinds, rows, now=None):
    """Rozparsované řádky → payload pro POST (jeden report na původ)."""
    now = now or datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    source = "QE Live" if link["kind"] == "qe" else "Raidbots"
    out = []
    for kind in kinds:
        sub = [r for r in rows if r["kind"] == kind]
        char_ilvl = next((r.get("charIlvl") for r in sub if r.get("charIlvl")), None)
        out.append({"character": character, "spec": spec, "origin": kind, "source": source, "reportUrl": link["url"],
                    "charIlvl": char_ilvl, "simmedAt": now,
                    "rows": [{k: v for k, v in r.items() if k not in ("kind", "charIlvl")} for r in sub]})
    return out


def store_report(api, character, spec, url, kind, names=None, simmed_at=None):
    """Stáhne report, rozparsuje a uloží do databáze. kind: raid | mplus | raidhc | topgear | qe.
    simmed_at: ISO čas simu (rebuild zachová původní); výchozí teď. Vrací {ok, message, counts}; nikdy nehází."""
    try:
        link = parse_report_link(url)
        if not link:
            raise RuntimeError(f"neplatný odkaz na report: {url}")
        kind = "qe" if link["kind"] == "qe" else (kind if kind in ("mplus", "topgear", "raidhc") else "raid")
        kinds = ["raid", "mplus"] if kind == "qe" else [kind]
        if kind == "qe":
            rows = parse_qe(fetch_qe(link["id"]))
        elif kind == "topgear":
            d = fetch_raidbots(link["id"])
            rows = parse_topgear(d, fetch_raidbots_input(link["id"], d), names if names is not None else item_names_for(api, character))
        else:
            rows = parse_raidbots(fetch_raidbots(link["id"]), include_worn=(kind == "raidhc"))
            if kind == "raidhc":   # HC vault Droptimizer = raidový report, jen jiná obtížnost
                for r in rows:
                    if r["kind"] == "raid":
                        r["kind"] = "raidhc"
        rows = [r for r in rows if r["kind"] in kinds]
        api.store(build_reports(character, spec, link, kinds, rows, simmed_at))
        counts = {k: sum(1 for r in rows if r["kind"] == k and not r.get("worn")) for k in kinds}
        if kind == "topgear":
            msg = (f"Top Gear {'+' if rows[0]['pct'] > 0 else ''}{rows[0]['pct']} % ({rows[0]['slot']} itemů)" if rows else "Top Gear bez výsledku")
        else:
            msg = ", ".join(f"{KIND_LABEL[k]} {counts[k]} itemů" for k in kinds)
        return {"ok": True, "message": msg, "counts": counts}
    except Exception as err:  # noqa: BLE001
        return {"ok": False, "message": str(err), "counts": {}}


# ------------------------------------------------------------------- CLI ----

def cmd_rebuild(api, character=None, origin=None):
    data = api.results(character)
    reports = data.get("reports") or []
    # QE report pokrývá raid i M+ v jednom – neparsovat dvakrát
    seen, done, failed = set(), 0, []
    for p in sorted(reports, key=lambda p: (p["character_key"], p["spec_key"], p["origin"])):
        link = parse_report_link(p["report_url"])
        if not link:
            failed.append(f"{p['character']} {p['origin']}: neplatný odkaz {p['report_url']}")
            continue
        if origin and p["origin"] != origin:
            continue
        kind = "qe" if link["kind"] == "qe" else p["origin"]
        key = (p["character_key"], p["spec_key"], link["id"], kind)
        if key in seen:
            continue
        seen.add(key)
        log(f"▶ {p['character']} ({p['spec']}) {KIND_LABEL.get(kind, kind)} {link['url']}")
        res = store_report(api, p["character"], p["spec"], link["url"], kind, simmed_at=p.get("simmed_at"))
        log(f"   {'✅' if res['ok'] else '⚠'} {res['message']}")
        if res["ok"]:
            done += 1
        else:
            failed.append(f"{p['character']} {kind}: {res['message']}")
    log(f"Hotovo: {done} reportů" + (f", selhalo {len(failed)}: " + "; ".join(failed) if failed else ""))


def sheet_time_to_iso(s):
    """"15.9.2026 21:51[:03]" v čase tabulky (Europe/Prague) → ISO UTC."""
    m = re.match(r"^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?", str(s or "").strip())
    if not m:
        return None
    dt = datetime(int(m.group(3)), int(m.group(2)), int(m.group(1)), int(m.group(4) or 0), int(m.group(5) or 0), int(m.group(6) or 0), tzinfo=SHEET_TZ)
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def cmd_import_sheet(api, sheet_id=SHEET_ID, dry_run=False):
    """Jednorázový přenos listu "Sim výsledky" (gviz CSV, bez parsování reportů – 1:1 co je v listu).
    Pozn.: gviz vrací u Top Gear řádků prázdné Item ID (sloupec je číselný) – opraví `rebuild`."""
    url = f"https://docs.google.com/spreadsheets/d/{sheet_id}/gviz/tq?tqx=out:csv&headers=1&sheet={requests.utils.quote(SHEET_TAB)}"
    r = requests.get(url, timeout=120)
    r.raise_for_status()
    rows = list(csv.DictReader(io.StringIO(r.text)))
    if not rows or "Postava" not in rows[0] or "Rozdíl %" not in rows[0]:
        sys.exit("CSV listu nemá očekávané sloupce (Postava, Rozdíl %…)")
    groups = OrderedDict()
    for row in rows:
        if not row.get("Postava"):
            continue
        origin = LABEL_ORIGIN.get((row.get("Původ") or "").strip(), "raid")
        key = (name_key(row["Postava"]), spec_key(row.get("Spec")), origin)
        g = groups.setdefault(key, {"character": row["Postava"].strip(), "spec": (row.get("Spec") or "").strip(), "origin": origin,
                                    "source": (row.get("Zdroj") or "Raidbots").strip(), "reportUrl": (row.get("Report") or "").strip(),
                                    "charIlvl": None, "simmedAt": None, "rows": []})
        t = sheet_time_to_iso(row.get("Čas"))
        if t and (not g["simmedAt"] or t > g["simmedAt"]):
            g["simmedAt"] = t
        if g["charIlvl"] is None and _num(row.get("ilvl postavy")):
            g["charIlvl"] = _num(row.get("ilvl postavy"))
        item_id = (row.get("Item ID") or "").strip()
        if not item_id and origin != "topgear":
            continue
        g["rows"].append({
            "bossId": _num(row.get("Boss ID")), "boss": (row.get("Boss") or "").strip(),
            "itemId": item_id if "|" in item_id or not item_id else str(int(_num(item_id))),
            "item": (row.get("Item") or "").strip(), "slot": (row.get("Slot") or "").strip(),
            "ilvl": _num(row.get("ilvl")), "base": _num(row.get("Základ")), "value": _num(row.get("S itemem")),
            "diff": _num(row.get("Rozdíl")), "pct": _num(row.get("Rozdíl %")),
            "catalystId": _num(row.get("Katalyzátor ID")), "catalystFrom": (row.get("Katalyzátor z") or "").strip(),
            "worn": bool(re.search(r"nasazeno", row.get("Stav") or "", re.I)),
        })
    log(f"List: {len(rows)} řádků → {len(groups)} reportů (postava + spec + původ)")
    ok = 0
    for g in groups.values():
        if not g["reportUrl"]:
            log(f"   ⚠ {g['character']} {g['spec']} {g['origin']}: bez odkazu na report – přeskočeno")
            continue
        if not g["simmedAt"]:
            g["simmedAt"] = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        if dry_run:
            log(f"   {g['character']} ({g['spec']}) {ORIGIN_LABEL[g['origin']]}: {len(g['rows'])} řádků, {g['simmedAt']}")
            continue
        api.store([g])
        ok += 1
        log(f"   ✅ {g['character']} ({g['spec']}) {ORIGIN_LABEL[g['origin']]}: {len(g['rows'])} řádků")
    log(f"Hotovo: {ok} reportů uloženo")


def _sheet_csv(sheet_id, tab):
    url = f"https://docs.google.com/spreadsheets/d/{sheet_id}/gviz/tq?tqx=out:csv&headers=1&sheet={requests.utils.quote(tab)}"
    r = requests.get(url, timeout=120)
    r.raise_for_status()
    rows = list(csv.DictReader(io.StringIO(r.text)))
    return [{k.strip().lower(): (v or "").strip() for k, v in row.items() if k} for row in rows]


def cmd_import_extras(api, sheet_id=SHEET_ID):
    """Jednorázový přenos listů Vault (Postava | Čas | Item ID | Item | Slot | ilvl | Bonus ID), Cresty
    (Postava | Čas | Adventurer | Veteran | Champion | Hero | Myth | Server | Region) a Discord
    (Hráč | Kanál URL | Webhook URL | Discord user ID). Každý list nahradí celou tabulku."""
    vault = [{"character": r["postava"], "time": sheet_time_to_iso(r.get("čas")), "itemId": _num(r.get("item id")), "item": r.get("item", ""),
              "slot": r.get("slot", ""), "ilvl": _num(r.get("ilvl")), "bonusId": r.get("bonus id", "")}
             for r in _sheet_csv(sheet_id, "Vault") if r.get("postava") and _num(r.get("item id"))]
    crests = [{"character": r["postava"], "time": sheet_time_to_iso(r.get("čas")), "adventurer": _num(r.get("adventurer")), "veteran": _num(r.get("veteran")),
               "champion": _num(r.get("champion")), "hero": _num(r.get("hero")), "myth": _num(r.get("myth")), "server": r.get("server", ""), "region": r.get("region", "")}
              for r in _sheet_csv(sheet_id, "Cresty") if r.get("postava")]
    discord = [{"player": r["hráč"], "channelUrl": r.get("kanál url", ""), "webhookUrl": r.get("webhook url", ""), "userId": r.get("discord user id", "")}
               for r in _sheet_csv(sheet_id, "Discord") if r.get("hráč")]
    res = api.import_extras({"vault": vault, "crests": crests, "discord": discord})
    log(f"Import: vault {len(vault)} řádků, cresty {len(crests)} postav, Discord {len(discord)} hráčů → {res.get('imported')}")


def cmd_show(api, character=None):
    data = api.results(character)
    reps = data.get("reports") or []
    rows = data.get("rows") or []
    counts = {}
    for r in rows:
        counts[(r["character"], r["spec"], r["origin"])] = counts.get((r["character"], r["spec"], r["origin"]), 0) + 1
    for p in reps:
        print(f"{p['character']:<16} {p['spec']:<14} {ORIGIN_LABEL.get(p['origin'], p['origin']):<9} "
              f"{counts.get((p['character'], p['spec'], p['origin']), 0):>4} řádků  {p['simmed_at']}  {p['report_url']}")
    print(f"{len(reps)} reportů, {len(rows)} řádků, poslední zápis {data.get('stored')}")


def main():
    ap = argparse.ArgumentParser(description="Výsledky simů → databáze (Worker API)")
    ap.add_argument("command", choices=["store", "rebuild", "import-sheet", "import-extras", "show", "migrate", "delete"])
    ap.add_argument("--character")
    ap.add_argument("--spec")
    ap.add_argument("--url", help="(store) odkaz na Raidbots / QE Live report")
    ap.add_argument("--kind", default="raid", choices=["raid", "mplus", "raidhc", "topgear", "qe"])
    ap.add_argument("--origin", choices=["raid", "mplus", "raidhc", "topgear"], help="(rebuild / delete) jen tenhle původ")
    ap.add_argument("--sheet-id", default=SHEET_ID)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    api = EsApi.from_config()
    if args.command == "migrate":
        print(api.migrate())
    elif args.command == "store":
        if not (args.character and args.spec and args.url):
            sys.exit("store: potřebuje --character, --spec a --url")
        res = store_report(api, args.character, args.spec, args.url, args.kind)
        print(("✅ " if res["ok"] else "⚠ ") + res["message"])
        sys.exit(0 if res["ok"] else 1)
    elif args.command == "rebuild":
        cmd_rebuild(api, args.character, args.origin)
    elif args.command == "import-sheet":
        cmd_import_sheet(api, args.sheet_id, args.dry_run)
    elif args.command == "import-extras":
        cmd_import_extras(api, args.sheet_id)
    elif args.command == "show":
        cmd_show(api, args.character)
    elif args.command == "delete":
        if not args.character:
            sys.exit("delete: potřebuje --character")
        print(api.delete(args.character, args.spec, args.origin))


if __name__ == "__main__":
    main()
