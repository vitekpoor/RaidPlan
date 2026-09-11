#!/usr/bin/env python3
"""
sim_runner.py – automatický Raidbots Droptimizer pro frontu "Sim fronta".

Co dělá (jeden spuštěný příkaz, pak se jen čeká):
  1. stáhne čekající řádky z Google Sheets (JSON API web appu, ?p=simapi),
  2. pro každý řádek otevře v Chromiu nový panel s Raidbots Droptimizerem,
     vloží SimC string, vybere zdroj ("Season 2 Raids") a obtížnost
     ("Mythic"), klikne Run – až `parallel` simů najednou (výchozí 10),
  3. hlídá všechny běžící reporty (…/simbot/report/<id>) a jak který doběhne,
  4. nahlásí ho zpět do Sheets – Apps Script ho nahraje do wowaudit
     (stejná funkce jako dialog "Simy → Zpracovat frontu").

Kolik simů Raidbots pustí najednou, určuje účet (Premium tier); když další
sim odmítne, runner řádek vrátí do fronty a dál posílá jen tolik, kolik
skutečně běží.

Healery (holy/disc/resto/mistweaver/preservation) Droptimizer neumí – ty
runner prohání QE Live Upgrade Finderem (questionablyepic.com): vybere spec,
Import Gear → SimC, obtížnost, GO!; report je hotový hned a jde do wowaudit
stejnou cestou (wowaudit QE odkazy bere).

Řádky se stavem ⚠ chyba, kde chybu zapsal sim_runner, se při dalším běhu
zkusí znovu automaticky.

Prohlížeč používá vlastní trvalý profil (.raidbots_profile/), takže
přihlášení do Raidbots (Premium) i nastavení Droptimizeru se pamatují.

Použití (v tools/roster/):
  python sim_runner.py setup        # uloží URL web appu + token (menu Simy → Token pro sim_runner.py…)
  python sim_runner.py login        # otevře prohlížeč, přihlas se do Raidbots, pak Enter
  python sim_runner.py login --export   # …a navíc uloží přihlášení do raidbots_state.json (secret pro GitHub Actions)
  python sim_runner.py pending      # jen vypíše, kolik řádků čeká
  python sim_runner.py              # zpracuje frontu

Online (bez PC): .github/workflows/sims.yml spouští tenhle skript v GitHub Actions
každou hodinu a na kliknutí (menu Simy → Spustit simy online, tlačítko na hubu).
Konfigurace přes env: SIM_WEBAPP_URL, SIM_API_TOKEN, SIM_STORAGE_STATE (cesta
k JSON z `login --export`), volitelně SIM_PARALLEL, SIM_UPGRADE.
  python sim_runner.py --parallel 3 # max 3 simy najednou (výchozí 10)
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

HERE = Path(__file__).resolve().parent
CONFIG_PATH = HERE / "sim_runner.config.json"
PROFILE_DIR = HERE / ".raidbots_profile"
LOG_DIR = HERE / "sim_runner_logs"

DROPTIMIZER_URL = "https://www.raidbots.com/simbot/droptimizer"
REPORT_RE = re.compile(r"raidbots\.com/simbot/report/([A-Za-z0-9]{10,40})")
GOLD = "rgb(255, 187, 51)"  # barva rámečku vybraného zdroje / obtížnosti

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


# ---------------------------------------------------------------- config ----

def load_config():
    cfg = dict(DEFAULTS)
    if CONFIG_PATH.exists():
        cfg.update(json.loads(CONFIG_PATH.read_text(encoding="utf-8")))
    cfg["webapp_url"] = os.environ.get("SIM_WEBAPP_URL", cfg["webapp_url"])
    cfg["token"] = os.environ.get("SIM_API_TOKEN", cfg["token"])
    if os.environ.get("SIM_PARALLEL", "").strip().isdigit():
        cfg["parallel"] = int(os.environ["SIM_PARALLEL"])
    if os.environ.get("SIM_UPGRADE", "").strip():
        cfg["upgrade"] = os.environ["SIM_UPGRADE"].strip()
    return cfg


def cmd_setup(cfg):
    print("Nastavení sim_runner.py – hodnoty najdeš v Sheets: menu Simy → Token pro sim_runner.py…")
    print("Web app URL = stejná …/exec adresa, na které hráči mají formulář absence / simu.")
    url = input(f"Web app URL [{cfg['webapp_url'] or '-'}]: ").strip() or cfg["webapp_url"]
    token = input(f"Token [{'(uložený)' if cfg['token'] else '-'}]: ").strip() or cfg["token"]
    source = input(f"Raidbots zdroj [{cfg['source']}]: ").strip() or cfg["source"]
    diff = input(f"Obtížnost [{cfg['difficulty']}]: ").strip() or cfg["difficulty"]
    par = input(f"Simů najednou [{cfg['parallel']}]: ").strip() or cfg["parallel"]
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

    def call(self, action, **params):
        q = {"p": "simapi", "token": self.token, "action": action}
        q.update({k: v for k, v in params.items() if v is not None})
        r = requests.get(self.url, params=q, timeout=90, allow_redirects=True)
        r.raise_for_status()
        try:
            data = r.json()
        except ValueError:
            raise RuntimeError(f"Web app nevrátil JSON (HTTP {r.status_code}): {r.text[:200]}")
        if not data.get("ok"):
            raise RuntimeError(f"simapi/{action}: {data.get('error') or data.get('message') or data}")
        return data

    def queue(self):
        return self.call("queue")["rows"]

    def running(self, row, character, url):
        return self.call("running", row=row, character=character, url=url)

    def done(self, row, character, url):
        r = requests.get(self.url, params={"p": "simapi", "token": self.token, "action": "done",
                                           "row": row, "character": character, "url": url},
                         timeout=120, allow_redirects=True)
        r.raise_for_status()
        return r.json()

    def error(self, row, character, note):
        return self.call("error", row=row, character=character, note=note[:500])

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

    def load_simc(self, page, simc):
        page.goto(DROPTIMIZER_URL, wait_until="domcontentloaded")
        self.settle(page)
        self.set_editor(page, simc)
        # Raidbots si pamatuje minulý vstup, takže seznam zdrojů může být na stránce
        # ještě od předchozí postavy. Čekáme, až karta postavy (mimo editor) ukáže
        # jméno z vloženého stringu a zmizí "Loading character…".
        name = simc_name(simc)
        deadline = time.time() + 60
        last = ""
        while True:
            info = page.evaluate(
                """() => { const c = document.body.cloneNode(true);
                     c.querySelectorAll('.cm-editor').forEach(e => e.remove());
                     const t = c.innerText || ''; return { text: t, list: !!document.querySelector('#instanceList') }; }""")
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

    def configure(self, page):
        self.select_tile(page, self.cfg["source"], "zdroj")
        self.select_tile(page, self.cfg["difficulty"], "obtížnost")
        self.set_upgrade_level(page)
        # ověření přes vygenerovaný SimC vstup (profilesety nesou "raid-mythic" apod.)
        want = "raid-" + self.cfg["difficulty"].lower()
        body = self.text(page)
        if "raid-" in body and want not in body:
            raise RuntimeError(f"vstup pro sim neobsahuje {want}")

    def run(self, page):
        """Klikne Run a vrátí (report_id, url). SubmitLimit = účet nesmí pustit další sim."""
        before = self.text(page)
        page.get_by_role("button", name=re.compile(r"run droptimizer", re.I)).click()
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
        rb.home.goto("https://www.raidbots.com/auth", wait_until="domcontentloaded")
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
        res = api.done(row["row"], character, url)
        log(f"   {character}: {res.get('message') or res}")
        return "done" if res.get("ok") else "error"
    except Exception as err:  # noqa: BLE001
        rb.screenshot(page, f"error_qe_{strip_accents(character)}")
        fail_row(api, row, str(err).splitlines()[0][:300])
        return "error"
    finally:
        page.close()


def submit_row(rb, api, row, dry_run):
    """Otevře panel, nahraje SimC, nastaví a klikne Run. Vrací dict aktivního simu nebo None."""
    character = row["character"]
    page = rb.new_tab()
    try:
        rb.load_simc(page, row["simc"])
        rb.configure(page)
        if dry_run:
            rb.screenshot(page, f"dryrun_{strip_accents(character)}")
            log(f"   {character}: dry-run – nastavení OK, Run nekliknuto")
            page.close()
            return None
        report_id, url = rb.run(page)
        log(f"   {character}: spuštěno {url}")
        try:
            api.running(row["row"], character, url)
        except Exception as err:  # noqa: BLE001
            log(f"   (stav 🔄 se nezapsal: {err})")
        return {"row": row, "page": page, "id": report_id, "url": url,
                "deadline": time.time() + rb.cfg["sim_timeout_min"] * 60, "state": ""}
    except SubmitLimit:
        page.close()
        raise
    except Exception as err:  # noqa: BLE001
        rb.screenshot(page, f"error_{strip_accents(character)}")
        page.close()
        fail_row(api, row, str(err).splitlines()[0][:300])
        return None


def finish_sim(rb, api, sim):
    row, character = sim["row"], sim["row"]["character"]
    log(f"   {character}: sim hotový, nahrávám do wowaudit…")
    try:
        res = api.done(row["row"], character, sim["url"])
        log(f"   {character}: {res.get('message') or res}")
        ok = bool(res.get("ok"))
    except Exception as err:  # noqa: BLE001
        log(f"   ⚠ {character}: upload selhal: {err}")
        ok = False
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
    todo = deque()
    healers = []
    for row in rows:
        if not row["simc"].strip():
            fail_row(api, row, "prázdný SimC string")
            results[rkey(row)] = "error"
        elif row["spec"].lower() in HEALER_SPECS:
            healers.append(row)
        else:
            todo.append(row)
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
            log("Pozor: v Raidbots nejsi přihlášený (běží to bez Premium – pomalejší fronta a jen 1 sim). Přihlášení: python sim_runner.py login")
        for row in healers:
            log(f"▶ {row['character']} ({row['spec']}) – řádek {row['row']} – healer → QE Live")
            results[rkey(row)] = qe_row(rb, api, row, args.dry_run)
        if todo:
            log(f"Posílám až {parallel} simů najednou.")
        while todo or active:
            # 1) doplnit běžící simy do limitu
            while todo and len(active) < parallel:
                row = todo.popleft()
                log(f"▶ {row['character']} ({row['spec']}) – řádek {row['row']}")
                try:
                    sim = submit_row(rb, api, row, args.dry_run)
                except SubmitLimit as lim:
                    todo.appendleft(row)
                    parallel = max(1, len(active))
                    log(f"   Raidbots nepustil další sim ({lim}); dál jedu s {parallel} najednou.")
                    if not active:
                        log("   Žádný sim neběží a Raidbots přesto odmítá – čekám 60 s a zkusím znovu.")
                        time.sleep(60)
                    break
                if sim:
                    active.append(sim)
                elif args.dry_run:
                    results[rkey(row)] = "dry"
                else:
                    results[rkey(row)] = "error"
            if not active:
                continue
            # 2) zkontrolovat běžící
            time.sleep(cfg["poll_seconds"])
            still = []
            for sim in active:
                ch = sim["row"]["character"]
                if rb.report_ready(sim["id"]):
                    results[rkey(sim["row"])] = finish_sim(rb, api, sim)
                    continue
                failed = rb.report_failed(sim["page"])
                if failed:
                    rb.screenshot(sim["page"], f"simfail_{strip_accents(ch)}")
                    sim["page"].close()
                    fail_row(api, sim["row"], f"Raidbots hlásí chybu simulace ({failed}) {sim['url']}")
                    results[rkey(sim["row"])] = "error"
                    continue
                if time.time() > sim["deadline"]:
                    sim["page"].close()
                    fail_row(api, sim["row"], f"sim nedoběhl do {cfg['sim_timeout_min']} minut {sim['url']}")
                    results[rkey(sim["row"])] = "error"
                    continue
                state = rb.job_state(sim["id"])
                if state and state != sim["state"]:
                    log(f"   {ch}: {state}")
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
    ap.add_argument("command", nargs="?", default="run", choices=["run", "setup", "login", "pending"])
    ap.add_argument("--parallel", type=int, help="kolik simů najednou, každý ve vlastním panelu (výchozí z configu, 10)")
    ap.add_argument("--storage-state", metavar="FILE", help="JSON s přihlášením Raidbots z `login --export` (jinak env SIM_STORAGE_STATE / trvalý profil)")
    ap.add_argument("--export", nargs="?", const=str(HERE / "raidbots_state.json"), metavar="FILE",
                    help="(login) po přihlášení uložit cookies/localStorage do souboru pro GitHub Actions")
    ap.add_argument("--dry-run", action="store_true", help="vše kromě kliknutí na Run Droptimizer")
    ap.add_argument("--headless", action="store_true", help="bez okna prohlížeče")
    ap.add_argument("--row", type=int, help="zpracovat jen řádek listu N")
    ap.add_argument("--max", type=int, help="nejvýše N řádků")
    ap.add_argument("--keep-open", action="store_true", help="po skončení nechat prohlížeč otevřený")
    args = ap.parse_args()
    cfg = load_config()
    if args.command == "setup":
        cmd_setup(cfg)
    elif args.command == "login":
        cmd_login(cfg, args.export)
    elif args.command == "pending":
        cmd_pending(cfg)
    else:
        cmd_run(cfg, args)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nPřerušeno.")
