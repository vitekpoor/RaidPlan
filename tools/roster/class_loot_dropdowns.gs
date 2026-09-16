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
  var width = Math.max(rs.getLastColumn(), ROSTER_HEADER.length);
  // sloupce podle hlavičky (v listu může být prázdný sloupec navíc, např. E před "Alt char");
  // když hlavička chybí, platí pořadí ROSTER_HEADER
  var head = rs.getRange(1, 1, 1, width).getValues()[0].map(function (h) { return String(h || "").trim().toLowerCase(); });
  var col = {};
  ROSTER_HEADER.forEach(function (h, i) { var j = head.indexOf(h.toLowerCase()); col[h] = j >= 0 ? j : i; });
  var vals = rs.getRange(2, 1, rs.getLastRow() - 1, width).getValues();
  var players = [];
  vals.forEach(function (v) {
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

/**
 * GET = servíruj formulář. Jména hráčů se vkládají ze serveru (Roster).
 * Stejná web app obsluhuje i sim frontu: URL …/exec?p=sim (viz SIM FRONTA).
 */
function doGet(e) {
  var page = e && e.parameter ? String(e.parameter.p || "") : "";
  if (page === "sim") return simFormPage_();
  if (page === "simapi") return simApi_(e);
  var roster = getRoster_() || [];
  var names = roster.map(function (p) { return p.player; });
  var html = ABSENCE_FORM_HTML_
    .replace("__NAMES__", JSON.stringify(names))
    .replace("__TYPES__", JSON.stringify(ABSENCE_TYPES))
    .replace("__MAXDAYS__", String(ABS_MAX_DAYS));
  return HtmlService.createHtmlOutput(html)
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL) // vložené na hlavní stránce guildy (GitHub Pages)
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
// Barvy odpovídají vzhledu webu (web/assets/css/site.css – tmavě šedá + růžový akcent, šablona Cyborg Gaming).
var ABSENCE_FORM_HTML_ = '<!DOCTYPE html>\
<html lang="cs"><head><meta charset="utf-8"><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet"><title>Hlášení absence</title>\
<style>\
  :root { color-scheme: dark; }\
  * { box-sizing: border-box; }\
  body { background:#111413; color:#e4eae6; font-family:"Inter","Segoe UI",-apple-system,sans-serif;\
         margin:0; padding:1.25rem; line-height:1.5; }\
  .card { max-width:26rem; margin:0 auto; background:#171b19; border:1px solid #242a27;\
          border-radius:10px; padding:1.5rem 1.5rem 1.25rem; }\
  h1 { font-size:1.25rem; margin:0 0 1rem; color:#3fd68a; }\
  label { display:block; font-size:.75rem; text-transform:uppercase; letter-spacing:.1em;\
          color:#8b968f; font-weight:700; margin:0.9rem 0 .3rem; }\
  select, input[type=date] { width:100%; font-size:1rem; padding:.55rem .7rem;\
          background:#0a0c0b; color:#e4eae6; border:1px solid #242a27; border-radius:6px; }\
  select:focus, input:focus { outline:2px solid #3fd68a; border-color:#3fd68a; }\
  .hint { color:#8b968f; font-size:.78rem; margin:.25rem 0 0; }\
  button { width:100%; margin-top:1.3rem; padding:.7rem; font-size:1.05rem; font-weight:700;\
           background:#3fd68a; color:#07110c; border:none; border-radius:999px; cursor:pointer; }\
  button:disabled { opacity:.5; cursor:wait; }\
  #status { margin-top:1rem; font-weight:600; min-height:1.4em; white-space:pre-line; }\
  #status.ok { color:#3fd68a; } #status.err { color:#f0857a; }\
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
var GUIDE_URL = "https://vitekpoor.github.io/RaidPlan/raid.html"; // taktiky; kořen webu je rozcestník (staré odkazy …/#boss-N přesměruje)
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

// ================== SIM FRONTA (SimC string -> Raidbots Droptimizer -> wowaudit) ==================
//
// Hráč neumí/nechce nastavovat Raidbots, tak pošle jen SimC string z addonu
// (/simc ve hře) přes webový formulář …/exec?p=sim. Řádek skončí v listu
// "Sim fronta". Raid leader v Sheets otevře menu Simy → Zpracovat frontu:
// dialog mu SimC zkopíruje do schránky, otevře Raidbots Droptimizer a po
// vložení odkazu na hotový report ho nahraje do wowaudit přes API
// (POST /v1/wishlists) pro správnou postavu. Odkaz jde vložit i přímo do
// sloupce "Report URL" – instalovatelný onEdit trigger udělá to samé.
//
// Jednorázové nastavení (vlastník, v editoru Apps Script):
//   1. setWowauditApiKey()   – uloží API klíč týmu (wowaudit → Settings → API)
//                              do Script Properties (nikdy ne do kódu).
//   2. buildSimSheet()       – založí list "Sim fronta".
//   3. installSimTrigger()   – onEdit trigger pro ruční vložení Report URL.
//   4. Nasadit web app (viz ABSENCE WEB APP) – formulář je na …/exec?p=sim.
//
// Nastavení Raidbots je vypsané v dialogu (a v SIM_RAIDBOTS_STEPS níže);
// odpovídá referenčnímu reportu 96x39Cpcgyn2Tmneq7G6ht: Season 2 Raids,
// Mythic, Patchwerk, 1 cíl, 5 minut, výchozí raid buffy a consumables,
// Smart Sim (high precision).

var SIM_SHEET_NAME = "Sim fronta";
var SIM_HEADER = ["Čas", "Postava", "Spec", "SimC string", "Report URL", "Stav", "Poznámka", "wowaudit ID", "Report M+ URL", "Vault", "Report Top Gear URL", "Report HC raid URL"];
var SIM_COL = { time: 1, character: 2, spec: 3, simc: 4, report: 5, status: 6, note: 7, id: 8, reportMplus: 9, vault: 10, reportTopgear: 11, reportRaidhc: 12 };
// Za každou postavu běží DVA Droptimizery: raid (Season 2 Raids, Mythic) a Mythic+ dungeony
// ("+10 Vault" = Myth track), oba s "Upgrade up to" Myth 6/6 – stejné ilvl, férové srovnání.
// QE Live (healeři) má raid i dungeony v jednom reportu (kind "qe" = oba).
var SIM_MPLUS = true;                 // řádek je ✅ až s raidovým i M+ reportem
// Třetí sim (jen Raidbots/DPS): Top Gear z nejlepších raid + M+ itemů na slot – sim_runner ho
// pustí, až má oba Droptimizery; výsledek = jeden souhrnný řádek "Top Gear" (best overall).
var SIM_TOPGEAR = true;               // řádek je ✅ až i s Top Gear reportem (QE Live healeři ho nemají)
var SIM_TOPGEAR_SKIP = "– (nic není upgrade)";   // hodnota sloupce, když Top Gear nemá kandidáty
// Čtvrtý sim jen u postav s Great Vaultem (sloupec "Vault" není prázdný): raidový Droptimizer
// s obtížností "Heroic Vault" (Myth 1/6) + Upgrade up to Myth 6/6 = všechny raidové itemy max 334.
// Bonus roll na HC (a na mythic bossech, které zabíjíme) dává mythic item, ale max 334 – 344 base
// dropí jen poslední mythic bossové (Coiled Altar, Ula'tek), kde bonus roll ještě dlouho nepůjde.
// Stránka Simy proto verdikt "vzít z vaultu vs. nechat si bonus roll" počítá z tohohle reportu
// (Původ "Raid HC"), ne z plného mythic Droptimizeru. QE Live (healeři) má raid už na 334 (dropType max).
var SIM_RAIDHC = true;                // řádek s vaultem je ✅ až i s HC raid reportem
var SIM_KIND_LABEL = { raid: "raid", mplus: "M+", qe: "raid+M+", topgear: "Top Gear", raidhc: "HC raid" };   // label "HC raid" nesmí začínat "raid " (mergeSimNote_)
var SIM_KIND_ORIGIN = { raid: "Raid", mplus: "M+", topgear: "Top Gear", raidhc: "Raid HC" };   // hodnota sloupce "Původ" v listu "Sim výsledky"
var SIM_STATUS = { pending: "⏳ čeká na sim", running: "🔄 simuluje", done: "✅ hotovo", error: "⚠ chyba", dropped: "❌ zahozeno" };
var SIM_STATUS_BG = { "⏳ čeká na sim": "#FFF2CC", "🔄 simuluje": "#CFE2F3", "✅ hotovo": "#D9EAD3", "✅ ve wowaudit": "#D9EAD3", "⚠ chyba": "#F4CCCC", "❌ zahozeno": "#EFEFEF" };
var SIM_MAX_SIMC = 200000;         // pojistka na velikost vstupu (SimC export má ~10–20 kB)

var WOWAUDIT_API = "https://api.wowaudit.com/v1";
var WOWAUDIT_KEY_PROP = "WOWAUDIT_API_KEY";
var WOWAUDIT_CHARS_CACHE = "wowaudit_characters_v1";
var WOWAUDIT_CHARS_TTL = 6 * 3600;  // CacheService maximum
var WOWAUDIT_REPLACE_MANUAL = false; // true = sim přepíše ruční úpravy hráče ve wowaudit
var WOWAUDIT_UPLOAD = true;          // false = do wowaudit neposílat (stránka Simy bere data z listu "Sim výsledky")

var RAIDBOTS_DROPTIMIZER_URL = "https://www.raidbots.com/simbot/droptimizer";
var SIM_RAIDBOTS_STEPS = [
  "Vlož SimC string do pole „SimC Addon“ (ne Armory).",
  "Source: Raids → „Season 2 Raids“ (The Venomous Abyss + Tidebound Grotto), Difficulty: Mythic, Upgrade up to: Myth 6/6.",
  "Druhý sim té samé postavy: Source „Mythic+ Dungeons“ (All Dungeons), Difficulty „+10 Vault“, Upgrade up to: Myth 6/6 → odkaz ulož jako M+ report.",
  "Fight: Patchwerk, 1 cíl (1 boss), délka 5 minut (300 s).",
  "Buffs & consumables nechat výchozí (všechny raid buffy zapnuté, Bloodlust ano, Power Infusion ne, výchozí potion/food/flask).",
  "Smart Sim: zapnuto, High precision: zapnuto.",
  "Run Droptimizer → po dokončení zkopíruj URL reportu (…/simbot/report/XXXX), vyber Raid / M+ a ulož.",
  "Třetí sim (dělá sim_runner sám): Top Gear z nejlepších raid + M+ itemů → odkaz ulož jako Top Gear (best overall řádek na stránce Simy).",
  "Postava s Great Vaultem: ještě jeden raidový Droptimizer – Source „Season 2 Raids“, Difficulty „Heroic Vault“ (Myth 1/6), Upgrade up to: Myth 6/6 (všechno max 334 = co dá bonus roll na HC) → odkaz ulož jako HC raid; z něj je verdikt vault vs. bonus roll.",
  "Healeři: místo Raidbots použij QE Live Upgrade Finder (questionablyepic.com/live/upgradefinder) – Import → SimC string, Raid: Mythic, M+: +10, Generate → odkaz reportu pokrývá raid i dungeony najednou."
];
var QE_UPGRADE_FINDER_URL = "https://questionablyepic.com/live/upgradefinder";

/* ---------- wowaudit API ---------- */

/** Jednorázově: uloží API klíč týmu do Script Properties (prompt v Sheets). */
function setWowauditApiKey() {
  var ui = SpreadsheetApp.getUi();
  var res = ui.prompt("wowaudit API klíč",
    "Vlož API klíč týmu (wowaudit → tým → Settings → API). Uloží se do Script Properties, ne do kódu.",
    ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui.Button.OK) return;
  var key = res.getResponseText().trim();
  if (!/^[0-9a-f]{40,}$/i.test(key)) { ui.alert("To nevypadá jako wowaudit API klíč (hex řetězec)."); return; }
  PropertiesService.getScriptProperties().setProperty(WOWAUDIT_KEY_PROP, key);
  CacheService.getScriptCache().remove(WOWAUDIT_CHARS_CACHE);
  var chars = wowauditCharacters_(true);
  ui.alert("Klíč uložen. wowaudit vrátil " + chars.length + " postav: " +
    chars.map(function (c) { return c.name; }).join(", "));
}

function wowauditKey_() {
  var key = PropertiesService.getScriptProperties().getProperty(WOWAUDIT_KEY_PROP);
  if (!key) throw new Error("Chybí wowaudit API klíč – spusť setWowauditApiKey().");
  return key;
}

/** HTTP volání wowaudit API. Vrací { code, body(text), json(objekt|null) }. */
function wowauditFetch_(path, method, payload) {
  var opts = {
    method: method || "get",
    headers: { "Authorization": "Bearer " + wowauditKey_(), "Accept": "application/json" },
    muteHttpExceptions: true
  };
  if (payload) { opts.contentType = "application/json"; opts.payload = JSON.stringify(payload); }
  var resp = UrlFetchApp.fetch(WOWAUDIT_API + path, opts);
  var body = resp.getContentText();
  var json = null;
  try { json = JSON.parse(body); } catch (err) { /* text */ }
  return { code: resp.getResponseCode(), body: body, json: json };
}

/**
 * Seznam postav týmu ve wowaudit [{id, name, realm, cls, role}], seřazený
 * podle jména. Cache 6 h (formulář se otevírá často); force = obnovit.
 */
function wowauditCharacters_(force) {
  var cache = CacheService.getScriptCache();
  if (!force) {
    var hit = cache.get(WOWAUDIT_CHARS_CACHE);
    if (hit) return JSON.parse(hit);
  }
  var r = wowauditFetch_("/characters", "get");
  if (r.code !== 200 || !Array.isArray(r.json)) {
    throw new Error("wowaudit /characters vrátil HTTP " + r.code + ": " + r.body.slice(0, 200));
  }
  var chars = r.json.map(function (c) {
    return { id: c.id, name: String(c.name || ""), realm: String(c.realm || ""),
             cls: String(c["class"] || ""), role: String(c.role || "") };
  }).sort(function (a, b) { return a.name.localeCompare(b.name, "cs"); });
  cache.put(WOWAUDIT_CHARS_CACHE, JSON.stringify(chars), WOWAUDIT_CHARS_TTL);
  return chars;
}

/** Menu: vynutí nové načtení postav z wowaudit (po přidání hráče do týmu). */
function refreshWowauditCharacters() {
  var chars = wowauditCharacters_(true);
  SpreadsheetApp.getUi().alert("Načteno " + chars.length + " postav z wowaudit:\n" +
    chars.map(function (c) { return c.name + " (" + c.cls + ")"; }).join("\n"));
}

/* ---------- list Sim fronta ---------- */

function simSheet_() {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SIM_SHEET_NAME);
  if (sh) ensureSimHeader_(sh);
  return sh;
}

/** Doplní nové sloupce hlavičky (Report M+ URL, Vault) do staršího listu. */
function ensureSimHeader_(sh) {
  try {
    var head = sh.getRange(1, 1, 1, SIM_HEADER.length).getValues()[0];
    var missing = SIM_HEADER.some(function (h, i) { return String(head[i] || "") !== h; });
    if (!missing) return;
    sh.getRange(1, 1, 1, SIM_HEADER.length).setValues([SIM_HEADER])
      .setFontWeight("bold").setBackground("#24322C").setFontColor("#FFFFFF");
  } catch (err) { /* jen kosmetika */ }
}

/** Jednorázově založí list "Sim fronta" (idempotentní – existující data nechá). */
function buildSimSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = simSheet_();
  if (!sh) sh = ss.insertSheet(SIM_SHEET_NAME);
  sh.getRange(1, 1, 1, SIM_HEADER.length).setValues([SIM_HEADER])
    .setFontWeight("bold").setBackground("#24322C").setFontColor("#FFFFFF");
  sh.setFrozenRows(1);
  var widths = [130, 130, 110, 260, 300, 120, 260, 90, 300, 160, 300, 300];
  widths.forEach(function (w, i) { sh.setColumnWidth(i + 1, w); });
  sh.getRange(1, 1, Math.max(sh.getMaxRows(), 2), SIM_HEADER.length)
    .setWrapStrategy(SpreadsheetApp.WrapStrategy.CLIP).setVerticalAlignment("middle");
  sh.getRange(2, SIM_COL.time, sh.getMaxRows() - 1, 1).setNumberFormat("d.M.yyyy H:mm");
  sh.getRange(1, SIM_COL.simc).setNote("Celý SimC string – kopíruj přes menu Simy → Zpracovat frontu " +
    "(Ctrl+C z buňky s víceřádkovým textem přidá uvozovky).");
  sh.getRange(1, SIM_COL.report).setNote("Raidový Droptimizer (nebo QE Live) – stačí sem vložit odkaz na hotový report, trigger ho zpracuje.");
  sh.getRange(1, SIM_COL.reportMplus).setNote("Mythic+ Droptimizer (Mythic+ Dungeons, +10 Vault, Myth 6/6) – odkaz sem vloží sim_runner, nebo ručně.");
  sh.getRange(1, SIM_COL.vault).setNote("Itemy z Great Vaultu podle SimC exportu (blok Weekly Reward Choices) – plný seznam je v listu „Vault“.");
  sh.getRange(1, SIM_COL.reportTopgear).setNote("Raidbots Top Gear z nejlepších raid + M+ itemů (best overall) – vkládá sim_runner po obou Droptimizerech.");
  SpreadsheetApp.getUi().alert("List „" + SIM_SHEET_NAME + "“ je připravený.\n" +
    "Nezapomeň: setWowauditApiKey(), installSimTrigger() a nasadit web app (formulář …/exec?p=sim).");
}

/** Instalovatelný onEdit trigger pro ruční vložení Report URL (nahradí starý). */
function installSimTrigger() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var n = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === "onSimEdit") { ScriptApp.deleteTrigger(t); n++; }
  });
  ScriptApp.newTrigger("onSimEdit").forSpreadsheet(ss).onEdit().create();
  SpreadsheetApp.getUi().alert("Trigger onSimEdit nainstalován" + (n ? " (starý nahrazen)." : "."));
}

/** Menu Simy v Sheets. (Jednoduchý onOpen – běží pro každého, ale menu je jen kosmetika.) */
function onOpen() {
  try {
    SpreadsheetApp.getUi().createMenu("Simy")
      .addItem("Zpracovat frontu…", "showSimQueue")
      .addSeparator()
      .addItem("Obnovit seznam postav z wowaudit", "refreshWowauditCharacters")
      .addItem("Nastavit wowaudit API klíč…", "setWowauditApiKey")
      .addItem("Vytvořit list Sim fronta", "buildSimSheet")
      .addItem("Nainstalovat trigger (Report URL)", "installSimTrigger")
      .addItem("Token pro sim_runner.py…", "setSimApiToken")
      .addSeparator()
      .addItem("Vytvořit list Sim výsledky", "buildSimResultsSheet")
      .addItem("Vytvořit list Vault", "buildVaultSheet")
      .addItem("Vytvořit list Cresty", "buildCrestSheet")
      .addItem("Vytvořit list Discord (místnosti hráčů)", "buildDiscordSheet")
      .addItem("Nastavit Discord bot token / společný webhook…", "setDiscordSecrets")
      .addItem("Načíst místnosti hráčů z Discordu (bot)", "syncDiscordRooms")
      .addItem("Test Discord notifikace pro postavu…", "testDiscordNotify")
      .addItem("Doplnit cresty ze Sim fronty", "backfillCrests")
      .addItem("Načíst výsledky ze všech hotových reportů", "rebuildSimResults")
      .addItem("Znovu nasimovat označené řádky fronty", "requeueSelectedSims")
      .addSeparator()
      .addItem("Spustit simy online (GitHub)", "runSimsOnline")
      .addItem("Nastavit GitHub token…", "setGithubToken")
      .addItem("Nastavit heslo pro web tlačítko…", "setSimRunPassword")
      .addToUi();
  } catch (err) { /* bez UI (trigger/web) */ }
}

/* ---------- SimC parsing ---------- */

/**
 * Vytáhne z SimC exportu jméno postavy, classu, spec, server a region. Vrací
 * { name, cls, spec, server, region, ok, error }. Kontroluje, že jde opravdu o SimC export
 * (řádek `<classa>="Jméno"` + aspoň jeden slot s `,id=`).
 */
function parseSimc_(text) {
  var s = String(text || "").replace(/\r/g, "").trim();
  var out = { name: "", cls: "", spec: "", server: "", region: "", ok: false, error: "" };
  if (!s) { out.error = "SimC string je prázdný."; return out; }
  if (s.length > SIM_MAX_SIMC) { out.error = "SimC string je podezřele dlouhý."; return out; }
  var m = /^(deathknight|demonhunter|druid|evoker|hunter|mage|monk|paladin|priest|rogue|shaman|warlock|warrior)="([^"\n]+)"\s*$/mi.exec(s);
  if (!m) { out.error = "Nenašel jsem řádek classa=\"Jméno\" – vlož celý export z addonu SimulationCraft (/simc)."; return out; }
  out.cls = m[1].toLowerCase();
  out.name = m[2].trim();
  var sp = /^spec=([a-z_]+)\s*$/mi.exec(s);
  out.spec = sp ? sp[1].toLowerCase() : "";
  var sv = /^server=([^\s]+)\s*$/mi.exec(s);
  out.server = sv ? sv[1] : "";
  var rg = /^region=([a-z]+)\s*$/mi.exec(s);
  out.region = rg ? rg[1].toLowerCase() : "";
  if (!/^[a-z_0-9]+=,id=\d+/mi.test(s)) { out.error = "Export neobsahuje žádný vybavený item (řádky head=,id=…)."; return out; }
  out.vault = parseVault_(s);   // null = blok chybí (hráč neotevřel Great Vault), [] = otevřel, ale nic nenabízí
  out.crests = parseCrests_(s); // null = řádek upgrade_currencies chybí (starý addon)
  out.ok = true;
  return out;
}

/**
 * Great Vault ze SimC exportu. Addon SimulationCraft přidá (když má hráč otevřený
 * vault) zakomentovaný blok:
 *   ### Weekly Reward Choices
 *   # Název itemu (ilvl)
 *   # trinket1=,id=123456,bonus_id=1/2/3
 *   ### End of Weekly Reward Choices
 * Vrací pole { slot, id, name, ilvl, bonus } nebo null, když blok chybí. Řádky
 * vaultu (raid / dungeon / world) addon nerozlišuje – stránka Simy si itemy páruje
 * podle ID s raidovým a M+ Droptimizerem; itemy z delvů/worldu ignoruje.
 */
function parseVault_(s) {
  var m = /###\s*Weekly Reward Choices([\s\S]*?)(?:###\s*End of Weekly Reward Choices|$)/i.exec(s);
  if (!m) return null;
  var items = [], name = "", ilvl = "";
  m[1].split("\n").forEach(function (line) {
    var l = line.replace(/^\s*#\s?/, "").trim();
    if (!l) return;
    var it = /^([a-z_0-9]+)=,?id=(\d+)(.*)$/i.exec(l);
    if (it) {
      var b = /bonus_id=([\d\/]+)/.exec(it[3]);
      items.push({ slot: it[1].toLowerCase().replace(/[12]$/, ""), id: Number(it[2]), name: name,
                   ilvl: ilvl ? Number(ilvl) : "", bonus: b ? b[1] : "" });
      name = ""; ilvl = "";
      return;
    }
    var nm = /^(.*?)\s*(?:\((\d{3})\))?\s*$/.exec(l);
    if (nm && nm[1] && !/^#/.test(nm[1])) { name = nm[1]; ilvl = nm[2] || ""; }
  });
  return items;
}

/** Porovnání jmen bez diakritiky a velikosti písmen (Ähaferös ~ ahaferos). */
function simNameKey_(name) {
  return String(name || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
}

/**
 * Z odkazu/ID na sim report vrátí { id, kind, url } nebo null.
 * kind = "raidbots" (Droptimizer) nebo "qe" (QE Live Upgrade Finder pro
 * healery). Stejné tvary odkazů akceptuje i wowaudit UI:
 *   raidbots.com/simbot/report/<id>, raidbots.com/reports/<id>/data.json,
 *   questionablyepic.com/live/upgradereport/<id>, /live/report/<id>, /api/upgrades/<id>.
 * Samotné ID bez odkazu bere jako Raidbots.
 */
function parseReportLink_(s) {
  s = String(s || "").trim();
  var m = /raidbots\.com\/(?:simbot\/report|reports)\/([A-Za-z0-9]{10,40})/.exec(s);
  if (m) return { id: m[1], kind: "raidbots", url: "https://www.raidbots.com/simbot/report/" + m[1] };
  m = /questionablyepic\.com\/(?:live\/upgradereport|live\/report|api\/upgrades)\/([A-Za-z0-9_-]{6,80})/.exec(s);
  if (m) return { id: m[1], kind: "qe", url: "https://questionablyepic.com/live/upgradereport/" + m[1] };
  if (/^[A-Za-z0-9]{10,40}$/.test(s)) return { id: s, kind: "raidbots", url: "https://www.raidbots.com/simbot/report/" + s };
  return null;
}

/** Zpětně kompatibilní zkratka: ID reportu nebo "". */
function raidbotsReportId_(s) {
  var r = parseReportLink_(s);
  return r ? r.id : "";
}

/* ---------- webový formulář pro hráče (…/exec?p=sim) ---------- */

function simFormPage_() {
  return HtmlService.createHtmlOutput(SIM_FORM_HTML_)
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL) // vložené na hlavní stránce guildy (GitHub Pages)
    .setTitle("Sim pro loot")
    .addMetaTag("viewport", "width=device-width, initial-scale=1");
}

/**
 * Odeslání z webového formuláře: data = { simc }. Postavu ověří podle jména
 * (a classy) v SimC stringu proti listu "Roster" (main i alt) a zapíše řádek do
 * fronty. Vrací { ok, message }.
 */
function submitSimWeb(data) {
  var lock = LockService.getScriptLock();
  try { lock.waitLock(20000); } catch (err) { return { ok: false, message: "⚠ Zkus to za chvíli znovu (souběžné odeslání)." }; }
  try {
    data = data || {};
    var p = parseSimc_(data.simc);
    if (!p.ok) return { ok: false, message: "⚠ " + p.error };

    var found = findRosterCharacter_(p.name, p.cls);
    if (found.error) return { ok: false, message: "⚠ " + found.error };
    var ch = found.character;

    var sh = simSheet_();
    if (!sh) return { ok: false, message: "⚠ List „" + SIM_SHEET_NAME + "“ neexistuje – napiš raid leaderovi." };

    // starší čekající řádky té samé postavy zahodíme – platí poslední sim
    var last = sh.getLastRow();
    if (last >= 2) {
      var vals = sh.getRange(2, 1, last - 1, SIM_HEADER.length).getValues();
      vals.forEach(function (v, i) {
        if (String(v[SIM_COL.character - 1]) === ch.name && String(v[SIM_COL.status - 1]) === SIM_STATUS.pending) {
          setSimStatus_(sh, i + 2, SIM_STATUS.dropped, "nahrazeno novějším odesláním");
        }
      });
    }
    var vaultCell = p.vault === null ? "" : (p.vault.length ? p.vault.map(function (v) { return v.id; }).join(", ") : "(prázdný)");
    sh.appendRow([new Date(), ch.name, p.spec, String(data.simc).replace(/\r/g, "").trim(),
                  "", SIM_STATUS.pending, "", ch.id, "", vaultCell, ""]);
    var r = sh.getLastRow();
    sh.getRange(r, SIM_COL.simc).setWrapStrategy(SpreadsheetApp.WrapStrategy.CLIP);
    sh.getRange(r, SIM_COL.status).setBackground(SIM_STATUS_BG[SIM_STATUS.pending]);
    var vaultMsg = "";
    if (p.vault === null) {
      vaultMsg = " Vault v exportu nebyl – když před /simc otevřeš Great Vault, uvidíš na stránce Simy i porovnání vaultu s raidem.";
    } else {
      try { storeVault_(ch.name, p.vault); } catch (err) { /* vault je bonus, nesmí shodit odeslání */ }
      vaultMsg = p.vault.length ? " Vault: " + p.vault.length + (p.vault.length === 1 ? " item." : p.vault.length < 5 ? " itemy." : " itemů.") : "";
    }
    // cresty (měny z řádku upgrade_currencies) – bonus, nesmí shodit odeslání
    if (p.crests) { try { storeCrests_(ch.name, p.crests, null, p.server, p.region); } catch (err) { /* ignorovat */ } }
    var waiting = countPendingSims_(sh);
    // rovnou spustit runner v GitHub Actions (chyba GitHubu nesmí shodit odeslání formuláře)
    var started = "";
    if (SIM_AUTO_RUN) {
      try {
        var run = runSimsOnline_("form:" + ch.name);
        started = run.ok ? " Sim se právě spouští – za pár minut uvidíš upgrady na stránce Simy." : " Sim proběhne automaticky nejpozději do hodiny.";
      } catch (err) { started = " Sim proběhne automaticky nejpozději do hodiny."; }
    } else {
      started = " Sim proběhne automaticky nejpozději do hodiny a upgrady uvidíš na stránce Simy.";
    }
    return { ok: true, message: "✅ Uloženo: " + ch.name + " (" + p.spec + ")." + vaultMsg + " Ve frontě čeká " + waiting +
      (waiting === 1 ? " sim." : waiting < 5 ? " simy." : " simů.") + started };
  } catch (err) {
    return { ok: false, message: "⚠ Chyba: " + err.message };
  } finally {
    lock.releaseLock();
  }
}

/** Classa ze SimC ("deathknight") vs. z rosteru ("Death Knight") → stejný klíč. */
function simClassKey_(cls) {
  return String(cls || "").toLowerCase().replace(/[^a-z]/g, "");
}

/**
 * Ověří postavu ze SimC proti listu "Roster" (main i alt char, bez diakritiky a velikosti
 * písmen; stejné jméno u mainu i altu rozhodne classa). wowaudit ID se jen zkusí dohledat
 * (nepovinné – upload do wowaudit si ho případně dohledá sám). Vrací { character } nebo { error }.
 */
function findRosterCharacter_(name, cls) {
  var roster = getRoster_();
  if (!roster) return { error: "List „" + ROSTER_SHEET_NAME + "“ je prázdný nebo neexistuje – napiš raid leaderovi." };
  var key = simNameKey_(name), ck = simClassKey_(cls);
  var hits = [];
  roster.forEach(function (r) {
    if (r.main && simNameKey_(r.main) === key) hits.push({ name: r.main, cls: r.mainClass, role: r.mainRole, player: r.player, which: "main" });
    if (r.alt && simNameKey_(r.alt) === key) hits.push({ name: r.alt, cls: r.altClass, role: r.altRole, player: r.player, which: "alt" });
  });
  if (!hits.length) {
    return { error: "Postava „" + name + "“ není v rosteru (list Roster). Pošli string z postavy, se kterou raiduješ, nebo napiš raid leaderovi, ať ji do rosteru doplní." };
  }
  var byClass = hits.filter(function (h) { return !ck || !h.cls || simClassKey_(h.cls) === ck; });
  if (!byClass.length) {
    return { error: "Postava „" + name + "“ je v rosteru jako " + hits.map(function (h) { return h.cls; }).join(" / ") +
      ", ale string je z classy " + cls + ". Pošli string ze správné postavy, nebo ať raid leader opraví roster." };
  }
  var h = byClass[0];
  var id = 0;
  try {
    var wk = simNameKey_(h.name);
    wowauditCharacters_(false).forEach(function (c) { if (!id && simNameKey_(c.name) === wk) id = c.id; });
  } catch (err) { /* wowaudit je nepovinný */ }
  return { character: { name: h.name, id: id, role: h.role, player: h.player, cls: h.cls } };
}

/**
 * (Už se pro formulář nepoužívá – postava se ověřuje proti rosteru, viz findRosterCharacter_.)
 * Najde postavu wowaudit týmu podle jména ze SimC (bez diakritiky/velikosti
 * písmen); při shodě více jmen rozhodne server (SimC `server=drakthul` vs.
 * wowaudit realm "Drak'thul"). Vrací { character } nebo { error }.
 */
function findWowauditCharacter_(name, server) {
  var chars = wowauditCharacters_(false);
  var key = simNameKey_(name);
  var hits = chars.filter(function (c) { return simNameKey_(c.name) === key; });
  if (hits.length > 1 && server) {
    var sk = simRealmKey_(server);
    var narrowed = hits.filter(function (c) { return simRealmKey_(c.realm) === sk; });
    if (narrowed.length) hits = narrowed;
  }
  if (hits.length === 1) return { character: hits[0] };
  if (hits.length === 0) {
    return { error: "Postava „" + name + "“ není ve wowaudit týmu. Pošli string z postavy, se kterou raiduješ, nebo napiš raid leaderovi, ať ji do wowaudit přidá." };
  }
  return { error: "Jméno „" + name + "“ mají ve wowaudit " + hits.length + " postavy (" +
    hits.map(function (c) { return c.name + "-" + c.realm; }).join(", ") + ") – napiš raid leaderovi." };
}

/** "Drak'thul" / "drakthul" / "Twisting Nether" -> "drakthul" / "twistingnether". */
function simRealmKey_(realm) {
  return simNameKey_(realm).replace(/[^a-z0-9]/g, "");
}

function countPendingSims_(sh) {
  var last = sh.getLastRow();
  if (last < 2) return 0;
  return sh.getRange(2, SIM_COL.status, last - 1, 1).getValues()
    .filter(function (v) { return String(v[0]) === SIM_STATUS.pending; }).length;
}

function setSimStatus_(sh, row, status, note) {
  sh.getRange(row, SIM_COL.status).setValue(status).setBackground(SIM_STATUS_BG[status] || null);
  if (note !== undefined) sh.getRange(row, SIM_COL.note).setValue(note);
}

/* ---------- nahrání reportu do wowaudit ---------- */

/**
 * Zpracuje report z řádku fronty: primárně zapíše výsledky do listu
 * "Sim výsledky" (čte ho stránka Simy), sekundárně (WOWAUDIT_UPLOAD) ho zkusí
 * nahrát do wowaudit. Řádek je ✅, když se povedlo aspoň jedno.
 * Vrací { ok, message }. Používá dialog, onEdit trigger i sim_runner (simapi done).
 */
function uploadSimReport_(sh, row, reportUrl, kind, opts) {
  opts = opts || {};
  var vals = sh.getRange(row, 1, 1, SIM_HEADER.length).getValues()[0];
  var wasComplete = String(vals[SIM_COL.status - 1] || "").indexOf("✅") === 0;
  var character = String(vals[SIM_COL.character - 1] || "");
  var spec = String(vals[SIM_COL.spec - 1] || "");
  var charId = Number(vals[SIM_COL.id - 1]);
  var link = parseReportLink_(reportUrl);
  if (!link) { setSimStatus_(sh, row, SIM_STATUS.error, "Neplatný odkaz na report (Raidbots / QE Live): " + reportUrl); return { ok: false, message: "⚠ Neplatný odkaz – vlož odkaz na Raidbots Droptimizer nebo QE Live Upgrade Finder report." }; }
  // druh reportu: raid | mplus | topgear | raidhc (Raidbots) | qe (QE Live = raid i dungeony v jednom, Top Gear nemá)
  kind = String(kind || "");
  kind = link.kind === "qe" ? "qe" : (kind === "mplus" || kind === "topgear" || kind === "raidhc" ? kind : "raid");
  var kinds = kind === "qe" ? ["raid", "mplus"] : [kind];
  if (kinds.indexOf("raid") >= 0) sh.getRange(row, SIM_COL.report).setValue(link.url);
  if (kinds.indexOf("mplus") >= 0) sh.getRange(row, SIM_COL.reportMplus).setValue(link.url);
  if (kinds.indexOf("topgear") >= 0) sh.getRange(row, SIM_COL.reportTopgear).setValue(link.url);
  if (kinds.indexOf("raidhc") >= 0) sh.getRange(row, SIM_COL.reportRaidhc).setValue(link.url);
  if (kind === "qe") sh.getRange(row, SIM_COL.reportTopgear).setValue("– (QE Live)");

  // 1) primární cíl: list "Sim výsledky" (čte ho stránka Simy)
  var stored = storeSimResults_(character, spec, link, kinds);

  // 2) wowaudit jen jako bonus (jen raidový report) – s "Upgrade up to" reporty odmítá ("no matching droptimizer configuration")
  var wa = { ok: false, skipped: true, message: "vypnuto" };
  if (WOWAUDIT_UPLOAD && kinds.indexOf("raid") >= 0) {
    try {
      if (!charId) {
        var chars = wowauditCharacters_(false);
        chars.forEach(function (c) { if (simNameKey_(c.name) === simNameKey_(character)) charId = c.id; });
        if (charId) sh.getRange(row, SIM_COL.id).setValue(charId);
      }
      if (!charId) wa = { ok: false, skipped: false, message: "postava není ve wowaudit" };
      else wa = wowauditUploadReport_(charId, link.id);
    } catch (err) { wa = { ok: false, skipped: false, message: String(err && err.message || err) }; }
  }

  // 3) hotovo, až když má řádek raidový, M+ i Top Gear report (SIM_MPLUS / SIM_TOPGEAR) a u vaultu HC raid (SIM_RAIDHC); QE pokrývá vše
  var complete = simRowComplete_(sh, row);
  var missing = simRowMissing_(sh, row);
  var when = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "d.M. H:mm");
  var seg = SIM_KIND_LABEL[kind] + " " + when + (link.kind === "qe" ? " QE Live: " : " Raidbots: ") +
    (stored.ok ? stored.message : "výsledky se nenačetly: " + stored.message) +
    (wa.skipped ? "" : (wa.ok ? " · wowaudit nahráno" : " · wowaudit odmítl: " + wa.message));
  var note = mergeSimNote_(vals[SIM_COL.note - 1], kind, seg);
  var ok = stored.ok || wa.ok;
  if (ok && !complete) note += " | čeká na " + missing + " sim";
  // Discord: jen když se řádek právě teď stal kompletním (ne při přepočtu hotových řádků)
  var pendingNotify = null;
  if (ok && complete && !wasComplete && opts.notify !== false) {
    var dn = notifySimDone_(character, spec, { viaRunner: !!opts.viaRunner });
    if (dn.note) note += " | " + dn.note;
    pendingNotify = dn.pending;
  }
  setSimStatus_(sh, row, !ok ? SIM_STATUS.error : (complete ? SIM_STATUS.done : SIM_STATUS.running), note);
  var msg = ok
    ? "✅ " + character + " [" + SIM_KIND_LABEL[kind] + "]: " + (stored.ok ? stored.message + " ve výsledcích" : "výsledky se nenačetly") +
      (wa.skipped ? "" : (wa.ok ? ", wowaudit OK" : ", wowaudit odmítl")) + (complete ? "" : " – čeká se ještě na " + missing + " sim")
    : "⚠ " + character + " [" + SIM_KIND_LABEL[kind] + "]: " + stored.message + (wa.skipped ? "" : "; wowaudit: " + wa.message);
  return { ok: ok, message: msg, complete: complete, notify: pendingNotify };
}

/** Které simy řádku ještě chybí ("M+", "M+ a Top Gear", …); "" = kompletní. */
function simRowMissing_(sh, row) {
  var vals = sh.getRange(row, 1, 1, SIM_HEADER.length).getValues()[0];
  var raidLink = parseReportLink_(vals[SIM_COL.report - 1]);
  var hasMplus = !!parseReportLink_(vals[SIM_COL.reportMplus - 1]);
  var hasTopgear = !!String(vals[SIM_COL.reportTopgear - 1] || "").trim();
  var hasRaidhc = !!parseReportLink_(vals[SIM_COL.reportRaidhc - 1]);
  var hasVault = !!String(vals[SIM_COL.vault - 1] || "").trim();
  var isQe = !!(raidLink && raidLink.kind === "qe");
  var miss = [];
  if (!raidLink) miss.push("raid");
  if (SIM_MPLUS && !hasMplus) miss.push("M+");
  if (SIM_TOPGEAR && !hasTopgear && !isQe) miss.push("Top Gear");
  if (SIM_RAIDHC && hasVault && !hasRaidhc && !isQe) miss.push("HC raid");
  return miss.length > 1 ? miss.slice(0, -1).join(", ") + " a " + miss[miss.length - 1] : miss.join("");
}

function simRowComplete_(sh, row) {
  return simRowMissing_(sh, row) === "";
}

/** POST /v1/wishlists – vrací { ok, skipped:false, message }. */
function wowauditUploadReport_(charId, reportId) {
  var r = wowauditFetch_("/wishlists", "post", {
    report_id: reportId, character_id: charId,
    replace_manual_edits: WOWAUDIT_REPLACE_MANUAL, clear_conduits: false
  });
  if (r.code === 200 && r.json && r.json.created) return { ok: true, skipped: false, message: "nahráno" };
  var msg = "";
  if (r.json && typeof r.json === "object") {
    msg = String(r.json.message || r.json.error || "");
    if (!msg) {
      // tvar {"created":false,"base":["…"],"team":["…"]}
      var parts = [];
      Object.keys(r.json).forEach(function (k) { if (Array.isArray(r.json[k])) parts.push(r.json[k].join(", ")); });
      msg = parts.join("; ");
    }
  }
  if (!msg) msg = r.body.slice(0, 200);
  return { ok: false, skipped: false, message: "HTTP " + r.code + " " + msg };
}

/** Handler instalovatelného onEdit triggeru – vložení odkazu do sloupce Report URL. */
function onSimEdit(e) {
  try {
    if (!e || !e.range) return;
    var sh = e.range.getSheet();
    if (sh.getName() !== SIM_SHEET_NAME) return;
    var col = e.range.getColumn();
    if ((col !== SIM_COL.report && col !== SIM_COL.reportMplus && col !== SIM_COL.reportTopgear) || e.range.getRow() < 2 || e.range.getNumRows() !== 1) return;
    var val = String(e.value || e.range.getValue() || "").trim();
    if (!val) return;
    var lock = LockService.getScriptLock();
    try { lock.waitLock(20000); } catch (err) { return; }
    try { uploadSimReport_(sh, e.range.getRow(), val, col === SIM_COL.reportMplus ? "mplus" : (col === SIM_COL.reportTopgear ? "topgear" : "raid")); } finally { lock.releaseLock(); }
  } catch (err) {
    try { e.range.getSheet().getRange(e.range.getRow(), SIM_COL.note).setValue("⚠ " + err.message); } catch (e2) { /* ignore */ }
  }
}

/**
 * Menu Simy → "Znovu nasimovat označené řádky fronty": označ v listu "Sim fronta" řádky (klidně víc
 * bloků přes Ctrl), funkce jim smaže reporty (raid, M+, Top Gear, HC raid), dá stav ⏳ a jedním
 * spuštěním pošle runner online. Hodí se po změně kódu (nový druh simu, opravený parser), aby se
 * hotové postavy přepočítaly aktuální logikou. SimC string a Vault zůstávají, takže se pustí i HC raid.
 */
function requeueSelectedSims() {
  var ui = SpreadsheetApp.getUi();
  var sh = SpreadsheetApp.getActiveSheet();
  if (sh.getName() !== SIM_SHEET_NAME) { ui.alert("Označ řádky v listu „" + SIM_SHEET_NAME + "“ a spusť to znovu."); return; }
  var rl = sh.getActiveRangeList();
  var ranges = rl ? rl.getRanges() : [sh.getActiveRange()];
  var rowSet = {};
  ranges.forEach(function (rg) {
    for (var r = rg.getRow(); r < rg.getRow() + rg.getNumRows(); r++) if (r >= 2) rowSet[r] = 1;
  });
  var rows = Object.keys(rowSet).map(Number).sort(function (a, b) { return a - b; });
  if (rows.length > 60) { ui.alert("Označeno je " + rows.length + " řádků – to je moc najednou (max 60)."); return; }
  var items = rows.map(function (r) {
    var v = sh.getRange(r, 1, 1, SIM_HEADER.length).getValues()[0];
    return { row: r, character: String(v[SIM_COL.character - 1] || ""), spec: String(v[SIM_COL.spec - 1] || ""),
             status: String(v[SIM_COL.status - 1] || ""), simc: String(v[SIM_COL.simc - 1] || ""), vault: String(v[SIM_COL.vault - 1] || "").trim() };
  }).filter(function (it) { return it.character && it.simc; });
  if (!items.length) { ui.alert("V označení není žádný řádek s postavou a SimC stringem."); return; }
  var resp = ui.alert("Znovu nasimovat " + items.length + " řádků?",
    items.map(function (it) { return "• " + it.character + " (" + it.spec + ", řádek " + it.row + (it.vault ? ", s vaultem" : "") + ")"; }).join("\n") +
    "\n\nSmažou se jejich reporty (raid, M+, Top Gear, HC raid), stav bude ⏳ a simy se spustí online najednou.",
    ui.ButtonSet.OK_CANCEL);
  if (resp !== ui.Button.OK) return;
  var when = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "d.M. H:mm");
  items.forEach(function (it) {
    [SIM_COL.report, SIM_COL.reportMplus, SIM_COL.reportTopgear, SIM_COL.reportRaidhc].forEach(function (c) { sh.getRange(it.row, c).clearContent(); });
    setSimStatus_(sh, it.row, SIM_STATUS.pending, "znovu do fronty " + when);
  });
  var r;
  try { r = runSimsOnline_("requeue:" + items.length); }
  catch (err) { r = { ok: false, message: String(err && err.message || err) }; }
  ui.alert(items.length + " řádků je zpět ve frontě.\n" + (r.ok ? r.message
    : "Spuštění online selhalo: " + r.message + "\nSpusť simy ručně (menu Simy → Spustit simy online, nebo sim_runner.py)."));
}

/* ---------- dialog pro raid leadera (menu Simy → Zpracovat frontu) ---------- */

function showSimQueue() {
  var html = HtmlService.createHtmlOutput(SIM_QUEUE_HTML_
      .replace("__STEPS__", JSON.stringify(SIM_RAIDBOTS_STEPS))
      .replace("__RAIDBOTS__", JSON.stringify(RAIDBOTS_DROPTIMIZER_URL))
      .replace("__QE__", JSON.stringify(QE_UPGRADE_FINDER_URL)))
    .setWidth(900).setHeight(640);
  SpreadsheetApp.getUi().showModalDialog(html, "Sim fronta – Raidbots → wowaudit");
}

/** Data pro dialog: čekající (a chybové) řádky bez SimC stringu. */
function getSimQueue() {
  var sh = simSheet_();
  if (!sh) throw new Error("List „" + SIM_SHEET_NAME + "“ neexistuje – spusť buildSimSheet().");
  var last = sh.getLastRow();
  var out = [];
  if (last < 2) return out;
  var vals = sh.getRange(2, 1, last - 1, SIM_HEADER.length).getValues();
  var tz = Session.getScriptTimeZone();
  vals.forEach(function (v, i) {
    var status = String(v[SIM_COL.status - 1]);
    if (status !== SIM_STATUS.pending && status !== SIM_STATUS.running && status !== SIM_STATUS.error) return;
    out.push({
      row: i + 2,
      time: v[SIM_COL.time - 1] instanceof Date ? Utilities.formatDate(v[SIM_COL.time - 1], tz, "d.M. H:mm") : String(v[SIM_COL.time - 1]),
      character: String(v[SIM_COL.character - 1]),
      spec: String(v[SIM_COL.spec - 1]),
      status: status,
      note: String(v[SIM_COL.note - 1] || ""),
      simcLength: String(v[SIM_COL.simc - 1] || "").length,
      hasRaid: !!parseReportLink_(v[SIM_COL.report - 1]),
      hasMplus: !!parseReportLink_(v[SIM_COL.reportMplus - 1]),
      hasTopgear: !!String(v[SIM_COL.reportTopgear - 1] || "").trim(),
      hasRaidhc: !!parseReportLink_(v[SIM_COL.reportRaidhc - 1]),
      hasVault: !!String(v[SIM_COL.vault - 1] || "").trim()
    });
  });
  return out;
}

/** SimC string jednoho řádku (pro kopírování do schránky v dialogu). */
function getSimcForRow(row) {
  var sh = simSheet_();
  return String(sh.getRange(Number(row), SIM_COL.simc).getValue() || "");
}

/** Dialog: uložit report pro řádek (kind raid | mplus; QE Live odkaz pokrývá oboje). */
function uploadSimRow(row, reportUrl, kind) {
  var sh = simSheet_();
  var lock = LockService.getScriptLock();
  try { lock.waitLock(20000); } catch (err) { return { ok: false, message: "⚠ Zkus to za chvíli znovu." }; }
  try { return uploadSimReport_(sh, Number(row), reportUrl, kind); }
  catch (err) { return { ok: false, message: "⚠ " + err.message }; }
  finally { lock.releaseLock(); }
}

/** Dialog: zahodit řádek (např. hráč poslal nesmysl). */
function dropSimRow(row) {
  var sh = simSheet_();
  setSimStatus_(sh, Number(row), SIM_STATUS.dropped, "zahozeno raid leaderem");
  return { ok: true, message: "Řádek zahozen." };
}

var SIM_QUEUE_HTML_ = '<!DOCTYPE html><html lang="cs"><head><meta charset="utf-8">\
<style>\
  * { box-sizing:border-box; }\
  body { font-family:"Segoe UI",-apple-system,sans-serif; font-size:13px; color:#222; margin:0; padding:12px 14px; }\
  h3 { margin:0 0 8px; font-size:15px; }\
  .wrap { display:grid; grid-template-columns: 1fr 300px; gap:14px; }\
  .item { border:1px solid #ddd; border-radius:6px; padding:8px 10px; margin-bottom:8px; background:#fafafa; }\
  .item.err { border-color:#e06666; background:#fdf3f3; }\
  .head { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }\
  .name { font-weight:700; font-size:14px; }\
  .meta { color:#666; font-size:12px; }\
  .note { color:#b45309; font-size:12px; margin-top:4px; white-space:pre-line; }\
  .row { display:flex; gap:6px; margin-top:8px; flex-wrap:wrap; align-items:center; }\
  input[type=text] { flex:1; min-width:220px; padding:5px 7px; border:1px solid #bbb; border-radius:4px; font-size:13px; }\
  select.kind { padding:5px 6px; border:1px solid #bbb; border-radius:4px; font-size:13px; background:#fff; }\
  button, a.btn { padding:5px 10px; border-radius:4px; border:1px solid #999; background:#fff; cursor:pointer; font-size:13px; text-decoration:none; color:#222; }\
  button.primary { background:#2e7d32; color:#fff; border-color:#2e7d32; }\
  button.danger { color:#b00020; }\
  button:disabled { opacity:.5; cursor:wait; }\
  .steps { background:#f1f5f3; border:1px solid #cfdad4; border-radius:6px; padding:10px 12px; font-size:12px; }\
  .steps ol { padding-left:18px; margin:6px 0 0; } .steps li { margin-bottom:5px; }\
  .msg { margin-top:6px; font-weight:600; font-size:12px; } .msg.ok { color:#2e7d32; } .msg.err { color:#b00020; }\
  .empty { color:#666; padding:20px; text-align:center; }\
  textarea.hidden { position:absolute; left:-9999px; top:0; }\
</style></head><body>\
<div class="wrap"><div>\
<h3>Fronta simů <span id="count" class="meta"></span> <button id="reload" style="float:right">↻ Obnovit</button></h3>\
<div id="list"><div class="empty">Načítám…</div></div>\
</div><div>\
<div class="steps"><b>Postup pro každou postavu</b>\
<ol id="steps"></ol>\
<p style="margin:8px 0 0"><a class="btn" id="rb" target="_blank" rel="noopener">🚀 Otevřít Raidbots Droptimizer</a> \
<a class="btn" id="qe" target="_blank" rel="noopener">💚 QE Live (healeři)</a></p>\
<p class="meta" style="margin-top:8px">Raidbots si nastavení pamatuje v prohlížeči – po prvním správném nastavení stačí jen vložit SimC a spustit.</p>\
</div></div></div>\
<textarea class="hidden" id="clip"></textarea>\
<script>\
var STEPS = __STEPS__, RAIDBOTS = __RAIDBOTS__, QE = __QE__;\
var $ = function (id) { return document.getElementById(id); };\
$("rb").href = RAIDBOTS; $("qe").href = QE;\
STEPS.forEach(function (s) { var li = document.createElement("li"); li.textContent = s; $("steps").appendChild(li); });\
function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\\"": "&quot;" }[c]; }); }\
function copyText(text, btn) {\
  var done = function (ok) { btn.textContent = ok ? "✅ Zkopírováno" : "⚠ Kopírování selhalo"; setTimeout(function () { btn.textContent = "📋 Kopírovat SimC"; }, 2500); };\
  if (navigator.clipboard && navigator.clipboard.writeText) {\
    navigator.clipboard.writeText(text).then(function () { done(true); }, function () { fallback(); });\
  } else { fallback(); }\
  function fallback() { var ta = $("clip"); ta.value = text; ta.select(); var ok = false; try { ok = document.execCommand("copy"); } catch (e) {} done(ok); }\
}\
function render(items) {\
  var list = $("list"); list.innerHTML = "";\
  $("count").textContent = items.length ? "(" + items.length + ")" : "";\
  if (!items.length) { list.innerHTML = "<div class=\\"empty\\">Fronta je prázdná 🎉</div>"; return; }\
  items.forEach(function (it) {\
    var div = document.createElement("div"); div.className = "item" + (it.status.indexOf("chyba") >= 0 ? " err" : "");\
    var have = (it.hasRaid ? " · raid ✅" : " · raid –") + (it.hasMplus ? " · M+ ✅" : " · M+ –") + (it.hasTopgear ? " · Top Gear ✅" : " · Top Gear –") + (it.hasVault ? (it.hasRaidhc ? " · HC raid ✅" : " · HC raid –") : "");\
    div.innerHTML = "<div class=\\"head\\"><span class=\\"name\\">" + esc(it.character) + "</span><span class=\\"meta\\">" + esc(it.spec) + " · " + esc(it.time) + " · " + esc(it.status) + have + "</span></div>" +\
      (it.note ? "<div class=\\"note\\">" + esc(it.note) + "</div>" : "") +\
      "<div class=\\"row\\"><button class=\\"copy\\">📋 Kopírovat SimC</button>" +\
      "<a class=\\"btn\\" href=\\"" + RAIDBOTS + "\\" target=\\"_blank\\" rel=\\"noopener\\">🚀 Raidbots</a>" +\
      "<a class=\\"btn\\" href=\\"" + QE + "\\" target=\\"_blank\\" rel=\\"noopener\\" title=\\"Healeři\\">💚 QE Live</a>" +\
      "<button class=\\"drop danger\\" title=\\"Zahodit tento řádek\\">✖</button></div>" +\
      "<div class=\\"row\\"><input type=\\"text\\" class=\\"url\\" placeholder=\\"https://www.raidbots.com/simbot/report/…\\">" +\
      "<select class=\\"kind\\" title=\\"Který sim to je (QE Live odkaz pokrývá raid i M+)\\"><option value=\\"raid\\"" + (it.hasRaid ? "" : " selected") + ">Raid</option><option value=\\"mplus\\"" + (it.hasRaid && !it.hasMplus ? " selected" : "") + ">M+</option><option value=\\"topgear\\"" + (it.hasRaid && it.hasMplus && !it.hasTopgear ? " selected" : "") + ">Top Gear</option><option value=\\"raidhc\\"" + (it.hasRaid && it.hasMplus && it.hasTopgear && it.hasVault && !it.hasRaidhc ? " selected" : "") + ">HC raid (vault)</option></select>" +\
      "<button class=\\"up primary\\">⬆ Uložit report</button></div><div class=\\"msg\\"></div>";\
    var copyBtn = div.querySelector(".copy"), upBtn = div.querySelector(".up"), dropBtn = div.querySelector(".drop"), url = div.querySelector(".url"), kindSel = div.querySelector(".kind"), msg = div.querySelector(".msg");\
    copyBtn.addEventListener("click", function () {\
      copyBtn.disabled = true; copyBtn.textContent = "⏳…";\
      google.script.run.withSuccessHandler(function (t) { copyBtn.disabled = false; copyText(t, copyBtn); })\
        .withFailureHandler(function (e) { copyBtn.disabled = false; copyBtn.textContent = "⚠ " + e.message; }).getSimcForRow(it.row);\
    });\
    url.addEventListener("keydown", function (e) { if (e.key === "Enter") upBtn.click(); });\
    upBtn.addEventListener("click", function () {\
      if (!url.value.trim()) { msg.className = "msg err"; msg.textContent = "Vlož odkaz na report."; return; }\
      upBtn.disabled = true; msg.className = "msg"; msg.textContent = "⏳ Načítám výsledky reportu…";\
      google.script.run.withSuccessHandler(function (res) { upBtn.disabled = false; msg.className = "msg " + (res.ok ? "ok" : "err"); msg.textContent = res.message; if (res.ok) setTimeout(load, 900); })\
        .withFailureHandler(function (e) { upBtn.disabled = false; msg.className = "msg err"; msg.textContent = "⚠ " + e.message; }).uploadSimRow(it.row, url.value.trim(), kindSel.value);\
    });\
    dropBtn.addEventListener("click", function () {\
      if (!confirm("Zahodit sim pro " + it.character + "?")) return;\
      google.script.run.withSuccessHandler(load).dropSimRow(it.row);\
    });\
    list.appendChild(div);\
  });\
}\
function load() {\
  google.script.run.withSuccessHandler(render).withFailureHandler(function (e) { $("list").innerHTML = "<div class=\\"empty\\">⚠ " + esc(e.message) + "</div>"; }).getSimQueue();\
}\
$("reload").addEventListener("click", load);\
load();\
</script></body></html>';

// Formulář pro hráče – jen jedno pole, postava se pozná ze SimC stringu.
// Stejný vzhled jako absence (tmavý, růžový akcent).
var SIM_FORM_HTML_ = '<!DOCTYPE html>\
<html lang="cs"><head><meta charset="utf-8"><title>Sim pro loot</title>\
<style>\
  :root { color-scheme: dark; }\
  * { box-sizing: border-box; }\
  body { background:#111413; color:#e4eae6; font-family:"Inter","Segoe UI",-apple-system,sans-serif;\
         margin:0; padding:1.25rem; line-height:1.5; }\
  .card { max-width:32rem; margin:0 auto; background:#171b19; border:1px solid #242a27;\
          border-radius:10px; padding:1.5rem 1.5rem 1.25rem; }\
  h1 { font-size:1.25rem; margin:0 0 .5rem; color:#3fd68a; }\
  textarea { width:100%; min-height:14rem; font-size:.8rem; padding:.55rem .7rem; margin-top:.8rem;\
          background:#0a0c0b; color:#e4eae6; border:1px solid #242a27; border-radius:6px;\
          font-family:Consolas,monospace; resize:vertical; }\
  textarea:focus { outline:2px solid #3fd68a; border-color:#3fd68a; }\
  .hint { color:#8b968f; font-size:.78rem; margin:.25rem 0 0; }\
  .how { background:#0a0c0b; border:1px solid #242a27; border-radius:6px; padding:.7rem .9rem; font-size:.85rem; margin-top:1rem; }\
  .how ol { margin:.3rem 0 0; padding-left:1.2rem; } .how li { margin-bottom:.25rem; }\
  code { background:#242a27; padding:.05rem .35rem; border-radius:4px; font-size:.85em; }\
  button { width:100%; margin-top:1rem; padding:.7rem; font-size:1.05rem; font-weight:700;\
           background:#3fd68a; color:#07110c; border:none; border-radius:999px; cursor:pointer; }\
  button:disabled { opacity:.5; cursor:wait; }\
  #status { margin-top:1rem; font-weight:600; min-height:1.4em; white-space:pre-line; }\
  #status.ok { color:#3fd68a; } #status.err { color:#f0857a; }\
  #detected { color:#8b968f; font-size:.85rem; margin-top:.4rem; min-height:1.2em; }\
  #detected b { color:#d9e4de; }\
</style></head><body><div class="card">\
<h1>⚔️ Sim pro loot</h1>\
<p class="hint">Vlož sem celý text z <code>/simc</code>. Postavu poznáme automaticky (musí být v rosteru guildy), sim proběhne sám (raid i Mythic+ Droptimizer / QE Live, itemy jako plně upgradnuté Myth 6/6) a upgrady uvidíš na stránce Simy. Když před <code>/simc</code> otevřeš <b>Great Vault</b>, uvidíš tam i porovnání vaultu s raidem.</p>\
<textarea id="simc" placeholder="Sem vlož SimC string (Ctrl+V)…" spellcheck="false" autofocus></textarea>\
<div id="detected"></div>\
<button id="send">Odeslat</button>\
<div id="status"></div>\
<div class="how"><b>Jak získat SimC string</b>\
<ol><li>Nainstaluj addon <b>SimulationCraft</b> (CurseForge / Wago).</li>\
<li>Otevři <b>Great Vault</b> (klikni na truhlu v hlavním městě) – export pak obsahuje i itemy, které ti vault nabízí.</li>\
<li>Ve hře na postavě, se kterou raiduješ (v raidovém gearu), napiš <code>/simc</code>.</li>\
<li>V okně, které se otevře: <code>Ctrl+A</code>, <code>Ctrl+C</code> – a sem <code>Ctrl+V</code>.</li>\
<li>Po výměně gearu pošli nový string – starý nevyřízený se automaticky nahradí.</li></ol></div>\
</div>\
<script>\
var $ = function (id) { return document.getElementById(id); };\
function show(ok, msg) { var s = $("status"); s.className = ok ? "ok" : "err"; s.textContent = msg; }\
$("simc").addEventListener("input", function () {\
  var m = /^(deathknight|demonhunter|druid|evoker|hunter|mage|monk|paladin|priest|rogue|shaman|warlock|warrior)="([^"\\n]+)"/mi.exec(this.value);\
  var sp = /^spec=([a-z_]+)/mi.exec(this.value);\
  var d = $("detected");\
  if (!m) { d.textContent = this.value.trim() ? "⚠ Nevypadá to jako export z /simc." : ""; return; }\
  var vb = /###\\s*Weekly Reward Choices([\\s\\S]*?)(?:###\\s*End of Weekly Reward Choices|$)/i.exec(this.value);\
  var vn = vb ? (vb[1].match(/^\\s*#?\\s*[a-z_0-9]+=,?id=\\d+/gmi) || []).length : -1;\
  d.innerHTML = "Postava: <b>" + m[2].replace(/[<>&]/g, "") + "</b>" + (sp ? " · " + sp[1] : "") + " · " + m[1] +\
    (vn < 0 ? " · <span style=\\"color:#f0857a\\">bez vaultu</span> (otevři Great Vault a udělej /simc znovu)" : " · vault: " + vn + " itemů");\
});\
$("send").addEventListener("click", function () {\
  if (!$("simc").value.trim()) return show(false, "⚠ Vlož SimC string.");\
  $("send").disabled = true; show(true, "⏳ Odesílám…");\
  google.script.run.withSuccessHandler(function (res) {\
    $("send").disabled = false; show(res.ok, res.message);\
    if (res.ok) { $("simc").value = ""; $("detected").textContent = ""; }\
  }).withFailureHandler(function (err) {\
    $("send").disabled = false; show(false, "⚠ Chyba spojení: " + err.message);\
  }).submitSimWeb({ simc: $("simc").value });\
});\
</script></body></html>';

/* ---------- JSON API pro lokální sim_runner.py (…/exec?p=simapi) ----------
 *
 * Roster/sim_runner.py (Playwright) si stáhne čekající řádky, pro každý na
 * Raidbots spustí Droptimizer a hotový report nahlásí zpět; upload do
 * wowaudit dělá stejná funkce jako dialog. Přístup chrání token ve Script
 * Properties (menu Simy → Token pro sim_runner.py…). Volání:
 *   ?p=simapi&token=…&action=queue                      → { ok, rows:[{row, character, spec, simc, id, status, report_raid, report_mplus,
 *                                                                        report_topgear, report_raidhc, vault}] }
 *   ?p=simapi&token=…&action=running&row=N&character=…&url=…&kind=raid|mplus|topgear|raidhc|qe → stav 🔄 (odkaz do Poznámky)
 *   ?p=simapi&token=…&action=done&row=N&character=…&url=…&kind=raid|mplus|topgear|raidhc|qe    → výsledky do "Sim výsledky" (+ wowaudit u raidu);
 *                                                        řádek je ✅, až když má raidový, M+ a Top Gear report, u vaultu i HC raid (QE = vše)
 *   ?p=simapi&token=…&action=error&row=N&character=…&note=…    → stav ⚠ + poznámka
 *   ?p=simapi&token=…&action=note&row=N&character=…&note=…     → jen poznámka (stav se nemění)
 *   ?p=simapi&token=…&action=notified&row=N&character=…&result=… → výsledek Discord zprávy poslané runnerem (do poznámky)
 *   POST {p:"simapi", token, action:"rooms", guild, me, channels:[…Discord API /guilds/{id}/channels…]}
 *                                                        → naplní list "Discord" (místnosti hráčů; Discord blokuje bot API z Google)
 * `done` vrací i `notify: {channelId, userId, text}` když má runner poslat Discord zprávu přes bota.
 * `character` slouží jako kontrola, že se řádky mezitím neposunuly.
 */

var SIM_API_TOKEN_PROP = "SIM_API_TOKEN";

/** Jednorázově: vygeneruje (nebo ukáže) token a URL pro sim_runner.py. */
function setSimApiToken() {
  var ui = SpreadsheetApp.getUi();
  var props = PropertiesService.getScriptProperties();
  var token = props.getProperty(SIM_API_TOKEN_PROP);
  if (!token) {
    token = Utilities.getUuid().replace(/-/g, "") + Utilities.getUuid().replace(/-/g, "");
    props.setProperty(SIM_API_TOKEN_PROP, token);
  }
  ui.alert("Token pro sim_runner.py",
    "Spusť v Roster/:  python sim_runner.py setup\n\n" +
    "Web app URL: použij stejnou adresu …/exec, na které hráči mají formulář absence / simu " +
    "(Apps Script → Nasadit → Spravovat nasazení → webová aplikace). " +
    "ScriptApp.getService().getUrl() z menu vrací jiné ID, které nefunguje.\n\nToken:\n" + token +
    "\n\n(Token je uložený ve Script Properties – smazáním property SIM_API_TOKEN se vygeneruje nový.)",
    ui.ButtonSet.OK);
}

function simApiJson_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function simApi_(e) {
  var q = (e && e.parameter) || {};
  try {
    var token = PropertiesService.getScriptProperties().getProperty(SIM_API_TOKEN_PROP);
    if (!token || String(q.token || "") !== token) return simApiJson_({ ok: false, error: "bad token" });
    var sh = simSheet_();
    if (!sh) return simApiJson_({ ok: false, error: "List „" + SIM_SHEET_NAME + "“ neexistuje." });
    var action = String(q.action || "");
    if (action === "queue") return simApiJson_({ ok: true, rows: simApiQueue_(sh) });
    if (action === "notify_test") {
      // runner (task discord-test) si vyzvedne testovací zprávu pro postavu a pošle ji botem
      var ch = String(q.character || "").trim();
      if (!ch) return simApiJson_({ ok: false, error: "chybí character" });
      var t = notifySimDone_(ch, "", { test: true, viaRunner: true });
      return simApiJson_({ ok: true, note: t.note, notify: t.pending, target: discordTargetFor_(ch) });
    }

    var row = Number(q.row);
    if (!(row >= 2)) return simApiJson_({ ok: false, error: "chybí row" });
    var vals = sh.getRange(row, 1, 1, SIM_HEADER.length).getValues()[0];
    var character = String(vals[SIM_COL.character - 1] || "");
    if (q.character !== undefined && simNameKey_(q.character) !== simNameKey_(character)) {
      return simApiJson_({ ok: false, error: "řádek " + row + " je teď „" + character + "“, ne „" + q.character + "“ – fronta se posunula, načti ji znovu" });
    }
    var lock = LockService.getScriptLock();
    try { lock.waitLock(20000); } catch (err) { return simApiJson_({ ok: false, error: "lock timeout" }); }
    try {
      var kind = String(q.kind || "raid");
      if (action === "running") {
        var seg = (SIM_KIND_LABEL[kind] || kind) + " 🔄 " + String(q.url || "") + " (" +
          Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "d.M. H:mm") + ")";
        setSimStatus_(sh, row, SIM_STATUS.running, mergeSimNote_(vals[SIM_COL.note - 1], kind, seg));
        return simApiJson_({ ok: true });
      }
      if (action === "done" && kind === "topgear-skip") {
        // Top Gear nemá kandidáty (nic není upgrade) – sloupec vyplnit, aby byl řádek kompletní
        sh.getRange(row, SIM_COL.reportTopgear).setValue(SIM_TOPGEAR_SKIP);
        var doneNow = simRowComplete_(sh, row);
        var skipNote = mergeSimNote_(vals[SIM_COL.note - 1], "topgear", "Top Gear přeskočen: nic není upgrade");
        var pending2 = null;
        if (doneNow && String(vals[SIM_COL.status - 1] || "").indexOf("✅") !== 0) {
          var dn2 = notifySimDone_(character, String(vals[SIM_COL.spec - 1] || ""), { viaRunner: true });
          if (dn2.note) skipNote += " | " + dn2.note;
          pending2 = dn2.pending;
        }
        setSimStatus_(sh, row, doneNow ? SIM_STATUS.done : SIM_STATUS.running, skipNote);
        return simApiJson_({ ok: true, message: "Top Gear přeskočen", complete: doneNow, notify: pending2 });
      }
      if (action === "done") {
        var r = uploadSimReport_(sh, row, String(q.url || ""), kind, { viaRunner: true });
        return simApiJson_({ ok: r.ok, message: r.message, complete: r.complete, notify: r.notify || null });
      }
      if (action === "error") { setSimStatus_(sh, row, SIM_STATUS.error, String(q.note || "sim_runner: chyba")); return simApiJson_({ ok: true }); }
      if (action === "notified") {
        // runner poslal (nebo nedokázal poslat) Discord zprávu – nahradit "⏳" v poznámce výsledkem
        var cur = String(sh.getRange(row, SIM_COL.note).getValue() || ""), resTxt = String(q.result || "Discord ✔ (bot)").slice(0, 160);
        sh.getRange(row, SIM_COL.note).setValue(cur.indexOf(DISCORD_PENDING_NOTE) >= 0 ? cur.replace(DISCORD_PENDING_NOTE, resTxt) : (cur ? cur + " | " : "") + resTxt);
        return simApiJson_({ ok: true });
      }
      if (action === "note") { sh.getRange(row, SIM_COL.note).setValue(String(q.note || "")); return simApiJson_({ ok: true }); }
      return simApiJson_({ ok: false, error: "neznámá action " + action });
    } finally { lock.releaseLock(); }
  } catch (err) {
    return simApiJson_({ ok: false, error: String(err && err.message || err) });
  }
}

/**
 * Čekající řádky včetně SimC stringu (+ rozběhnuté, kdyby runner spadl,
 * + chybové, kde chybu zapsal sám sim_runner – ty zkusí znovu).
 */
function simApiQueue_(sh) {
  var last = sh.getLastRow();
  var out = [];
  if (last < 2) return out;
  var vals = sh.getRange(2, 1, last - 1, SIM_HEADER.length).getValues();
  vals.forEach(function (v, i) {
    var status = String(v[SIM_COL.status - 1]);
    var note = String(v[SIM_COL.note - 1] || "");
    var runnerError = status === SIM_STATUS.error && /^sim_runner:/.test(note);
    if (status !== SIM_STATUS.pending && status !== SIM_STATUS.running && !runnerError) return;
    out.push({
      row: i + 2,
      character: String(v[SIM_COL.character - 1]),
      spec: String(v[SIM_COL.spec - 1]),
      simc: String(v[SIM_COL.simc - 1] || ""),
      id: Number(v[SIM_COL.id - 1]) || 0,
      status: status,
      note: String(v[SIM_COL.note - 1] || ""),
      report_raid: parseReportLink_(v[SIM_COL.report - 1]) ? String(v[SIM_COL.report - 1]) : "",
      report_mplus: parseReportLink_(v[SIM_COL.reportMplus - 1]) ? String(v[SIM_COL.reportMplus - 1]) : "",
      report_topgear: String(v[SIM_COL.reportTopgear - 1] || "").trim(),
      report_raidhc: parseReportLink_(v[SIM_COL.reportRaidhc - 1]) ? String(v[SIM_COL.reportRaidhc - 1]) : "",
      vault: String(v[SIM_COL.vault - 1] || "").trim()   // neprázdné = postava má Great Vault → runner pustí i HC raid sim
    });
  });
  return out;
}

/**
 * Poznámka řádku fronty drží segmenty oddělené " | ", každý začíná labelem
 * druhu simu ("raid …", "M+ …"). Nový segment nahradí starý segment téhož druhu
 * (kind "qe" nahradí oba) a odstraní "čeká na …".
 */
function mergeSimNote_(oldNote, kind, seg) {
  var labels = kind === "qe" ? ["raid", "M+", "Top Gear"] : [SIM_KIND_LABEL[kind] || kind];
  var keep = String(oldNote || "").split(" | ").filter(function (n) {
    n = n.trim();
    if (!n || /^čeká na /.test(n) || /^sim_runner:/.test(n) || /^⚠/.test(n)) return false;
    return !labels.some(function (l) { return n.indexOf(l + " ") === 0; });
  });
  keep.push(seg);
  return keep.join(" | ");
}

// ================== SIM VÝSLEDKY (Raidbots / QE Live report -> list "Sim výsledky") ==================
//
// Po zpracování reportu (dialog, onEdit trigger i sim_runner přes uploadSimReport_)
// se stáhne veřejný JSON reportu a itemy z raidu / Mythic+ dungeonů se zapíšou
// do listu "Sim výsledky" – jeden řádek na item, sloupec "Původ" = Raid | M+.
// Starší řádky té samé postavy a téhož původu se smažou (platí vždy poslední
// sim). Stránka loot.html na GitHub Pages čte tenhle list přes gviz CSV, takže
// je vždy aktuální bez dalšího publikování.
//
// Raidbots: https://www.raidbots.com/reports/<id>/data.json – profilesety
//   "instance/encounter/raid-mythic/itemId/ilvl/enchant/slot////" + mean DPS,
//   základ = players[0].collected_data.dps.mean, názvy z simbot.meta.itemLibrary.
//   Třetí část jména začíná "raid…" u raidu; cokoli jiného bereme jako M+ dungeon
//   (Boss ID = instance z první části, Boss = název dungeonu z instanceLibrary).
// QE Live: https://questionablyepic.com/api/getUpgradeReport.php?reportID=<id>
//   (JSON zabalený ve stringu) – results[] {item, dropLoc, dropType, level,
//   rawDiff, percDiff}; raid = dropLoc "Raid" + dropType "max" (334 = Myth 6/6),
//   dungeon = dropLoc "Dungeon", nejvyšší ilvl varianta (dropType "bonus" = 334;
//   "max" je jen Hero 6/6 = 321). Boss/název u QE itemů doplní stránka z loot_items.json.

var SIM_RESULTS_SHEET_NAME = "Sim výsledky";
var SIM_RESULTS_HEADER = ["Postava", "Spec", "Zdroj", "Report", "Čas", "Boss ID", "Boss", "Item ID", "Item",
                          "Slot", "ilvl", "Základ", "S itemem", "Rozdíl", "Rozdíl %", "Původ", "Katalyzátor ID", "Katalyzátor z",
                          "ilvl postavy",    // 19: průměrný ilvl nasazeného gearu z reportu (stránka Simy: „Akka (321)“)
                          "Stav"];           // 20: "nasazeno" = item, který Raidbots nesimoval, protože ho hráč už má (nebo lepší);
                                             //     jen u HC raid reportu – bonus roll ho může dát (zisk 0), stránka s ním počítá
var SIM_RESULTS_ORIGIN_COL = 16;
// Katalyzátor: Raidbots simuluje i set kusy vyrobené katalyzátorem z ne-setového itemu jiného bosse
// (profileset "…/legs////268225" – poslední pole = ID zdrojového itemu). Takový kus má ID set itemu,
// ale sekundární staty zdrojového itemu → je to jiný item než set kus, který padá ze set bosse.
// Sloupce 17/18 = ID a název zdrojového (padajícího) itemu; prázdné = normální drop.
var SIM_RESULTS_CATALYST_COL = 17;
var SIM_RESULTS_WORN = "nasazeno";   // sloupec 20 "Stav" u itemů, které hráč už má (Raidbots je nesimuje)
// Raidbots inventoryType → slot v SimC řeči (pro nesimované itemy, které nemají profileset)
var RAIDBOTS_INV_SLOT = { 1: "head", 2: "neck", 3: "shoulder", 5: "chest", 20: "chest", 6: "waist", 7: "legs", 8: "feet", 9: "wrist",
                          10: "hands", 11: "finger", 12: "trinket", 13: "one_hand", 14: "off_hand", 15: "back", 16: "back", 17: "two_hand",
                          21: "main_hand", 22: "off_hand", 23: "off_hand", 26: "ranged" };

function simResultsSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(SIM_RESULTS_SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(SIM_RESULTS_SHEET_NAME);
    sh.getRange(1, 1, 1, SIM_RESULTS_HEADER.length).setValues([SIM_RESULTS_HEADER]).setFontWeight("bold");
    sh.setFrozenRows(1);
  } else {
    // starší list bez sloupců "Původ" (prázdný = Raid) / "Katalyzátor …" – doplnit hlavičky
    for (var c = SIM_RESULTS_ORIGIN_COL; c <= SIM_RESULTS_HEADER.length; c++) {
      if (String(sh.getRange(1, c).getValue()) !== SIM_RESULTS_HEADER[c - 1]) sh.getRange(1, c).setValue(SIM_RESULTS_HEADER[c - 1]).setFontWeight("bold");
    }
  }
  return sh;
}

/** Hodnota sloupce "Původ" → kind (prázdná = raid, kvůli starším řádkům). */
function originKind_(v) {
  v = String(v || "");
  return v === SIM_KIND_ORIGIN.mplus ? "mplus" : (v === SIM_KIND_ORIGIN.topgear ? "topgear" : (v === SIM_KIND_ORIGIN.raidhc ? "raidhc" : "raid"));
}

/**
 * Raidbots Top Gear report → jeden souhrnný řádek: nejlepší kombinace ("Combo N") vs. základ.
 * Itemy kombinace jsou v simbot.input jako `profileset."Combo N"+=slot=,id=…`; za "změnu"
 * bereme řádky, které se liší od nasazeného gearu v hlavičce inputu. Názvy: Top Gear report
 * nemá itemLibrary, tak je bereme z řádků postavy v listu "Sim výsledky" (raid / M+).
 * Item ID = ID oddělená "|", Item = názvy " + ", Slot = počet vyměněných itemů.
 */
function simResultsFromTopgear_(reportId, character) {
  var resp = UrlFetchApp.fetch("https://www.raidbots.com/reports/" + reportId + "/data.json", { muteHttpExceptions: true });
  if (resp.getResponseCode() !== 200) throw new Error("Raidbots data.json HTTP " + resp.getResponseCode());
  var d = JSON.parse(resp.getContentText());
  var sim = d.sim || {};
  var base = Number(((((sim.players || [])[0] || {}).collected_data || {}).dps || {}).mean);
  if (!base) throw new Error("v reportu chybí základní DPS");
  var results = ((sim.profilesets || {}).results) || [];
  var best = null;
  results.forEach(function (r) { if (!best || Number(r.mean) > Number(best.mean)) best = r; });
  if (!best) return [];
  // POZOR: data.json má v simbot.input jen první chunk profilesetů – kompletní vstup je v input.txt
  var input = String((d.simbot || {}).input || "");
  try {
    var ti = UrlFetchApp.fetch("https://www.raidbots.com/reports/" + reportId + "/input.txt", { muteHttpExceptions: true });
    if (ti.getResponseCode() === 200 && ti.getContentText().indexOf("profileset.") >= 0) input = ti.getContentText();
  } catch (err) { /* zůstane simbot.input */ }
  // nasazený gear: řádky `slot=,id=…` v hlavičce (před prvním profilesetem)
  var equipped = {};
  input.split("\n").forEach(function (l) {
    if (/^profileset\./.test(l)) return;
    var m = /^([a-z_0-9]+)=,(id=.*)$/i.exec(l.trim());
    if (m) equipped[m[1].toLowerCase()] = m[2];
  });
  var changed = [];
  var re = /^profileset\."([^"]+)"\+?=(.*)$/gm, m;
  while ((m = re.exec(input)) !== null) {
    if (m[1] !== best.name) continue;
    var it = /^([a-z_0-9]+)=,(id=(\d+).*)$/i.exec(m[2].trim());
    if (!it) continue;
    if (equipped[it[1].toLowerCase()] === it[2]) continue;   // stejný kus jako nasazený
    changed.push({ slot: it[1].toLowerCase(), id: Number(it[3]) });
  }
  // názvy z řádků postavy v listu "Sim výsledky"
  var names = {};
  try {
    var sh = simResultsSheet_();
    var last = sh.getLastRow();
    if (last >= 2) {
      var data = sh.getRange(2, 1, last - 1, 9).getValues();
      var key = simNameKey_(character);
      data.forEach(function (v) { if (simNameKey_(v[0]) === key && v[7] && v[8]) names[String(v[7])] = String(v[8]); });
    }
  } catch (err) { /* jen názvy */ }
  var mean = Number(best.mean);
  return [{
    kind: "topgear", bossId: "", boss: "Top Gear",
    itemId: changed.map(function (c) { return c.id; }).join("|"),
    item: changed.map(function (c) { return names[String(c.id)] || ("#" + c.id); }).join(" + "),
    slot: changed.length, ilvl: "", charIlvl: equippedIlvl_(d),
    base: Math.round(base), value: Math.round(mean),
    diff: Math.round(mean - base), pct: Math.round((mean - base) / base * 10000) / 100
  }];
}

/** Menu: založí list (idempotentní). */
function buildSimResultsSheet() {
  simResultsSheet_();
  SpreadsheetApp.getUi().alert("List „" + SIM_RESULTS_SHEET_NAME + "“ je připravený.");
}

/**
 * Stáhne report a zapíše výsledky postavy pro dané druhy (kinds = ["raid"],
 * ["mplus"] nebo oba). Vrací { ok, count, message }. Nikdy nehází – volá se po
 * úspěšném simu a nesmí ho „zkazit“.
 */
function storeSimResults_(character, spec, link, kinds) {
  try {
    kinds = kinds && kinds.length ? kinds : ["raid"];
    // HC raid: i itemy, které Raidbots nesimoval, protože je hráč už má (bonus roll je může dát → zisk 0)
    var rows = (kinds.indexOf("topgear") >= 0 ? simResultsFromTopgear_(link.id, character)
                : link.kind === "qe" ? simResultsFromQe_(link.id) : simResultsFromRaidbots_(link.id, kinds.indexOf("raidhc") >= 0));
    // HC raid report je stejný raidový Droptimizer (jen obtížnost "Heroic Vault"), parser ho vrátí jako "raid"
    if (kinds.indexOf("raidhc") >= 0) rows.forEach(function (r) { if (r.kind === "raid") r.kind = "raidhc"; });
    rows = rows.filter(function (r) { return kinds.indexOf(r.kind) >= 0; });
    var sh = simResultsSheet_();
    var now = new Date();
    var counts = {};
    var out = rows.map(function (r) {
      if (!r.worn) counts[r.kind] = (counts[r.kind] || 0) + 1;
      return [character, spec, link.kind === "qe" ? "QE Live" : "Raidbots", link.url, now,
              r.bossId, r.boss, r.itemId, r.item, r.slot, r.ilvl, r.base, r.value, r.diff, r.pct, SIM_KIND_ORIGIN[r.kind],
              r.catalystId || "", r.catalystFrom || "", r.charIlvl || "", r.worn ? SIM_RESULTS_WORN : ""];
    });
    // smazat staré řádky postavy téhož původu (odspodu, aby se neposouvaly indexy)
    var last = sh.getLastRow();
    if (last >= 2) {
      var data = sh.getRange(2, 1, last - 1, SIM_RESULTS_ORIGIN_COL).getValues();
      var key = simNameKey_(character);
      for (var i = data.length - 1; i >= 0; i--) {
        if (simNameKey_(data[i][0]) === key && kinds.indexOf(originKind_(data[i][SIM_RESULTS_ORIGIN_COL - 1])) >= 0) sh.deleteRow(i + 2);
      }
    }
    if (out.length) {
      var start = sh.getLastRow() + 1;
      sh.getRange(start, 1, out.length, SIM_RESULTS_HEADER.length).setValues(out);
      sh.getRange(start, 5, out.length, 1).setNumberFormat("d.M.yyyy H:mm");
      sh.getRange(start, 12, out.length, 3).setNumberFormat("0");
      sh.getRange(start, 15, out.length, 1).setNumberFormat("0.00");
    }
    var msg = kinds.map(function (k) {
      if (k === "topgear") return rows.length ? "Top Gear " + (rows[0].pct > 0 ? "+" : "") + rows[0].pct + " % (" + rows[0].slot + " itemů)" : "Top Gear bez výsledku";
      return SIM_KIND_LABEL[k] + " " + (counts[k] || 0) + " itemů";
    }).join(", ");
    return { ok: true, count: out.length, message: msg };
  } catch (err) {
    return { ok: false, count: 0, message: String(err && err.message || err) };
  }
}

/**
 * includeWorn: přidá i itemy z simbot.meta.encounterItems (loot bossů pro classu/spec hráče), které
 * nemají žádný profileset – Raidbots je nesimuje s hláškou "You are already wearing this item or a
 * better version". Bonus roll je ale dát může (zisk 0), tak s nimi stránka počítá v očekávaném zisku.
 * Set kusy jsou v encounterItems pod encounterId -100 (set jako celek) → Boss ID prázdné, bossy doplní
 * stránka z loot_items.json.
 */
function simResultsFromRaidbots_(reportId, includeWorn) {
  var resp = UrlFetchApp.fetch("https://www.raidbots.com/reports/" + reportId + "/data.json", { muteHttpExceptions: true });
  if (resp.getResponseCode() !== 200) throw new Error("Raidbots data.json HTTP " + resp.getResponseCode());
  var d = JSON.parse(resp.getContentText());
  var sim = d.sim || {};
  var base = Number(((((sim.players || [])[0] || {}).collected_data || {}).dps || {}).mean);
  if (!base) throw new Error("v reportu chybí základní DPS");
  // itemLibrary má jeden záznam na item A ZDROJ: set kus je tam vícekrát (token z každého set bosse
  // + katalyzátorové verze z ne-setových itemů, tags ["catalyst"], sourceItem = zdrojový item).
  // Proto klíčujeme id + encounter (+ zdrojový item u katalyzátoru); samotné id je jen záloha.
  var lib = {}, libAny = {};
  (((d.simbot || {}).meta || {}).itemLibrary || []).forEach(function (it) {
    if (!it || it.id == null) return;
    var id = String(it.id);
    var cat = isCatalystItem_(it) ? String((it.sourceItem || {}).id || "") : "";
    lib[id + "/" + String(it.encounterId) + "/" + cat] = it;
    if (!lib[id + "//" + cat]) lib[id + "//" + cat] = it;
    if (!libAny[id]) libAny[id] = it;
  });
  var bosses = {}, instances = {};
  (((d.simbot || {}).meta || {}).instanceLibrary || []).forEach(function (inst) {
    if (inst && inst.id != null) instances[String(inst.id)] = inst.name || "";
    (inst.encounters || []).forEach(function (e) { bosses[String(e.id)] = e.name; });
  });
  var best = {};
  (((sim.profilesets || {}).results) || []).forEach(function (r) {
    // instance/encounter/obtížnost/itemId/ilvl/enchant/slot/…/…/…/zdrojový item katalyzátoru
    var p = String(r.name || "").split("/");
    if (p.length < 7) return;
    var kind = p[2].indexOf("raid") === 0 ? "raid" : "mplus";
    var itemId = p[3];
    var catalystId = p.length > 10 && /^\d+$/.test(p[10]) ? p[10] : "";
    var mean = Number(r.mean);
    var encId = Number(p[1]), instId = Number(p[0]);
    var it = lib[itemId + "/" + p[1] + "/" + catalystId] || lib[itemId + "//" + catalystId] || libAny[itemId] || {};
    var srcItem = it.sourceItem || {};
    if (catalystId && String(srcItem.id || "") !== catalystId) srcItem = libAny[catalystId] || {};
    // raid: jeden řádek na item, bosse a (u katalyzátoru) zdrojový item;
    // M+: jeden řádek na item a dungeon (Boss ID = instance) – v M+ se stejně dělá celý dungeon;
    // prsteny/trinkety jsou v obou slotech – necháme lepší
    // M+ profilesety mají instance -1 ("Mythic+ Dungeons") – konkrétní dungeon je v itemu:
    // sources[].instanceId (> 0) nebo encounter.name (Raidbots tam dává název dungeonu)
    if (kind === "mplus" && !(instId > 0)) {
      var src = (it.sources || []).filter(function (x) { return x && x.instanceId > 0 && instances[String(x.instanceId)]; })[0];
      if (src) instId = Number(src.instanceId);
    }
    var bossId = kind === "raid" ? encId : instId;
    var key = kind + "/" + itemId + "/" + bossId + "/" + catalystId;
    if (best[key] && best[key].value >= mean) return;
    // název bosse podle profilesetu (encounter z názvu), teprve pak z itemu – záznam itemu může
    // patřit jinému zdroji téhož set kusu
    var boss = kind === "raid"
      ? (bosses[String(encId)] || (encId === -97 ? "Trash" : "") || (it.encounter && it.encounter.name) || "")
      : ((instId > 0 && instances[String(instId)]) || (it.encounter && it.encounter.name) || (it.instance && it.instance.name) || instances[String(instId)] || "");
    best[key] = {
      kind: kind, bossId: bossId, boss: boss,
      itemId: Number(itemId), item: it.name || "", slot: p[6].replace(/[12]$/, ""),
      ilvl: Number(it.itemLevel) || Number(p[4]) || "",   // itemLibrary má ilvl včetně zvoleného upgradu
      base: Math.round(base), value: Math.round(mean),
      diff: Math.round(mean - base), pct: Math.round((mean - base) / base * 10000) / 100,
      catalystId: catalystId ? Number(catalystId) : "", catalystFrom: catalystId ? (srcItem.name || "") : ""
    };
  });
  var charIlvl = equippedIlvl_(d);
  var out = Object.keys(best).map(function (k) { best[k].charIlvl = charIlvl; return best[k]; })
    .sort(function (a, b) { return b.pct - a.pct; });
  if (includeWorn) {
    var simmed = {}, maxIlvl = 0;
    (((sim.profilesets || {}).results) || []).forEach(function (r) {
      var p = String(r.name || "").split("/");
      if (p.length < 7) return;
      simmed[p[3] + "/" + p[1]] = true;
      // set kus (encounterItems ho vede pod -100): za nasimovaný platí jen přímý drop (token/curio),
      // katalyzátorové varianty (poslední pole = zdrojový item) jsou jiné itemy z jiných bossů
      if (!(p.length > 10 && /^\d+$/.test(p[10]))) simmed[p[3] + "/-100"] = true;
      maxIlvl = Math.max(maxIlvl, Number(p[4]) || 0);
    });
    (((d.simbot || {}).meta || {}).encounterItems || []).forEach(function (it) {
      if (!it || it.id == null) return;
      (it.sources || []).forEach(function (src) {
        var encId = Number(src.encounterId);
        if (simmed[String(it.id) + "/" + encId]) return;
        out.push({
          kind: "raid", bossId: encId > 0 ? encId : "", boss: encId > 0 ? (bosses[String(encId)] || "") : "",
          itemId: Number(it.id), item: it.name || "", slot: RAIDBOTS_INV_SLOT[Number(it.inventoryType)] || "",
          ilvl: maxIlvl || "", base: Math.round(base), value: Math.round(base), diff: 0, pct: 0,
          catalystId: "", catalystFrom: "", charIlvl: charIlvl, worn: true
        });
      });
    });
  }
  return out;
}

/**
 * Průměrný ilvl nasazeného gearu z Raidbots data.json (sim.players[0].gear[slot].ilevel).
 * Jako ve hře: 16 slotů, dvouruční zbraň (main_hand bez off_hand) se počítá dvakrát. "" když gear chybí.
 */
function equippedIlvl_(d) {
  var gear = ((((d || {}).sim || {}).players || [])[0] || {}).gear || {};
  var sum = 0, n = 0, hasOff = false;
  Object.keys(gear).forEach(function (slot) {
    var il = Number((gear[slot] || {}).ilevel);
    if (!(il > 0)) return;
    if (slot === "off_hand") hasOff = true;
    if (slot === "shirt" || slot === "tabard") return;
    sum += il; n++;
  });
  if (!hasOff && gear.main_hand && Number(gear.main_hand.ilevel) > 0) { sum += Number(gear.main_hand.ilevel); n++; }
  return n ? Math.round(sum / n * 10) / 10 : "";
}

/** Záznam itemLibrary je katalyzátorová verze (tags ["catalyst"], příp. redirected_base_stats). */
function isCatalystItem_(it) {
  var tags = it.tags || [];
  for (var i = 0; i < tags.length; i++) if (String(tags[i]).toLowerCase() === "catalyst") return true;
  return !!(it.redirected_base_stats && it.sourceItem && it.sourceItem.id && !it.fromToken);
}

function simResultsFromQe_(reportId) {
  var resp = UrlFetchApp.fetch("https://questionablyepic.com/api/getUpgradeReport.php?reportID=" + encodeURIComponent(reportId), { muteHttpExceptions: true });
  if (resp.getResponseCode() !== 200) throw new Error("QE report HTTP " + resp.getResponseCode());
  var d = JSON.parse(resp.getContentText());
  if (typeof d === "string") d = JSON.parse(d);
  var results = d.results || [];
  var best = {};
  results.forEach(function (r) {
    var loc = String(r.dropLoc || "");
    var kind = loc === "Raid" ? "raid" : (/dungeon/i.test(loc) ? "mplus" : "");
    if (!kind) return;   // Delves, Crafted, PvP… ignorujeme
    var type = String(r.dropType || "drop");
    if (kind === "raid" && type !== "max") return;   // raid: plně upgradnutý item (Myth 6/6)
    var pct = Number(r.percDiff);
    var raw = Number(r.rawDiff);
    var level = Number(r.level) || 0;
    var id = kind + "/" + String(r.item);
    // dungeon: nejvyšší ilvl varianta (dropType "bonus" 334 = Myth 6/6; "max" je jen Hero 6/6)
    if (best[id] && (best[id].ilvl > level || (best[id].ilvl === level && best[id].pct >= pct))) return;
    var base = (pct && raw) ? Math.round(raw / (pct / 100)) : "";
    best[id] = {
      kind: kind, bossId: "", boss: "", itemId: Number(r.item), item: "", slot: "",
      ilvl: level || "", base: base, value: base !== "" ? base + Math.round(raw) : "",
      diff: Math.round(raw), pct: Math.round(pct * 100) / 100
    };
  });
  return Object.keys(best).map(function (k) { return best[k]; })
    .sort(function (a, b) { return b.pct - a.pct; });
}

/** Menu: znovu načte výsledky ze všech ✅ řádků fronty (např. po založení listu). */
function rebuildSimResults() {
  var sh = simSheet_();
  if (!sh) { SpreadsheetApp.getUi().alert("List „" + SIM_SHEET_NAME + "“ neexistuje."); return; }
  var last = sh.getLastRow();
  var done = 0, failed = [];
  if (last >= 2) {
    var vals = sh.getRange(2, 1, last - 1, SIM_HEADER.length).getValues();
    // pro každou postavu poslední řádek, který má odkaz na report (✅ i ⚠ – např. wowaudit odmítl,
    // ale sim proběhl; i 🔄 s hotovým raidem, kde M+ ještě běží); zahozené řádky se ignorují
    var latest = {};
    vals.forEach(function (v, i) {
      var status = String(v[SIM_COL.status - 1]);
      if (status === SIM_STATUS.dropped || status === SIM_STATUS.pending) return;
      if (!parseReportLink_(v[SIM_COL.report - 1]) && !parseReportLink_(v[SIM_COL.reportMplus - 1]) && !parseReportLink_(v[SIM_COL.reportTopgear - 1]) && !parseReportLink_(v[SIM_COL.reportRaidhc - 1])) return;
      latest[simNameKey_(v[SIM_COL.character - 1])] = { v: v, row: i + 2, status: status };
    });
    Object.keys(latest).forEach(function (k) {
      var e = latest[k], v = e.v;
      var character = String(v[SIM_COL.character - 1]);
      var spec = String(v[SIM_COL.spec - 1]);
      var raidLink = parseReportLink_(v[SIM_COL.report - 1]);
      var mLink = parseReportLink_(v[SIM_COL.reportMplus - 1]);
      var results = [];
      var tLink = parseReportLink_(v[SIM_COL.reportTopgear - 1]);
      var hLink = parseReportLink_(v[SIM_COL.reportRaidhc - 1]);
      if (e.status.indexOf("✅") === 0) {
        if (raidLink) results.push(storeSimResults_(character, spec, raidLink, raidLink.kind === "qe" ? ["raid", "mplus"] : ["raid"]));
        if (mLink && !(raidLink && mLink.id === raidLink.id)) results.push(storeSimResults_(character, spec, mLink, ["mplus"]));
        if (tLink && tLink.kind === "raidbots") results.push(storeSimResults_(character, spec, tLink, ["topgear"]));
        if (hLink && hLink.kind === "raidbots") results.push(storeSimResults_(character, spec, hLink, ["raidhc"]));
      } else {
        // opraví i stav řádku
        var quiet = { notify: false };
        if (raidLink) results.push(uploadSimReport_(sh, e.row, raidLink.url, "raid", quiet));
        if (mLink && !(raidLink && mLink.id === raidLink.id)) results.push(uploadSimReport_(sh, e.row, mLink.url, "mplus", quiet));
        if (tLink && tLink.kind === "raidbots") results.push(uploadSimReport_(sh, e.row, tLink.url, "topgear", quiet));
        if (hLink && hLink.kind === "raidbots") results.push(uploadSimReport_(sh, e.row, hLink.url, "raidhc", quiet));
      }
      var bad = results.filter(function (r) { return !r.ok; });
      if (!bad.length) done++; else failed.push(character + " (" + bad.map(function (r) { return r.message; }).join("; ") + ")");
    });
  }
  SpreadsheetApp.getUi().alert("Výsledky načteny pro " + done + " postav." + (failed.length ? "\nSelhalo: " + failed.join(", ") : ""));
}

// ================== VAULT (Great Vault ze SimC exportu -> list "Vault") ==================
//
// Když hráč před /simc otevře Great Vault, addon přidá do exportu blok "Weekly
// Reward Choices" (viz parseVault_). Odeslání formuláře ho uloží sem – jeden
// řádek na nabízený item. Stránka Simy si itemy spáruje podle Item ID
// s výsledky raidového a M+ Droptimizeru (stejné ilvl Myth 6/6) a u každého
// hráče ukáže, jestli je lepší vzít vault, nebo si nechat bonus roll na raid.
// Itemy z delvů / worldu (nejsou v žádném Droptimizeru) stránka ignoruje.
// Bez bloku ve stringu se starý vault postavy nechává (stránka hlídá týdenní reset).

var VAULT_SHEET_NAME = "Vault";
var VAULT_HEADER = ["Postava", "Čas", "Item ID", "Item", "Slot", "ilvl", "Bonus ID"];

function vaultSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(VAULT_SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(VAULT_SHEET_NAME);
    sh.getRange(1, 1, 1, VAULT_HEADER.length).setValues([VAULT_HEADER]).setFontWeight("bold");
    sh.setFrozenRows(1);
  }
  return sh;
}

/** Menu: založí list (idempotentní). */
function buildVaultSheet() {
  vaultSheet_();
  SpreadsheetApp.getUi().alert("List „" + VAULT_SHEET_NAME + "“ je připravený.");
}

/** Přepíše vault postavy (items = pole z parseVault_). Prázdné pole = vault otevřený, ale nic nenabízí. */
function storeVault_(character, items) {
  var sh = vaultSheet_();
  var last = sh.getLastRow();
  if (last >= 2) {
    var names = sh.getRange(2, 1, last - 1, 1).getValues();
    var key = simNameKey_(character);
    for (var i = names.length - 1; i >= 0; i--) {
      if (simNameKey_(names[i][0]) === key) sh.deleteRow(i + 2);
    }
  }
  if (!items || !items.length) return 0;
  var now = new Date();
  var out = items.map(function (v) { return [character, now, v.id, v.name || "", v.slot || "", v.ilvl || "", v.bonus || ""]; });
  var start = sh.getLastRow() + 1;
  sh.getRange(start, 1, out.length, VAULT_HEADER.length).setValues(out);
  sh.getRange(start, 2, out.length, 1).setNumberFormat("d.M.yyyy H:mm");
  return out.length;
}

// ================== CRESTY (měny ze SimC exportu -> list "Cresty") ==================
//
// Addon SimulationCraft přidá do exportu řádek
//   # upgrade_currencies=c:3442:274/c:3443:430/c:3444:140/c:3445:80/c:3446:210/i:232875:15/...
// (c:<currency id>:<počet> = měna, i:<item id>:<počet> = předmět). Měny 3442–3446
// jsou cresty aktuální sezóny (Adventurer/Veteran/Champion/Hero/Myth Mistcrest).
// Odeslání formuláře uloží počty sem – jeden řádek na postavu (přepisuje se).
// Stránka Simy z toho ukazuje u hráče Myth cresty proti sezónnímu capu.
// Navíc se sem ukládá server + region postavy (řádky `server=` a `region=` z exportu) –
// stránka Simy z nich skládá odkazy na Warcraft Logs, Raider.IO a Armory.
// Addon exportuje jen aktuální stav (kolik hráč MÁ), ne kolik za sezónu získal.

// ================== DISCORD NOTIFIKACE (místnosti hráčů) ==================
//
// Každý hráč může mít na Discordu vlastní místnost. List "Discord" (menu Simy → Vytvořit list Discord):
//   Hráč | Kanál URL | Webhook URL | Discord user ID
//   - Hráč = jméno z listu Roster (sloupec "Hráč"); postavy (main i alt) se na hráče mapují přes Roster
//   - Kanál URL = odkaz na místnost (Discord → pravý klik na kanál → Kopírovat odkaz), stránka Simy z něj
//     dělá ikonu u postavy; s bot tokenem se do ní i posílá
//   - Webhook URL = webhook té místnosti (Upravit kanál → Integrace → Webhooky) – bez bota stačí tohle
//   - Discord user ID = pro @zmínku (Developer Mode → pravý klik na uživatele → Copy User ID)
// Posílání: 1) webhook místnosti, 2) bot token (Script Property DISCORD_BOT_TOKEN, bot musí mít v místnosti
// Send Messages) + channel id z Kanál URL, 3) společný webhook (Script Property DISCORD_SIM_WEBHOOK) se zmínkou.
// Zpráva odejde, když se řádek fronty PRÁVĚ stal kompletním (všechny simy hotové) – ne při přepočtu hotových.

var DISCORD_SHEET_NAME = "Discord";
var DISCORD_HEADER = ["Hráč", "Kanál URL", "Webhook URL", "Discord user ID"];
var DISCORD_BOT_TOKEN_PROP = "DISCORD_BOT_TOKEN";
var DISCORD_DEFAULT_WEBHOOK_PROP = "DISCORD_SIM_WEBHOOK";   // společný kanál: webhook URL (posílá Apps Script přímo)
var DISCORD_DEFAULT_CHANNEL_PROP = "DISCORD_SIM_CHANNEL";   // …nebo ID kanálu (posílá bot z runneru, Google je u Discordu blokovaný)

/** Společný kanál pro hráče bez místnosti: { webhook } nebo { channelId } nebo null. Snese i ID kanálu omylem uložené jako webhook. */
function discordFallback_(props) {
  var wh = String(props.getProperty(DISCORD_DEFAULT_WEBHOOK_PROP) || "").trim();
  var chId = String(props.getProperty(DISCORD_DEFAULT_CHANNEL_PROP) || "").trim();
  var m = /channels\/\d+\/(\d+)/.exec(wh) || /^(\d{15,25})$/.exec(wh);
  if (m) { chId = chId || m[1]; wh = ""; }
  if (/^https?:\/\/.+\/api\/webhooks\//.test(wh)) return { webhook: wh };
  if (/^\d{15,25}$/.test(chId)) return { channelId: chId };
  return null;
}
var SIM_NOTIFY = true;                                             // false = žádné Discord zprávy
var DISCORD_CREATE_ROOM_CHANNEL = "1544826757956247764";           // kanál s tlačítkem "Create Room" – hráčům bez místnosti se pošle odkaz
var DISCORD_NO_ROOM_HINT = "ℹ️ Nemáš vlastní místnost – vytvoř si ji tlačítkem v <#" + DISCORD_CREATE_ROOM_CHANNEL + ">, příště ti přijde zpráva přímo tam.";
var SIM_PAGE_URL = "https://vitekpoor.github.io/RaidPlan/loot.html";

function discordSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(DISCORD_SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(DISCORD_SHEET_NAME);
    sh.getRange(1, 1, 1, DISCORD_HEADER.length).setValues([DISCORD_HEADER]).setFontWeight("bold").setBackground("#24322C").setFontColor("#FFFFFF");
    sh.setFrozenRows(1);
    [140, 420, 420, 200].forEach(function (w, i) { sh.setColumnWidth(i + 1, w); });
    sh.getRange(1, 1).setNote("Jméno hráče přesně jako v listu Roster (sloupec Hráč). Postavy (main i alt) se dohledají přes Roster.");
    sh.getRange(1, 2).setNote("Odkaz na místnost hráče: Discord → pravý klik na kanál → Kopírovat odkaz (https://discord.com/channels/<server>/<kanál>). Stránka Simy z něj dělá ikonu; s bot tokenem se do ní posílají zprávy.");
    sh.getRange(1, 3).setNote("Webhook místnosti: Upravit kanál → Integrace → Webhooky → Nový webhook → Kopírovat URL. Když je vyplněný, posílá se přes něj (bot není potřeba).");
    sh.getRange(1, 4).setNote("Discord ID uživatele pro @zmínku (User Settings → Advanced → Developer Mode, pak pravý klik na uživatele → Copy User ID). Nepovinné.");
    // předvyplnit hráče z Rosteru
    try {
      var roster = getRoster_() || [];
      if (roster.length) sh.getRange(2, 1, roster.length, 1).setValues(roster.map(function (r) { return [r.player]; }));
    } catch (err) { /* roster je nepovinný */ }
  }
  return sh;
}

function buildDiscordSheet() {
  discordSheet_();
  SpreadsheetApp.getUi().alert("List „" + DISCORD_SHEET_NAME + "“ je připravený – doplň ke hráčům odkaz na místnost a webhook (nebo nastav bot token).");
}

/** Jednorázově: bot token a/nebo společný webhook do Script Properties (nikdy do kódu). */
function setDiscordSecrets() {
  var ui = SpreadsheetApp.getUi(), props = PropertiesService.getScriptProperties();
  var t = ui.prompt("Discord bot token", "Token bota (Discord Developer Portal → Bot → Reset Token). Bot musí být na serveru a mít v místnostech hráčů právo Send Messages.\nPrázdné = nechat stávající, \"-\" = smazat.", ui.ButtonSet.OK_CANCEL);
  if (t.getSelectedButton() !== ui.Button.OK) return;
  var tok = t.getResponseText().trim();
  if (tok === "-") props.deleteProperty(DISCORD_BOT_TOKEN_PROP); else if (tok) props.setProperty(DISCORD_BOT_TOKEN_PROP, tok);
  var w = ui.prompt("Společný kanál", "Kanál pro hráče bez vlastní místnosti (nepovinné): webhook URL (https://discord.com/api/webhooks/…), nebo ID / odkaz kanálu – pak posílá bot přes GitHub runner.\nPrázdné = nechat stávající, \"-\" = smazat.", ui.ButtonSet.OK_CANCEL);
  if (w.getSelectedButton() !== ui.Button.OK) return;
  var wh = w.getResponseText().trim();
  if (wh === "-") { props.deleteProperty(DISCORD_DEFAULT_WEBHOOK_PROP); props.deleteProperty(DISCORD_DEFAULT_CHANNEL_PROP); }
  else if (wh) {
    var cm = /channels\/\d+\/(\d+)/.exec(wh) || /^(\d{15,25})$/.exec(wh);
    if (cm) { props.setProperty(DISCORD_DEFAULT_CHANNEL_PROP, cm[1]); props.deleteProperty(DISCORD_DEFAULT_WEBHOOK_PROP); }
    else if (/^https?:\/\/.+\/api\/webhooks\//.test(wh)) { props.setProperty(DISCORD_DEFAULT_WEBHOOK_PROP, wh); props.deleteProperty(DISCORD_DEFAULT_CHANNEL_PROP); }
    else { ui.alert("„" + wh + "“ není ani webhook URL, ani ID/odkaz kanálu – nic se neuložilo."); return; }
  }
  var fb = discordFallback_(props);
  ui.alert("Uloženo. Bot token: " + (props.getProperty(DISCORD_BOT_TOKEN_PROP) ? "nastaven" : "–") +
    ", společný kanál: " + (fb ? (fb.webhook ? "webhook" : "kanál " + fb.channelId + " (bot přes runner)") : "–") +
    "\n\nTyhle hodnoty jsou ve Script Properties (Nastavení projektu), ne v listu Discord – ten je jen pro místnosti jednotlivých hráčů.");
}

var DISCORD_GUILD_PROP = "DISCORD_GUILD_ID";
var DISCORD_CATEGORY_PROP = "DISCORD_PLAYERS_CATEGORY";   // název kategorie s místnostmi hráčů (více názvů oddělených čárkou)
var DISCORD_CATEGORY_DEFAULT = "TVOJE ROMKA, Players";     // porovnává se bez emoji/diakritiky/mezer ("🫜 TVOJE ROMKA ⚧" = "tvojeromka")
function discordCatKey_(name) { return simNameKey_(name).replace(/[^a-z0-9]+/g, ""); }
var DISCORD_VIEW_CHANNEL = 1024;                           // permission bit VIEW_CHANNEL (1 << 10)

function discordGet_(token, path) {
  var resp = UrlFetchApp.fetch("https://discord.com/api/v10" + path, { headers: { Authorization: "Bot " + token }, muteHttpExceptions: true });
  var code = resp.getResponseCode();
  if (code < 200 || code >= 300) throw new Error("Discord API HTTP " + code + " " + resp.getContentText().slice(0, 160));
  return JSON.parse(resp.getContentText());
}

/**
 * Zapíše místnosti hráčů do listu "Discord": textové kanály v kategorii DISCORD_PLAYERS_CATEGORY (výchozí
 * "Players"), jméno místnosti se páruje se jménem hráče z Rosteru (bez diakritiky, "akka" ~ "Akka",
 * "mistnost-akka" ~ "Akka"); Discord user ID = jediný člen (type 1) s View Channel, který není bot.
 * channels = odpověď Discord API GET /guilds/{id}/channels (z Apps Scriptu nebo od sim_runneru).
 * Ručně vyplněné hodnoty (webhook, existující user ID) zůstávají. Vrací { category, matched, unmatched, noRoom }.
 */
function applyDiscordRooms_(guild, channels, meId) {
  var catName = PropertiesService.getScriptProperties().getProperty(DISCORD_CATEGORY_PROP) || DISCORD_CATEGORY_DEFAULT;
  var wanted = catName.split(",").map(discordCatKey_).filter(Boolean);
  var cats = channels.filter(function (c) {
    if (!c || c.type !== 4) return false;
    var k = discordCatKey_(c.name);
    return wanted.some(function (w) { return k === w || (w.length >= 4 && k.indexOf(w) >= 0); });
  });
  if (!cats.length) {
    throw new Error("Kategorie „" + catName + "“ na serveru není. Kategorie: " +
      channels.filter(function (c) { return c && c.type === 4; }).map(function (c) { return c.name; }).join(", ") +
      " (název lze změnit ve Script Property " + DISCORD_CATEGORY_PROP + ")");
  }
  var catIds = {}; cats.forEach(function (c) { catIds[c.id] = 1; });
  var rooms = channels.filter(function (c) { return c && (c.type === 0 || c.type === 5) && catIds[c.parent_id]; });
  var roster = getRoster_() || [];
  var sh = discordSheet_();
  var last = sh.getLastRow();
  var rowsByPlayer = {};
  if (last >= 2) sh.getRange(2, 1, last - 1, 1).getValues().forEach(function (v, i) { if (String(v[0]).trim()) rowsByPlayer[simNameKey_(v[0])] = i + 2; });
  var matched = [], unmatched = [], matchedPlayers = {};
  rooms.forEach(function (ch) {
    var tokens = String(ch.name || "").toLowerCase().split(/[^a-z0-9á-žÁ-Ž]+/).filter(Boolean).map(simNameKey_);
    var chKey = simNameKey_(ch.name);
    var player = null;
    roster.forEach(function (r) {
      if (player) return;
      var pk = simNameKey_(r.player);
      if (pk && (chKey === pk || tokens.indexOf(pk) >= 0)) player = r.player;
    });
    if (!player) { unmatched.push("#" + ch.name); return; }
    var members = (ch.permission_overwrites || []).filter(function (o) {
      return Number(o.type) === 1 && (!meId || String(o.id) !== String(meId)) && (Number(o.allow) & DISCORD_VIEW_CHANNEL) !== 0;
    });
    var userId = members.length === 1 ? String(members[0].id) : "";
    var url = "https://discord.com/channels/" + guild + "/" + ch.id;
    var row = rowsByPlayer[simNameKey_(player)];
    if (!row) { row = sh.getLastRow() + 1; sh.getRange(row, 1).setValue(player); rowsByPlayer[simNameKey_(player)] = row; }
    sh.getRange(row, 2).setValue(url);
    if (userId && !String(sh.getRange(row, 4).getValue() || "").trim()) sh.getRange(row, 4).setValue(userId);
    matchedPlayers[simNameKey_(player)] = 1;
    matched.push(player + " ← #" + ch.name + (userId ? "" : " (user ID nenalezeno)"));
  });
  var noRoom = roster.filter(function (r) { return !matchedPlayers[simNameKey_(r.player)]; }).map(function (r) { return r.player; });
  return { category: cats.map(function (c) { return c.name; }).join(", "), matched: matched, unmatched: unmatched, noRoom: noRoom };
}

function discordRoomsSummary_(sm) {
  return "Načteno " + sm.matched.length + " místností z kategorie „" + sm.category + "“.\n\n" + sm.matched.join("\n") +
    (sm.unmatched.length ? "\n\nNespárované místnosti (jméno neodpovídá hráči v Rosteru): " + sm.unmatched.join(", ") : "") +
    (sm.noRoom.length ? "\n\nHráči bez místnosti: " + sm.noRoom.join(", ") : "");
}

/**
 * Menu: načíst místnosti hráčů z Discordu. Bot API z Google serverů Discord blokuje (HTTP 403 code 40333),
 * takže když přímé volání selže, spustí se GitHub Actions s task=discord-rooms – sim_runner.py tam kanály
 * stáhne a pošle je sem (POST simapi action=rooms). Bot token pro runner = secret DISCORD_BOT_TOKEN,
 * ID serveru = secret DISCORD_GUILD_ID (nebo Script Property DISCORD_GUILD_ID, runner si ho vezme z queue? ne – secret).
 */
function syncDiscordRooms() {
  var ui = SpreadsheetApp.getUi(), props = PropertiesService.getScriptProperties();
  var guild = props.getProperty(DISCORD_GUILD_PROP);
  if (!guild) {
    var g = ui.prompt("ID Discord serveru", "Discord → pravý klik na název serveru → Copy Server ID (zapnutý Developer Mode).", ui.ButtonSet.OK_CANCEL);
    if (g.getSelectedButton() !== ui.Button.OK) return;
    guild = g.getResponseText().replace(/\D/g, "");
    if (!guild) return;
    props.setProperty(DISCORD_GUILD_PROP, guild);
  }
  var token = props.getProperty(DISCORD_BOT_TOKEN_PROP);
  var directErr = "";
  if (token) {
    try {
      var channels = discordGet_(token, "/guilds/" + guild + "/channels");
      var me = null;
      try { me = discordGet_(token, "/users/@me"); } catch (err) { /* jen kvůli vyloučení bota */ }
      ui.alert(discordRoomsSummary_(applyDiscordRooms_(guild, channels, me ? me.id : "")));
      return;
    } catch (err) { directErr = String(err && err.message || err); }
  }
  // přímé volání nejde (Google IP jsou u Discordu blokované) → přes GitHub Actions
  var r = triggerSimRunner_("discord-rooms", { task: "discord-rooms" });
  ui.alert((directErr ? "Přímo z Google to nejde (" + directErr.slice(0, 120) + ").\n\n" : "") +
    (r.ok ? "Spustil jsem načtení místností přes GitHub Actions (sim_runner.py discord-rooms). Za 1–2 minuty se list „" + DISCORD_SHEET_NAME + "“ doplní – zkontroluj ho.\n" +
            "Potřebné GitHub secrets: DISCORD_BOT_TOKEN (token bota) a DISCORD_GUILD_ID = " + guild + "."
          : "GitHub Actions se nespustil: " + r.message));
}

/** Pošle testovací zprávu pro zadanou postavu (stejná cesta jako po dokončení simů). */
function testDiscordNotify() {
  var ui = SpreadsheetApp.getUi();
  var r = ui.prompt("Test Discord notifikace", "Jméno postavy (podle listu Sim výsledky / Roster):", ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  var character = r.getResponseText().trim();
  if (!character) return;
  var target = discordTargetFor_(character);
  var head = "Postava " + character + " → hráč " + (target && target.player ? target.player : "(nenalezen v Rosteru)") +
    "\nCíl: " + (target && target.webhook ? "webhook místnosti" : target && target.channelId ? "kanál " + target.channelId + " (bot)" : "společný webhook / nic");
  var fbTest = discordFallback_(PropertiesService.getScriptProperties());
  var botPath = (target && target.channelId && !target.webhook) || (!(target && (target.webhook || target.channelId)) && fbTest && fbTest.channelId);
  if (botPath) {
    // bot API z Google nejde (Discord blokuje) → test pošle runner v GitHub Actions
    var g = triggerSimRunner_("discord-test:" + character, { task: "discord-test", character: character });
    ui.alert(head + "\n\n" + (g.ok ? "Testovací zprávu pošle bot přes GitHub Actions (task discord-test) – za 1–2 minuty se objeví v místnosti. Průběh: GitHub → Actions → Sim queue."
                                 : "GitHub Actions se nespustil: " + g.message));
    return;
  }
  var res = notifySimDone_(character, "", { test: true });
  ui.alert(head + "\nVýsledek: " + (res.note || "nikam se neposlalo – chybí webhook místnosti / společný webhook (bot z Google nejde)"));
}

/** { nkey(hráč): { player, channelUrl, channelId, webhook, userId } } z listu Discord. */
function getDiscordRooms_() {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(DISCORD_SHEET_NAME);
  var out = {};
  if (!sh || sh.getLastRow() < 2) return out;
  var head = sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), DISCORD_HEADER.length)).getValues()[0].map(function (h) { return String(h || "").trim().toLowerCase(); });
  var col = {};
  DISCORD_HEADER.forEach(function (h, i) { var j = head.indexOf(h.toLowerCase()); col[h] = j >= 0 ? j : i; });
  sh.getRange(2, 1, sh.getLastRow() - 1, head.length).getValues().forEach(function (v) {
    var g = function (h) { return String(v[col[h]] == null ? "" : v[col[h]]).trim(); };
    var player = g("Hráč");
    if (!player) return;
    var url = g("Kanál URL");
    var m = /channels\/\d+\/(\d+)/.exec(url) || /^(\d{15,25})$/.exec(url);
    out[simNameKey_(player)] = { player: player, channelUrl: url, channelId: m ? m[1] : "", webhook: g("Webhook URL"), userId: g("Discord user ID").replace(/\D/g, "") };
  });
  return out;
}

/** Místnost hráče pro postavu: postava → hráč přes Roster (main/alt), jinak přímo jméno postavy = jméno hráče. */
function discordTargetFor_(character) {
  var rooms = getDiscordRooms_();
  var key = simNameKey_(character), player = "";
  (getRoster_() || []).forEach(function (r) {
    if (!player && ((r.main && simNameKey_(r.main) === key) || (r.alt && simNameKey_(r.alt) === key))) player = r.player;
  });
  var room = (player && rooms[simNameKey_(player)]) || rooms[key] || null;
  if (room) return room;
  return player ? { player: player, channelUrl: "", channelId: "", webhook: "", userId: "" } : null;
}

/** Souhrn hotových simů postavy z listu "Sim výsledky" (nejlepší raid / M+ item, Top Gear). */
function simSummaryFor_(character) {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SIM_RESULTS_SHEET_NAME);
  var out = { raid: null, mplus: null, topgear: null, nRaid: 0, nMplus: 0, hc: false };
  if (!sh || sh.getLastRow() < 2) return out;
  var key = simNameKey_(character);
  var vals = sh.getRange(2, 1, sh.getLastRow() - 1, SIM_RESULTS_HEADER.length).getValues();
  vals.forEach(function (v) {
    if (simNameKey_(v[0]) !== key) return;
    var kind = originKind_(v[SIM_RESULTS_ORIGIN_COL - 1]);
    var pct = Number(v[14]);
    var it = { item: String(v[8] || ""), boss: String(v[6] || ""), pct: isNaN(pct) ? 0 : pct, catalystFrom: String(v[17] || "") };
    if (kind === "topgear") { out.topgear = it; return; }
    if (kind === "raidhc") { out.hc = true; return; }
    if (kind !== "raid" && kind !== "mplus") return;
    if (it.pct > 0) out[kind === "raid" ? "nRaid" : "nMplus"]++;
    if (!out[kind] || it.pct > out[kind].pct) out[kind] = it;
  });
  return out;
}

function pctText_(p) { return (p > 0 ? "+" : "") + (Math.round(p * 100) / 100).toFixed(2) + " %"; }

function simDoneMessage_(character, spec, room, opts) {
  var s = simSummaryFor_(character);
  var lines = [];
  var head = (room && room.userId ? "<@" + room.userId + "> " : "") + "🧪 **" + character + "**" + (spec ? " (" + spec + ")" : "") + (opts && opts.test ? " – TEST notifikace" : " – simy jsou hotové!");
  lines.push(head);
  var itemText = function (it) { return it.item + (it.catalystFrom ? " (katalyzátor z " + it.catalystFrom + ")" : "") + (it.boss ? " – " + it.boss : "") + " " + pctText_(it.pct); };
  if (s.raid) lines.push("• Raid: " + s.nRaid + " upgradů, nejlepší " + itemText(s.raid));
  if (s.mplus) lines.push("• M+: " + s.nMplus + " upgradů, nejlepší " + itemText(s.mplus));
  if (s.topgear) lines.push("• Top Gear (best overall): " + pctText_(s.topgear.pct));
  if (s.hc) lines.push("• Great Vault: verdikt vault vs. bonus roll je na webu");
  lines.push("→ " + SIM_PAGE_URL + "#" + encodeURIComponent(character));
  return lines.join("\n");
}

function discordPostWebhook_(webhook, text, userId) {
  var payload = { content: text, allowed_mentions: { users: userId ? [userId] : [] } };
  var resp = UrlFetchApp.fetch(webhook, { method: "post", contentType: "application/json", payload: JSON.stringify(payload), muteHttpExceptions: true });
  var code = resp.getResponseCode();
  if (code < 200 || code >= 300) throw new Error("webhook HTTP " + code + " " + resp.getContentText().slice(0, 120));
}

function discordPostBot_(token, channelId, text, userId) {
  var payload = { content: text, allowed_mentions: { users: userId ? [userId] : [] } };
  var resp = UrlFetchApp.fetch("https://discord.com/api/v10/channels/" + channelId + "/messages",
    { method: "post", contentType: "application/json", headers: { Authorization: "Bot " + token }, payload: JSON.stringify(payload), muteHttpExceptions: true });
  var code = resp.getResponseCode();
  if (code < 200 || code >= 300) throw new Error("bot HTTP " + code + " " + resp.getContentText().slice(0, 120));
}

var DISCORD_PENDING_NOTE = "Discord ⏳ bot přes runner";

/**
 * Pošle zprávu o dokončených simech postavy do místnosti hráče. Vrací { note, pending }:
 * note = text do poznámky ("Discord ✔ hráč" / "Discord ✖ důvod" / "" když není kam posílat),
 * pending = { channelId, userId, text, player } když má zprávu poslat sim_runner (bot API):
 * Discord blokuje volání bot API z Google serverů (HTTP 403, code 40333 "internal network error"),
 * webhooky fungují. S opts.viaRunner (simapi) se tedy bot zpráva jen připraví a runner ji pošle
 * z GitHub Actions (env DISCORD_BOT_TOKEN) a nahlásí action=notified. Nikdy nehází.
 */
function notifySimDone_(character, spec, opts) {
  opts = opts || {};
  if (!SIM_NOTIFY) return { note: "", pending: null };
  try {
    var room = discordTargetFor_(character);
    var props = PropertiesService.getScriptProperties();
    var token = props.getProperty(DISCORD_BOT_TOKEN_PROP), fallback = discordFallback_(props);
    var text = simDoneMessage_(character, spec, room, opts);
    if (room && room.webhook) { discordPostWebhook_(room.webhook, text, room.userId); return { note: "Discord ✔ " + room.player, pending: null }; }
    if (room && room.channelId) {
      if (opts.viaRunner) return { note: DISCORD_PENDING_NOTE, pending: { channelId: room.channelId, userId: room.userId || "", text: text, player: room.player } };
      if (token) {
        try { discordPostBot_(token, room.channelId, text, room.userId); return { note: "Discord ✔ " + room.player + " (bot)", pending: null }; }
        catch (err) {
          if (/40333|403/.test(String(err && err.message))) throw new Error("Discord blokuje bot API z Google (40333) – doplň do listu Discord webhook místnosti, nebo nech zprávu poslat sim_runner");
          throw err;
        }
      }
    }
    if (fallback && DISCORD_CREATE_ROOM_CHANNEL) text += "\n" + DISCORD_NO_ROOM_HINT;   // do společného kanálu = hráč nemá místnost
    if (fallback && fallback.webhook) { discordPostWebhook_(fallback.webhook, text, room && room.userId); return { note: "Discord ✔ společný kanál", pending: null }; }
    if (fallback && fallback.channelId) {
      var fbPlayer = (room && room.player) || character;
      if (opts.viaRunner) return { note: DISCORD_PENDING_NOTE + " (společný kanál)", pending: { channelId: fallback.channelId, userId: (room && room.userId) || "", text: text, player: fbPlayer + " → společný kanál" } };
      if (token) {
        try { discordPostBot_(token, fallback.channelId, text, room && room.userId); return { note: "Discord ✔ společný kanál (bot)", pending: null }; }
        catch (err) { throw new Error("Discord blokuje bot API z Google (40333) – společný kanál pošle sim_runner při dalším běhu, nebo použij webhook"); }
      }
    }
    return { note: "", pending: null };
  } catch (err) {
    return { note: "Discord ✖ " + String(err && err.message || err).slice(0, 160), pending: null };
  }
}

var CREST_SHEET_NAME = "Cresty";
var CREST_IDS = [["3442", "Adventurer"], ["3443", "Veteran"], ["3444", "Champion"], ["3445", "Hero"], ["3446", "Myth"]];
var CREST_EXTRA = ["Server", "Region"];   // za cresty: SimC `server=drakthul`, `region=eu`
var CREST_HEADER = ["Postava", "Čas"].concat(CREST_IDS.map(function (c) { return c[1]; })).concat(CREST_EXTRA);

/** { "3442": 274, ... } ze SimC exportu, nebo null když řádek chybí. */
function parseCrests_(s) {
  var m = /^#\s*upgrade_currencies=(\S+)/m.exec(String(s || ""));
  if (!m) return null;
  var out = {}, any = false;
  m[1].split("/").forEach(function (part) {
    var p = part.split(":");   // c:<id>:<count>
    if (p[0] === "c" && p.length >= 3 && /^\d+$/.test(p[2])) { out[p[1]] = +p[2]; any = true; }
  });
  return any ? out : null;
}

function crestSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(CREST_SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(CREST_SHEET_NAME);
    sh.getRange(1, 1, 1, CREST_HEADER.length).setValues([CREST_HEADER]).setFontWeight("bold");
    sh.setFrozenRows(1);
    sh.getRange(1, 3, 1, CREST_IDS.length).setNotes([CREST_IDS.map(function (c) { return "currency id " + c[0]; })]);
  }
  // starší list bez sloupců Server/Region – doplnit hlavičku
  var have = sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), CREST_HEADER.length)).getValues()[0].map(String);
  CREST_HEADER.forEach(function (h, i) { if (have[i] !== h) sh.getRange(1, i + 1).setValue(h).setFontWeight("bold"); });
  return sh;
}

/** Menu: založí list (idempotentní). */
function buildCrestSheet() {
  crestSheet_();
  SpreadsheetApp.getUi().alert("List „" + CREST_SHEET_NAME + "“ je připravený.");
}

/** Přepíše řádek postavy (crests = objekt z parseCrests_; server/region ze SimC exportu, prázdné = nechat, co tam je). */
function storeCrests_(character, crests, when, server, region) {
  var sh = crestSheet_();
  var row = [character, when || new Date()].concat(CREST_IDS.map(function (c) { return crests[c[0]] != null ? crests[c[0]] : 0; }));
  var last = sh.getLastRow(), target = 0;
  if (last >= 2) {
    var names = sh.getRange(2, 1, last - 1, 1).getValues(), key = simNameKey_(character);
    for (var i = 0; i < names.length; i++) if (simNameKey_(names[i][0]) === key) { target = i + 2; break; }
  }
  if (!target) target = last + 1;
  sh.getRange(target, 1, 1, row.length).setValues([row]);
  sh.getRange(target, 2).setNumberFormat("d.M.yyyy H:mm");
  var col = row.length + 1;
  if (server) sh.getRange(target, col).setValue(String(server).toLowerCase());
  if (region) sh.getRange(target, col + 1).setValue(String(region).toLowerCase());
  return target;
}

/** Menu: jednorázově doplní cresty z posledního odeslání každé postavy v listu Sim fronta. */
function backfillCrests() {
  var sh = simSheet_();
  if (!sh || sh.getLastRow() < 2) { SpreadsheetApp.getUi().alert("List „" + SIM_SHEET_NAME + "“ je prázdný."); return; }
  var vals = sh.getRange(2, 1, sh.getLastRow() - 1, SIM_HEADER.length).getValues();
  var seen = {}, n = 0;
  for (var i = vals.length - 1; i >= 0; i--) {        // odspodu = nejnovější odeslání první
    var name = String(vals[i][SIM_COL.character - 1] || ""); if (!name) continue;
    var key = simNameKey_(name); if (seen[key]) continue;
    var simc = vals[i][SIM_COL.simc - 1];
    var crests = parseCrests_(simc); if (!crests) continue;
    seen[key] = 1;
    var t = vals[i][SIM_COL.time - 1];
    var sv = /^server=([^\s]+)\s*$/mi.exec(String(simc || "")), rg = /^region=([a-z]+)\s*$/mi.exec(String(simc || ""));
    storeCrests_(name, crests, t instanceof Date ? t : new Date(), sv ? sv[1] : "", rg ? rg[1] : "");
    n++;
  }
  SpreadsheetApp.getUi().alert("Cresty doplněné pro " + n + " postav.");
}

// ================== SPUŠTĚNÍ SIMŮ ONLINE (GitHub Actions) ==================
//
// sim_runner.py běží i v GitHub Actions (.github/workflows/sims.yml): podle
// plánu každou hodinu a na vyžádání. Na vyžádání ho spustí:
//   - menu Simy → "Spustit simy online (GitHub)", nebo
//   - tlačítko na hlavní stránce (hub) chráněné heslem raid leadera →
//     POST na web app { p: "runsims", pw: "…" } (doPost) → workflow_dispatch.
// Jednorázově: setGithubToken() (fine-grained PAT jen na tento repo,
// oprávnění Actions: read & write) a setSimRunPassword().

var GITHUB_REPO = "vitekpoor/RaidPlan";
var GITHUB_WORKFLOW = "sims.yml";
var GITHUB_BRANCH = "main";
var GITHUB_TOKEN_PROP = "GITHUB_TOKEN";
var SIM_RUN_PASSWORD_PROP = "SIM_RUN_PASSWORD";
var SIM_RUN_COOLDOWN_SEC = 120;
var SIM_AUTO_RUN = true;              // odeslání SimC z formuláře rovnou spustí runner v GitHub Actions
var SIM_RUN_DELAY_MIN = 3;            // když běží cooldown, spustí se odloženě za N minut (time-based trigger)

function setGithubToken() {
  var ui = SpreadsheetApp.getUi();
  var res = ui.prompt("GitHub token pro spouštění simů",
    "Vlož fine-grained personal access token (repo " + GITHUB_REPO + ", Actions: Read and write). Uloží se do Script Properties.",
    ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui.Button.OK) return;
  var t = res.getResponseText().trim();
  if (!/^(github_pat_|ghp_)[A-Za-z0-9_]{20,}$/.test(t)) { ui.alert("To nevypadá jako GitHub token (github_pat_… / ghp_…)."); return; }
  PropertiesService.getScriptProperties().setProperty(GITHUB_TOKEN_PROP, t);
  ui.alert("Token uložen.");
}

function setSimRunPassword() {
  var ui = SpreadsheetApp.getUi();
  var res = ui.prompt("Heslo pro tlačítko „Spustit simy“ na webu",
    "Heslo, které zadá raid leader na hlavní stránce. Uloží se do Script Properties.", ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui.Button.OK) return;
  var pw = res.getResponseText().trim();
  if (pw.length < 4) { ui.alert("Moc krátké heslo."); return; }
  PropertiesService.getScriptProperties().setProperty(SIM_RUN_PASSWORD_PROP, pw);
  ui.alert("Heslo uloženo.");
}

/** workflow_dispatch přes GitHub API. Vrací { ok, message }. */
function triggerSimRunner_(reason, extraInputs) {
  var token = PropertiesService.getScriptProperties().getProperty(GITHUB_TOKEN_PROP);
  if (!token) return { ok: false, message: "chybí GitHub token (menu Simy → Nastavit GitHub token…)" };
  var inputs = { reason: String(reason || "manual").slice(0, 80) };
  Object.keys(extraInputs || {}).forEach(function (k) { inputs[k] = String(extraInputs[k]); });
  var resp = UrlFetchApp.fetch("https://api.github.com/repos/" + GITHUB_REPO + "/actions/workflows/" + GITHUB_WORKFLOW + "/dispatches", {
    method: "post", contentType: "application/json", muteHttpExceptions: true,
    headers: { "Authorization": "Bearer " + token, "Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
    payload: JSON.stringify({ ref: GITHUB_BRANCH, inputs: inputs })
  });
  var code = resp.getResponseCode();
  if (code === 204) return { ok: true, message: "GitHub Actions spuštěn – simy doběhnou za pár minut, výsledky se objeví na stránce Simy." };
  return { ok: false, message: "GitHub API HTTP " + code + ": " + resp.getContentText().slice(0, 200) };
}

/** Společná logika pro menu i web: fronta prázdná → nespouštět; cooldown proti dvojkliku. */
function runSimsOnline_(reason) {
  var sh = simSheet_();
  var pending = sh ? countPendingSims_(sh) : 0;
  if (!pending) return { ok: true, message: "Fronta je prázdná – není co simovat." };
  var cache = CacheService.getScriptCache();
  if (cache.get("simrun_last")) {
    // někdo spustil před chvílí – GitHub by běžící/čekající run jen nahradil; naplánuj odložený start,
    // aby se vzaly i řádky přidané během běhu
    scheduleDelayedSimRun_();
    return { ok: true, message: "Simy už běží – tvůj řádek se vezme v dalším kole za " + SIM_RUN_DELAY_MIN + " minuty." };
  }
  var r = triggerSimRunner_(reason);
  if (r.ok) { cache.put("simrun_last", "1", SIM_RUN_COOLDOWN_SEC); r.message = pending + " ve frontě. " + r.message; }
  return r;
}

/** Jednorázový time-based trigger (jen jeden najednou). */
function scheduleDelayedSimRun_() {
  var exists = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === "runSimsDelayed"; });
  if (exists) return;
  ScriptApp.newTrigger("runSimsDelayed").timeBased().after(SIM_RUN_DELAY_MIN * 60 * 1000).create();
}

/** Handler odloženého startu – smaže sebe a spustí runner, pokud je co simovat. */
function runSimsDelayed() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === "runSimsDelayed") ScriptApp.deleteTrigger(t);
  });
  var sh = simSheet_();
  if (!sh || !countPendingSims_(sh)) return;
  var cache = CacheService.getScriptCache();
  if (cache.get("simrun_last")) { scheduleDelayedSimRun_(); return; }
  var r = triggerSimRunner_("delayed");
  if (r.ok) cache.put("simrun_last", "1", SIM_RUN_COOLDOWN_SEC);
}

/** Menu Simy → Spustit simy online (GitHub). */
function runSimsOnline() {
  var r = runSimsOnline_("sheets-menu");
  SpreadsheetApp.getUi().alert(r.message);
}

/**
 * POST z hlavní stránky: tělo JSON { p: "runsims", pw: "heslo" } (text/plain,
 * aby prohlížeč nedělal preflight). Odpověď JSON { ok, message }.
 */
function doPost(e) {
  var body = {};
  try { body = JSON.parse((e && e.postData && e.postData.contents) || "{}"); } catch (err) { body = {}; }
  var params = (e && e.parameter) || {};
  var p = String(body.p || params.p || "");
  if (p === "simapi") {
    var tok = PropertiesService.getScriptProperties().getProperty(SIM_API_TOKEN_PROP);
    if (!tok || String(body.token || "") !== tok) return simApiJson_({ ok: false, error: "bad token" });
    if (String(body.action || "") === "rooms") {
      try {
        var summary = applyDiscordRooms_(String(body.guild || ""), body.channels || [], String(body.me || ""));
        return simApiJson_({ ok: true, message: discordRoomsSummary_(summary), summary: summary });
      } catch (err) { return simApiJson_({ ok: false, error: String(err && err.message || err) }); }
    }
    return simApiJson_({ ok: false, error: "neznámá action " + body.action });
  }
  if (p !== "runsims") return simApiJson_({ ok: false, message: "neznámý požadavek" });
  var want = PropertiesService.getScriptProperties().getProperty(SIM_RUN_PASSWORD_PROP);
  var pw = String(body.pw || params.pw || "");
  if (!want) return simApiJson_({ ok: false, message: "heslo není nastavené (menu Simy → Nastavit heslo…)" });
  if (pw !== want) {
    Utilities.sleep(800);
    return simApiJson_({ ok: false, message: "špatné heslo" });
  }
  try { return simApiJson_(runSimsOnline_("web-hub")); }
  catch (err) { return simApiJson_({ ok: false, message: String(err && err.message || err) }); }
}
