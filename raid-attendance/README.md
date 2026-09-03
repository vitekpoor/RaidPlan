# Raid attendance bot

Every Tuesday evening a GitHub Actions job reads the absence matrix in the guild
Google Sheet ("Absence přehled" tab) and posts to Discord who is unavailable
and who arrives late on the raid days (Wednesday, Thursday, Sunday) of the
coming raid week (Wednesday to Tuesday, following the WoW weekly reset), and
whether those players stand in the boss lineups ("Boss sestavy" tab). An empty cell means the player is coming. The message is in
Czech by default (`REPORT_LANG=en` for English).

```
Google Sheet (public CSV export) → GitHub Actions (cron) → attendance.py → Discord webhook
```

Everything runs on GitHub's free tier; no server, no Google API keys.

## What the report looks like

```
📋 DOCHÁZKA NA RAID
━━━━━━━━━━━━━━━━━━━━

📅 PŘÍŠTÍ TÝDEN · 9.–15. 9.

❌ NEPŘIJDOU
• Hase — st 9.9. / čt 10.9. / ne 13.9.
  ↳ v sestavě: 01 Nek'zali, 03 Vashnik, 04 Explorers, 05 Sszorak, 06 Twin Fangs, 07 Coiled Altar, 08 Ula'tek, 09 Nymrissa
• Nesferity — ne 13.9.
  ↳ v sestavě: všichni bossové

⏰ PŘIJDOU POZDĚ
• jeeni — ne 13.9.

👥 RAIDOVÉ DNY
• st 9.9.
• čt 10.9.
• ne 13.9.
```

Under each absent or late player the bot says where they stand in the
"Boss sestavy" lineups: *všichni bossové* when they are in every boss's
lineup, the list of bosses when only in some, *žádný boss* when in none. Dates
of the boss columns are not shown.

## Setup (one time, ~10 minutes)

1. **Google Sheet.** The sheet must be readable by link: Share → *Anyone with
   the link* → *Viewer*. (The guild wishlist sheet already is.) Nothing else
   is needed — the script downloads the tab as CSV:
   `https://docs.google.com/spreadsheets/d/<SHEET_ID>/export?format=csv&gid=<GID>`.
   The defaults in `attendance.py` point at the guild sheet, tab gid
   `521369072`. Another sheet/tab: set the repository variables `SHEET_ID`
   and `SHEET_GID` (the gid is the number after `gid=` in the browser URL).

2. **Discord webhook.** In Discord: channel → Edit channel → Integrations →
   Webhooks → New Webhook → Copy Webhook URL.

3. **GitHub repository.** The files are in the RaidPlan repository already
   (see *Where it runs* below). For a separate repository, upload this folder
   plus `.github/workflows/weekly.yml`.

4. **Secrets.** Repository → Settings → Secrets and variables → Actions →
   *New repository secret*:

   | Secret | Value |
   |---|---|
   | `DISCORD_WEBHOOK_URL` | the webhook URL from step 2 (required) |
   | `DISCORD_MENTIONS` | optional, JSON `{"Hase": "1234…", "Nesferity": "5678…"}` |

5. **Enable Actions.** Repository → Actions tab → enable workflows if GitHub
   asks. The schedule starts working as soon as the workflow file is on the
   default branch.

6. **Test it.** Actions → *Weekly raid attendance report* → *Run workflow*.
   Tick **dry_run** to see the report in the job log without posting, or run
   it for real. The **date** input lets you pretend it is another day, e.g.
   `2026-09-08` reports on the raid week 9–15 September.

## Schedule

`weekly.yml` runs `0 17 * * 2` = Tuesday 17:00 UTC (19:00 Czech summer time,
18:00 winter time), the evening before the Wednesday raid. Change the cron line to move it. GitHub may start
scheduled jobs a few minutes late; GitHub also disables schedules on
repositories with no activity for 60 days — a manual run re-enables them.

## Which week is reported

The script works in `Europe/Prague`. The raid week runs **Wednesday to
Tuesday** like the WoW weekly reset (`WEEK_START`, default `wed`). The bot
finds the **next raid day after today** and reports the raid week that
contains it: on the Tuesday run that is the reset week starting tomorrow
(header PŘÍŠTÍ TÝDEN); run on a Thursday it would report the week already in
progress (TENTO TÝDEN). `WEEK_OFFSET=1` (or the manual-run input
`week_offset`) shifts the report a week later, `-1` earlier.

## How cells are interpreted

| Cell | Meaning |
|---|---|
| `X` (also `x`, `ne`, `nepřijdu`, `-`) | ❌ unavailable |
| `pozdě` (anything containing "pozd" or "late") | ⏰ arriving late |
| empty | the player is coming (with `SHOW_NOT_CONFIRMED=true` such players are listed under ⚠️ NOT CONFIRMED instead) |
| anything else | reported under 🔎 CHECK THE SHEET so a typo is never silently dropped |

Column headers are matched as dates in several formats (`čt 10.9.`,
`10.9.2026`, `2026-09-10`, `10/9/2026`). Headers without a year get the year
that puts them closest to the reported week, so December/January works.
A raid day that has no column at all is flagged in the RAID DAYS section.

## Options (repository *variables*, Settings → Secrets and variables → Actions → Variables)

| Variable | Default | Purpose |
|---|---|---|
| `RAID_WEEKDAYS` | `wed,thu,sun` | which weekdays count (English or Czech names) |
| `WEEK_START` | `wed` | first day of the raid week (WoW reset) |
| `SHOW_NOT_CONFIRMED` | `false` | `true` adds a ⚠️ NOT CONFIRMED list of players with no entry on any raid day |
| `MENTION_SECTIONS` | `unavailable,late` | where to @-mention mapped players; `none`, or add `unconfirmed` |
| `TIMEZONE` | `Europe/Prague` | |
| `REPORT_LANG` | `cs` | `en` for an English message |
| `REPORT_TITLE` | `DOCHÁZKA NA RAID` / `RAID AVAILABILITY` | |
| `SHEET_ID`, `SHEET_GID` | guild sheet | another sheet / tab |
| `LINEUP_GID` | `731845282` | gid of the "Boss sestavy" tab; `none` disables the lineup lookup |

## Discord mentions

Map sheet names to Discord user ids either in the `DISCORD_MENTIONS` secret
(JSON, see `mentions.example.json`) or in a `mentions.json` file next to the
script (git-ignored by default; commit it if you don't mind the ids being in
the repo). Get an id with Developer Mode enabled in Discord: right-click a
user → *Copy User ID*. Names are matched ignoring case and diacritics.
Only players in the UNAVAILABLE / LATE sections are mentioned by default.

## Running locally

```
pip install -r requirements.txt
python attendance.py --dry-run                 # today, real sheet, nothing sent
python attendance.py --dry-run --date 2026-09-06
python attendance.py --dry-run --csv test.csv  # a local CSV instead of the sheet
set DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...   (Windows)
python attendance.py                           # posts for real
```

## When something goes wrong

If the sheet cannot be read, has no date columns, or Discord rejects the
message, the job fails (red in Actions) and, when the webhook works, a short
🚨 error message is posted to the channel instead of a wrong report.
Unrecognized cell values and duplicate player rows do not stop the report;
they are listed at the bottom under 🔎 CHECK THE SHEET.

## Where it runs

This folder is deployed from the **RaidPlan** repository: the workflow file
lives at `RaidPlan/.github/workflows/weekly.yml` (GitHub only runs workflows
from that path on the default branch) and calls
`python raid-attendance/attendance.py`. The secret `DISCORD_WEBHOOK_URL` is
set on that repository. To move the bot to a repository of its own, copy this
folder there, put `weekly.yml` under `.github/workflows/`, and drop the
`raid-attendance/` prefix from the two paths in it.
