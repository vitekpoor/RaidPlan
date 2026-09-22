# ES Attendance – WoW addon

In-game roster check for the raid leader. The addon knows every player from the guild
**roster** (database behind the guild site, edited on roster.html: player → main + alt characters),
compares that with the group you are in, lets you invite the missing people (one click per player
or all at once) and writes an attendance record that ends up as a new day on the **Docházka** page.

```
/api/roster.csv ──build_roster.py──▶ ESAttendance/RosterData.lua ──▶ in game: /esa
                                                                        │
   D1 attendance ◀── Worker POST /api/attendance (attendance.html paste form / sync_attendance.py) ◀── export string
```

A WoW addon cannot talk to the internet, so both directions go through a copy step:
the roster is generated into a Lua file (or pasted in game), and the attendance record is a
short text you copy out of the game (Ctrl+C) or push with `sync_attendance.py`.

## Files

| File | Purpose |
|---|---|
| `ESAttendance/` | the addon itself (`ESAttendance.toc`, `Core.lua`, `UI.lua`, generated `RosterData.lua`) |
| `build_roster.py`, `update_roster.bat` | Worker `/api/roster.csv` → `RosterData.lua`, `--install` copies the addon into `_retail_\Interface\AddOns` |
| `sync_attendance.py`, `sync_attendance.bat` | SavedVariables → Worker `POST /api/attendance` (D1) |
| `worker/attendance.js` | Worker side: attendance records, `/api/es?p=esroster` roster text, `/attendance` page redirect |

## Install / update

```bat
addon\update_roster.bat
```

runs `python build_roster.py --install`: downloads the roster from the Worker (`/api/roster.csv`, no
credentials), writes `ESAttendance/RosterData.lua` and copies the addon into
`G:\World of Warcraft\_retail_\Interface\AddOns\ESAttendance` (auto-detected next to the repo;
`--wow PATH` or `WOW_ADDONS` override). Then `/reload` in game. Re-run after every roster change.

**Without the script, from inside the game (two shortcuts):** `/esa` → **Import rosteru**.
The dialog opens with the ready-made roster URL preselected in its URL box (the Worker
address `…/api/es` is compiled into `Core.lua`, `/esa url <…>` overrides it). Ctrl+C,
Alt-Tab, Ctrl+V into the browser address bar: the page `…/api/es?p=esroster` copies the current
roster to the clipboard by itself. Back in game Ctrl+V into the dialog: a pasted roster loads
immediately, no button. The imported roster is kept in SavedVariables; a newer `RosterData.lua`
wins again automatically, `/esa roster reset` drops the import. The window shows an orange
"N dní starý – Import rosteru" hint when the active roster is older than 7 days.
`…/api/es?p=esroster&raw=1` returns the plain text for scripts. The addon itself cannot fetch it:
WoW addons have no network, file or process access, so a copy step is unavoidable.

## In game

`/esa` opens the window (also `/esattendance`), as does the round green **ES** button on the
minimap rim (the site favicon, `icon.tga`): left click = window, right click = write attendance,
drag = move it along the rim, `/esa minimap` hides/shows it. Every roster player is a row:

- ✔ green – a character of the player is in the group (which one, alt/main, offline flag)
- ⏳ orange – missing, but one of their characters is online in the guild (that one gets invited)
- ✖ red – missing, nobody online (invite goes to the main character)
- **Pozvat** on a row invites that player; **Pozvat chybějící** invites everyone missing,
  **Pozvat jen online** only those with an online guild character. Invites are sent one per
  0.6 s; when you start alone the addon sends four party invites, waits for the first accept,
  converts to raid and continues. You must be leader or assist. **Zrušit** empties the queue.
- Invites use the guild list to get the realm-qualified `Name-Realm` for every guild member,
  online or offline. The roster has no realms, so a character that is not in the guild is
  invited by plain name, which only works on the leader's own realm. Every invite is echoed in
  chat with its target; `/esa debug [player]` prints what the addon knows (guild lookup, online
  state, chosen invite target, group state) when something does not arrive.
- Group members that are not in the roster are listed under the table ("Mimo roster").
- **jen chybějící** filters the list; hovering a row shows all characters and their online state.

Slash commands: `/esa write` (record attendance), `/esa invite [online]`, `/esa cancel`,
`/esa import`, `/esa export [yyyy-mm-dd]`, `/esa list`, `/esa roster [reset]`.

## Attendance

**Zapsat docházku** (or `/esa write`) records who is in the group right now – per player
(not per character) yes/no – for today's date with the current time. One record per day:
a second write the same evening overwrites the first. The record is stored in SavedVariables
(`WTF\Account\<acc>\SavedVariables\ESAttendance.lua`) and shown as a selectable export string

```
ESA1;2026-09-16;20:05;Ahaaferos=1:Ähaferös;Glasolo=0;Anál=1:Papathyr;…;?=Randomguy-TarrenMill
```

(`=1` present, `=0` missing, `:Char` which character, `?=` group member outside the roster).

Getting it into the database, two ways:

1. **Paste form** – Ctrl+C in game, open `…/attendance` (or `…/api/es?p=attendance`), log in with the
   admin button top right, Ctrl+V into the form, *Zapsat*.
2. **Script** – after the raid `/reload` or log out (WoW writes SavedVariables only then), run
   `addon\sync_attendance.bat`. It reads every record from the SavedVariables file and POSTs
   the new/changed ones (state in `addon/.synced.json`, `--all` resends) to the Worker with
   the `sim_runner.py` token from `tools/roster/sim_runner.config.json` (or
   `addon/es_attendance.config.json` with `api_url` + `api_token`). `--dry-run` only prints.

Page layout (attendance.html): one row per roster player, one column per record with header
`16.9.2026 (19:13)`, cells `ano` (green, character name as a tooltip), `omluvenka` (yellow: missing, but the
player has an absence for that day), `pozdě` (orange: missing, reported "přijdu pozdě" for that day) or `ne`
(red); unknown group members are listed under the day header. A record for an existing date replaces that day.
