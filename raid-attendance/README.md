# Raid attendance bot

Every Sunday evening a GitHub Actions job reads the absence matrix in the guild
Google Sheet ("Absence přehled" tab) and posts to Discord who is unavailable,
who arrives late and who has not entered anything for the raid days
(Wednesday, Thursday, Sunday) of the coming Monday–Sunday week.

```
Google Sheet (public CSV export) → GitHub Actions (cron) → attendance.py → Discord webhook
```

Everything runs on GitHub's free tier; no server, no Google API keys.

## What the report looks like

```
📋 RAID AVAILABILITY
━━━━━━━━━━━━━━━━━━━━

📅 NEXT WEEK · 7–13 SEP

❌ UNAVAILABLE
• Hase — Wed 9.9. / Thu 10.9. / Sun 13.9.
• Nesferity — Sun 13.9.

⏰ ARRIVING LATE
• nobody

⚠️ NOT CONFIRMED (no entry for any raid day)
• Ahaaferos
• …

👥 RAID DAYS
• Wed 9.9.
• Thu 10.9.
• Sun 13.9.
```

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

3. **GitHub repository.** Create a new repository (private is fine) and upload
   these files:

   ```
   .github/workflows/weekly.yml
   attendance.py
   requirements.txt
   README.md
   mentions.example.json
   .gitignore
   ```

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
   `2026-09-06` reports on the week 7–13 September.

## Schedule

`weekly.yml` runs `0 17 * * 0` = Sunday 17:00 UTC (19:00 Czech summer time,
18:00 winter time). Change the cron line to move it. GitHub may start
scheduled jobs a few minutes late; GitHub also disables schedules on
repositories with no activity for 60 days — a manual run re-enables them.

## Which week is reported

The script works in `Europe/Prague`. It takes the **next Monday** after
"today" and reports that Monday–Sunday. On the Sunday run that is the week
starting tomorrow. Set the variable `WEEK_OFFSET=-1` (or the manual-run input
`week_offset`) to report on the current week instead.

## How cells are interpreted

| Cell | Meaning |
|---|---|
| `X` (also `x`, `ne`, `nepřijdu`, `-`) | ❌ unavailable |
| `pozdě` (anything containing "pozd" or "late") | ⏰ arriving late |
| empty | nothing reported → the player is listed under ⚠️ NOT CONFIRMED if they have no entry on any raid day |
| anything else | reported under 🔎 CHECK THE SHEET so a typo is never silently dropped |

Column headers are matched as dates in several formats (`čt 10.9.`,
`10.9.2026`, `2026-09-10`, `10/9/2026`). Headers without a year get the year
that puts them closest to the reported week, so December/January works.
A raid day that has no column at all is flagged in the RAID DAYS section.

## Options (repository *variables*, Settings → Secrets and variables → Actions → Variables)

| Variable | Default | Purpose |
|---|---|---|
| `RAID_WEEKDAYS` | `wed,thu,sun` | which weekdays count (English or Czech names) |
| `SHOW_NOT_CONFIRMED` | `true` | hide the long NOT CONFIRMED list with `false` |
| `MENTION_SECTIONS` | `unavailable,late` | where to @-mention mapped players; `none`, or add `unconfirmed` |
| `TIMEZONE` | `Europe/Prague` | |
| `REPORT_TITLE` | `RAID AVAILABILITY` | |
| `SHEET_ID`, `SHEET_GID` | guild sheet | another sheet / tab |

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

## Alternative: keep it inside an existing repository

The workflow only needs to live in `.github/workflows/` of the repository's
default branch. To run it from the RaidPlan repository instead of a new one,
copy `weekly.yml` to `RaidPlan/.github/workflows/weekly.yml` and change the
last line to `python raid-attendance/attendance.py $ARGS` (and the
`pip install` line to `-r raid-attendance/requirements.txt`).
