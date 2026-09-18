#!/usr/bin/env python3
"""Sync tools/flopik/engine.js into tools/roster/class_loot_dropdowns.gs (between the FLOPIK ENGINE markers).

    python build_gs.py

engine.js is the single source of the boss definitions + fight analysis used by the Apps Script web app
(Warcraft Logs → sheet). Run this after editing engine.js, then re-paste the .gs into Google and deploy.
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
GS = os.path.join(HERE, "..", "roster", "class_loot_dropdowns.gs")
BEGIN = "// >>> FLOPIK ENGINE (generated from tools/flopik/engine.js by build_gs.py – edit engine.js, not this)"
END = "// <<< FLOPIK ENGINE"


def main():
    engine = open(os.path.join(HERE, "engine.js"), encoding="utf-8").read().strip("\n")
    gs = open(GS, encoding="utf-8").read()
    a, b = gs.find(BEGIN), gs.find(END)
    if a < 0 or b < 0 or b < a:
        sys.exit("markers not found in class_loot_dropdowns.gs")
    out = gs[:a] + BEGIN + "\n" + engine + "\n" + gs[b:]
    if out != gs:
        open(GS, "w", encoding="utf-8").write(out)
        print("class_loot_dropdowns.gs updated – re-paste into Apps Script and deploy a new version")
    else:
        print("class_loot_dropdowns.gs already up to date")


if __name__ == "__main__":
    main()
