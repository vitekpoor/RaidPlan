/**
 * Multi-select loot dropdowny pro wishlist Venomous Abyss (nativní checkboxy),
 * filtrované podle ARMOR TYPU hráče (cloth/leather/mail/plate).
 *
 * CÍL: v každé buňce wishlistu nativní Google Sheets multi-select dropdown –
 * checkbox u každého itemu přímo v rozbalené nabídce – a v nabídce jen itemy
 * pro armor typ daného hráče (+ univerzální itemy a zbraně, které používá
 * aspoň jedna classa dané armor skupiny). Bez menu "Loot", bez sidebaru.
 *
 * OMEZENÍ GOOGLE: "Povolit více výběrů" (multi-select čip) zatím NEJDE zapnout
 * přes Apps Script ani Sheets API – nastavuje se jen ručně v UI. Ručně se
 * proto vytvoří 4 ŠABLONOVÁ pravidla (jedno na armor typ) a skript je pak
 * rozkopíruje na správné hráče – kopírování checkboxy zachová.
 *
 * POSTUP:
 * 1. Otevři záložku s wishlistem a spusť buildLootLists (▶). Vytvoří list
 *    "_loot_lists": pod sloupcem každého bosse 4 bloky itemů (cloth/leather/
 *    mail/plate) a dole 4 šablonové buňky s návodem. Staré dropdowny smaže
 *    (hodnoty v buňkách zůstanou).
 * 2. RUČNĚ na listu _loot_lists vytvoř 4 pravidla (Data → Ověření dat,
 *    Kritéria: „Rozbalovací nabídka (z rozsahu)“):
 *      B87: =_loot_lists!B$2:B$21    (CLOTH)
 *      B88: =_loot_lists!B$23:B$42   (LEATHER)
 *      B89: =_loot_lists!B$44:B$63   (MAIL)
 *      B90: =_loot_lists!B$65:B$84   (PLATE)
 *    POZOR: sloupec B BEZ dolaru (posouvá se po bossech), řádky S dolarem.
 *    U všech v Rozšířených možnostech: Styl zobrazení = Čip (Chip),
 *    zaškrtni „Povolit více výběrů“ (Allow multiple selections) a u
 *    neplatných dat nech „Zobrazit upozornění“.
 * 3. Spusť applyArmorValidation – každému hráči nakopíruje do řádku šablonu
 *    jeho armor typu (podle PLAYER_CLASS) a list _loot_lists skryje.
 * 4. Spusť convertOldValues – převede staré hodnoty (oddělené " | " i ", ")
 *    na čipový formát a opraví itemy s čárkou v názvu, aby je čipy
 *    nehlásily jako neplatné.
 * 5. Kontrola: checkPicks vypíše itemy, které hráči nesedí ani na classu
 *    (armor filtr je per skupina – např. warglaive vidí celá leather
 *    skupina, ale patří jen DH).
 *
 * POZN.: itemy s čárkou v názvu mají čárku nahrazenou " – ", protože čárka
 * je oddělovač hodnot multi-selectu.
 *
 * ============================ ROSTER ============================
 * Hráči, main/alt chary, classy a role jsou v databázi guildy (Cloudflare Worker + D1,
 * upravují se na https://eternal-shadows.vitek-poor.workers.dev/roster). Skript je čte
 * z ES_API + /api/roster.csv (getRoster_). Po změně rosteru spusť syncWishlist – doplní
 * chybějící řádky do wishlistu (alt hned pod main), obarví jména podle classy, překopíruje
 * armor dropdowny podle aktuální classy a vypíše itemy, které po změně classy už hráči
 * nesedí, plus řádky wishlistu, které v rosteru nejsou.
 *
 * PLAYER_CLASS níže zůstává jen jako FALLBACK, když API neodpoví (čte ho i tools/roster/make_splits.py).
 *
 * Absence, boss sestavy, sim fronta, výsledky simů, Vault, cresty, Discord místnosti, docházka
 * i Flopik dřív žily tady (listy + web app); od 2026-09-21 jsou v databázi guildy (repo worker/)
 * a na webu. Stará web app URL (…/exec?p=…) jen přesměruje na web (doGet níže).
 */

var LIST_SHEET_NAME = "_loot_lists";
var ARMOR_ORDER = ["c", "l", "m", "p"];
var ARMOR_LABEL = { "c": "CLOTH", "l": "LEATHER", "m": "MAIL", "p": "PLATE" };
var BLOCK_START = { "c": 2, "l": 23, "m": 44, "p": 65 }; // první řádek bloku itemů
var BLOCK_ROWS = 20;                                     // výška bloku (prázdné řádky se v dropdownu ignorují)
var TEMPLATE_ROW = { "c": 87, "l": 88, "m": 89, "p": 90 }; // šablonové buňky ve sloupci B

// ------------- CHAR -> CLASS -------------
var PLAYER_CLASS = {
  "hase": "Rogue", "hase2": "Rogue",
  "anál": "Evoker", "anál2": "Shaman",
  "meslock": "Warlock", "meslock2": "Warlock",
  "irdwy": "Mage", "irdwy2": "Mage",
  "rendy": "Demon Hunter", "rendy2": "Demon Hunter",
  "pifta": "Hunter", "pifta2": "Demon Hunter",
  "arch": "Rogue", "arch2": "Rogue",
  "akka": "Warlock", "akka2": "Warlock", "akko2": "Warlock",
  "jeeni": "Evoker", "jeeni2": "Monk",
  "mimik": "Hunter", "mimik2": "Hunter",
  "schizoddh": "Demon Hunter", "schizoidy": "Warrior",
  "zîreael": "Mage", "zîreael2": "Mage",
  "nesferity": "Druid", "nesferity2": "Druid",
  "houdy": "Evoker", "houdy2": "Druid",
  "drastic": "Paladin", "drastic2": "Paladin",
  "ryzz": "Warrior", "ryzz2": "Demon Hunter",
  "ahaaferos2": "Paladin", "ahaaferos": "Death Knight",
  "glasolo": "Monk", "glaasolo": "Death Knight",
  "global": "Priest", "global2": "Priest",
  "gina": "Paladin", "gina2": "Shaman",
  "giarem": "Shaman", "giarem2": "Monk",
  "rojko": "Shaman", "rojko2": "Priest",
  "miky": "Warrior", "miky2": "Warrior",
  "hitaro": "Death Knight", "hitaro2": "Priest",
  "trenser": "Evoker", "trenser2": "Evoker",
  "hackyrek": "Warrior", "hackyrek2": "Warrior"
};

// ------------- pravidla tříd -------------
var ARMOR = {
  "Mage": "c", "Priest": "c", "Warlock": "c",
  "Rogue": "l", "Druid": "l", "Demon Hunter": "l", "Monk": "l",
  "Hunter": "m", "Shaman": "m", "Evoker": "m",
  "Warrior": "p", "Paladin": "p", "Death Knight": "p"
};
var WEAPONS = {
  "dagger":    ["Rogue","Mage","Warlock","Priest","Shaman","Hunter","Druid","Evoker","Warrior"],
  "fist":      ["Warrior","Rogue","Monk","Demon Hunter","Shaman","Hunter","Druid","Evoker"],
  "staff":     ["Druid","Hunter","Mage","Monk","Priest","Shaman","Warlock","Warrior","Evoker"],
  "polearm":   ["Warrior","Paladin","Death Knight","Hunter","Druid","Monk"],
  "axe":       ["Warrior","Paladin","Death Knight","Rogue","Shaman","Monk","Demon Hunter","Hunter","Evoker"],
  "axe2h":     ["Warrior","Paladin","Death Knight","Hunter","Shaman","Evoker"],
  "mace":      ["Warrior","Paladin","Death Knight","Rogue","Monk","Druid","Shaman","Priest","Evoker"],
  "mace2h":    ["Warrior","Paladin","Death Knight","Druid","Shaman","Evoker"],
  "sword":     ["Warrior","Paladin","Death Knight","Rogue","Mage","Warlock","Monk","Demon Hunter","Hunter","Evoker"],
  "sword2h":   ["Warrior","Paladin","Death Knight"],
  "warglaive": ["Demon Hunter"],
  "gun":       ["Hunter"],
  "bow":       ["Hunter"],
  "shield":    ["Warrior","Paladin","Shaman"],
  "offhand":   ["Mage","Priest","Warlock","Druid","Shaman","Paladin","Monk","Evoker"]
};

// ------------- ROSTER -------------
var ROSTER_SHEET_NAME = "Roster";
var WISHLIST_SHEET_NAME = "Wishlist";
var ROLES = ["tank", "heal", "dps"];
var CLASS_COLOR = {
  "Death Knight": "#C41E3A", "Demon Hunter": "#A330C9", "Druid": "#FF7C0A",
  "Evoker": "#33937F", "Hunter": "#AAD372", "Mage": "#3FC7EB",
  "Monk": "#00FF98", "Paladin": "#F48CBA", "Priest": "#FFFFFF",
  "Rogue": "#FFF468", "Shaman": "#0070DE", "Warlock": "#8788EE",
  "Warrior": "#C69B6D"
};
var ROSTER_HEADER = ["Hráč", "Main char", "Main classa", "Main role",
                     "Alt char", "Alt classa", "Alt role", "Poznámka"];
// [hráč, main char, main classa, main role, alt char, alt classa, alt role]
// ------------- item DB (sloty/armor ověřeny z wiki tooltipů) -------------
// c/l/m/p = armor; u = univerzální; w:<typ> = zbraň; tok:<c|l|m|p> = tier token; all = všichni
var DB = {
  "Nek'zali the Soulcoiler": [
    ["Crown of the Eternal Fang – hlava", "m"],
    ["Skullguard of the Risen Sacrifice – hlava", "p"],
    ["Vestment of the Awakening – chest", "l"],
    ["Restless Spirit Shackles – wristy", "l"],
    ["Cursed Reliquary Cincture – waist", "m"],
    ["Initiate's Sacrificial Tights – legy", "c"],
    ["Nek'zali's Spiritwalkers – boty", "c"],
    ["Entombed Cultist's Sabatons – boty", "p"],
    ["Amani Summoning Shawl – back", "u"],
    ["Strongblood's Ceremonial Cleaver – 1H axe", "w:axe"],
    ["Hexing Spiritrender – dagger", "w:dagger"],
    ["Tomb-Creeper's Claw – fist weapon", "w:fist"],
    ["Soulcoiler Ritual Vessel – trinket", "u"]
  ],
  "Entombed Sentinels": [
    ["Shadow Hunter's Warmask – hlava", "l"],
    ["Venom-Singed Cuffs – wristy", "c"],
    ["Venom Warden's Greaves – legy", "p"],
    ["Sentinel's Vitriolic Chain – neck", "u"],
    ["Keeper's Seething Core – trinket", "u"],
    ["Ancient Construct's Venomshiv – dagger", "w:dagger"],
    ["Caustic Keeper-Crusher – 2H mace", "w:mace2h"],
    ["Spine of the Hissing Abyss – off-hand", "w:offhand"],
    ["Venomwoven Idol – tier ruce token", "tok:c"],
    ["Venomcured Idol – tier ruce token", "tok:l"],
    ["Venomcast Idol – tier ruce token", "tok:m"],
    ["Venomforged Idol – tier ruce token", "tok:p"]
  ],
  "The Lost Explorers": [
    ["Errant Scrollsage's Hood – hlava", "c"],
    ["Unpossessed Skullsash – waist", "l"],
    ["Boots of the Reckless Wayfarer – boty", "m"],
    ["Shellbound Bracers – wristy", "p"],
    ["First Mate's Shellward – trinket", "u"],
    ["Gebbo's Bottomless Bag – trinket", "u"],
    ["Malevolent Spiritcudgel – 1H mace", "w:mace"],
    ["Gebbo's Backup Blaster – gun", "w:gun"],
    ["Venom-Slashed Scuteward – shield", "w:shield"],
    ["Venomwoven Remnant – tier ramena token", "tok:c"],
    ["Venomcured Remnant – tier ramena token", "tok:l"],
    ["Venomcast Remnant – tier ramena token", "tok:m"],
    ["Venomforged Remnant – tier ramena token", "tok:p"]
  ],
  "Vashnik the Malignant": [
    ["Frothing Venom Spaulders – ramena", "l"],
    ["Serpentine Mixing Belt – waist", "m"],
    ["Scaled Fiend's Warboots – boty", "p"],
    ["Vile Alchemist's Band – ring", "u"],
    ["Vashnik's Sanguine Rancor – trinket", "u"],
    ["Fang of Umbral Malignance – trinket", "u"],
    ["Venomancer's Winged Channeler – staff", "w:staff"],
    ["Malignant Toothed Edge – 2H sword", "w:sword2h"],
    ["Venomwoven Icon – tier chest token", "tok:c"],
    ["Venomcured Icon – tier chest token", "tok:l"],
    ["Venomcast Icon – tier chest token", "tok:m"],
    ["Venomforged Icon – tier chest token", "tok:p"]
  ],
  "Sszorak": [
    ["Ruthless Slaughtergrips – ruce", "l"],
    ["Ferocious Scaleboots – boty", "m"],
    ["Caustic Chain-Wrapped Sash – waist", "c"],
    ["Apex Brute's Claw Ring – ring", "u"],
    ["Sszorak's Ferocity – trinket", "u"],
    ["Idol of the Howling Nexus – trinket", "u"],
    ["Venomous Boneglaive – warglaive", "w:warglaive"],
    ["Slithering Savage's Gavel – 1H mace", "w:mace"],
    ["Venomwoven Relic – tier legy token", "tok:c"],
    ["Venomcured Relic – tier legy token", "tok:l"],
    ["Venomcast Relic – tier legy token", "tok:m"],
    ["Venomforged Relic – tier legy token", "tok:p"]
  ],
  "The Twin Fangs": [
    ["Ornaments of the Eternal Coil – ramena", "c"],
    ["Bespittled Slitherslippers – boty", "l"],
    ["Ophidian Fangmail – chest", "m"],
    ["Scaleplate Strangulators – ruce", "p"],
    ["Amulet of the Twin Fangs – neck", "u"],
    ["Preternatural Antivenom – trinket", "u"],
    ["Vexhul's Everflowing Gland – trinket", "u"],
    ["Ravenous Feaster's Fang – dagger", "w:dagger"],
    ["Venomwoven Effigy – tier hlava token", "tok:c"],
    ["Venomcured Effigy – tier hlava token", "tok:l"],
    ["Venomcast Effigy – tier hlava token", "tok:m"],
    ["Venomforged Effigy – tier hlava token", "tok:p"]
  ],
  "The Coiled Altar": [
    ["Grasps of the Eternal Shadow – ruce", "c"],
    ["Cackling Soultreads – boty", "c"],
    ["Sash of the Forlorn Vessel – waist", "l"],
    ["Coiled Hex Legguards – legy", "l"],
    ["Soulslither Spaulders – ramena", "m"],
    ["Cuisses of the Uncoiled Union – legy", "m"],
    ["Reckless Spirit Breastplate – chest", "p"],
    ["Girdle of Toxic Regret – waist", "p"],
    ["Silken Voodoo Drape – back", "u"],
    ["Hex Lord's Dooming Idol – trinket", "u"],
    ["Zul'jin's Guillotine Technique – trinket", "u"],
    ["Baleful Hexblade – 1H sword", "w:sword"],
    ["Aman'muso, Warlord's Vengeance – 1H axe", "w:axe"],
    ["Maze-roa, Warlord's Fury – 2H axe", "w:axe2h"]
  ],
  "Ula'tek": [
    ["Venomkeeper's Horrific Cowl – hlava (cantrip)", "c"],
    ["Gaze of the Coiled Watcher – hlava (cantrip)", "l"],
    ["Awoken Dreadfang Cuirass – chest (cantrip)", "m"],
    ["Chausses of Unbound Rancor – legy (cantrip)", "p"],
    ["Aqirbane Reliquary – neck", "u"],
    ["Font of Venomous Rage – trinket", "u"],
    ["Voracious Heart of Ula'tek – trinket", "u"],
    ["Jaw of the Shackled Goddess – 1H sword", "w:sword"],
    ["Zatha'tek, Breath of Corruption – dagger (very rare)", "w:dagger"],
    ["Jan'thrazet, the Soul Fang – dagger (very rare)", "w:dagger"],
    ["Abyssal Broodfiend's Bardiche – polearm", "w:polearm"],
    ["Caustic Repose Greatbow – bow", "w:bow"],
    ["Slumbering Coil Curio – tier token (libovolný slot)", "all"]
  ],
  "Nymrissa Wavecaller (Grotto)": [
    ["Wavecaller's Seastone – trinket", "u"],
    ["Alluring Bubbleband – ring", "u"],
    ["Tidebound Sorceress's Robes – chest", "c"],
    ["Cincture of the Abyssal Grotto – waist", "c"],
    ["Breakwater Boots – boty", "l"],
    ["Grips of Swirling Fury – ruce", "m"],
    ["Rising Tide Wristguards – wristy", "m"],
    ["Swelling Sea Spaulders – ramena", "p"],
    ["Forgotten Grotto Girdle – waist", "p"],
    ["Tidepiercer's Bubble Popper – gun", "w:gun"],
    ["Frostscale's Mystic Frond – off-hand", "w:offhand"],
    ["Bubblefin Splash Guard – shield", "w:shield"]
  ]
};

// koncové podtržítko = nenabízí se v run-menu (jen pomocná)

/** Čárka v názvu itemu by rozbila multi-select (odděluje hodnoty) -> " – ". */
function sanitizeName_(name) {
  return String(name).replace(/, /g, " – ");
}

/**
 * Itemy bosse pro armor skupinu: armor kusy + tier token daného typu,
 * univerzální itemy a zbraně, které používá aspoň jedna classa skupiny.
 */
function itemsForArmor_(boss, armor) {
  var out = [];
  DB[boss].forEach(function (it) {
    var name = it[0], tag = it[1];
    var take =
      tag === "u" || tag === "all" ||
      tag === armor ||
      (tag.indexOf("tok:") === 0 && tag.slice(4) === armor) ||
      (tag.indexOf("w:") === 0 && WEAPONS[tag.slice(2)].some(function (cls) {
        return ARMOR[cls] === armor;
      }));
    if (take) out.push(sanitizeName_(name));
  });
  return out;
}

function itemsForClass_(boss, cls) {
  var out = [];
  var armor = ARMOR[cls];
  DB[boss].forEach(function (it) {
    var name = it[0], tag = it[1];
    if (tag === "u" || tag === "all") { out.push(name); return; }
    if (tag === armor) { out.push(name); return; }
    if (tag.indexOf("tok:") === 0 && tag.slice(4) === armor) { out.push(name); return; }
    if (tag.indexOf("w:") === 0 && WEAPONS[tag.slice(2)].indexOf(cls) >= 0) { out.push(name); return; }
  });
  return out;
}

/**
 * KROK 1: vytvoří list "_loot_lists" – pro každý sloupec bosse ve wishlistu
 * stejný sloupec se 4 bloky itemů podle armor typu + dole šablonové buňky.
 * Staré dropdowny na wishlistu smaže. List nechává VIDITELNÝ kvůli ručnímu
 * kroku 2; skryje ho až applyArmorValidation.
 * Šablony (ověření dat v B87–B90) se při opakovaném spuštění nemažou.
 */
function buildLootLists() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var ws = ss.getActiveSheet();
  if (ws.getName() === LIST_SHEET_NAME) {
    SpreadsheetApp.getUi().alert("Otevři záložku s wishlistem, ne " + LIST_SHEET_NAME + ".");
    return;
  }
  var lastRow = ws.getLastRow(), lastCol = ws.getLastColumn();
  var headers = ws.getRange(1, 1, 1, lastCol).getValues()[0];

  var ls = ss.getSheetByName(LIST_SHEET_NAME) || ss.insertSheet(LIST_SHEET_NAME);
  ls.clearContents(); // jen obsah – případné už vytvořené šablonové validace přežijí

  var bosses = 0;
  for (var c = 2; c <= lastCol; c++) {
    var boss = String(headers[c - 1] || "").trim();
    if (!DB[boss]) continue;
    ls.getRange(1, c).setValue(boss);
    ARMOR_ORDER.forEach(function (a) {
      var items = itemsForArmor_(boss, a).map(function (n) { return [n]; });
      if (items.length) ls.getRange(BLOCK_START[a], c, items.length, 1).setValues(items);
    });
    bosses++;
  }

  // popisky bloků a návod k šablonám do sloupce A
  ARMOR_ORDER.forEach(function (a) {
    var from = BLOCK_START[a], to = from + BLOCK_ROWS - 1;
    ls.getRange(from, 1).setValue("▼ " + ARMOR_LABEL[a] + " (řádky " + from + "–" + to + ")");
    ls.getRange(TEMPLATE_ROW[a], 1).setValue(
      "ŠABLONA " + ARMOR_LABEL[a] + " → v B" + TEMPLATE_ROW[a] +
      " vytvoř Ověření dat: rozsah =_loot_lists!B$" + from + ":B$" + to +
      "  (čip + povolit více výběrů)");
  });
  ls.setColumnWidth(1, 420);
  if (ls.isSheetHidden()) ls.showSheet();

  if (lastRow > 1 && lastCol > 1)
    ws.getRange(2, 2, lastRow - 1, lastCol - 1).clearDataValidations();

  SpreadsheetApp.getUi().alert(
    "Seznamy pro " + bosses + " bossů jsou na listu " + LIST_SHEET_NAME + ".\n\n" +
    "Teď JEDNOU ručně na listu " + LIST_SHEET_NAME + " vytvoř 4 pravidla\n" +
    "(Data → Ověření dat, „Rozbalovací nabídka (z rozsahu)“):\n" +
    ARMOR_ORDER.map(function (a) {
      return "  B" + TEMPLATE_ROW[a] + ": =_loot_lists!B$" + BLOCK_START[a] +
             ":B$" + (BLOCK_START[a] + BLOCK_ROWS - 1) + "  (" + ARMOR_LABEL[a] + ")";
    }).join("\n") + "\n" +
    "Sloupec B bez $, řádky s $. Rozšířené možnosti: Styl = Čip,\n" +
    "zaškrtni „Povolit více výběrů“.\n\n" +
    "Pak spusť applyArmorValidation.");
}

/**
 * KROK 3: rozkopíruje ručně vytvořené šablony (multi-select čipy) z listu
 * _loot_lists na wishlist – každý hráč dostane šablonu svého armor typu.
 * Kopírování zachová checkboxy a relativní sloupec v rozsahu se posune
 * na správného bosse.
 */
function applyArmorValidation() {
  var ws = SpreadsheetApp.getActiveSheet();
  if (ws.getName() === LIST_SHEET_NAME || ws.getName() === ROSTER_SHEET_NAME) {
    SpreadsheetApp.getUi().alert("Otevři záložku s wishlistem, ne " + ws.getName() + ".");
    return;
  }
  var res = applyArmorValidationTo_(ws, charClassMap_());
  if (res.error) { SpreadsheetApp.getUi().alert(res.error); return; }
  SpreadsheetApp.getUi().alert(
    "Hotovo: multi-select dropdowny (filtr podle armor typu) pro " + res.applied + " hráčů.\n" +
    (res.unknown.length ? "Neznámé jméno (přidej do Rosteru): " + res.unknown.join(", ") : "Všechna jména rozpoznána."));
}

/** Jádro applyArmorValidation – classy bere z předané mapy (char -> classa). */
function applyArmorValidationTo_(ws, classMap) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var ls = ss.getSheetByName(LIST_SHEET_NAME);
  if (!ls)
    return { error: "List " + LIST_SHEET_NAME + " neexistuje – nejdřív spusť buildLootLists." };
  var missing = ARMOR_ORDER.filter(function (a) {
    return !ls.getRange(TEMPLATE_ROW[a], 2).getDataValidation();
  });
  if (missing.length)
    return { error: "Chybí šablonové validace: " +
      missing.map(function (a) { return ARMOR_LABEL[a] + " (B" + TEMPLATE_ROW[a] + ")"; }).join(", ") +
      "\nVytvoř je ručně na listu " + LIST_SHEET_NAME + " (návod ve sloupci A)." };

  var lastRow = ws.getLastRow(), lastCol = ws.getLastColumn();
  var headers = ws.getRange(1, 1, 1, lastCol).getValues()[0];
  var names = ws.getRange(1, 1, lastRow, 1).getValues();

  // souvislé úseky sloupců bossů (kvůli rychlejšímu copyTo po řádcích)
  var runs = [], start = 0;
  for (var c = 2; c <= lastCol + 1; c++) {
    var isBoss = c <= lastCol && !!DB[String(headers[c - 1] || "").trim()];
    if (isBoss && !start) start = c;
    if (!isBoss && start) { runs.push([start, c - start]); start = 0; }
  }

  var applied = 0, unknown = [];
  for (var r = 2; r <= lastRow; r++) {
    var raw = String(names[r - 1][0] || "").trim();
    if (!raw) continue;
    var cls = classMap[raw.toLowerCase()];
    if (!cls) { if (raw.toLowerCase().indexOf("legenda") !== 0) unknown.push(raw); continue; }
    var tpl = ls.getRange(TEMPLATE_ROW[ARMOR[cls]], 2);
    runs.forEach(function (run) {
      tpl.copyTo(ws.getRange(r, run[0], 1, run[1]),
                 SpreadsheetApp.CopyPasteType.PASTE_DATA_VALIDATION, false);
    });
    applied++;
  }
  ls.hideSheet();
  return { applied: applied, unknown: unknown };
}

/**
 * Převede staré hodnoty na čipový formát "Item A, Item B":
 * zvládá oddělovače " | " i ", ", itemy s čárkou v názvu (hledá známé názvy
 * z DB, nerozděluje naslepo) a už ručně upravené názvy s " – ".
 * Jen sloupce bossů; volné texty (např. "Trinket, Waist, Ring") nechává,
 * jen z nich udělá samostatné čipy. Spouštět na záložce s wishlistem.
 * Když striktní pravidlo („Odmítnout zadání“) zápis blokuje, validaci
 * dočasně sundá, hodnotu zapíše a čipy vrátí kopií šablony.
 */
function convertOldValues() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var ws = ss.getActiveSheet();
  var lastRow = ws.getLastRow(), lastCol = ws.getLastColumn();
  if (lastRow < 2 || lastCol < 2) return;
  var headers = ws.getRange(1, 1, 1, lastCol).getValues()[0];
  var names = ws.getRange(1, 1, lastRow, 1).getValues();
  var ls = ss.getSheetByName(LIST_SHEET_NAME);
  var classMap = charClassMap_();
  var changed = 0, forced = [];

  for (var c = 2; c <= lastCol; c++) {
    var boss = String(headers[c - 1] || "").trim();
    if (!DB[boss]) continue;

    // hledané podoby názvů: originál z DB i sanitizovaná varianta (" – ")
    var pairs = [];
    DB[boss].forEach(function (it) {
      var raw = it[0], san = sanitizeName_(raw);
      pairs.push([raw, san]);
      if (san !== raw) pairs.push([san, san]);
    });
    pairs.sort(function (a, b) { return b[0].length - a[0].length; }); // delší dřív

    var vals = ws.getRange(2, c, lastRow - 1, 1).getValues();
    for (var i = 0; i < vals.length; i++) {
      var v = String(vals[i][0] || "").trim();
      if (!v) continue;

      var rest = v, found = [];
      pairs.forEach(function (p) {
        var idx = rest.indexOf(p[0]);
        if (idx < 0) return;
        found.push({ pos: idx, name: p[1] });
        rest = rest.split(p[0]).join(" "); // vyříznout, ať se nenajde podruhé
      });
      found.sort(function (a, b) { return a.pos - b.pos; });

      var parts = found.map(function (f) { return f.name; });
      // zbytek (volný text) rozsekat na tokeny a přidat za itemy
      rest.split(/[|,]+/).forEach(function (s) {
        s = s.trim();
        if (s && s !== "–" && s !== "-") parts.push(s);
      });
      // dedup
      parts = parts.filter(function (s, k) { return parts.indexOf(s) === k; });

      var nv = parts.join(", ");
      if (nv === v) continue;

      var cell = ws.getRange(i + 2, c);
      try {
        cell.setValue(nv);
      } catch (err) {
        // striktní pravidlo („Odmítnout zadání“) blokuje zápis – typicky item
        // mimo armor typ hráče. Validaci sundat, zapsat a vrátit šablonu.
        cell.clearDataValidations();
        cell.setValue(nv);
        var cls = classMap[String(names[i + 1][0] || "").trim().toLowerCase()];
        if (ls && cls && ls.getRange(TEMPLATE_ROW[ARMOR[cls]], 2).getDataValidation()) {
          ls.getRange(TEMPLATE_ROW[ARMOR[cls]], 2)
            .copyTo(cell, SpreadsheetApp.CopyPasteType.PASTE_DATA_VALIDATION, false);
        }
        forced.push(cell.getA1Notation());
      }
      changed++;
    }
  }
  SpreadsheetApp.getUi().alert(
    "Převedeno " + changed + " buněk na čipový formát." +
    (forced.length
      ? "\n\nHodnoty mimo seznam hráče (zkontroluj přes checkPicks): " + forced.join(", ") +
        "\nTip: v šablonách nastav u neplatných dat „Zobrazit upozornění“\n" +
        "místo „Odmítnout zadání“ a spusť znovu applyArmorValidation."
      : ""));
}

/**
 * Kontrola tříd: seznamy v dropdownu jsou per boss, takže hráč může omylem
 * zaškrtnout item, který jeho classa nepoužije. Tohle je vypíše.
 */
function checkPicks() {
  var ws = SpreadsheetApp.getActiveSheet();
  var res = checkPicksList_(ws, charClassMap_());
  SpreadsheetApp.getUi().alert(
    (res.problems.length
      ? "Itemy mimo classu (" + res.problems.length + "):\n" + res.problems.join("\n")
      : "Všechny vybrané itemy sedí na classy hráčů. ✔") +
    (res.unknown.length ? "\n\nNeznámá jména (přidej do Rosteru): " + res.unknown.join(", ") : ""));
}

/** Jádro checkPicks – classy bere z předané mapy (char -> classa). */
function checkPicksList_(ws, classMap) {
  var lastRow = ws.getLastRow(), lastCol = ws.getLastColumn();
  var headers = ws.getRange(1, 1, 1, lastCol).getValues()[0];
  var vals = ws.getRange(1, 1, lastRow, lastCol).getValues();
  var problems = [], unknown = [];

  for (var r = 2; r <= lastRow; r++) {
    var raw = String(vals[r - 1][0] || "").trim();
    if (!raw) continue;
    var cls = classMap[raw.toLowerCase()];
    if (!cls) { if (raw.toLowerCase().indexOf("legenda") !== 0) unknown.push(raw); continue; }
    for (var c = 2; c <= lastCol; c++) {
      var boss = String(headers[c - 1] || "").trim();
      if (!DB[boss]) continue;
      var v = String(vals[r - 1][c - 1] || "").trim();
      if (!v) continue;
      var allowed = itemsForClass_(boss, cls).map(sanitizeName_);
      v.split(", ").forEach(function (it) {
        it = it.trim();
        if (it && allowed.indexOf(it) < 0)
          problems.push(raw + " (" + cls + ") × " + boss + ": " + it);
      });
    }
  }
  return { problems: problems, unknown: unknown };
}

/**
 * Zformátuje wishlist tak, aby bylo v buňkách vidět víc hodnot:
 * zalamování textu, širší sloupce bossů, auto výška řádků, zarovnání nahoru.
 */
function formatWishlist() {
  var ws = SpreadsheetApp.getActiveSheet();
  var lastRow = ws.getLastRow(), lastCol = ws.getLastColumn();
  var headers = ws.getRange(1, 1, 1, lastCol).getValues()[0];

  ws.setColumnWidth(1, 130); // hráči
  for (var c = 2; c <= lastCol; c++) {
    var boss = String(headers[c - 1] || "").trim();
    ws.setColumnWidth(c, DB[boss] ? 280 : 200);
  }
  var data = ws.getRange(1, 1, lastRow, lastCol);
  data.setWrapStrategy(SpreadsheetApp.WrapStrategy.WRAP)
      .setVerticalAlignment("top")
      .setFontSize(9);
  ws.getRange(1, 1, 1, lastCol).setFontSize(10).setFontWeight("bold").setWrapStrategy(SpreadsheetApp.WrapStrategy.WRAP);
  ws.autoResizeRows(2, lastRow - 1);
  ws.setFrozenRows(1);
  ws.setFrozenColumns(1);
}

/** Smaže všechny dropdowny z aktivního listu. */
function removeDropdowns() {
  var ws = SpreadsheetApp.getActiveSheet();
  ws.getRange(2, 2, ws.getLastRow() - 1, ws.getLastColumn() - 1).clearDataValidations();
}

/**
 * Spusť JEDNOU, pokud byl dřív nainstalovaný on-edit trigger pro starý
 * " | " multi-select (applyMultiSelect) – ten už neexistuje a trigger by
 * jen házel chyby.
 */
function uninstallOldTriggers() {
  var n = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === "applyMultiSelect") { ScriptApp.deleteTrigger(t); n++; }
  });
  SpreadsheetApp.getUi().alert(n ? "Smazáno " + n + " starých triggerů." : "Žádný starý trigger nenalezen.");
}

// ================== ROSTER ==================

// Databáze guildy (Cloudflare Worker + D1, repo worker/): roster se upravuje na webu (roster.html).
var ES_API = "https://eternal-shadows.vitek-poor.workers.dev";

/** CSV rosteru z API (hlavička ROSTER_HEADER, řádek "LAVIČKA" před náhradníky) → 2D pole, nebo null. */
function esRosterCsv_() {
  try {
    var resp = UrlFetchApp.fetch(ES_API + "/api/roster.csv", { muteHttpExceptions: true });
    if (resp.getResponseCode() !== 200) return null;
    var rows = Utilities.parseCsv(resp.getContentText());
    return rows && rows.length > 1 && /hráč/i.test(String(rows[0][0])) ? rows : null;
  } catch (err) { return null; }
}

/**
 * Roster z API -> pole hráčů {player, main, mainClass, mainRole, alt, altClass, altRole}.
 * Vrací null, když API neodpoví.
 */
function getRoster_() {
  var rows = esRosterCsv_();
  if (!rows) return null;
  var head = rows[0].map(function (h) { return String(h || "").trim().toLowerCase(); });
  var col = {};
  ROSTER_HEADER.forEach(function (h, i) { var j = head.indexOf(h.toLowerCase()); col[h] = j >= 0 ? j : i; });
  var players = [];
  rows.slice(1).forEach(function (v) {
    var g = function (h) { return String(v[col[h]] == null ? "" : v[col[h]]).trim(); };
    var player = g("Hráč");
    var main = g("Main char");
    if (!player || !main) return;
    var mainRole = g("Main role").toLowerCase();
    players.push({
      player: player,
      main: main,
      mainClass: g("Main classa"),
      mainRole: mainRole,
      alt: g("Alt char"),
      altClass: g("Alt classa"),
      altRole: g("Alt role").toLowerCase() || mainRole
    });
  });
  return players;
}

/** Mapa char -> classa: primárně z Rosteru, fallback PLAYER_CLASS. */
function charClassMap_() {
  var roster = getRoster_();
  if (!roster) return PLAYER_CLASS;
  var map = {};
  roster.forEach(function (p) {
    if (p.main) map[p.main.toLowerCase()] = p.mainClass;
    if (p.alt) map[p.alt.toLowerCase()] = p.altClass;
  });
  return map;
}

/**
 * SYNCHRONIZACE roster (API) -> Wishlist. Spouštět po každé změně rosteru na webu:
 *   - doplní chybějící řádky charů (alt hned pod main, nový hráč za
 *     posledního známého; hodnoty existujících řádků se NEMĚNÍ),
 *   - obarví jména ve wishlistu podle classy,
 *   - překopíruje armor multi-select dropdowny podle aktuální classy,
 *   - vypíše itemy, které po změně classy hráči nesedí, a řádky
 *     wishlistu, které v Rosteru nejsou (orphany – smaž je ručně).
 */
function syncWishlist() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var ws = ss.getSheetByName(WISHLIST_SHEET_NAME) || ss.getSheets()[0];
  var roster = getRoster_();
  if (!roster || !roster.length) {
    SpreadsheetApp.getUi().alert("Roster se nepodařilo načíst z " + ES_API + "/api/roster.csv (upravuje se na webu, roster.html).");
    return;
  }

  // kontrola classí a rolí
  var bad = [];
  roster.forEach(function (p) {
    [[p.main, p.mainClass, p.mainRole], [p.alt, p.altClass, p.altRole]].forEach(function (x) {
      if (!x[0]) return;
      if (!ARMOR[x[1]]) bad.push(x[0] + ": neplatná classa '" + x[1] + "'");
      if (ROLES.indexOf(x[2]) < 0) bad.push(x[0] + ": neplatná role '" + x[2] + "'");
    });
  });
  if (bad.length) {
    SpreadsheetApp.getUi().alert("Oprav napřed Roster:\n" + bad.join("\n"));
    return;
  }

  // požadované chary v pořadí Rosteru (alt hned pod main)
  var desired = [];
  roster.forEach(function (p) {
    desired.push({ ch: p.main, cls: p.mainClass });
    if (p.alt) desired.push({ ch: p.alt, cls: p.altClass });
  });
  var classMap = {};
  desired.forEach(function (d) { classMap[d.ch.toLowerCase()] = d.cls; });

  // existující řádky wishlistu
  var lastRow = ws.getLastRow();
  var names = ws.getRange(1, 1, lastRow, 1).getValues();
  var rowOf = {}, legendRow = 0;
  for (var r = 2; r <= lastRow; r++) {
    var raw = String(names[r - 1][0] || "").trim();
    if (!raw) continue;
    if (raw.toLowerCase().indexOf("legenda") === 0) { legendRow = r; continue; }
    rowOf[raw.toLowerCase()] = { row: r, raw: raw };
  }

  // doplnit chybějící řádky
  var added = [];
  var prevRow = 0;
  desired.forEach(function (d) {
    var key = d.ch.toLowerCase();
    if (rowOf[key]) { prevRow = rowOf[key].row; return; }
    var at = prevRow || (legendRow ? legendRow - 1 : ws.getLastRow());
    ws.insertRowAfter(at);
    var newRow = at + 1;
    Object.keys(rowOf).forEach(function (k) { if (rowOf[k].row > at) rowOf[k].row++; });
    if (legendRow > at) legendRow++;
    ws.getRange(newRow, 1).setValue(d.ch);
    rowOf[key] = { row: newRow, raw: d.ch };
    prevRow = newRow;
    added.push(d.ch);
  });

  // barvy jmen podle classy + orphani
  var orphans = [];
  Object.keys(rowOf).forEach(function (k) {
    var cls = classMap[k];
    var cell = ws.getRange(rowOf[k].row, 1);
    if (cls) cell.setBackground(CLASS_COLOR[cls] || null).setFontColor("#000000");
    else orphans.push(rowOf[k].raw);
  });

  // dropdowny podle aktuálních classí
  var res = applyArmorValidationTo_(ws, classMap);
  if (res.error) {
    SpreadsheetApp.getUi().alert(res.error);
    return;
  }

  // itemy, které po změně classy nesedí
  var picks = checkPicksList_(ws, classMap);

  SpreadsheetApp.getUi().alert(
    "Wishlist synchronizovaný s Rosterem.\n" +
    "Dropdowny obnovené pro " + res.applied + " charů.\n" +
    (added.length ? "Přidané řádky: " + added.join(", ") + "\n" : "") +
    (orphans.length
      ? "Řádky, které v Rosteru nejsou (smaž ručně, nebo je do Rosteru doplň): "
        + orphans.join(", ") + "\n" : "") +
    (picks.problems.length
      ? "\nItemy mimo classu (po změně classy je hráč musí vybrat znovu):\n"
        + picks.problems.join("\n")
      : "\nVšechny vybrané itemy sedí na classy. ✔"));
}

// ================== MENU + STARÁ WEB APP ==================

function onOpen() {
  try {
    SpreadsheetApp.getUi().createMenu("Wishlist")
      .addItem("Synchronizovat s rosterem (syncWishlist)", "syncWishlist")
      .addItem("Zkontrolovat vybrané itemy (checkPicks)", "checkPicks")
      .addSeparator()
      .addItem("Vytvořit seznamy itemů (buildLootLists)", "buildLootLists")
      .addItem("Nakopírovat dropdowny (applyArmorValidation)", "applyArmorValidation")
      .addItem("Formátovat wishlist (formatWishlist)", "formatWishlist")
      .addToUi();
  } catch (err) { /* bez UI (trigger) */ }
}

/**
 * Web app (…/exec?p=…) dřív obsluhovala formuláře absence / SimC / docházky, roster pro addon
 * a Flopik API. To všechno je na webu guildy – staré odkazy jen přesměrujeme.
 */
function doGet(e) {
  var q = e && e.parameter ? e.parameter : {};
  var p = String(q.p || "");
  var target = p === "esroster" ? "/api/es?p=esroster" + (q.raw ? "&raw=1" : "")
    : p === "attendance" ? "/attendance"
    : p === "sim" ? "/#simc"
    : p === "flopik" ? "/flopik"
    : "/#omluvenky";
  var url = ES_API + target;
  return HtmlService.createHtmlOutput(
    '<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=' + url + '"></head>' +
    '<body style="font-family:sans-serif">Přesunuto na web guildy: <a href="' + url + '">' + url + '</a></body></html>')
    .setTitle("Eternal Shadows");
}
