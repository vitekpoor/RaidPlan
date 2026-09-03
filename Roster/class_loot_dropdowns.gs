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
 * List "Roster" je JEDINÝ zdroj pravdy o hráčích: main/alt char, classa,
 * role. Wishlist se z něj generuje/synchronizuje.
 *
 * Jednorázově: spusť buildRosterSheet – vytvoří list "Roster" předvyplněný
 * současnými hráči (dropdowny na classy a role; armor se neeviduje,
 * plyne přímo z classy přes mapu ARMOR).
 *
 * Běžná údržba (nový hráč, změna classy, přejmenování altu):
 *   1. uprav řádek v Rosteru,
 *   2. spusť syncWishlist – doplní chybějící řádky do wishlistu (alt hned
 *      pod main), obarví jména podle classy, překopíruje armor dropdowny
 *      podle aktuální classy a vypíše itemy, které po změně classy už
 *      hráči nesedí, plus řádky wishlistu, které v Rosteru nejsou.
 *
 * PLAYER_CLASS níže zůstává jen jako FALLBACK/SEED – když list Roster
 * existuje, čte se všechno z něj. Roster/make_splits.py čte Roster taky.
 *
 * ============================ ABSENCE ============================
 * List "Absence" = formulář pro hráče (dropdown se jmény z Rosteru,
 * datum Od/Do jako dropdown s příštími ~60 dny ze skrytého listu
 * "_absence_dates" (klouzavé =TODAY()+n, minulost se nenabízí; Do je
 * nepovinné), typ absence, checkbox Odeslat). Hned po zaškrtnutí se vedle checkboxu vzorcem ukáže
 * "⏳ Odesílám…" (okamžitá odezva bez čekání na skript); trigger pak
 * zapíše záznam pro každý den intervalu do CHRÁNĚNÉHO listu
 * "Absence přehled" (hráči × datumy, marker X / pozdě), vypíše výsledek
 * do Stavu a formulář vyčistí. Omylem zadané záznamy maže vlastník
 * ručně přímo v přehledu (hráči tam psát nemůžou).
 *
 * Anonymní editoři nemůžou spouštět skripty tlačítkem, proto to jede přes
 * INSTALOVATELNÝ onEdit trigger – ten běží jako vlastník (instalátor),
 * takže smí zapisovat i do chráněného přehledu.
 *
 * Jednorázově (jako vlastník tabulky):
 *   1. spusť buildAbsenceSheets  – vytvoří/obnoví oba listy + ochrany,
 *   2. spusť installAbsenceTrigger – nainstaluje trigger (autorizuj).
 * Po změně Rosteru spusť buildAbsenceSheets znovu (doplní nové hráče,
 * existující záznamy nechá).
 *
 * WEB FORMULÁŘ (doporučená cesta – listový formulář je sdílený, takže si
 * ho hráči navzájem přepisovali a zůstávalo v něm jméno posledního):
 * skript je zároveň webová apka. doGet servíruje každému hráči VLASTNÍ
 * formulář v prohlížeči (jméno si pamatuje jen jeho zařízení), odeslání
 * jde přes submitAbsenceWeb do stejné logiky (recordAbsence_) a zapíše
 * do chráněného přehledu. Odkaz na /exec připni na Discord.
 * Nasazení: viz komentář u sekce ABSENCE WEB APP níže.
 *
 * ============================ BOSS SESTAVY ============================
 * List "Boss sestavy" = kdo jde na který boss (mythic = 20 lidí).
 * Sloupec na boss: hlavička "NN Jméno", odkazy na RaidPlan + taktiku,
 * DATUM raidu (dropdown jako u absencí), počítadlo a 20 slotů
 * s dropdownem hráčů z Rosteru.
 *
 * Jednorázově: spusť buildBossLineups – vytvoří list a PRÁZDNÉ sloupce
 * předvyplní prvními 20 hráči z Rosteru (už vyplněné sloupce nesahá,
 * takže je bezpečné pouštět opakovaně, třeba po přidání hráče do Rosteru).
 *
 * Barvy se obnovují samy při každé editaci listu (instalovatelný trigger
 * onAbsenceEdit) a při otevření tabulky; ručně je obnoví refreshBossLineups:
 *   - pozadí jména = barva MAIN classy hráče,
 *   - ČERVENĚ + přeškrtnutě = hráč má na datum bosse absenci "Nepřijdu",
 *   - ORANŽOVĚ = "Přijdu pozdě",
 *   - červený text = hráč je ve sloupci dvakrát,
 *   - šedě + poznámka = jméno není v Rosteru,
 *   - počítadlo zeleně při 20/20, jinak oranžově.
 *
 * Na sestavy navazuje raidplan/raidplan.py --boss NN (nebo update_plans.bat):
 * stáhne sloupec bosse, porovná ho se jmény v RaidPlan plánu a hráče mimo
 * sestavu přejmenuje na náhradníky (párování podle role, ikony/barvy podle
 * Rosteru). Hlavička sloupce proto MUSÍ začínat číslem plánu ("01 ...").
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
var ROSTER_SEED = [
  ["Ahaaferos", "ahaaferos2", "Paladin",      "tank", "ahaaferos",  "Death Knight", "tank"],
  ["Glasolo",   "glasolo",    "Monk",         "tank", "glaasolo",   "Death Knight", "tank"],
  ["Global",    "global",     "Priest",       "heal", "global2",    "Priest",       "heal"],
  ["Anál",      "anál",       "Evoker",       "heal", "anál2",      "Shaman",       "heal"],
  ["Gina",      "gina",       "Paladin",      "heal", "gina2",      "Shaman",       "heal"],
  ["Giarem",    "giarem",     "Shaman",       "heal", "giarem2",    "Monk",         "heal"],
  ["Houdy",     "houdy",      "Evoker",       "heal", "houdy2",     "Druid",        "heal"],
  ["Rojko",     "rojko",      "Shaman",       "heal", "rojko2",     "Priest",       "heal"],
  ["Meslock",   "meslock",    "Warlock",      "dps",  "meslock2",   "Warlock",      "dps"],
  ["Miky",      "miky",       "Warrior",      "dps",  "miky2",      "Warrior",      "dps"],
  ["Hitaro",    "hitaro",     "Death Knight", "dps",  "hitaro2",    "Priest",       "dps"],
  ["Zîreael",   "zîreael",    "Mage",         "dps",  "zîreael2",   "Mage",         "dps"],
  ["pifta",     "pifta",      "Hunter",       "dps",  "pifta2",     "Demon Hunter", "dps"],
  ["Mimik",     "mimik",      "Hunter",       "dps",  "mimik2",     "Hunter",       "dps"],
  ["jeeni",     "jeeni",      "Evoker",       "dps",  "jeeni2",     "Monk",         "dps"],
  ["Trenser",   "trenser",    "Evoker",       "dps",  "trenser2",   "Evoker",       "dps"],
  ["Schizoid",  "schizoddh",  "Demon Hunter", "dps",  "schizoidy",  "Warrior",      "dps"],
  ["Hase",      "hase",       "Rogue",        "dps",  "hase2",      "Rogue",        "dps"],
  ["Arch",      "arch",       "Rogue",        "dps",  "arch2",      "Rogue",        "dps"],
  ["Hackyrek",  "hackyrek",   "Warrior",      "dps",  "hackyrek2",  "Warrior",      "dps"],
  ["Ryzz",      "ryzz",       "Warrior",      "dps",  "ryzz2",      "Demon Hunter", "dps"],
  ["Irdwy",     "irdwy",      "Mage",         "dps",  "irdwy2",     "Mage",         "dps"],
  ["Rendy",     "rendy",      "Demon Hunter", "dps",  "rendy2",     "Demon Hunter", "dps"],
  ["Nesferity", "nesferity",  "Druid",        "dps",  "nesferity2", "Druid",        "dps"],
  ["Akka",      "akka",       "Warlock",      "dps",  "akka2",      "Warlock",      "dps"],
  ["Drastic",   "drastic",    "Paladin",      "dps",  "drastic2",   "Paladin",      "dps"]
];

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

/**
 * JEDNORÁZOVĚ: vytvoří list "Roster" – zdroj pravdy o hráčích.
 * Předvyplní ho ROSTER_SEED (současný stav) a přidá dropdowny na classy
 * a role. Armor se NEeviduje – plyne přímo z classy (mapa ARMOR).
 * Existující neprázdný Roster NEPŘEPÍŠE.
 */
function buildRosterSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var rs = ss.getSheetByName(ROSTER_SHEET_NAME);
  if (rs && rs.getLastRow() > 1) {
    SpreadsheetApp.getUi().alert(
      "List " + ROSTER_SHEET_NAME + " už existuje a má data – nepřepisuju.\n" +
      "Když ho chceš vytvořit znovu, napřed ho smaž/přejmenuj.");
    return;
  }
  rs = rs || ss.insertSheet(ROSTER_SHEET_NAME);

  var maxRows = Math.max(ROSTER_SEED.length + 20, 50); // rezerva na nové hráče
  var classes = Object.keys(ARMOR);

  rs.getRange(1, 1, 1, ROSTER_HEADER.length).setValues([ROSTER_HEADER])
    .setFontWeight("bold").setBackground("#CCCCCC");
  rs.getRange(2, 1, ROSTER_SEED.length, ROSTER_HEADER.length).setValues(
    ROSTER_SEED.map(function (p) {
      return [p[0], p[1], p[2], p[3], p[4], p[5], p[6], ""];
    }));

  // dropdowny: classy (C, F) a role (D, G)
  var clsRule = SpreadsheetApp.newDataValidation()
    .requireValueInList(classes, true).setAllowInvalid(false).build();
  var roleRule = SpreadsheetApp.newDataValidation()
    .requireValueInList(ROLES, true).setAllowInvalid(false).build();
  [3, 6].forEach(function (c) { rs.getRange(2, c, maxRows - 1, 1).setDataValidation(clsRule); });
  [4, 7].forEach(function (c) { rs.getRange(2, c, maxRows - 1, 1).setDataValidation(roleRule); });

  colorRosterNames_(rs);
  rs.setFrozenRows(1);
  rs.setColumnWidth(1, 110);
  [2, 5].forEach(function (c) { rs.setColumnWidth(c, 110); });
  [3, 6].forEach(function (c) { rs.setColumnWidth(c, 120); });
  rs.setColumnWidth(8, 220);

  SpreadsheetApp.getUi().alert(
    "List " + ROSTER_SHEET_NAME + " je vytvořený (" + ROSTER_SEED.length + " hráčů).\n\n" +
    "Odteď se hráči, classy a role upravují TADY. Po každé změně spusť\n" +
    "syncWishlist – doplní řádky do wishlistu, obarví jména a překopíruje\n" +
    "dropdowny podle aktuální classy.");
}

/** Obarví buňky charů v Rosteru podle classy (Priest = bílá + černý text). */
function colorRosterNames_(rs) {
  var last = rs.getLastRow();
  if (last < 2) return;
  var vals = rs.getRange(2, 1, last - 1, 7).getValues();
  for (var i = 0; i < vals.length; i++) {
    [[2, vals[i][2]], [5, vals[i][5]]].forEach(function (x) {
      var col = x[0], cls = String(x[1] || "").trim();
      var cell = rs.getRange(i + 2, col);
      if (String(vals[i][col - 1] || "").trim() && CLASS_COLOR[cls])
        cell.setBackground(CLASS_COLOR[cls]).setFontColor("#000000");
      else
        cell.setBackground(null);
    });
  }
}

/**
 * Načte Roster -> pole hráčů {player, main, mainClass, mainRole, alt,
 * altClass, altRole}. Vrací null, když list neexistuje.
 */
function getRoster_() {
  var rs = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(ROSTER_SHEET_NAME);
  if (!rs || rs.getLastRow() < 2) return null;
  var vals = rs.getRange(2, 1, rs.getLastRow() - 1, 8).getValues();
  var players = [];
  vals.forEach(function (v) {
    var player = String(v[0] || "").trim();
    var main = String(v[1] || "").trim();
    if (!player || !main) return;
    var mainRole = String(v[3] || "").trim().toLowerCase();
    players.push({
      player: player,
      main: main,
      mainClass: String(v[2] || "").trim(),
      mainRole: mainRole,
      alt: String(v[4] || "").trim(),
      altClass: String(v[5] || "").trim(),
      altRole: String(v[6] || "").trim().toLowerCase() || mainRole
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
 * SYNCHRONIZACE Roster -> Wishlist. Spouštět po každé změně Rosteru:
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
    SpreadsheetApp.getUi().alert("List " + ROSTER_SHEET_NAME + " neexistuje nebo je prázdný – spusť buildRosterSheet.");
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

/** Obnoví barvy jmen v Rosteru podle vybraných classí (po změně classy). */
function recolorRoster() {
  var rs = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(ROSTER_SHEET_NAME);
  if (!rs) { SpreadsheetApp.getUi().alert("List " + ROSTER_SHEET_NAME + " neexistuje."); return; }
  colorRosterNames_(rs);
}

// ================== ABSENCE ==================

var ABSENCE_SHEET_NAME = "Absence";
var ABSENCE_LOG_SHEET_NAME = "Absence přehled";
var ABSENCE_TYPES = ["Nepřijdu", "Přijdu pozdě"];
// typ -> [marker v přehledu, barva buňky]
var ABSENCE_MARK = { "Nepřijdu": ["X", "#E06666"], "Přijdu pozdě": ["pozdě", "#F6B26B"] };
var ABS_INPUT_BG = "#FFF2CC";
// buňky formuláře
var ABS_PLAYER_CELL = "B2";
var ABS_DATE_CELL = "B3";     // od
var ABS_DATE_TO_CELL = "B4";  // do (nepovinné – prázdné = jen jeden den)
var ABS_TYPE_CELL = "B5";
var ABS_SUBMIT_CELL = "B7";
var ABS_BUSY_CELL = "C7";     // vzorec – okamžitá odezva po zaškrtnutí
var ABS_STATUS_CELL = "B8";
var ABS_MAX_DAYS = 62;        // pojistka proti překlepu v intervalu
var ABS_DATES_SHEET_NAME = "_absence_dates"; // skrytý zdroj dropdownu datumů
var ABS_DATE_CHOICES = 60;    // kolik dnů dopředu dropdown nabízí

/**
 * Vytvoří/obnoví list "Absence" (formulář) a "Absence přehled" (chráněný).
 * Bezpečné spouštět opakovaně – existující záznamy v přehledu zachová,
 * jen doplní nové hráče z Rosteru a obnoví validace/ochrany.
 */
function buildAbsenceSheets() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var roster = getRoster_();
  if (!roster || !roster.length) {
    SpreadsheetApp.getUi().alert("List " + ROSTER_SHEET_NAME + " neexistuje nebo je prázdný – spusť buildRosterSheet.");
    return;
  }
  var rs = ss.getSheetByName(ROSTER_SHEET_NAME);

  // ---- skrytý seznam datumů pro dropdown ----
  // Kalendář (datepicker) se ukáže až po dvojkliku a hráči ho nenacházeli.
  // Dropdown s datumy je na jedno kliknutí: pomocný list drží klouzavé okno
  // =TODAY()+n, takže nabídka začíná vždy DNEŠKEM (minulost v ní není)
  // a sama se posouvá. Vzorce bez oddělovačů -> žádný problém s locale.
  var ds = ss.getSheetByName(ABS_DATES_SHEET_NAME) || ss.insertSheet(ABS_DATES_SHEET_NAME);
  ds.clearContents();
  var dateFormulas = [["=TODAY()"]];
  for (var di = 2; di <= ABS_DATE_CHOICES; di++) dateFormulas.push(["=A" + (di - 1) + "+1"]);
  ds.getRange(1, 1, ABS_DATE_CHOICES, 1).setFormulas(dateFormulas)
    .setNumberFormat("ddd d.M.yyyy");
  ds.hideSheet();
  ds.getProtections(SpreadsheetApp.ProtectionType.SHEET).forEach(function (p) { p.remove(); });
  var dsProt = ds.protect().setDescription("Zdroj datumů pro Absence dropdown");
  dsProt.removeEditors(dsProt.getEditors());

  // ---- formulář ----
  var form = ss.getSheetByName(ABSENCE_SHEET_NAME) || ss.insertSheet(ABSENCE_SHEET_NAME);
  // rozložení se mohlo změnit – celou plochu formuláře přestavět od nuly.
  // breakApart přes CELÝ list: na výseku spadne, když nějaké sloučení
  // přesahuje jeho okraj ("je třeba vybrat všechny buňky ve sloučeném rozsahu")
  form.getRange(1, 1, form.getMaxRows(), form.getMaxColumns()).breakApart();
  form.getRange("A1:D16").clear();
  form.setHiddenGridlines(true);

  // titulek
  form.getRange("A1:C1").merge().setValue("🗓️  Hlášení absence")
    .setBackground("#434343").setFontColor("#FFFFFF")
    .setFontWeight("bold").setFontSize(14)
    .setHorizontalAlignment("center").setVerticalAlignment("middle");
  form.setRowHeight(1, 38);

  // popisky vlevo + nápovědy vpravo
  form.getRange("A2").setValue("Hráč");
  form.getRange("A3").setValue("Od");
  form.getRange("A4").setValue("Do");
  form.getRange("A5").setValue("Typ");
  form.getRange("A7").setValue("Odeslat");
  form.getRange("A8").setValue("Stav");
  form.getRange("A2:A8").setFontWeight("bold")
    .setHorizontalAlignment("right").setVerticalAlignment("middle");
  form.getRange("C2").setValue("tvoje jméno (hráč, ne postava)");
  form.getRange("C3").setValue("klikni na šipku a vyber den");
  form.getRange("C4").setValue("nepovinné – prázdné = jen jeden den");
  form.getRange("C5").setValue("Nepřijdu / Přijdu pozdě");
  form.getRange("C2:C5").setFontColor("#999999").setFontStyle("italic")
    .setVerticalAlignment("middle");
  form.setRowHeights(2, 7, 30);
  form.setRowHeight(6, 12);  // mezera před Odeslat
  form.setRowHeight(8, 36);  // stav může mít delší text

  // dropdown hráčů přímo z Rosteru (sloupec A) – žádná lokální kopie jmen
  var playerRule = SpreadsheetApp.newDataValidation()
    .requireValueInRange(rs.getRange(2, 1, Math.max(rs.getMaxRows() - 1, 1), 1), true)
    .setAllowInvalid(false).setHelpText("Vyber jméno hráče z Rosteru.").build();
  form.getRange(ABS_PLAYER_CELL).setDataValidation(playerRule);
  // dropdown datumů (dnešek až +ABS_DATE_CHOICES dní) místo skrytého datepickeru
  var dateRule = SpreadsheetApp.newDataValidation()
    .requireValueInRange(ds.getRange(1, 1, ABS_DATE_CHOICES, 1), true)
    .setAllowInvalid(false)
    .setHelpText("Klikni na šipku a vyber datum (dnešek až +" + ABS_DATE_CHOICES + " dní).")
    .build();
  [ABS_DATE_CELL, ABS_DATE_TO_CELL].forEach(function (a1) {
    form.getRange(a1).setDataValidation(dateRule).setNumberFormat("ddd d.M.yyyy");
  });
  form.getRange(ABS_TYPE_CELL).setDataValidation(SpreadsheetApp.newDataValidation()
    .requireValueInList(ABSENCE_TYPES, true).setAllowInvalid(false).build());
  if (!form.getRange(ABS_TYPE_CELL).getValue())
    form.getRange(ABS_TYPE_CELL).setValue(ABSENCE_TYPES[0]);
  form.getRange(ABS_SUBMIT_CELL).insertCheckboxes().setHorizontalAlignment("center");
  // okamžitá odezva: vzorec se přepočítá hned po zaškrtnutí, bez čekání na skript.
  // POZOR: setFormula tady vkládá text tak, jak je, a tabulka má českou locale
  // -> oddělovač argumentů musí být ";" (s "," buňka skončí na #ERROR!).
  form.getRange(ABS_BUSY_CELL)
    .setFormula('=IF(' + ABS_SUBMIT_CELL + ';"⏳ Odesílám… (pár vteřin)";"")')
    .setFontWeight("bold").setFontColor("#E69138").setVerticalAlignment("middle");
  form.getRange(ABS_STATUS_CELL + ":C8").merge().setFontWeight("bold")
    .setWrap(true).setVerticalAlignment("middle");

  // vstupní buňky: podbarvení + rámeček, ať je na první pohled vidět, kam psát
  var inputCells = [ABS_PLAYER_CELL, ABS_DATE_CELL, ABS_DATE_TO_CELL, ABS_TYPE_CELL, ABS_SUBMIT_CELL];
  inputCells.forEach(function (a1) {
    form.getRange(a1).setBackground(ABS_INPUT_BG)
      .setBorder(true, true, true, true, false, false, "#B7A75C", SpreadsheetApp.BorderStyle.SOLID)
      .setVerticalAlignment("middle");
  });

  // návod
  form.getRange("A10:C15").merge().setValue(
    "JAK NAHLÁSIT ABSENCI\n" +
    "1.  Hráč – vyber svoje jméno.\n" +
    "2.  Od – klikni na šipku a vyber datum. Do vyplň, jen když hlásíš víc dnů v kuse.\n" +
    "3.  Typ – Nepřijdu (celý raid), nebo Přijdu pozdě.\n" +
    "4.  Zaškrtni Odeslat a počkej pár vteřin – výsledek se objeví ve Stavu.\n\n" +
    "Záznamy se propisují do listu „" + ABSENCE_LOG_SHEET_NAME + "“ (jen ke čtení).\n" +
    "Omylem zadané datum ti smaže raid leader – napiš mu.")
    .setWrap(true).setFontColor("#666666")
    .setVerticalAlignment("top");

  form.setColumnWidth(1, 80);
  form.setColumnWidth(2, 210);
  form.setColumnWidth(3, 280);

  // ochrana formuláře – editovatelné jen vstupní buňky
  form.getProtections(SpreadsheetApp.ProtectionType.SHEET).forEach(function (p) { p.remove(); });
  var formProt = form.protect().setDescription("Absence – jen vstupní buňky");
  formProt.setUnprotectedRanges(inputCells.map(function (a1) { return form.getRange(a1); }));
  formProt.removeEditors(formProt.getEditors());

  // ---- přehled (chráněný) ----
  var ov = ss.getSheetByName(ABSENCE_LOG_SHEET_NAME) || ss.insertSheet(ABSENCE_LOG_SHEET_NAME);
  ov.getRange("A1").setValue("Hráč").setFontWeight("bold").setBackground("#CCCCCC");
  // doplnit hráče z Rosteru (existující řádky a markery nechat)
  var lastRow = ov.getLastRow();
  var have = {};
  if (lastRow >= 2) {
    ov.getRange(2, 1, lastRow - 1, 1).getValues().forEach(function (v) {
      var n = String(v[0] || "").trim();
      if (n) have[n.toLowerCase()] = true;
    });
  }
  roster.forEach(function (p) {
    if (have[p.player.toLowerCase()]) return;
    lastRow++;
    ov.getRange(lastRow, 1).setValue(p.player);
    have[p.player.toLowerCase()] = true;
  });
  // barvy jmen podle main classy
  var colorOf = {};
  roster.forEach(function (p) { colorOf[p.player.toLowerCase()] = CLASS_COLOR[p.mainClass] || null; });
  if (ov.getLastRow() >= 2) {
    var names = ov.getRange(2, 1, ov.getLastRow() - 1, 1).getValues();
    names.forEach(function (v, i) {
      var col = colorOf[String(v[0] || "").trim().toLowerCase()];
      if (col) ov.getRange(i + 2, 1).setBackground(col).setFontColor("#000000");
    });
  }
  ov.setFrozenRows(1);
  ov.setFrozenColumns(1);
  ov.setColumnWidth(1, 110);

  ov.getProtections(SpreadsheetApp.ProtectionType.SHEET).forEach(function (p) { p.remove(); });
  var ovProt = ov.protect().setDescription("Absence přehled – zapisuje jen skript");
  ovProt.removeEditors(ovProt.getEditors());

  SpreadsheetApp.getUi().alert(
    "Listy " + ABSENCE_SHEET_NAME + " a " + ABSENCE_LOG_SHEET_NAME + " jsou připravené.\n\n" +
    "Pokud jsi to ještě neudělal, spusť JEDNOU installAbsenceTrigger\n" +
    "(bez triggeru se odeslání formuláře nikam nepropíše).");
}

/**
 * JEDNORÁZOVĚ (jako vlastník): nainstaluje triggery pro formulář –
 * onEdit (odeslání) a onOpen (smaže starou zprávu ve Stavu, ať hráč
 * nevidí výsledek někoho jiného). Triggery běží jako instalátor, takže
 * zapisují i do chráněných buněk a fungují i pro anonymní editory.
 */
function installAbsenceTrigger() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var n = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    var h = t.getHandlerFunction();
    if (h === "onAbsenceEdit" || h === "onAbsenceOpen") { ScriptApp.deleteTrigger(t); n++; }
  });
  ScriptApp.newTrigger("onAbsenceEdit").forSpreadsheet(ss).onEdit().create();
  ScriptApp.newTrigger("onAbsenceOpen").forSpreadsheet(ss).onOpen().create();
  SpreadsheetApp.getUi().alert(
    "Triggery nainstalované" + (n ? " (staré odstraněny)" : "") + ".\n" +
    "Formulář Absence je od teď aktivní i pro anonymní hráče.");
}

/**
 * Handler instalovatelného onOpen triggeru – při otevření tabulky smaže
 * zprávu ve Stavu z minulého odeslání (jinak by ji viděl další hráč).
 */
function onAbsenceOpen() {
  var form = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(ABSENCE_SHEET_NAME);
  if (form) form.getRange(ABS_STATUS_CELL).clearContent();
  // barvy sestav můžou být od minula neaktuální (nové absence, posun datumů)
  try { recolorBossLineups_(); } catch (err) {}
}

/**
 * Handler instalovatelného onEdit triggeru – odeslání absence (checkbox)
 * a automatická obnova barev listu Boss sestavy po každé jeho editaci.
 */
function onAbsenceEdit(e) {
  if (!e || !e.range) return;
  var form = e.range.getSheet();
  if (form.getName() === BOSS_LINEUP_SHEET_NAME) {
    try { recolorBossLineups_(); } catch (err) {}
    return;
  }
  if (form.getName() !== ABSENCE_SHEET_NAME) return;
  if (e.range.getA1Notation() !== ABS_SUBMIT_CELL) return;
  if (String(e.value) !== "TRUE") return;

  form.getRange(ABS_STATUS_CELL).setValue("⏳ Zpracovávám…");
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
  } catch (err) {
    form.getRange(ABS_STATUS_CELL).setValue("⚠ Zkus to za chvíli znovu (souběžné odeslání).");
    form.getRange(ABS_SUBMIT_CELL).setValue(false);
    return;
  }
  try {
    processAbsence_(form);
  } catch (err) {
    form.getRange(ABS_STATUS_CELL).setValue("⚠ Chyba: " + err.message);
  } finally {
    form.getRange(ABS_SUBMIT_CELL).setValue(false);
    lock.releaseLock();
  }
}

/** Zpracuje odeslaný listový formulář – přečte buňky, zapíše přes
 *  recordAbsence_ a výsledek ukáže ve Stavu. */
function processAbsence_(form) {
  var status = form.getRange(ABS_STATUS_CELL);
  var player = String(form.getRange(ABS_PLAYER_CELL).getValue() || "").trim();
  var dateFrom = form.getRange(ABS_DATE_CELL).getValue();
  var dateTo = form.getRange(ABS_DATE_TO_CELL).getValue();
  var type = String(form.getRange(ABS_TYPE_CELL).getValue() || "").trim();

  if (dateTo !== "" && dateTo != null && !(dateTo instanceof Date)) {
    status.setValue("⚠ Datum Do není platné datum.");
    return;
  }
  var res = recordAbsence_(player,
                           dateFrom instanceof Date ? dateFrom : null,
                           dateTo instanceof Date ? dateTo : null, type);
  status.setValue(res.message);
  if (res.ok) {
    // jméno nechat – další hlášení téhož hráče; datumy vyčistit
    form.getRange(ABS_DATE_CELL).clearContent();
    form.getRange(ABS_DATE_TO_CELL).clearContent();
  }
}

/**
 * Jádro zápisu absence – sdílí ho listový formulář (processAbsence_)
 * i webová apka (submitAbsenceWeb). from/to = Date (to smí být null =
 * jeden den). Volající drží zámek. Vrací { ok: bool, message: string }.
 */
function recordAbsence_(player, from, to, type) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var tz = ss.getSpreadsheetTimeZone();

  player = String(player || "").trim();
  type = String(type || "").trim();
  if (!player) return { ok: false, message: "⚠ Vyber hráče." };
  if (!(from instanceof Date)) return { ok: false, message: "⚠ Vyber datum Od." };
  if (ABSENCE_TYPES.indexOf(type) < 0) return { ok: false, message: "⚠ Vyber typ absence." };
  var roster = getRoster_() || [];
  var known = roster.some(function (p) { return p.player.toLowerCase() === player.toLowerCase(); });
  if (!known) return { ok: false, message: "⚠ Hráč '" + player + "' není v Rosteru." };

  var ov = ss.getSheetByName(ABSENCE_LOG_SHEET_NAME);
  if (!ov) return { ok: false, message: "⚠ Chybí list " + ABSENCE_LOG_SHEET_NAME + " – spusť buildAbsenceSheets." };

  // interval po kalendářních dnech (bez času, ať DST nic neposune)
  from = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  to = (to instanceof Date) ? new Date(to.getFullYear(), to.getMonth(), to.getDate()) : from;
  if (to < from) return { ok: false, message: "⚠ Datum Do je před datem Od." };
  var now = new Date();
  var today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (from < today)
    return { ok: false, message: "⚠ Datum v minulosti (" +
             Utilities.formatDate(from, tz, "d.M.yyyy") +
             ") – hlásit jde jen dnešek a budoucí dny." };
  var days = Math.round((to - from) / 86400000) + 1;
  if (days > ABS_MAX_DAYS)
    return { ok: false, message: "⚠ Interval má " + days + " dní – maximum je " +
             ABS_MAX_DAYS + ". Zkontroluj datumy." };

  var row = findAbsencePlayerRow_(ov, player, roster);
  var mark = ABSENCE_MARK[type];
  for (var i = 0; i < days; i++) {
    var d = new Date(from.getFullYear(), from.getMonth(), from.getDate() + i);
    var col = findAbsenceDateCol_(ov, d, tz);
    ov.getRange(row, col).setValue(mark[0]).setBackground(mark[1])
      .setHorizontalAlignment("center").setFontColor("#000000");
  }
  // nová absence se může týkat někoho v boss sestavách – přebarvit
  try { recolorBossLineups_(); } catch (err) {}

  var rangeLabel = Utilities.formatDate(from, tz, "d.M.yyyy");
  if (days > 1)
    rangeLabel += " – " + Utilities.formatDate(to, tz, "d.M.yyyy") +
                  " (" + days + " " + (days >= 5 ? "dní" : "dny") + ")";
  return { ok: true,
           message: "✔ Uloženo: " + player + " – " + rangeLabel + " – " + type +
                    "  (" + Utilities.formatDate(new Date(), tz, "d.M. HH:mm") + ")" };
}

/**
 * Najde sloupec s datem v řádku 1 přehledu; když chybí, vloží nový tak,
 * aby datumy zůstaly vzestupně. Vrací číslo sloupce.
 */
function findAbsenceDateCol_(ov, date, tz) {
  var key = Utilities.formatDate(date, tz, "yyyy-MM-dd");
  var lastCol = ov.getLastColumn();
  var insertAt = lastCol + 1; // default: za poslední
  if (lastCol >= 2) {
    var heads = ov.getRange(1, 2, 1, lastCol - 1).getValues()[0];
    for (var i = 0; i < heads.length; i++) {
      if (!(heads[i] instanceof Date)) continue;
      var k = Utilities.formatDate(heads[i], tz, "yyyy-MM-dd");
      if (k === key) return i + 2;
      if (k > key) { insertAt = i + 2; break; }
    }
  }
  if (insertAt <= lastCol) ov.insertColumnBefore(insertAt);
  ov.getRange(1, insertAt).setValue(date).setNumberFormat("ddd d.M.")
    .setFontWeight("bold").setBackground("#CCCCCC").setHorizontalAlignment("center");
  ov.setColumnWidth(insertAt, 75);
  return insertAt;
}

/** Najde řádek hráče v přehledu; když chybí, přidá ho (obarví podle classy). */
function findAbsencePlayerRow_(ov, player, roster) {
  var lastRow = ov.getLastRow();
  if (lastRow >= 2) {
    var names = ov.getRange(2, 1, lastRow - 1, 1).getValues();
    for (var i = 0; i < names.length; i++) {
      if (String(names[i][0] || "").trim().toLowerCase() === player.toLowerCase())
        return i + 2;
    }
  }
  var row = lastRow + 1;
  var cell = ov.getRange(row, 1).setValue(player);
  roster.some(function (p) {
    if (p.player.toLowerCase() !== player.toLowerCase()) return false;
    if (CLASS_COLOR[p.mainClass]) cell.setBackground(CLASS_COLOR[p.mainClass]).setFontColor("#000000");
    return true;
  });
  return row;
}

// ================== ABSENCE WEB APP ==================
// Každý hráč dostane VLASTNÍ formulář v prohlížeči (nic sdíleného, nikdo
// nikomu nic nepřepíše). Odeslání zapisuje stejnou logikou jako listový
// formulář (recordAbsence_). Odkaz na /exec připni na Discord.
//
// NASAZENÍ (jednorázově, jako vlastník): Apps Script editor → Nasadit
// (Deploy) → Nové nasazení → typ „Webová aplikace“ → Spustit jako: JÁ,
// Kdo má přístup: KDOKOLI → Nasadit → zkopíruj URL končící /exec.
// Po každé změně kódu: Nasadit → Spravovat nasazení → ✏️ → Verze: Nová
// verze → Nasadit (URL zůstává stejná).

/** GET = servíruj formulář. Jména hráčů se vkládají ze serveru (Roster). */
function doGet() {
  var roster = getRoster_() || [];
  var names = roster.map(function (p) { return p.player; });
  var html = ABSENCE_FORM_HTML_
    .replace("__NAMES__", JSON.stringify(names))
    .replace("__TYPES__", JSON.stringify(ABSENCE_TYPES))
    .replace("__MAXDAYS__", String(ABS_MAX_DAYS));
  return HtmlService.createHtmlOutput(html)
    .setTitle("Hlášení absence")
    .addMetaTag("viewport", "width=device-width, initial-scale=1");
}

/**
 * Odeslání z webového formuláře. data = { player, from, to, type },
 * datumy jako "yyyy-mm-dd" (HTML date input). Vrací { ok, message }.
 */
function submitAbsenceWeb(data) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
  } catch (err) {
    return { ok: false, message: "⚠ Zkus to za chvíli znovu (souběžné odeslání)." };
  }
  try {
    data = data || {};
    var from = parseIsoDate_(data.from);
    var to = parseIsoDate_(data.to);
    if (data.from && !from) return { ok: false, message: "⚠ Datum Od není platné." };
    if (data.to && !to) return { ok: false, message: "⚠ Datum Do není platné." };
    return recordAbsence_(data.player, from, to, data.type);
  } catch (err) {
    return { ok: false, message: "⚠ Chyba: " + err.message };
  } finally {
    lock.releaseLock();
  }
}

/** "2026-09-05" -> Date (lokální půlnoc), jinak null. */
function parseIsoDate_(s) {
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || "").trim());
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}

// Barvy odpovídají tmavému vzhledu raid guide (jade/gold na tmavém podkladu).
var ABSENCE_FORM_HTML_ = '<!DOCTYPE html>\
<html lang="cs"><head><meta charset="utf-8"><title>Hlášení absence</title>\
<style>\
  :root { color-scheme: dark; }\
  * { box-sizing: border-box; }\
  body { background:#101815; color:#d9e4de; font-family:"Segoe UI",-apple-system,sans-serif;\
         margin:0; padding:1.25rem; line-height:1.5; }\
  .card { max-width:26rem; margin:0 auto; background:#18231f; border:1px solid #24322c;\
          border-radius:8px; padding:1.5rem 1.5rem 1.25rem; }\
  h1 { font-size:1.25rem; margin:0 0 1rem; color:#55b98a; }\
  label { display:block; font-size:.75rem; text-transform:uppercase; letter-spacing:.1em;\
          color:#8ba49a; font-weight:700; margin:0.9rem 0 .3rem; }\
  select, input[type=date] { width:100%; font-size:1rem; padding:.55rem .7rem;\
          background:#101815; color:#d9e4de; border:1px solid #24322c; border-radius:6px; }\
  select:focus, input:focus { outline:2px solid #55b98a; border-color:#55b98a; }\
  .hint { color:#8ba49a; font-size:.78rem; margin:.25rem 0 0; }\
  button { width:100%; margin-top:1.3rem; padding:.7rem; font-size:1.05rem; font-weight:700;\
           background:#55b98a; color:#0d1411; border:none; border-radius:6px; cursor:pointer; }\
  button:disabled { opacity:.5; cursor:wait; }\
  #status { margin-top:1rem; font-weight:600; min-height:1.4em; white-space:pre-line; }\
  #status.ok { color:#55b98a; } #status.err { color:#e08a3c; }\
</style></head><body><div class="card">\
<h1>🗓️ Hlášení absence</h1>\
<label for="player">Hráč</label>\
<select id="player"><option value="" disabled selected>— vyber svoje jméno —</option></select>\
<label for="type">Typ</label>\
<select id="type"></select>\
<label for="from">Od</label>\
<input type="date" id="from">\
<label for="to">Do <span style="text-transform:none;font-weight:400">(nepovinné – prázdné = jen jeden den)</span></label>\
<input type="date" id="to">\
<button id="send">Odeslat</button>\
<div id="status"></div>\
<p class="hint">Záznam se propíše do listu „Absence přehled“. Omylem zadané datum smaže raid leader – napiš mu.</p>\
</div>\
<script>\
var NAMES = __NAMES__, TYPES = __TYPES__, MAXDAYS = __MAXDAYS__;\
var $ = function (id) { return document.getElementById(id); };\
NAMES.forEach(function (n) { var o = document.createElement("option"); o.textContent = n; o.value = n; $("player").appendChild(o); });\
TYPES.forEach(function (t) { var o = document.createElement("option"); o.textContent = t; o.value = t; $("type").appendChild(o); });\
try { var last = localStorage.getItem("absPlayer"); if (last && NAMES.indexOf(last) >= 0) $("player").value = last; } catch (e) {}\
var today = new Date(), iso = today.getFullYear() + "-" + String(today.getMonth() + 1).padStart(2, "0") + "-" + String(today.getDate()).padStart(2, "0");\
$("from").min = iso; $("to").min = iso;\
$("from").addEventListener("change", function () { if ($("to").value && $("to").value < this.value) $("to").value = ""; $("to").min = this.value || iso; });\
function show(ok, msg) { var s = $("status"); s.className = ok ? "ok" : "err"; s.textContent = msg; }\
$("send").addEventListener("click", function () {\
  if (!$("player").value) return show(false, "⚠ Vyber svoje jméno.");\
  if (!$("from").value) return show(false, "⚠ Vyber datum Od.");\
  $("send").disabled = true; show(true, "⏳ Odesílám…");\
  try { localStorage.setItem("absPlayer", $("player").value); } catch (e) {}\
  google.script.run.withSuccessHandler(function (res) {\
    $("send").disabled = false; show(res.ok, res.message);\
    if (res.ok) { $("from").value = ""; $("to").value = ""; }\
  }).withFailureHandler(function (err) {\
    $("send").disabled = false; show(false, "⚠ Chyba spojení: " + err.message);\
  }).submitAbsenceWeb({ player: $("player").value, from: $("from").value, to: $("to").value, type: $("type").value });\
});\
</script></body></html>';

// ================== BOSS SESTAVY ==================

var BOSS_LINEUP_SHEET_NAME = "Boss sestavy";
var LINEUP_SIZE = 20;          // mythic
var LINEUP_LINKS_ROW = 2;
var LINEUP_DATE_ROW = 3;
var LINEUP_COUNT_ROW = 4;
var LINEUP_FIRST_SLOT_ROW = 6; // řádek 5 = mezera
// [číslo plánu, krátké jméno do hlavičky, RaidPlan view link, kotva v guide]
// Číslo v hlavičce ("01 ...") je klíč, podle kterého sloupec páruje
// raidplan/raidplan.py --boss – neměnit bez úpravy skriptu.
var BOSS_PLANS = [
  ["01", "Nek'zali",     "https://raidplan.io/plan/egs7gyaq69pg7xhs", "boss-1"],
  ["02", "Sentinels",    "https://raidplan.io/plan/xtxvjvkrhxhh2bfs", "boss-2"],
  ["03", "Vashnik",      "https://raidplan.io/plan/q8pqzrw3vf5p3q6c", "boss-3"],
  ["04", "Explorers",    "https://raidplan.io/plan/w22burzhsdzwbhf4", "boss-4"],
  ["05", "Sszorak",      "https://raidplan.io/plan/uaqafdx6g3bp6g79", "boss-5"],
  ["06", "Twin Fangs",   "https://raidplan.io/plan/u7tdr98jetxpk3sd", "boss-6"],
  ["07", "Coiled Altar", "https://raidplan.io/plan/v2p7xuwgtbauzh3k", "boss-7"],
  ["08", "Ula'tek",      "https://raidplan.io/plan/v3u4qp9jugsdyzys", "boss-8"],
  ["09", "Nymrissa",     "https://raidplan.io/plan/g4skqtr53vrsx467", "boss-9"]
];
var GUIDE_URL = "https://vitekpoor.github.io/RaidPlan/";
var LINEUP_ABSENT_BG = "#E06666";
var LINEUP_LATE_BG = "#F6B26B";
var LINEUP_UNKNOWN_BG = "#DDDDDD";

/**
 * Vytvoří/obnoví list "Boss sestavy". Bezpečné spouštět opakovaně:
 * vyplněné sloupce NEPŘEPISUJE, jen obnoví hlavičky, odkazy, validace
 * a formát; prázdné sloupce předvyplní prvními 20 hráči z Rosteru.
 * Vyžaduje existující list _absence_dates (vytváří buildAbsenceSheets).
 */
function buildBossLineups() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var roster = getRoster_();
  if (!roster || !roster.length) {
    SpreadsheetApp.getUi().alert("List " + ROSTER_SHEET_NAME + " neexistuje nebo je prázdný – spusť buildRosterSheet.");
    return;
  }
  var rs = ss.getSheetByName(ROSTER_SHEET_NAME);
  var ds = ss.getSheetByName(ABS_DATES_SHEET_NAME);
  if (!ds) {
    SpreadsheetApp.getUi().alert("Chybí list " + ABS_DATES_SHEET_NAME + " – spusť nejdřív buildAbsenceSheets.");
    return;
  }

  var sh = ss.getSheetByName(BOSS_LINEUP_SHEET_NAME) || ss.insertSheet(BOSS_LINEUP_SHEET_NAME);
  var lastSlotRow = LINEUP_FIRST_SLOT_ROW + LINEUP_SIZE - 1;

  // popisky ve sloupci A
  sh.getRange(1, 1).setValue("Boss");
  sh.getRange(LINEUP_LINKS_ROW, 1).setValue("Odkazy");
  sh.getRange(LINEUP_DATE_ROW, 1).setValue("Datum");
  sh.getRange(LINEUP_COUNT_ROW, 1).setValue("Hráčů");
  sh.getRange(1, 1, LINEUP_COUNT_ROW, 1).setFontWeight("bold")
    .setHorizontalAlignment("right").setVerticalAlignment("middle");
  var slotLabels = [];
  for (var i = 1; i <= LINEUP_SIZE; i++) slotLabels.push([i]);
  sh.getRange(LINEUP_FIRST_SLOT_ROW, 1, LINEUP_SIZE, 1).setValues(slotLabels)
    .setFontColor("#999999").setHorizontalAlignment("right");

  var playerRule = SpreadsheetApp.newDataValidation()
    .requireValueInRange(rs.getRange(2, 1, Math.max(rs.getMaxRows() - 1, 1), 1), true)
    .setAllowInvalid(true).setHelpText("Vyber hráče z Rosteru.").build();
  var dateRule = SpreadsheetApp.newDataValidation()
    .requireValueInRange(ds.getRange(1, 1, ABS_DATE_CHOICES, 1), true)
    .setAllowInvalid(true)
    .setHelpText("Datum raidu na tenhle boss – podle něj se hlídají absence.")
    .build();

  var seeded = [];
  BOSS_PLANS.forEach(function (b, idx) {
    var c = idx + 2;
    var colA1 = String.fromCharCode(64 + c); // B..J
    sh.getRange(1, c).setValue(b[0] + " " + b[1]).setFontWeight("bold")
      .setBackground("#434343").setFontColor("#FFFFFF")
      .setHorizontalAlignment("center").setVerticalAlignment("middle");
    var links = SpreadsheetApp.newRichTextValue().setText("Plán ↗  Taktika ↗")
      .setLinkUrl(0, 6, b[2])
      .setLinkUrl(8, 17, GUIDE_URL + "#" + b[3])
      .build();
    sh.getRange(LINEUP_LINKS_ROW, c).setRichTextValue(links).setHorizontalAlignment("center");
    sh.getRange(LINEUP_DATE_ROW, c).setDataValidation(dateRule)
      .setNumberFormat("ddd d.M.yyyy").setHorizontalAlignment("center");
    // jen jeden argument -> žádný problém s locale oddělovačem
    sh.getRange(LINEUP_COUNT_ROW, c).setFormula(
      "=COUNTA(" + colA1 + LINEUP_FIRST_SLOT_ROW + ":" + colA1 + lastSlotRow + ')&" / ' + LINEUP_SIZE + '"'
    ).setHorizontalAlignment("center");
    var slots = sh.getRange(LINEUP_FIRST_SLOT_ROW, c, LINEUP_SIZE, 1);
    slots.setDataValidation(playerRule);
    var empty = slots.getValues().every(function (v) { return !String(v[0] || "").trim(); });
    if (empty) {
      var seed = roster.slice(0, LINEUP_SIZE).map(function (p) { return [p.player]; });
      if (seed.length) sh.getRange(LINEUP_FIRST_SLOT_ROW, c, seed.length, 1).setValues(seed);
      seeded.push(b[0] + " " + b[1]);
    }
    sh.setColumnWidth(c, 130);
  });

  sh.setColumnWidth(1, 70);
  sh.setRowHeight(1, 30);
  sh.setRowHeight(LINEUP_FIRST_SLOT_ROW - 1, 8);
  sh.setFrozenRows(LINEUP_FIRST_SLOT_ROW - 1);
  sh.setFrozenColumns(1);
  recolorBossLineups_();

  SpreadsheetApp.getUi().alert(
    "List " + BOSS_LINEUP_SHEET_NAME + " je připravený (gid=" + sh.getSheetId() + ").\n" +
    (seeded.length
      ? "Předvyplněné sloupce (prvních " + Math.min(LINEUP_SIZE, roster.length) + " hráčů z Rosteru): " + seeded.join(", ")
      : "Žádný sloupec nebyl prázdný – existující sestavy nechány beze změny.") + "\n\n" +
    "Vyber u každého bosse DATUM raidu – absence hráčů na ten den se\n" +
    "hned podbarví (červená = nepřijde, oranžová = přijde pozdě).\n" +
    "Plán pak přegeneruješ přes raidplan/update_plans.bat.");
}

/** Ruční obnova barev/kontrol sestav (jinak se dějí samy triggerem). */
function refreshBossLineups() {
  var err = recolorBossLineups_();
  SpreadsheetApp.getUi().alert(err || "Sestavy obnovené (barvy classy, absence, duplicity).");
}

/**
 * Přebarví sloupce sestav: classa hráče, absence na datum bosse,
 * duplicity a neznámá jména. Vrací chybovou hlášku, nebo "" (OK).
 * Nesmí volat getUi – běží i z triggeru.
 */
function recolorBossLineups_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(BOSS_LINEUP_SHEET_NAME);
  if (!sh) return "List " + BOSS_LINEUP_SHEET_NAME + " neexistuje – spusť buildBossLineups.";
  var tz = ss.getSpreadsheetTimeZone();
  var roster = getRoster_() || [];
  var colorOf = {};
  roster.forEach(function (p) { colorOf[p.player.toLowerCase()] = CLASS_COLOR[p.mainClass] || null; });

  // absence: "hráč|yyyy-MM-dd" -> marker ("X" / "pozdě")
  var absMap = {};
  var ov = ss.getSheetByName(ABSENCE_LOG_SHEET_NAME);
  if (ov && ov.getLastRow() >= 2 && ov.getLastColumn() >= 2) {
    var heads = ov.getRange(1, 2, 1, ov.getLastColumn() - 1).getValues()[0];
    var body = ov.getRange(2, 1, ov.getLastRow() - 1, ov.getLastColumn()).getValues();
    body.forEach(function (r) {
      var pl = String(r[0] || "").trim().toLowerCase();
      if (!pl) return;
      heads.forEach(function (h, i) {
        if (!(h instanceof Date)) return;
        var v = String(r[i + 1] || "").trim();
        if (v) absMap[pl + "|" + Utilities.formatDate(h, tz, "yyyy-MM-dd")] = v;
      });
    });
  }

  var nCols = BOSS_PLANS.length;
  var dates = sh.getRange(LINEUP_DATE_ROW, 2, 1, nCols).getValues()[0];
  var grid = sh.getRange(LINEUP_FIRST_SLOT_ROW, 2, LINEUP_SIZE, nCols);
  var vals = grid.getValues();
  var bgs = [], notes = [], lines = [], fontCols = [];
  for (var r = 0; r < LINEUP_SIZE; r++) {
    bgs.push([]); notes.push([]); lines.push([]); fontCols.push([]);
  }
  var countBg = [];
  for (var c = 0; c < nCols; c++) {
    var dateKey = (dates[c] instanceof Date)
      ? Utilities.formatDate(dates[c], tz, "yyyy-MM-dd") : null;
    var seen = {};
    var filled = 0;
    for (var r2 = 0; r2 < LINEUP_SIZE; r2++) {
      var name = String(vals[r2][c] || "").trim();
      var key = name.toLowerCase();
      var bg = null, note = "", line = "none", fc = "#000000";
      if (name) {
        filled++;
        bg = colorOf[key] || LINEUP_UNKNOWN_BG;
        if (!(key in colorOf)) note = "Není v Rosteru";
        if (seen[key]) {
          fc = "#CC0000";
          note = (note ? note + " · " : "") + "Duplicitně v sestavě";
        }
        seen[key] = true;
        var abs = dateKey ? absMap[key + "|" + dateKey] : null;
        if (abs) {
          var late = abs.toLowerCase().indexOf("poz") === 0;
          bg = late ? LINEUP_LATE_BG : LINEUP_ABSENT_BG;
          if (!late) line = "line-through";
          note = (note ? note + " · " : "") +
            (late ? "Přijde pozdě " : "ABSENCE – nepřijde ") +
            Utilities.formatDate(dates[c], tz, "d.M.");
        }
      }
      bgs[r2][c] = bg; notes[r2][c] = note; lines[r2][c] = line; fontCols[r2][c] = fc;
    }
    countBg.push(filled === LINEUP_SIZE ? "#D9EAD3" : "#FCE5CD");
  }
  grid.setBackgrounds(bgs).setFontColors(fontCols).setFontLines(lines).setNotes(notes);
  sh.getRange(LINEUP_COUNT_ROW, 2, 1, nCols).setBackgrounds([countBg]);
  return "";
}

// ================== LEGACY ==================
/**
 * Původní single-select dropdowny filtrované podle classy (bez checkboxů).
 * NESPOUŠTĚT po nastavení multi-selectu – přepsal by čipovou validaci!
 */
function applyClassDropdowns() {
  var ws = SpreadsheetApp.getActiveSheet();
  var lastRow = ws.getLastRow(), lastCol = ws.getLastColumn();
  var headers = ws.getRange(1, 1, 1, lastCol).getValues()[0];
  var names = ws.getRange(1, 1, lastRow, 1).getValues();
  var classMap = charClassMap_();
  var applied = 0, unknown = [];

  for (var r = 2; r <= lastRow; r++) {
    var raw = names[r - 1][0];
    if (!raw) continue;
    var key = String(raw).trim().toLowerCase();
    var cls = classMap[key];
    if (!cls) { if (key !== "legenda:") unknown.push(raw); continue; }
    for (var c = 2; c <= lastCol; c++) {
      var boss = String(headers[c - 1] || "").trim();
      if (!DB[boss]) continue;
      var cell = ws.getRange(r, c);
      var list = itemsForClass_(boss, cls);
      var cur = String(cell.getValue() || "").trim();
      if (cur && list.indexOf(cur) < 0) list = list.concat([cur]);
      cell.setDataValidation(SpreadsheetApp.newDataValidation()
        .requireValueInList(list, true)
        .setAllowInvalid(true)
        .build());
      applied++;
    }
  }
  SpreadsheetApp.getUi().alert(
    "Hotovo: " + applied + " buněk s dropdownem.\n" +
    (unknown.length ? "Neznámé jméno (přidej do PLAYER_CLASS): " + unknown.join(", ") : "Všechna jména rozpoznána."));
}
