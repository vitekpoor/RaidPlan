# -*- coding: utf-8 -*-
"""
Venomous Abyss – generátor 2 split run.

Vstup:
  - živý Wishlist sheet (CSV export, anonymní link-access)
  - list "Roster" v témže spreadsheetu -> hráči, main/alt chary, classy, role
    (zdroj pravdy; vytvoří ho buildRosterSheet v class_loot_dropdowns.gs)
  - class_loot_dropdowns.gs  -> item DB (kontrola názvů) + armor mapping

Model splitů (odpovídá stávajícímu split sheetu):
  Každý hráč chodí do OBOU run – main char v jedné, alt char v druhé.
  Skript rozhoduje, do které runy jde čí MAIN.

Cíl: uspokojit co nejvíc lidí. Dropy bereme jako nezávislé na složení raidu,
takže jediné, co split ovlivní, je KONKURENCE – když stejný item chtějí dva
hráči, mají být v různých runách (každý drop pak má svého zájemce a nikdo
nečeká, až se ten druhý nasytí).

Skóre: pro každý item a runu s w zájemci v té runě přičteme
H(w) = 1 + 1/2 + ... + 1/w (klesající užitek dalšího zájemce téhož itemu
ve stejné runě). Item se 2 zájemci: společná runa = 1.5, rozdělení = 2.0.

Omezení na runu: >= MIN_TANKS tanků, MIN_HEALS-MAX_HEALS healerů,
vyváženost počtu mainů mezi runami (±MAX_IMBALANCE) a navíc vyváženost
mainů po rolích – main healeři a main dps se dělí mezi runy rovnoměrně
(±MAX_ROLE_IMBALANCE), aby obě runy měly srovnatelný healing i damage.

Použití:
  python make_splits.py            # stáhne živý wishlist + roster a spočítá splity
  python make_splits.py --skip-last 2                    # ignoruj poslední 2 bossy
  python make_splits.py --skip-boss "Ula'tek" "The Coiled Altar"  # konkrétní bossové
  python make_splits.py --skip-player schizoid           # hráč chybí, nepočítat ho
(volby lze opakovat i kombinovat; trvalé výjimky jdou zapsat do SKIP_BOSSES /
SKIP_PLAYERS níže)
"""

import argparse
import csv
import io
import random
import re
import subprocess
import sys
import unicodedata
import urllib.request
from collections import Counter
from pathlib import Path

HERE = Path(__file__).parent
GS_FILE = HERE / "class_loot_dropdowns.gs"
OUT_FILE = HERE / "splits_proposal.txt"

WISHLIST_ID = "1CUG3oyufoNs5CrY68WMJVVHLJz-52uFQMuOtv5q3ECI"
WISHLIST_GID = "0"

MIN_TANKS = 2
MIN_HEALS = 4
MAX_HEALS = 5
MAX_IMBALANCE = 1        # max rozdíl počtu mainů mezi runami
MAX_ROLE_IMBALANCE = 1   # max rozdíl počtu mainů dané role (tank/heal/dps)
RESTARTS = 400
SEED = 7

# Trvalé výjimky (totéž jde zadat jednorázově přes --skip-boss / --skip-player).
SKIP_BOSSES = []    # bossové, jejichž loot se nepočítá, např. ["Dimensius"]
SKIP_PLAYERS = []   # chybějící hráči, např. ["Schizoid"]

# ---------------------------------------------------------------- PLAYERS --
# Hráči se načítají z listu "Roster" ve wishlist spreadsheetu (zdroj pravdy):
# hráč, main/alt char, classa a role obou charů. Naplní se v main().
PLAYERS = []     # [(hráč, main char, alt char, main role), ...]
CHAR_CLASS = {}  # char -> classa (z Rosteru)
CHAR_ROLE = {}   # char -> role (z Rosteru; alt může mít jinou než main)
ROLE_OVERRIDE = {}  # ruční výjimka char -> role (má přednost před Rosterem)

# WoW class barvy pro pozadí jmen (konvence ze split sheetu)
CLASS_COLOR = {
    "Death Knight": "#C41E3A", "Demon Hunter": "#A330C9", "Druid": "#FF7C0A",
    "Evoker": "#33937F", "Hunter": "#AAD372", "Mage": "#3FC7EB",
    "Monk": "#00FF98", "Paladin": "#F48CBA", "Priest": "#FFFFFF",
    "Rogue": "#FFF468", "Shaman": "#0070DE", "Warlock": "#8788EE",
    "Warrior": "#C69B6D",
}

# Aktuální rozdělení mainů podle split sheetu (pro porovnání skóre).
CURRENT_MAIN_RUN1 = {
    "ahaaferos", "global", "anál", "rojko", "miky", "zîreael", "pifta",
    "trenser", "schizoddh", "arch", "ryzz", "nesferity", "akka", "drastic",
}

# klesající užitek k-tého zájemce o stejný item ve stejné runě
def H(w):
    return sum(1.0 / k for k in range(1, w + 1))


# ------------------------------------------------------------ parse .gs ---
def parse_gs(path):
    src = path.read_text(encoding="utf-8")

    def parse_str_map(name):
        block = re.search(r"var %s = \{(.*?)\};" % name, src, re.S).group(1)
        return dict(re.findall(r'"([^"]+)"\s*:\s*"([^"]+)"', block))

    player_class = parse_str_map("PLAYER_CLASS")
    armor_of = parse_str_map("ARMOR")

    db_block = re.search(r"var DB = \{(.*?)\n\};", src, re.S).group(1)
    db_items = {}  # boss -> set(norm item name)
    for boss_m in re.finditer(r'"([^"]+)":\s*\[(.*?)\n  \]', db_block, re.S):
        boss, items_src = boss_m.group(1), boss_m.group(2)
        db_items[boss] = {norm(n) for n, _t in
                          re.findall(r'\["([^"]+)",\s*"([^"]+)"\]', items_src)}
    return player_class, armor_of, db_items


def norm(s):
    s = unicodedata.normalize("NFC", str(s)).strip().lower()
    s = s.replace(", ", " – ")
    return re.sub(r"\s+", " ", s)


# ------------------------------------------------------------- wishlist ---
def load_wishlist():
    url = ("https://docs.google.com/spreadsheets/d/%s/export?format=csv&gid=%s"
           % (WISHLIST_ID, WISHLIST_GID))
    text = urllib.request.urlopen(url, timeout=30).read().decode("utf-8")
    rows = list(csv.reader(io.StringIO(text)))
    bosses = [b.strip() for b in rows[0][1:10]]
    wishes = {}      # char -> list of (boss, item)
    raw_names = {}   # char -> jméno tak, jak je napsané v sheetu
    for r in rows[1:]:
        if not r or not r[0].strip() or r[0].startswith("Legenda"):
            continue
        char = norm(r[0])
        raw_names.setdefault(char, r[0].strip())
        items = []
        for boss, cell in zip(bosses, r[1:10]):
            for it in cell.split(", "):
                it = it.strip()
                if it:
                    items.append((boss, it))
        if items or char not in wishes:
            wishes[char] = items
    return bosses, wishes, raw_names


# -------------------------------------------------------------- roster ----
def load_roster():
    """Načte list Roster -> (PLAYERS, CHAR_CLASS, CHAR_ROLE)."""
    url = ("https://docs.google.com/spreadsheets/d/%s/gviz/tq"
           "?tqx=out:csv&sheet=Roster" % WISHLIST_ID)
    try:
        text = urllib.request.urlopen(url, timeout=30).read().decode("utf-8")
    except Exception as e:
        sys.exit("Roster se nepodařilo stáhnout (%s).\nExistuje ve wishlist "
                 "spreadsheetu list 'Roster'? Vytvoří ho funkce "
                 "buildRosterSheet v class_loot_dropdowns.gs." % e)

    rows = list(csv.reader(io.StringIO(text)))
    if not rows or len(rows) < 2:
        sys.exit("Roster je prázdný.")
    header = [norm(h) for h in rows[0]]

    def col(name):
        if norm(name) not in header:
            sys.exit("V Rosteru chybí sloupec '%s' (nalezené: %s)."
                     % (name, ", ".join(rows[0])))
        return header.index(norm(name))

    ip, im, imc, imr = (col("Hráč"), col("Main char"),
                        col("Main classa"), col("Main role"))
    ia, iac, iar = col("Alt char"), col("Alt classa"), col("Alt role")

    players, char_class, char_role = [], {}, {}
    for r in rows[1:]:
        def cell(i):
            return r[i].strip() if i < len(r) else ""
        player, main, alt = cell(ip), cell(im), cell(ia)
        if not player or not main:
            continue
        if not alt:
            sys.exit("Hráč '%s' nemá v Rosteru alt char – model splitů počítá "
                     "s tím, že každý hráč chodí obě runy (main + alt)." % player)
        main_role = cell(imr).lower()
        alt_role = cell(iar).lower() or main_role
        for ch, role in ((main, main_role), (alt, alt_role)):
            if role not in ("tank", "heal", "dps"):
                sys.exit("Char '%s' má v Rosteru neplatnou roli '%s' "
                         "(tank/heal/dps)." % (ch, role))
        players.append((player, norm(main), norm(alt), main_role))
        char_class[norm(main)] = cell(imc)
        char_class[norm(alt)] = cell(iac)
        char_role[norm(main)] = main_role
        char_role[norm(alt)] = alt_role
    if not players:
        sys.exit("Roster neobsahuje žádného hráče.")
    return players, char_class, char_role


# --------------------------------------------------------------- model ----
class Model:
    def __init__(self, skip_bosses=(), skip_last=0, ignore_chars=()):
        self.player_class, self.armor_of, self.db_items = parse_gs(GS_FILE)
        self.bosses, raw_wishes, raw_names = load_wishlist()
        self.skip_bosses = self._resolve_bosses(skip_bosses)
        if skip_last:
            self.skip_bosses |= set(self.bosses[-skip_last:])
        all_db = set().union(*self.db_items.values())

        self.chars = {}
        self.unmatched = []
        for player, main, alt, role in PLAYERS:
            for ch in (main, alt):
                cls = CHAR_CLASS.get(ch) or self.player_class.get(ch)
                if not cls:
                    sys.exit("Neznámá classa pro char '%s' – doplň do Rosteru" % ch)
                if cls not in self.armor_of:
                    sys.exit("Char '%s' má v Rosteru neznámou classu '%s'"
                             % (ch, cls))
                wants = []
                for boss, item in raw_wishes.get(ch, []):
                    key = (boss, norm(item))
                    if key[1] not in self.db_items.get(boss, set()):
                        if norm(item) in all_db:  # item zapsaný u jiného bosse
                            key = (next(b for b, s in self.db_items.items()
                                        if norm(item) in s), norm(item))
                        elif boss in self.skip_bosses:
                            continue
                        else:
                            self.unmatched.append((ch, boss, item))
                    if key[0] in self.skip_bosses:
                        continue
                    wants.append(key)
                self.chars[ch] = {
                    "player": player,
                    "display": raw_names.get(ch, ch.capitalize()),
                    "class": cls,
                    "armor": self.armor_of[cls],
                    "role": ROLE_OVERRIDE.get(ch, CHAR_ROLE.get(ch, role)),
                    "wants": sorted(set(wants)),
                    "label": {(b, norm(i)): i for b, i in raw_wishes.get(ch, [])},
                }

        missing = [c for c, w in raw_wishes.items()
                   if c not in self.chars and w and c not in set(ignore_chars)]
        if missing:
            print("POZOR: wishlist řádky bez hráče v PLAYERS: %s" % ", ".join(missing))

    def _resolve_bosses(self, names):
        resolved = set()
        for name in names:
            hits = [b for b in self.bosses if norm(name) == norm(b)]
            if not hits:
                hits = [b for b in self.bosses if norm(name) in norm(b)]
            if len(hits) != 1:
                sys.exit("Boss '%s' %s – bossové ve wishlistu: %s"
                         % (name,
                            "není jednoznačný" if hits else "nenalezen",
                            ", ".join(self.bosses)))
            resolved.add(hits[0])
        return resolved

    def run_chars(self, assign, r):
        return [main if assign[i] == r else alt
                for i, (_p, main, alt, _role) in enumerate(PLAYERS)]

    def item_counts(self, assign, r):
        c = Counter()
        for ch in self.run_chars(assign, r):
            c.update(self.chars[ch]["wants"])
        return c

    def score(self, assign):
        total = 0.0
        for r in (0, 1):
            total += sum(H(w) for w in self.item_counts(assign, r).values())
        return total

    def main_role_counts(self, assign, r):
        """Kolik MAINů dané role hraje v runě r."""
        c = {"tank": 0, "heal": 0, "dps": 0}
        for i, (_p, main, _alt, _role) in enumerate(PLAYERS):
            if assign[i] == r:
                c[self.chars[main]["role"]] += 1
        return c

    def valid(self, assign, relaxed=False):
        if abs(sum(assign) - (len(assign) - sum(assign))) > MAX_IMBALANCE:
            return False
        m0, m1 = (self.main_role_counts(assign, r) for r in (0, 1))
        for role in ("tank", "heal", "dps"):
            if abs(m0[role] - m1[role]) > MAX_ROLE_IMBALANCE:
                return False
        for r in (0, 1):
            chars = self.run_chars(assign, r)
            tanks = sum(1 for c in chars if self.chars[c]["role"] == "tank")
            heals = sum(1 for c in chars if self.chars[c]["role"] == "heal")
            if tanks < MIN_TANKS:
                return False
            if not relaxed and not (MIN_HEALS <= heals <= MAX_HEALS):
                return False
            if relaxed and heals < MIN_HEALS:
                return False
        return True

    def role_counts(self, assign, r):
        chars = self.run_chars(assign, r)
        return {role: sum(1 for c in chars if self.chars[c]["role"] == role)
                for role in ("tank", "heal", "dps")}

    def contested(self, assign, r):
        """Itemy, o které se v runě r pere víc zájemců: (item, [chary])."""
        out = []
        chars = self.run_chars(assign, r)
        counts = self.item_counts(assign, r)
        for key, w in sorted(counts.items(), key=lambda kv: -kv[1]):
            if w >= 2:
                who = [c for c in chars if key in self.chars[c]["wants"]]
                out.append((key, who))
        return out


# ------------------------------------------------------------ optimizer ---
def optimize(model, relaxed=False):
    n = len(PLAYERS)
    rng = random.Random(SEED)
    half = n // 2

    def ok(a):
        return model.valid(a, relaxed=relaxed)

    def random_assign():
        a = [0] * half + [1] * (n - half)
        rng.shuffle(a)
        return a

    def climb(a):
        best = model.score(a)
        improved = True
        while improved:
            improved = False
            for i in range(n):
                a[i] ^= 1
                if ok(a):
                    s = model.score(a)
                    if s > best + 1e-9:
                        best = s
                        improved = True
                        continue
                a[i] ^= 1
            for i in range(n):
                for j in range(i + 1, n):
                    if a[i] == a[j]:
                        continue
                    a[i] ^= 1; a[j] ^= 1
                    s = model.score(a)
                    if ok(a) and s > best + 1e-9:
                        best = s
                        improved = True
                    else:
                        a[i] ^= 1; a[j] ^= 1
        return a, best

    seeds = [[0 if PLAYERS[i][1] in CURRENT_MAIN_RUN1 else 1 for i in range(n)]]
    seeds += [random_assign() for _ in range(RESTARTS)]

    best_a, best_s = None, -1.0
    for a in seeds:
        a = list(a)
        if not ok(a):
            for _ in range(100):
                if ok(a):
                    break
                a[rng.randrange(n)] ^= 1
            if not ok(a):
                continue
        a, s = climb(a)
        if s > best_s:
            best_a, best_s = list(a), s
    return best_a, best_s


# --------------------------------------------------------------- report ---
def label_of(model, key):
    for info in model.chars.values():
        if key in info["label"]:
            return info["label"][key]
    return key[1]


def report(model, assign, title):
    lines = ["=" * 66, title, "=" * 66]
    for r in (0, 1):
        chars = model.run_chars(assign, r)
        rc = model.role_counts(assign, r)
        counts = model.item_counts(assign, r)
        solo = sum(1 for w in counts.values() if w == 1)
        cont = model.contested(assign, r)
        mrc = model.main_role_counts(assign, r)
        lines += ["",
                  "RUN %d  (%d charů: %d tank / %d heal / %d dps; "
                  "z toho MAINů: %d tank / %d heal / %d dps)"
                  % (r + 1, len(chars), rc["tank"], rc["heal"], rc["dps"],
                     mrc["tank"], mrc["heal"], mrc["dps"]),
                  "chtěných itemů: %d unikátních, z toho %d bez konkurence, %d sporných"
                  % (len(counts), solo, len(cont))]
        for role in ("tank", "heal", "dps"):
            lines.append("  -- %s --" % role.upper())
            for i, (player, main, alt, _role) in enumerate(PLAYERS):
                ch = main if assign[i] == r else alt
                info = model.chars[ch]
                if info["role"] != role:
                    continue
                mark = "MAIN" if ch == main else "alt "
                shared = sum(1 for k in info["wants"] if counts[k] >= 2)
                note = "  (%d sdílených)" % shared if shared else ""
                lines.append("  %-12s %-12s %-13s %s  wishlist:%d%s"
                             % (player, ch, info["class"], mark,
                                len(info["wants"]), note))
        if cont:
            lines.append("  Sporné itemy v runě (víc zájemců najednou):")
            for key, who in cont:
                players = ", ".join(model.chars[c]["player"] for c in who)
                lines.append("    %dx  %s  [%s]  – %s"
                             % (len(who), label_of(model, key), key[0], players))
    lines += ["", "Skóre (očekávaná nasycenost wishlistů): %.2f" % model.score(assign)]
    return "\n".join(lines)


def write_csv(model, assign, path):
    """CSV pro import do Google Sheets: Run 1 a Run 2 vedle sebe,
    sekce Tank/Heal/Dps, pod tím tabulky sporných itemů."""
    rows = [["Run 1", "", "", "", "", "", "Run 2", "", "", "", ""],
            ["Char", "Classa", "Armor", "Main/Alt", "Wishlist", "",
             "Char", "Classa", "Armor", "Main/Alt", "Wishlist"]]
    counts = [model.item_counts(assign, r) for r in (0, 1)]

    for role in ("tank", "heal", "dps"):
        rows.append([role.upper()] + [""] * 10)
        for i, (_player, main, alt, _role) in enumerate(PLAYERS):
            if model.chars[main]["role"] != role:
                continue
            row = []
            for r in (0, 1):
                ch = main if assign[i] == r else alt
                info = model.chars[ch]
                shared = sum(1 for k in info["wants"] if counts[r][k] >= 2)
                wl = ("%d (%d sdílených)" % (len(info["wants"]), shared)
                      if shared else str(len(info["wants"])))
                row += [info["display"], info["class"], info["armor"],
                        "MAIN" if ch == main else "alt", wl]
                if r == 0:
                    row.append("")
            rows.append(row)

    for r in (0, 1):
        cont = model.contested(assign, r)
        rows += [[""] * 11,
                 ["Sporné itemy – Run %d (víc zájemců ve stejné runě)" % (r + 1)]
                 + [""] * 10,
                 ["Zájemců", "Item", "Boss", "Hráči"] + [""] * 7]
        for key, who in cont:
            rows.append([len(who), label_of(model, key), key[0],
                         ", ".join(model.chars[c]["player"] for c in who)]
                        + [""] * 7)

    with open(path, "w", newline="", encoding="utf-8-sig") as f:
        csv.writer(f).writerows(rows)


def write_html(model, assign, path):
    """HTML tabulka pro vložení do Google Sheets přes schránku (Ctrl+V
    zachová barvy buněk). Stejné rozložení jako cílový tab: Run 1 a Run 2
    vedle sebe (bez sloupce s classou – tu nese barva jména), vpravo
    tabulky sporných itemů."""
    import html as html_mod

    def cell(text="", bg=None, bold=False):
        return {"t": str(text), "bg": bg, "b": bold}

    GRAY = "#CCCCCC"
    counts = [model.item_counts(assign, r) for r in (0, 1)]
    left = [[cell("Run 1", bg="#FF9900", bold=True), cell(), cell(), cell(),
             cell(bg=GRAY),
             cell("Run 2", bg="#00FF00", bold=True), cell(), cell(), cell()],
            [cell(h, bg=GRAY, bold=True) for h in
             ("Char", "Armor", "Main/Alt", "Wishlist")] + [cell(bg=GRAY)] +
            [cell(h, bg=GRAY, bold=True) for h in
             ("Char", "Armor", "Main/Alt", "Wishlist")]]
    for role in ("tank", "heal", "dps"):
        left.append([cell(role.upper(), bg=GRAY, bold=True)]
                    + [cell(bg=GRAY)] * 8)
        for i, (_player, main, alt, _role) in enumerate(PLAYERS):
            if model.chars[main]["role"] != role:
                continue
            row = []
            for r in (0, 1):
                ch = main if assign[i] == r else alt
                info = model.chars[ch]
                shared = sum(1 for k in info["wants"] if counts[r][k] >= 2)
                wl = ("%d (%d sdílených)" % (len(info["wants"]), shared)
                      if shared else str(len(info["wants"])))
                row += [cell(info["display"], bg=CLASS_COLOR[info["class"]]),
                        cell(info["armor"]),
                        cell("MAIN" if ch == main else "alt",
                             bold=(ch == main)),
                        cell(wl)]
                if r == 0:
                    row.append(cell(bg=GRAY))
            left.append(row)

    right = []
    for r in (0, 1):
        right += [[cell("Sporné itemy – Run %d (víc zájemců ve stejné runě)"
                        % (r + 1), bg="#FF9900" if r == 0 else "#00FF00",
                        bold=True), cell(), cell(), cell()],
                  [cell(h, bg=GRAY, bold=True) for h in
                   ("Zájemců", "Item", "Boss", "Hráči")]]
        for key, who in model.contested(assign, r):
            right.append([cell(len(who)), cell(label_of(model, key)),
                          cell(key[0]),
                          cell(", ".join(model.chars[c]["player"] for c in who))])
        right.append([cell()] * 4)

    n_rows = max(len(left), len(right))
    out = ["<table>"]
    for i in range(n_rows):
        row = (left[i] if i < len(left) else [cell()] * 9) + [cell()] + \
              (right[i] if i < len(right) else [cell()] * 4)
        tds = []
        for c in row:
            style = []
            if c["bg"]:
                style.append("background-color:%s" % c["bg"])
            if c["b"]:
                style.append("font-weight:bold")
            tds.append("<td%s>%s</td>"
                       % (' style="%s"' % ";".join(style) if style else "",
                          html_mod.escape(c["t"])))
        out.append("<tr>%s</tr>" % "".join(tds))
    out.append("</table>")
    Path(path).write_text("\n".join(out), encoding="utf-8")


def main():
    global PLAYERS, CHAR_CLASS, CHAR_ROLE
    ap = argparse.ArgumentParser()
    ap.add_argument("--skip-boss", action="append", nargs="+", default=[],
                    metavar="BOSS",
                    help="ignoruj loot těchto bossů (více jmen za sebou, "
                         "oddělených čárkou, nebo volbu opakuj)")
    ap.add_argument("--skip-last", type=int, default=0, metavar="N",
                    help="ignoruj loot posledních N bossů")
    ap.add_argument("--skip-player", action="append", nargs="+", default=[],
                    metavar="HRÁČ",
                    help="hráči, kteří chybí – vynech je ze splitů (více jmen "
                         "za sebou, oddělených čárkou, nebo volbu opakuj)")
    args = ap.parse_args()

    def flatten(groups):
        out = []
        for grp in groups:
            # PowerShell doručí čárkou oddělený seznam rozsekaný po slovech
            # a s uvozovkami uvnitř tokenů – pak tokeny slepíme zpět a
            # rozdělíme až podle čárek.
            raws = [" ".join(grp)] if any('"' in t for t in grp) else grp
            for raw in raws:
                out += [x.strip().strip('"').strip("'").strip()
                        for x in raw.split(",")]
        return [x for x in out if x]

    PLAYERS, CHAR_CLASS, CHAR_ROLE = load_roster()

    skip_bosses_arg = flatten(args.skip_boss)
    skip_players = {norm(p) for p in SKIP_PLAYERS + flatten(args.skip_player)}
    ignore_chars = []
    if skip_players:
        known = {norm(x) for p in PLAYERS for x in p[:3]}
        unknown = skip_players - known
        if unknown:
            sys.exit("Neznámý hráč v --skip-player: %s (hráči: %s)"
                     % (", ".join(sorted(unknown)),
                        ", ".join(p[0] for p in PLAYERS)))
        skipped = [p for p in PLAYERS
                   if {norm(x) for x in p[:3]} & skip_players]
        PLAYERS = [p for p in PLAYERS if p not in skipped]
        ignore_chars = [norm(c) for p in skipped for c in p[1:3]]
        print("Vynechaní hráči: %s" % ", ".join(p[0] for p in skipped))

    model = Model(skip_bosses=SKIP_BOSSES + skip_bosses_arg,
                  skip_last=args.skip_last,
                  ignore_chars=ignore_chars)
    if model.skip_bosses:
        print("Ignorovaný loot bossů: %s"
              % ", ".join(b for b in model.bosses if b in model.skip_bosses))
    if model.unmatched:
        print("POZOR – itemy nenapárované na loot DB (počítají se i tak):")
        for ch, boss, item in model.unmatched:
            print("  %s | %s | %s" % (ch, boss, item))
        print()

    n = len(PLAYERS)
    current = [0 if PLAYERS[i][1] in CURRENT_MAIN_RUN1 else 1 for i in range(n)]

    best, score = optimize(model)
    if best is None:
        heals = model.role_counts(current, 0)["heal"]
        print("POZOR: healerů na runu je %d, mimo požadované rozmezí %d-%d "
              "(každý healer chodí na obě runy). Počítám s relaxovaným limitem;"
              " případně dej healerův char do ROLE_OVERRIDE jako 'dps'."
              % (heals, MIN_HEALS, MAX_HEALS))
        best, score = optimize(model, relaxed=True)
    if best is None:
        sys.exit("Nenalezeno žádné přípustné rozdělení – zkontroluj role v PLAYERS.")

    out = report(model, best, "NAVRŽENÉ SPLITY (minimalizace konkurence o itemy)")
    out += ("\n\nPro srovnání: aktuální split ze sheetu má skóre %.2f "
            "(navržený %.2f)." % (model.score(current), score))
    print(out)
    written = []
    for path, writer in [
            (OUT_FILE, lambda p: p.write_text(out, encoding="utf-8")),
            (OUT_FILE.with_suffix(".csv"), lambda p: write_csv(model, best, p)),
            (OUT_FILE.with_suffix(".html"), lambda p: write_html(model, best, p))]:
        try:
            writer(path)
            written.append(path.name)
        except PermissionError:
            print("POZOR: %s se nepodařilo zapsat (soubor je otevřený jinde?)"
                  % path.name)
    print("\nUloženo: %s" % ", ".join(written))

    # barevnou HTML tabulku rovnou do schránky – v Google Sheets pak stačí Ctrl+V
    html_file = OUT_FILE.with_suffix(".html")
    if html_file.name in written:
        try:
            subprocess.run(
                ["powershell.exe", "-STA", "-NoProfile", "-Command",
                 "Set-Clipboard -AsHtml -Value (Get-Content -Raw '%s')"
                 % html_file],
                check=True, capture_output=True, timeout=30)
            print("Tabulka je ve schránce – v Sheets vyber buňku A1 a Ctrl+V.")
        except Exception as e:
            print("POZOR: kopírování do schránky selhalo (%s) – vlož ručně z %s"
                  % (e, html_file.name))


if __name__ == "__main__":
    main()
