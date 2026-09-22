#!/usr/bin/env python3
"""GitHub Actions wrapper around `raidplan.py --boss` (.github/workflows/raidplan.yml).

Reads its job from environment variables (workflow_dispatch inputs), runs the same sync as
update_plans.bat does locally, and reports the whole log back to the Worker
(POST /api/lineups/sync-result) so lineups.html can show what happened.

  RAIDPLAN_PLANS   content of venomabyss_plans.txt (GitHub secret – holds the edit keys)
  BOSSES           "all" or plan numbers separated by spaces/commas ("02 05")
  CHANGES          swaps / renames separated by commas, semicolons or newlines
                   ("Akka-Meslock, Miky=Hase"; same syntax as on the command line)
  DRY_RUN          "true" = preview only, nothing is saved
  ES_API_URL / ES_API_TOKEN   Worker API (result report); RUN_URL, REASON – only for the report
"""

import json
import os
import re
import subprocess
import sys
import tempfile
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
API = (os.environ.get("ES_API_URL") or "https://eternal-shadows.vitek-poor.workers.dev").rstrip("/")
TOKEN = os.environ.get("ES_API_TOKEN", "")
MAX_LOG = 60000


def report(payload):
    if not TOKEN:
        print("(ES_API_TOKEN not set – result not reported to the Worker)")
        return
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(API + "/api/lineups/sync-result", data=data, method="POST",
                                 headers={"Content-Type": "application/json", "Authorization": "Bearer " + TOKEN,
                                          "User-Agent": "raidplan-sync/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            print("result reported:", r.read().decode("utf-8", "replace")[:200])
    except Exception as e:  # noqa: BLE001 – the sync itself already happened, never fail on the report
        print("WARNING: could not report the result:", e)


def main():
    started = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    bosses = [b.zfill(2) if b.isdigit() else b for b in re.split(r"[\s,;]+", os.environ.get("BOSSES", "all").strip()) if b]
    if not bosses or any(b.lower() == "all" for b in bosses):
        bosses = ["all"]
    changes = [c.strip() for c in re.split(r"[,;\n]+", os.environ.get("CHANGES", "")) if c.strip()]
    dry_run = os.environ.get("DRY_RUN", "").strip().lower() in ("1", "true", "yes")
    base = {"bosses": bosses, "changes": changes, "dryRun": dry_run, "startedAt": started,
            "runUrl": os.environ.get("RUN_URL", ""), "reason": os.environ.get("REASON", "")}

    plans = os.environ.get("RAIDPLAN_PLANS", "")
    if not plans.strip():
        log = "GitHub secret RAIDPLAN_PLANS is missing – it must contain venomabyss_plans.txt (plan numbers + view/edit links)."
        print(log)
        report({**base, "ok": False, "exitCode": 2, "log": log, "finishedAt": started})
        sys.exit(2)

    tmp = tempfile.mkdtemp(prefix="raidplan-")
    plans_file = os.path.join(tmp, "plans.txt")
    with open(plans_file, "w", encoding="utf-8") as f:
        f.write(plans)
    cmd = [sys.executable, "-X", "utf8", os.path.join(HERE, "raidplan.py"), "--boss", *bosses, "--plans-file", plans_file]
    if changes:
        changes_file = os.path.join(tmp, "changes.txt")
        with open(changes_file, "w", encoding="utf-8") as f:
            f.write("\n".join(changes) + "\n")
        cmd += ["--file", changes_file]
    if dry_run:
        cmd.append("--dry-run")
    print("$", " ".join(c if c != plans_file else "<plans>" for c in cmd), flush=True)

    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace", cwd=HERE)
    lines = []
    for line in proc.stdout:
        sys.stdout.write(line)
        sys.stdout.flush()
        lines.append(line)
    code = proc.wait()
    log = "".join(lines)
    if len(log) > MAX_LOG:
        log = log[:MAX_LOG // 2] + "\n… (log zkrácen) …\n" + log[-MAX_LOG // 2:]
    finished = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    print(f"\nraidplan.py exited with {code}")
    report({**base, "ok": code == 0, "exitCode": code, "log": log, "finishedAt": finished})
    sys.exit(code)


if __name__ == "__main__":
    main()
