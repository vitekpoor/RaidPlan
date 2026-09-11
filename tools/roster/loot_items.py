#!/usr/bin/env python3
"""
loot_items.py – vytvoří raidplan/loot_items.json: loot tabulka aktuální raid
sezóny (itemy + bossové) z veřejných dat Raidbots. Stránka loot.html podle ní
doplňuje název, slot a bosse k itemům z QE Live reportů (ty mají jen ID) a řadí
bosse ve správném pořadí.

Zdroj: https://www.raidbots.com/static/data/live/equippable-items.json (~50 MB,
stahuje se jen při spuštění tohoto skriptu – výstup je malý a commituje se).

Použití:  python loot_items.py            (v Roster/)
Spouštět po změně sezóny / přidání raidu (INSTANCES níže).
"""

import json
import sys
from pathlib import Path

import requests

HERE = Path(__file__).resolve().parent
OUT = HERE.parent / "raidplan" / "loot_items.json"
SRC = "https://www.raidbots.com/static/data/live/equippable-items.json"

# instance id -> název; pořadí bossů = pořadí v raid guide (bossnav)
INSTANCES = {1320: "The Venomous Abyss", 1317: "The Tidebound Grotto"}
BOSSES = [
    (2888, "Nek'zali the Soulcoiler", "I", 1320),
    (2874, "Entombed Sentinels", "II", 1320),
    (2882, "Vashnik the Malignant", "III", 1320),
    (2894, "The Lost Explorers", "IV", 1320),
    (2871, "Sszorak", "V", 1320),
    (2887, "The Twin Fangs", "VI", 1320),
    (2883, "The Coiled Altar", "VII", 1320),
    (2895, "Ula'tek", "VIII", 1320),
    (-97, "Trash", "T", 1320),
    (2849, "Nymrissa Wavecaller", "Lair", 1317),
]

# Tier set kusy (itemSetId, zdroj instanceId -100 = token/catalyst): token padá podle slotu
# z konkrétního bosse (viz raid guide) a flexibilní Slumbering Coil Curio z Ula'teka.
TIER_EXPANSION = 11
TIER_SLOT_BOSS = {1: 2887, 3: 2894, 5: 2882, 20: 2882, 7: 2871, 10: 2874}
TIER_ANY_BOSS = 2895

# Blizzard inventoryType -> slot
SLOTS = {
    1: "head", 2: "neck", 3: "shoulder", 5: "chest", 20: "chest", 6: "waist", 7: "legs", 8: "feet",
    9: "wrist", 10: "hands", 11: "finger", 12: "trinket", 13: "one_hand", 14: "off_hand", 15: "ranged",
    16: "back", 17: "two_hand", 21: "main_hand", 22: "off_hand", 23: "off_hand", 26: "ranged", 28: "relic",
}


def main():
    print(f"Stahuji {SRC} …", flush=True)
    r = requests.get(SRC, timeout=300)
    r.raise_for_status()
    items = r.json()
    boss_ids = {b[0] for b in BOSSES}
    out_items = {}
    tiers = 0
    for it in items:
        inv = it.get("inventoryType")
        srcs = [s for s in it.get("sources", []) if s.get("instanceId") in INSTANCES]
        is_tier = (not srcs and it.get("itemSetId") and it.get("expansion") == TIER_EXPANSION
                   and any(s.get("instanceId") == -100 for s in it.get("sources", [])) and inv in TIER_SLOT_BOSS)
        if not srcs and not is_tier:
            continue
        slot = SLOTS.get(inv, "token" if it.get("itemClass") == 15 else ("token" if inv is None else f"inv{inv}"))
        if is_tier:
            bosses = sorted({TIER_SLOT_BOSS[inv], TIER_ANY_BOSS})
            tiers += 1
        else:
            bosses = sorted({s["encounterId"] for s in srcs if s["encounterId"] in boss_ids})
        out_items[str(it["id"])] = {
            "name": it.get("name", ""),
            "icon": it.get("icon", ""),
            "slot": slot,
            "quality": it.get("quality"),
            "bosses": bosses,
        }
        if is_tier:
            out_items[str(it["id"])]["tier"] = True
    out = {
        "instances": {str(k): v for k, v in INSTANCES.items()},
        "bosses": [{"id": b[0], "name": b[1], "num": b[2], "instance": b[3]} for b in BOSSES],
        "items": out_items,
    }
    OUT.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"{len(out_items)} itemů ({tiers} tier kusů), {len(BOSSES)} bossů -> {OUT}")


if __name__ == "__main__":
    try:
        main()
    except requests.RequestException as err:
        sys.exit(f"Stažení selhalo: {err}")
