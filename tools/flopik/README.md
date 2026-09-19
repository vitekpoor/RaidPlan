# Flopik – fails po pullech (z Warcraft Logs)

Po každém pullu se spočítají předem definované faily bosse – smrti u každého bosse, zásahy
Tempestem u Sszoraka, soaky orbů vs. stacky Eternal Venom u Twin Fangs… – a zapíšou do listu
**„Flopik“** v guildovní tabulce. Stránka **flopik.html** má dropdown reportů (raidových večerů)
z Warcraft Logs, pro vybraný report si nechá chybějící pully dopočítat a každou minutu se
obnovuje, takže během raidu (guilda loguje živě do WCL) ukazuje poslední pull.

```
Warcraft Logs (živý upload) ──► Apps Script web app (?p=flopik&action=refresh&code=…)
                                  │  WCL API v2: fights + události fightu (filtr podle metrik bosse)
                                  │  engine.js: flopikAnalyze(fight, events, actors) → řádky
                                  ▼
                              list „Flopik“ ──gviz CSV──► flopik.html (dropdown reportů z action=reports)
```

## Nastavení (jednorázově)

1. V Apps Scriptu (`tools/roster/class_loot_dropdowns.gs`) je sekce **FLOPIK** + **FLOPIK – Warcraft Logs**
   + vygenerovaný **FLOPIK ENGINE**. Po každé změně vložit celý soubor do Google a nasadit novou verzi web appu.
2. API klient: https://www.warcraftlogs.com/api/clients → v tabulce menu **Flopik → Nastavit Warcraft Logs API
   klienta…** (client ID + secret se uloží do Script Properties `WCL_CLIENT_ID` / `WCL_CLIENT_SECRET`, token do
   `WCL_TOKEN`). Menu rovnou ověří přístup dotazem na guildu (ID 91339, `FLOPIK_GUILD` v .gs).
3. Report musí být **public/unlisted** (client credentials nevidí private reporty).

Pak už nic – stránka sama zavolá `refresh` pro vybraný report. Ručně jde report načíst i z menu
**Flopik → Načíst report z Warcraft Logs…** (kód nebo URL). Jedno volání počítá max ~4 minuty
(limit Apps Scriptu), stránka volá opakovaně, dokud `remaining > 0`. Pully kratší než 30 s se nezapisují (stránka je skryje i zpětně).

## Přidání bosse / failu

Vše je v **`engine.js`** (`FLOPIK_BOSSES`) – po úpravě spustit `python build_gs.py` (vloží engine mezi
markery v .gs) a znovu nasadit. Boss = encounter ID → `{ key, name, metrics: [...] }`; boss, který tam
není, dostane automaticky aspoň smrti.

```js
flopikHits_("tempest", "Tempest", [1287083], { castIds: [1287072], window: 3.0, hot: [1, 2], hotAll: [2, 4], note: "…" })
flopikDebuff_("residue", "Caustic Residue", [1296667])   // počet aplikací debuffu na hráče
flopikCasts_("soak", "Soaky", [123456])                   // počet castů hráče
```

`hits` = „unique hit count“: každý cast, který hráče zasáhl, se počítá jednou (zásahy do `window` s od
sebe jsou jeden cast; ticky periodic damage se nepočítají), `castIds` = ID castu bosse pro počet castů
v souhrnu. `hot`/`hotAll` = prahy pro oranžové / červené zvýraznění v pullu / v součtu, `note` = legenda.
Spell ID: WCL (Events tab) nebo `grep -a "Tempest" WoWCombatLog-*.txt | head` (ID zásahu/debuffu, ne castu).

Složitější mechaniky (Twin Fangs: soak orbu → stack, zdroje stacků, death cutoff 2) mají vlastní analyzátor
(`flopikTwinFangs_`, `analyze: "twinfangs"`), který vrací i sloupce, statistiky a legendu – stránka o bossech
nic neví, vykreslí, co dostane.

Test bez Google: `engine.js` je čistý JS – načíst v prohlížeči s uloženými událostmi fightu z WCL API
(viz `flopikFilterFor` pro filterExpression) a zavolat `flopikAnalyze(fight, events, actors, report.startTime)`.

## Damage breakdown + srovnání s rank 1 logem

Po kliknutí na jméno hráče se pod řádkem rozbalí rozpad za celý pull (bez death cutoffu): **schopnosti** (podíl na
celkové damage, DPS), **casty** (počet, za minutu) a **cíle**, vedle stejného rozpadu z **rank 1 logu** téhož specu na
tomto bossovi a obtížnosti (WCL `worldData.encounter.characterRankings`, metrika dps, u healerů hps + Healing tabulka).
Data hráčů se berou z WCL tabulek `DamageDone` / `Healing` / `Casts` fightu při `refresh` (sekce **FLOPIK – Damage
breakdown** v .gs, `flopikDmgAttach_`) a ukládají do Data JSON hráče (klíč `dmg`). Referenční logy jsou v listu
**„FlopikRef“** (klíč `bossId|obtížnost|Class-Spec`, hledají se znovu po 7 dnech, neúspěch po dni); stránka je čte přes
gviz CSV stejně jako list Flopik. Rank 1 kill má jinou délku než náš wipe, proto se srovnávají podíly a hodnoty za
sekundu / minutu. Oranžově jsou schopnosti, které top log používá a my ne. Pully spočítané před přidáním modulu rozpad
nemají – smazat jejich řádky v listu a stránka je načte znovu.

## Data v tabulce

List „Flopik“: `Datum | Pull | Boss | Obtížnost | Start | Délka (s) | Kill | Hráč | Data | Boss klíč | Zapsáno | Report | Fight`.
Na každý pull jeden souhrnný řádek (Hráč prázdný, Data = JSON s `cols`, `stats`, `legend`, `description`,
`summary`, `deathList`, `cutoff`) a jeden řádek na hráče (Data = JSON hodnot metrik + `died`, `deaths`).
Report = kód WCL reportu, Fight = ID fightu (klíč pro „už spočítáno“). Číslo pullu = pořadí v rámci dne a bosse.

## Lokální varianta (bez Warcraft Logs)

`flopik.py` umí to samé přímo z combat logu na disku: `python flopik.py` sleduje nejnovější
`_retail_\Logs\WoWCombatLog*.txt` a po každém pullu pošle výsledek do listu (POST `p=flopik`, token
sim_runner.py z `tools/roster/sim_runner.config.json` nebo `flopik.config.json`), `--replay SOUBOR` projede
starší log, `--no-upload` jen vypíše. Definice bossů pro Python jsou v `bosses.py` / `twinfangs.py`
(zrcadlo engine.js). Řádky z lokálního logu nemají Report a na stránce jsou pod „lokální combat log“.
