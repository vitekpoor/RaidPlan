// Eternal Shadows Worker: static site (repo root, see .assetsignore) + JSON API backed by D1.
// Static assets are served first; anything not matching a file lands here.
//   GET /api/health  -> { ok, db, tables, version }
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      let db = false, tables = [], error;
      try {
        const rs = await env.DB.prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'sqlite_%' ORDER BY name"
        ).all();
        db = true;
        tables = rs.results.map(r => r.name);
      } catch (e) {
        error = String(e && e.message || e);
      }
      return json({ ok: db, db, tables, error, version: env.VERSION || null });
    }

    if (url.pathname.startsWith("/api/")) {
      return json({ error: "not found" }, 404);
    }
    return new Response("Not found", { status: 404 });
  },
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
