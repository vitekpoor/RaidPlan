#!/usr/bin/env node
// Site build: web/ (sources) → dist/ (what the Worker serves as static assets).
// Runs on Cloudflare before every deploy (wrangler.jsonc "build.command") and locally with `node web/build.mjs`
// (Playwright's bundled node.exe works when Node is not installed). Nothing generated is committed.
//
//   raid.html   = parts/head.html + bosses/*.html (alphabetical) + parts/tail.html
//   index.html  = hub.html
//   loot / roster / attendance / lineups / flopik .html, loot_items.json, *.png and assets/ are copied as they are –
//   the pages reference assets/… and loot_items.json relative to the site root, exactly like the sources do.

import { readFileSync, writeFileSync, mkdirSync, cpSync, readdirSync, rmSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const WEB = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(WEB, "..", "dist");
const PAGES = ["loot.html", "roster.html", "attendance.html", "lineups.html", "flopik.html"];

rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });

// raid guide: assembled from parts + one file per boss
const read = (p) => readFileSync(path.join(WEB, p), "utf8");
const bosses = readdirSync(path.join(WEB, "bosses")).filter((f) => f.endsWith(".html")).sort();
writeFileSync(path.join(DIST, "raid.html"), read("parts/head.html") + bosses.map((f) => read("bosses/" + f)).join("") + read("parts/tail.html"));

// hub → index, standalone pages, data + images
writeFileSync(path.join(DIST, "index.html"), read("hub.html"));
for (const p of PAGES) cpSync(path.join(WEB, p), path.join(DIST, p));
for (const f of readdirSync(WEB)) {
  if (/\.(png|jpg|webp|json|ico|txt)$/i.test(f) && statSync(path.join(WEB, f)).isFile()) cpSync(path.join(WEB, f), path.join(DIST, f));
}
cpSync(path.join(WEB, "assets"), path.join(DIST, "assets"), { recursive: true });

const files = [];
(function walk(d) { for (const f of readdirSync(d)) { const p = path.join(d, f); if (statSync(p).isDirectory()) walk(p); else files.push(p); } })(DIST);
console.log(`dist/: ${files.length} files (raid.html from ${bosses.length} boss parts, index.html from hub.html, ${PAGES.length} pages, assets/)`);
