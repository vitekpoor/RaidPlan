"""Flopik – The Twin Fangs (Mythic): Caustic Globule soaks vs. Eternal Venom stacks per player.

Rules (verified on the 2026-09-17 combat log):
  orb soak      = SPELL_CAST_SUCCESS 1289201 (Caustic Globule) on a player -> immediately SPELL_CAST_SUCCESS 1290336 (Eternal Venom) by Vexhul
  add spawn     = Rouse the Brood (1308482, Ithraz) hits the whole raid -> 1 stack each; it falls off by itself after ~25 s
  orb explosion = Caustic Globule 1290338 (AOE) -> 1 stack to the whole raid
  add frontal   = Eternal Venom cast with source "Spawn of Vexhul" (right after its Corrosive Spit 1291478 cast success).
                  The marker debuff 1293979 applied at cast start names the targeted player. Split into: 1st cast on its
                  target (expected, 1 per add), anyone else in the cone (avoidable) and a 2nd+ cast of the same add (the add
                  should have died before it - verified 2026-09-17: 5 s cast, ~7 s between casts, target hit in 237/245 casts)
  waves         = Stir the Depths (aura 1292807) on the player at the same moment
  Vile Flood    = intermission laser of Vexhul: debuff/damage 1294605 on the player at the same moment (cast itself is 1294293)
  dropped       = SPELL_AURA_REMOVED_DOSE / REMOVED (not on the player's death)
  net stacks    = gained - dropped = the player's stacks at the cutoff; ideally == orbs
The pull is cut at the N-th player death (death cutoff, default 2) – after that the wipe is on anyway.
"""
import collections
import datetime

from common import nm, near, DAMAGE_EVENTS

SPELL_ORB, SPELL_VENOM, SPELL_ROUSE, SPELL_EXPL, SPELL_STIR, SPELL_FLOOD = "1289201", "1290336", "1308482", "1290338", "1292807", "1294605"
SPELL_SPIT, SPELL_MARK = "1291478", "1293979"
SPAWN = '"Spawn of Vexhul"'
KEEP = ("Caustic Globule", "Eternal Venom", "Stir the Depths", "Rouse the Brood", "Vile Flood", "Corrosive Spit")
SRC = ["orb", "wave", "explosion", "spawn", "spawnSide", "spawn2", "stir", "flood", "other"]
FLOOD_EVENTS = DAMAGE_EVENTS + ("SPELL_PERIODIC_DAMAGE", "SPELL_PERIODIC_MISSED", "SPELL_AURA_APPLIED")

COLS = [
    {"k": "orbs", "l": "Orby", "cls": "orb", "agg": "sum"},
    {"k": "net", "l": "Stacky", "cls": "total", "agg": "sum"},
    {"k": "diff", "l": "Rozdíl", "cls": "diff", "signed": 1, "hot": [2, 4], "hotAll": [12, 18], "agg": "sum"},
    {"k": "total", "l": "Získané", "grp": 1, "agg": "sum"},
    {"k": "removed", "l": "Odpadlé", "neg": 1, "agg": "sum"},
    {"k": "orb", "l": "Orb", "grp": 1, "agg": "sum"},
    {"k": "wave", "l": "Spawn addek", "agg": "sum"},
    {"k": "explosion", "l": "Výbuch", "agg": "sum"},
    {"k": "spawn", "l": "Addka cíl", "agg": "sum"},
    {"k": "spawnSide", "l": "Addka v cestě", "avoid": 1, "hot": [1, 2], "hotAll": [3, 6], "agg": "sum"},
    {"k": "spawn2", "l": "Addka 2. cast", "avoid": 1, "hot": [1, 2], "hotAll": [2, 4], "agg": "sum"},
    {"k": "stir", "l": "Vlny", "avoid": 1, "hot": [2, 3], "hotAll": [6, 10], "agg": "sum"},
    {"k": "flood", "l": "Vile Flood", "avoid": 1, "hot": [2, 3], "hotAll": [6, 10], "agg": "sum"},
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
    "<b>Addka cíl</b> – první frontal (Corrosive Spit) addky Spawn of Vexhul na hráče, kterého si addka vybrala (čekaný, 1 na addku). "
    "<b>Addka v cestě</b> – frontal trefil i někoho jiného, kdo stál v kuželu. <b>Addka 2. cast</b> – addka se dožila dalšího frontalu a trefila "
    "svůj cíl (měla umřít dřív). <b>Vlny</b> – zásah vlnou (Stir the Depths). <b>Vile Flood</b> – zásah "
    "laserem Vexhul v intermission. <b>Jiné</b> – zdroj se nepodařilo přiřadit (typicky stack v okamžiku smrti). Zbytečné stacky = v cestě + 2. cast + vlny + Vile Flood + jiné. Každý pull je uříznutý v okamžiku druhé smrti hráče (†).",
]
DESCRIPTION = ("Každý soaknutý <b>Caustic Globule</b> dá hráči 1 stack Eternal Venom. Stacky navíc přidává spawn addek (<b>Rouse the Brood</b>), "
               "výbuch nesoaknutého orbu, frontal addky (<b>Spawn of Vexhul</b>), vlny (<b>Stir the Depths</b>) a laser v intermission (<b>Vile Flood</b>). "
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
    orb_t, rouse_t, expl_t, stir_t, flood_t, spit_t, mark_t = (collections.defaultdict(list) for _ in range(7))
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
        if f[0] in FLOOD_EVENTS and f[9] == SPELL_FLOOD:
            flood_t[f[5]].append(t)
        if f[0] == "SPELL_CAST_SUCCESS" and f[9] == SPELL_SPIT and f[2] == SPAWN:
            spit_t[f[1]].append(t)
        if f[0] == "SPELL_AURA_APPLIED" and f[9] == SPELL_MARK and f[2] == SPAWN:
            mark_t[f[1]].append((t, f[5]))

    def spawn_kind(add, t, g):
        """Which frontal of this add is it and who was the marked target? -> spawn (1st cast, target) / spawnSide / spawn2"""
        lim = t + datetime.timedelta(milliseconds=100)
        n = sum(1 for x in spit_t[add] if x <= lim)
        tgt = None
        for x, who in mark_t[add]:
            if x <= lim:
                tgt = who
        if tgt is not None and tgt != g:
            return "spawnSide"
        return "spawn2" if n >= 2 else "spawn"

    orbs, stacks, maxst, removed, gained_a = (collections.Counter() for _ in range(5))
    gained = collections.defaultdict(collections.Counter)
    for t, f in evc:
        if len(f) <= 10:
            continue
        g = f[5]
        if f[0] == "SPELL_CAST_SUCCESS" and f[9] == SPELL_ORB:
            orbs[g] += 1
        if f[0] == "SPELL_CAST_SUCCESS" and f[9] == SPELL_VENOM:
            if f[2] == SPAWN:
                src = spawn_kind(f[1], t, g)
            elif near(orb_t[g], t, 0.15):
                src = "orb"
            elif near(stir_t[g], t, 0.15):
                src = "stir"
            elif near(rouse_t[g], t, 0.6):
                src = "wave"
            elif near(expl_t[g], t, 0.6):
                src = "explosion"
            elif near(flood_t[g], t, 0.6):
                src = "flood"
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
    avoid = sum(r["spawnSide"] + r["spawn2"] + r["stir"] + r["flood"] + r["other"] for r in rows)
    cut = round((cutoff - st).total_seconds()) if len(deaths) >= cutoff_n else None
    total_orbs = sum(orbs.values())
    adds2 = sum(1 for v in spit_t.values() if len(v) >= 2)
    stats = [
        {"l": "Cutoff", "v": ("%d:%02d" % (cut // 60, cut % 60)) if cut is not None else "—", "cls": "bad" if cut is not None else "",
         "s": ("%d. smrt: " % cutoff_n + ", ".join(x[2] for x in deaths[:cutoff_n])) if cut is not None else "nedosažen (%d úmrtí)" % len(deaths)},
        {"l": "Soaknuté orby", "v": total_orbs, "cls": "accent", "s": "%.1f na hráče" % (total_orbs / n), "agg": "sum"},
        {"l": "Stacky (čisté)", "v": net, "cls": "venom", "s": ("+" if diff >= 0 else "") + str(diff) + " oproti orbům", "agg": "sum"},
        {"l": "Zbytečné stacky", "v": avoid, "cls": "bad" if avoid else "", "s": "addka v cestě + 2. cast + vlny + Vile Flood + jiné", "agg": "sum"},
        {"l": "Addky s 2. frontalem", "v": adds2, "cls": "bad" if adds2 else "", "s": "z %d addek, které dokončily frontal" % len(spit_t), "agg": "sum"},
        {"l": "Spawny addek", "v": waves, "cls": "", "s": "%d stacků raidu, odpadají po ~25 s" % (waves * 20), "agg": "sum"},
        {"l": "Výbuchy orbů", "v": expl_n, "cls": "bad" if expl_n else "", "s": ("%d stacků celému raidu" % (expl_n * 20)) if expl_n else "žádný nesoaknutý orb", "agg": "sum"},
    ]
    return {"cols": COLS, "legend": LEGEND, "description": DESCRIPTION, "stats": stats, "cutoff": cut,
            "summary": {"orbs": total_orbs, "expl": expl_n, "waves": waves, "cutoffN": cutoff_n, "cutoffDeaths": [x[2] for x in deaths[:cutoff_n]]},
            "players": rows}
