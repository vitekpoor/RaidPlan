"""Flopik – which bosses are tracked and which "fails" are counted for each.

A boss entry is keyed by the ENCOUNTER_START encounter ID and has:
  key       short id used in the sheet / page
  cutoff    death cutoff – the pull is evaluated only up to the N-th player death (0 = whole pull)
  metrics   list of declarative metrics (see `hits`), evaluated by flopik.py
  analyze   optional custom analyzer (module with analyze(pull, ctx) + KEEP) for things a simple counter cannot do
Every boss – including ones not listed here – automatically gets per-player deaths.

Declarative metric kinds:
  hits(key, label, spell_ids, window=1.5, cast_ids=[…])
                                            "unique hit count": for each player the number of distinct casts of
                                            the spell(s) that hit them (SPELL_DAMAGE / ABSORBED / MISSED / AURA_APPLIED,
                                            hits closer than `window` s count as the same cast); with cast_ids the
                                            summary also shows how many times the boss cast it (SPELL_CAST_SUCCESS)
  debuff(key, label, spell_ids)             number of SPELL_AURA_APPLIED (+ _DOSE) of the debuff on the player
  casts(key, label, spell_ids)              number of SPELL_CAST_SUCCESS by the player (e.g. a required interrupt / soak spell)
Metric options: avoid=True (highlight as a fail, default True), hot=[a, b] (thresholds per pull), hotAll=[a, b] (all pulls),
note="…" (legend text).

Spell IDs: grep the combat log, e.g.  grep -a "Tempest" WoWCombatLog-*.txt | head   (the damage/aura ID, not the cast ID).
"""
import twinfangs


def _metric(kind, key, label, spell_ids, **opts):
    m = {"kind": kind, "k": key, "l": label, "ids": [str(i) for i in spell_ids], "avoid": True, "window": 1.5}
    m.update(opts)
    m["cast_ids"] = [str(i) for i in m.get("cast_ids", [])]
    return m


def hits(key, label, spell_ids, **opts):
    return _metric("hits", key, label, spell_ids, **opts)


def debuff(key, label, spell_ids, **opts):
    return _metric("debuff", key, label, spell_ids, **opts)


def casts(key, label, spell_ids, **opts):
    return _metric("casts", key, label, spell_ids, **opts)


BOSSES = {
    3470: {"key": "nekzali", "name": "Nek'zali the Soulcoiler", "metrics": []},
    3445: {"key": "sentinels", "name": "Entombed Sentinels", "metrics": []},
    3455: {"key": "vashnik", "name": "Vashnik the Malignant", "metrics": []},
    3497: {"key": "explorers", "name": "The Lost Explorers", "metrics": []},
    3420: {"key": "sszorak", "name": "Sszorak", "metrics": [
        hits("tempest", "Tempest", [1287083], cast_ids=[1287072], window=3.0, hot=[1, 2], hotAll=[2, 4],
             note="zásah Tempestem (1287083) – každý cast se počítá jednou (unique hit count), ne ticky"),
    ]},
    3421: {"key": "twinfangs", "name": "The Twin Fangs", "cutoff": 2, "analyze": twinfangs, "metrics": []},
    # orb pickups: Volatile Venom debuff on the carrier (5 s per orb, relays count again); spawn_ids / cast_ids only in engine.js
    3429: {"key": "coiledaltar", "name": "The Coiled Altar", "ver": 2, "metrics": [
        debuff("orbs", "Orby", [1282419], avoid=False, cast_ids=[1299960], spawn_ids=[1299781],
               note="sebrání orbu Coalesced Venom (debuff Volatile Venom 1282419 při každém sebrání)"),
    ]},
    3492: {"key": "ulatek", "name": "Ula'tek", "metrics": []},
    3379: {"key": "nymrissa", "name": "Nymrissa Wavecaller", "metrics": []},
}
