"""Flopik – The Twin Fangs (Mythic): Caustic Globule soaks vs. Eternal Venom stacks per player.

Rules (verified on the 2026-09-17 combat log):
  orb soak      = SPELL_CAST_SUCCESS 1289201 (Caustic Globule) on a player -> immediately SPELL_CAST_SUCCESS 1290336 (Eternal Venom) by Vexhul
  add spawn     = Rouse the Brood (1308482, Ithraz) hits the whole raid -> 1 stack each; it falls off by itself after ~25 s
  orb explosion = Caustic Globule 1290338 (AOE) -> 1 stack to the whole raid
  add frontal   = Eternal Venom cast with source "Spawn of Vexhul"
  waves         = Stir the Depths (aura 1292807) on the player at the same moment
  dropped       = SPELL_AURA_REMOVED_DOSE / REMOVED (not on the player's death)
  net stacks    = gained - dropped = the player's stacks at the cutoff; ideally == orbs
The pull is cut at the N-th player death (death cutoff, default 2) – after that the wipe is on anyway.
"""
import collections

from common import nm, near, DAMAGE_EVENTS

SPELL_ORB, SPELL_VENOM, SPELL_ROUSE, SPELL_EXPL, SPELL_STIR = "1289201", "1290336", "1308482", "1290338", "1292807"
KEEP = ("Caustic Globule", "Eternal Venom", "Stir the Depths", "Rouse the Brood")
SRC = ["orb", "wave", "explosion", "spawn", "stir", "other"]

COLS = [
    {"k": "orbs", "l": "Orby", "cls": "orb", "agg": "sum"},
    {"k": "net", "l": "Stacky", "cls": "total", "agg": "sum"},
    {"k": "diff", "l": "Rozdíl", "cls": "diff", "signed": 1, "hot": [2, 4], "hotAll": [12, 18], "agg": "sum"},
    {"k": "total", "l": "Získané", "grp": 1, "agg": "sum"},
    {"k": "removed", "l": "Odpadlé", "neg": 1, "agg": "sum"},
    {"k": "orb", "l": "Orb", "grp": 1, "agg": "sum"},
    {"k": "wave", "l": "Spawn addek", "agg": "sum"},
    {"k": "explosion", "l": "Výbuch", "agg": "sum"},
    {"k": "spawn", "l": "Addka frontal", "avoid": 1, "hot": [2, 3], "hotAll": [6, 10], "agg": "sum"},
    {"k": "stir", "l": "Vlny", "avoid": 1, "hot": [2, 3], "hotAll": [6, 10], "agg": "sum"},
    {"k": "other", "l": "Jiné", "avoid": 1, "hot": [2, 3], "hotAll": [6, 10], "agg": "sum"},
    {"k": "max", "l": "Max", "grp": 1, "cls": "max", "high": 8, "agg": "max"},
]
LEGEND = [
    "<b>Orby</b> = soaknuté Caustic Globule. <b>Stacky</b> = čisté stacky Eternal Venom při cutoffu (získané − odpadlé). "
    "<b>Rozdíl</b> = Stacky − Orby: <b>0 je ideál</b>, plus jsou stacky navíc (frontal addky, vlny, nebo stack ze spawnu addek, "
    "který ještě nestihl odpadnout). <b>Získané</b> = všechny stacky, které hráč dostal, <b>Odpadlé</b> = stacky, které mu spadly "
    "(smrt se nepočítá), dále rozpad získaných podle zdroje. <b>Max</b> = nejvyšší dosažený počet stacků v pullu.",
    "<b>Orb</b> – soak orbu (žádoucí, 1 stack za orb). <b>Spawn addek</b> – Rouse the Brood od Ithraze, 1 stack každému živému hráči "
    "zhruba každou minutu; nelze se vyhnout, stack sám odpadne po ~25 s. <b>Výbuch</b> – nesoaknutý orb explodoval, 1 stack celému raidu.",
    "<b>Addka frontal</b> – zásah frontalem addky Spawn of Vexhul. <b>Vlny</b> – zásah vlnou (Stir the Depths). <b>Jiné</b> – zdroj se "
    "nepodařilo přiřadit. Tyhle tři jsou zbytečné stacky. Každý pull je uříznutý v okamžiku druhé smrti hráče (†).",
]
DESCRIPTION = ("Každý soaknutý <b>Caustic Globule</b> dá hráči 1 stack Eternal Venom. Stacky navíc přidává spawn addek (<b>Rouse the Brood</b>), "
               "výbuch nesoaknutého orbu, frontal addky (<b>Spawn of Vexhul</b>) a vlny (<b>Stir the Depths</b>). "
               "V ideálním případě má hráč přesně tolik stacků, kolik soaknul orbů.")


def analyze(pull, ctx):
    """pull = {start, end, ev:[(t, fields)]}; ctx = {cutoff, deaths:[(t, guid, name)], names:{guid: name}}"""
    st = pull["start"]
    cutoff_n = ctx["cutoff_n"]
    deaths = ctx["deaths"]
    death_t = collections.defaultdict(list)
    for t, g, _ in deaths:
        death_t[g].append(t)
    cutoff = deaths[cutoff_n - 1][0] if len(deaths) >= cutoff_n else pull["end"]
    evc = [(t, f) for t, f in pull["ev"] if t <= cutoff]
    names = dict(ctx["names"])
    orb_t, rouse_t, expl_t, stir_t = (collections.defaultdict(list) for _ in range(4))
    for t, f in evc:
        if len(f) <= 10:
            continue
        if f[0] == "SPELL_CAST_SUCCESS" and f[9] == SPELL_ORB:
            orb_t[f[5]].append(t)
        if f[0] in DAMAGE_EVENTS and f[9] == SPELL_ROUSE:
            rouse_t[f[5]].append(t)
        if f[0] in DAMAGE_EVENTS and f[9] == SPELL_EXPL:
            expl_t[f[5]].append(t)
        if f[0] == "SPELL_AURA_APPLIED" and f[9] == SPELL_STIR:
            stir_t[f[5]].append(t)

    orbs, stacks, maxst, removed, gained_a = (collections.Counter() for _ in range(5))
    gained = collections.defaultdict(collections.Counter)
    for t, f in evc:
        if len(f) <= 10:
            continue
        g = f[5]
        if f[0] == "SPELL_CAST_SUCCESS" and f[9] == SPELL_ORB:
            orbs[g] += 1
        if f[0] == "SPELL_CAST_SUCCESS" and f[9] == SPELL_VENOM:
            if f[2] == '"Spawn of Vexhul"':
                src = "spawn"
            elif near(orb_t[g], t, 0.15):
                src = "orb"
            elif near(stir_t[g], t, 0.15):
                src = "stir"
            elif near(rouse_t[g], t, 0.6):
                src = "wave"
            elif near(expl_t[g], t, 0.6):
                src = "explosion"
            else:
                src = "other"
            gained[g][src] += 1
        if f[9] == SPELL_VENOM and f[0] in ("SPELL_AURA_APPLIED", "SPELL_AURA_APPLIED_DOSE", "SPELL_AURA_REMOVED_DOSE", "SPELL_AURA_REMOVED"):
            if f[0] == "SPELL_AURA_REMOVED" and near(death_t[g], t, 1.5):
                continue  # debuff dropped on death - keep the stacks the player died with
            n = 1 if f[0] == "SPELL_AURA_APPLIED" else 0 if f[0] == "SPELL_AURA_REMOVED" else int(f[-1])
            if n < stacks[g]:
                removed[g] += stacks[g] - n
            else:
                gained_a[g] += n - stacks[g]
            stacks[g] = n
            maxst[g] = max(maxst[g], n)
    expl_n, last = 0, None
    for x in sorted(set(round((t - st).total_seconds()) for lst in expl_t.values() for t in lst)):
        if last is None or x - last > 1:
            expl_n += 1
        last = x
    waves = max([c["wave"] for c in gained.values()] or [0])
    died = {g for t, g, _ in deaths if t <= cutoff}
    rows = []
    for g in set(names) | set(orbs) | set(gained):
        c = gained[g]
        rows.append({"name": names.get(g, nm(g)), "orbs": orbs[g], "net": stacks[g], "diff": stacks[g] - orbs[g],
                     "total": gained_a[g], "removed": removed[g], **{k: c[k] for k in SRC},
                     "max": maxst[g], "died": g in died})
    rows.sort(key=lambda r: (-r["orbs"], r["diff"], r["name"]))
    n = len(rows) or 1
    net = sum(r["net"] for r in rows)
    diff = sum(r["diff"] for r in rows)
    avoid = sum(r["spawn"] + r["stir"] + r["other"] for r in rows)
    cut = round((cutoff - st).total_seconds()) if len(deaths) >= cutoff_n else None
    total_orbs = sum(orbs.values())
    stats = [
        {"l": "Cutoff", "v": ("%d:%02d" % (cut // 60, cut % 60)) if cut is not None else "—", "cls": "bad" if cut is not None else "",
         "s": ("%d. smrt: " % cutoff_n + ", ".join(x[2] for x in deaths[:cutoff_n])) if cut is not None else "nedosažen (%d úmrtí)" % len(deaths)},
        {"l": "Soaknuté orby", "v": total_orbs, "cls": "accent", "s": "%.1f na hráče" % (total_orbs / n), "agg": "sum"},
        {"l": "Stacky (čisté)", "v": net, "cls": "venom", "s": ("+" if diff >= 0 else "") + str(diff) + " oproti orbům", "agg": "sum"},
        {"l": "Zbytečné stacky", "v": avoid, "cls": "bad" if avoid else "", "s": "frontal addky + vlny + jiné", "agg": "sum"},
        {"l": "Spawny addek", "v": waves, "cls": "", "s": "%d stacků raidu, odpadají po ~25 s" % (waves * 20), "agg": "sum"},
        {"l": "Výbuchy orbů", "v": expl_n, "cls": "bad" if expl_n else "", "s": ("%d stacků celému raidu" % (expl_n * 20)) if expl_n else "žádný nesoaknutý orb", "agg": "sum"},
    ]
    return {"cols": COLS, "legend": LEGEND, "description": DESCRIPTION, "stats": stats, "cutoff": cut,
            "summary": {"orbs": total_orbs, "expl": expl_n, "waves": waves, "cutoffDeaths": [x[2] for x in deaths[:cutoff_n]]},
            "players": rows}
