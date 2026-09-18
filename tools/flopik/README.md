# Flopik – fails po pullech z živého combat logu

Během raidu sleduje aktivní WoW combat log a po každém pullu (ENCOUNTER_END) spočítá předem
definované faily bosse – smrti u každého bosse, zásahy Tempestem u Sszoraka, soaky orbů vs.
stacky Eternal Venom u Twin Fangs… – a zapíše je do listu **„Flopik“** v guildovní tabulce.
Stránka **flopik.html** list čte a každou minutu se sama obnoví, takže během raidu ukazuje
poslední pull (ideálně na druhém monitoru nebo v Discordu jako odkaz).

```
WoW (/combatlog) → Logs\WoWCombatLog-*.txt → flopik.py (tail) → Apps Script doPost p=flopik → list „Flopik“ → flopik.html
```

## Spuštění během raidu

1. Ve hře musí běžet `/combatlog` (nebo auto-logging přes addon / WCL uploader). Stačí u jednoho hráče –
   toho, na jehož PC běží Flopik.
2. V tomto adresáři: `python flopik.py` (Python 3, žádné závislosti). Skript najde nejnovější
   `WoWCombatLog*.txt` v `_retail_\Logs`, čte ho od aktuálního konce a sám přejde na nový soubor,
   když WoW založí další (každé přihlášení = nový soubor).
3. Po každém pullu vypíše tabulku do konzole a pošle ji do tabulky (`✔ Sheets: …`). Ctrl+C ukončí.

| Volba | Význam |
| --- | --- |
| `--from-start` | zpracuje i pully, které už v aktuálním logu jsou (Flopik spuštěný až během raidu) |
| `--replay SOUBOR` | projede celý starší log (doplnění minulého raidu) a skončí |
| `--boss 3421` | jen jeden encounter (ID z ENCOUNTER_START) |
| `--no-upload` | jen konzole + `pulls.jsonl`, nic do tabulky |
| `--min-dur 15` | kratší pully (omylem pullnuto, reset) se nezapisují |
| `--logs DIR` | složka Logs, když ji skript nenajde sám (nebo env `WOW_LOGS`, nebo `"logs"` v configu) |

Přístup do tabulky: stejné `webapp_url` + `token` jako sim_runner.py (`tools/roster/sim_runner.config.json`),
případně vlastní `flopik.config.json` vedle skriptu (`{"webapp_url": "…/exec", "token": "…", "logs": "…"}`).
Token: menu tabulky **Simy → Token pro sim_runner.py…**. Oba soubory jsou v `.gitignore`.

## Přidání bosse / failu

Vše je v `bosses.py`. Boss = encounter ID → `{"key", "name", "metrics": [...]}`; boss, který tam není,
dostane automaticky aspoň smrti. Deklarativní metriky:

```python
hits("tempest", "Tempest", [1287083], cast_ids=[1287072], window=3.0, hot=[1, 2], hotAll=[2, 4], note="…")
debuff("residue", "Caustic Residue", [1296667])     # počet aplikací debuffu na hráče
casts("soak", "Soaky", [123456])                     # počet SPELL_CAST_SUCCESS hráče
```

`hits` = „unique hit count“: každý cast, který hráče zasáhl, se počítá jednou (zásahy do `window` s
od sebe jsou jeden cast; ticky periodic damage se nepočítají). `hot`/`hotAll` = prahy pro oranžové /
červené zvýraznění v pullu / v součtu, `note` = text do legendy. Spell ID se najde v logu:
`grep -a "Tempest" WoWCombatLog-*.txt | head` (ID u SPELL_DAMAGE / SPELL_AURA_APPLIED, ne u castu).

Složitější věci (Twin Fangs: soak orbů → stack, zdroje stacků, death cutoff) mají vlastní modul
s `analyze(pull, ctx)` a `KEEP` (podřetězce, které musí řádek logu obsahovat) – viz `twinfangs.py`.
Modul vrací i definice sloupců, statistiky a legendu, takže stránka nic o bossech vědět nemusí.

## Data v tabulce

List „Flopik“: `Datum | Pull | Boss | Obtížnost | Start | Délka (s) | Kill | Hráč | Data | Boss klíč | Zapsáno`.
Na každý pull jeden souhrnný řádek (Hráč prázdný, Data = JSON s `cols`, `stats`, `legend`, `description`,
`summary`, `deathList`, `cutoff`) a jeden řádek na hráče (Data = JSON hodnot metrik + `died`, `deaths`).
Stejný pull (datum + boss + start) se při opakovaném poslání přepíše, číslo pullu je pořadí v rámci dne a bosse.

Apps Script část: `tools/roster/class_loot_dropdowns.gs` (sekce FLOPIK + větev `p === "flopik"` v `doPost`).
Po změně je třeba skript v Google znovu vložit a nasadit (Nasadit → Spravovat nasazení → nová verze).
