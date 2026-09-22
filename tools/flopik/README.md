# Flopik – fails po pullech (z Warcraft Logs)

Po každém pullu se spočítají předem definované faily bosse – smrti u každého bosse, zásahy
Tempestem u Sszoraka, soaky orbů vs. stacky Eternal Venom u Twin Fangs… – a uloží do databáze
guildy (Cloudflare D1, tabulky `flopik_*`). Stránka **flopik.html** má dropdown reportů (raidových večerů)
z Warcraft Logs, pro vybraný report si nechá chybějící pully dopočítat a každou minutu se
obnovuje, takže během raidu (guilda loguje živě do WCL) ukazuje poslední pull.

```
Warcraft Logs (živý upload) ──► flopik.html: POST /api/flopik/refresh { code }
                                  │  Worker (worker/flopik.js) spustí GitHub Actions runner .github/workflows/flopik.yml
                                  │  wcl_refresh.mjs: WCL API v2 fights + události fightu (filtr podle metrik bosse)
                                  │  engine.js: flopikAnalyze(fight, events, actors) → pully → POST /api/flopik/pulls
                                  ▼
                              D1 (flopik_pulls, flopik_players, flopik_refs) ──► GET /api/flopik/pulls ──► flopik.html
```

## Nastavení (jednorázově)

1. API klient: https://www.warcraftlogs.com/api/clients → secrets `WCL_CLIENT_ID` / `WCL_CLIENT_SECRET`
   jednak na Workeru (dashboard; Worker s nimi odpovídá `reports` a `refwin` živě z WCL), jednak v GitHub
   Actions (runner). Worker potřebuje i secret `GITHUB_TOKEN` (actions:write) na spuštění runneru.
2. Report musí být **public/unlisted** (client credentials nevidí private reporty).

Pak už nic – stránka sama zavolá `refresh` pro vybraný report a čeká na `GET /api/flopik/status`. Runner
běží i z cronu během raidových večerů (`--live`). Pully kratší než 30 s se nezapisují (stránka je skryje i zpětně).
Lokální test: `node wcl_refresh.mjs --code KÓD --dry-run` (funguje i s node.exe z Playwrightu).

## Přidání bosse / failu

Vše je v **`engine.js`** (`FLOPIK_BOSSES`) – runner ho načítá přímo, stačí commit + push. Boss = encounter ID → `{ key, name, metrics: [...] }`; boss, který tam
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

Test bez WCL: `engine.js` je čistý JS – načíst v prohlížeči s uloženými událostmi fightu z WCL API
(viz `flopikFilterFor` pro filterExpression) a zavolat `flopikAnalyze(fight, events, actors, report.startTime)`.

## Damage breakdown + srovnání s rank 1 logem

Po kliknutí na jméno hráče se pod řádkem rozbalí rozpad za celý pull (bez death cutoffu): **schopnosti** (podíl na
celkové damage, DPS), **casty** (počet, za minutu) a **cíle**, vedle stejného rozpadu z **rank 1 logu** téhož specu na
tomto bossovi a obtížnosti (WCL `worldData.encounter.characterRankings`, metrika dps, u healerů hps + Healing tabulka).
Data hráčů se berou z WCL tabulek `DamageDone` / `Healing` / `Casts` fightu při `refresh` (runner,
`flopikDmgAttach_` v engine.js) a ukládají do dat hráče (klíč `dmg`). Referenční logy jsou v tabulce
**`flopik_refs`** (klíč `bossId|obtížnost|Class-Spec`, hledají se znovu po 7 dnech, neúspěch po dni); stránka je čte
z `GET /api/flopik/refs`. Rank 1 kill má jinou délku než náš wipe, proto se srovnávají podíly a hodnoty za
sekundu / minutu. Oranžově jsou schopnosti, které top log používá a my ne. Pully spočítané před přidáním modulu rozpad
nemají – po smazání pullu z databáze je stránka načte znovu.

## Data v databázi

`flopik_pulls`: report + fight (nebo datum + boss + start u lokálních pullů), číslo pullu v rámci dne a bosse, boss,
obtížnost, délka, kill a `meta` JSON (`cols`, `stats`, `legend`, `description`, `summary`, `deathList`, `cutoff`);
`flopik_players`: řádek na hráče a pull (`data` JSON hodnot metrik + `died`, `deaths`, `dmg`, `parse`).
Endpointy: hlavička `worker/flopik.js`.

## Lokální varianta (bez Warcraft Logs)

`flopik.py` umí to samé přímo z combat logu na disku: `python flopik.py` sleduje nejnovější
`_retail_\Logs\WoWCombatLog*.txt` a po každém pullu pošle výsledek do databáze (POST `/api/flopik/pulls`,
`api_url` + `api_token` z `tools/roster/sim_runner.config.json` nebo `flopik.config.json`), `--replay SOUBOR` projede
starší log, `--no-upload` jen vypíše. Definice bossů pro Python jsou v `bosses.py` / `twinfangs.py`
(zrcadlo engine.js). Řádky z lokálního logu nemají Report a na stránce jsou pod „lokální combat log“.
