#!/usr/bin/env python3
"""
loot_items.py – vytvoří web/loot_items.json: loot tabulka aktuální sezóny
(raid itemy + bossové, itemy z Mythic+ dungeonů + dungeony) z veřejných dat
Raidbots. Stránka loot.html podle ní doplňuje název, slot a bosse/dungeon
k itemům z QE Live reportů (ty mají jen ID) i k itemům z Great Vaultu, a řadí
bosse ve správném pořadí. Dungeony jsou v "bosses" jako položky kind "mplus".

Zdroj: https://www.raidbots.com/static/data/live/equippable-items.json (~50 MB,
stahuje se jen při spuštění tohoto skriptu – výstup je malý a commituje se).
Volitelně: python loot_items.py cesta/k/equippable-items.json (už stažený soubor).

Použití:  python loot_items.py            (v tools/roster/)
Spouštět po změně sezóny / přidání raidu či M+ poolu (INSTANCES / DUNGEONS níže).
"""

import json
import sys
from pathlib import Path

import requests

HERE = Path(__file__).resolve().parent
OUT = HERE.parent.parent / "web" / "loot_items.json"
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

# Mythic+ pool sezóny (instance id -> název; pořadí = jak je má Raidbots). Item ID
# u starších dungeonů (Kings' Rest, Temple of Sethraliss, Ruby Life Pools) jsou
# stejná jako původně – Raidbots i hra je jen škálují na aktuální ilvl.
DUNGEONS = {
    1322: "Altar of Fangs",
    1311: "Den of Nalorakk",
    1041: "Kings' Rest",
    1304: "Murder Row",
    1202: "Ruby Life Pools",
    1030: "Temple of Sethraliss",
    1309: "The Blinding Vale",
    1313: "Voidscar Arena",
}

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
    if len(sys.argv) > 1 and Path(sys.argv[1]).is_file():
        print(f"Čtu {sys.argv[1]} …", flush=True)
        items = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    else:
        print(f"Stahuji {SRC} …", flush=True)
        r = requests.get(SRC, timeout=300)
        r.raise_for_status()
        items = r.json()
    boss_ids = {b[0] for b in BOSSES}
    out_items = {}
    tiers = dung = 0
    for it in items:
        inv = it.get("inventoryType")
        srcs = [s for s in it.get("sources", []) if s.get("instanceId") in INSTANCES]
        dsrcs = [s for s in it.get("sources", []) if s.get("instanceId") in DUNGEONS]
        is_tier = (not srcs and it.get("itemSetId") and it.get("expansion") == TIER_EXPANSION
                   and any(s.get("instanceId") == -100 for s in it.get("sources", [])) and inv in TIER_SLOT_BOSS)
        if not srcs and not is_tier and not dsrcs:
            continue
        slot = SLOTS.get(inv, "token" if it.get("itemClass") == 15 else ("token" if inv is None else f"inv{inv}"))
        entry = {
            "name": it.get("name", ""),
            "icon": it.get("icon", ""),
            "slot": slot,
            "quality": it.get("quality"),
        }
        if is_tier:
            entry["bosses"] = sorted({TIER_SLOT_BOSS[inv], TIER_ANY_BOSS})
            entry["tier"] = True
            tiers += 1
        elif srcs:
            entry["bosses"] = sorted({s["encounterId"] for s in srcs if s["encounterId"] in boss_ids})
        else:
            # M+ item: "bosses" = id dungeonu (instance), stejně jako Boss ID u M+ řádků v "Sim výsledky"
            entry["bosses"] = sorted({s["instanceId"] for s in dsrcs})
            entry["kind"] = "mplus"
            dung += 1
        out_items[str(it["id"])] = entry
    out = {
        "instances": {str(k): v for k, v in INSTANCES.items()},
        "dungeons": {str(k): v for k, v in DUNGEONS.items()},
        "bosses": [{"id": b[0], "name": b[1], "num": b[2], "instance": b[3]} for b in BOSSES]
                  + [{"id": k, "name": v, "num": "M+", "instance": k, "kind": "mplus"} for k, v in DUNGEONS.items()],
        "items": out_items,
    }
    OUT.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"{len(out_items)} itemů ({tiers} tier kusů, {dung} z M+ dungeonů), {len(BOSSES)} bossů + {len(DUNGEONS)} dungeonů -> {OUT}")


if __name__ == "__main__":
    try:
        main()
    except requests.RequestException as err:
        sys.exit(f"Stažení selhalo: {err}")
