// A-Alerts verkeer: reads the NDW open data every minute, keeps the traffic items of the region (closures, roadworks,
// accidents, breakdowns, traffic jams) and the fixed speed cameras from OpenStreetMap, and hands them to the A-Alerts
// server (Cloudflare Worker) on GET /verkeer with a token. The worker asks every minute, which also keeps this free
// Koyeb instance awake. Nothing is written anywhere: this service only reads open data.
import http from "node:http";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { parseActueelBeeld, gepland } from "./ndw.js";
import { haalPlan } from "./plan.js";
import { VILD_VERSIE } from "./vild.js";
import { flitsersUitOverpass } from "./flitsers.js";

const PORT = Number(process.env.PORT) || 8000;
const TOKEN = process.env.VERKEER_TOKEN || "";
// Region: north, south, east, west (default: Apeldoorn with the A1, A50, the villages and Teuge).
const [noord, zuid, oost, west] = (process.env.GEBIED || "52.33,52.05,6.15,5.75").split(",").map(Number);
const GEBIED = { noord, zuid, oost, west };
const NDW = "https://opendata.ndw.nu/actueel_beeld.xml.gz";
const UA = { "user-agent": "A-Alerts verkeer (+https://a-alerts.nl)" };

const staat = { items: [], gepland: [], plan: new Map(), planEtag: null, planAt: 0, planFout: null, flitsers: [], ndwTijd: null, opgehaald: null, fout: null, etag: null, json: null, flitsersAt: 0, ndwEtag: null };
const straatCache = new Map();

/** Street and town of a spot from the PDOK Locatieserver (open data of the government), cached. */
async function straatBij(lat, lon) {
  const key = `${lat.toFixed(4)},${lon.toFixed(4)}`;
  if (straatCache.has(key)) return straatCache.get(key);
  const url = `https://api.pdok.nl/bzk/locatieserver/search/v3_1/reverse?lat=${lat}&lon=${lon}&type=weg&rows=1&fl=straatnaam,woonplaatsnaam,afstand`;
  let r = null;
  try {
    const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(8000) });
    if (res.ok) {
      const d = (await res.json())?.response?.docs?.[0];
      if (d && (d.afstand == null || d.afstand < 150)) r = { weg: d.straatnaam || null, plaats: d.woonplaatsnaam || null };
    }
  } catch { return null; } // not cached: try again next round
  straatCache.set(key, r);
  if (straatCache.size > 5000) straatCache.delete(straatCache.keys().next().value);
  return r;
}

function publiceer() {
  const body = { bijgewerkt: staat.ndwTijd, opgehaald: staat.opgehaald, gebied: GEBIED, items: staat.items, gepland: staat.gepland, flitsers: staat.flitsers };
  const json = JSON.stringify(body);
  const etag = `"${crypto.createHash("sha1").update(JSON.stringify([staat.items, staat.gepland, staat.flitsers])).digest("base64url").slice(0, 16)}"`;
  staat.json = json; staat.etag = etag;
}

/** Street and town for items without a road number (municipal roads): "Anklaarseweg", "Apeldoorn". */
async function straten(items, max = 15) {
  let nieuw = 0;
  for (const i of items) {
    const key = `${i.lat.toFixed(4)},${i.lon.toFixed(4)}`;
    if (!straatCache.has(key) && nieuw++ >= max) continue;
    const s = await straatBij(i.lat, i.lon);
    if (!s) continue;
    i.plaats = s.plaats;
    if (!i.kop) { i.weg = s.weg; i.kop = s.weg || null; }
  }
}

let bezig = false, bezigSinds = 0, laatsteOk = Date.now();
async function ronde() {
  if (bezig) return; // a slow round (first read of the planning feed) never overlaps the next one
  bezig = true; bezigSinds = Date.now();
  try { await rondeInner(); } finally { bezig = false; }
}

// Watchdog: a round that hangs for 6 minutes, or no fresh NDW data for 15 minutes, stops the process so Koyeb
// starts it again (a clean start instead of a service that answers but no longer fetches).
setInterval(() => {
  const m = process.memoryUsage();
  if (bezig && Date.now() - bezigSinds > 6 * 60_000) { console.error("[watchdog] ronde hangt, herstart"); process.exit(1); }
  if (Date.now() - laatsteOk > 15 * 60_000) { console.error("[watchdog] 15 min geen NDW-data, herstart"); process.exit(1); }
  if (m.rss > 450e6) { console.error(`[watchdog] geheugen ${Math.round(m.rss / 1e6)} MB, herstart`); process.exit(1); }
}, 30_000).unref();
setInterval(() => { const m = process.memoryUsage(); console.log(`[geheugen] rss ${Math.round(m.rss / 1e6)} MB, heap ${Math.round(m.heapUsed / 1e6)} MB`); }, 30 * 60_000).unref();

async function rondeInner() {
  let planNieuw = false;
  // Speed cameras: twice a day is plenty (they rarely change).
  // In the background: a slow Overpass server never holds up the traffic.
  if (Date.now() - staat.flitsersAt > 12 * 3600_000) {
    staat.flitsersAt = Date.now();
    flitsersUitOverpass(GEBIED).then((f) => { staat.flitsers = f; publiceer(); })
      .catch((e) => { console.error("[flitsers]", e.message || e); staat.flitsersAt = Date.now() - 11 * 3600_000; }); // retry in an hour
  }
  // Planning feed (cause, comments, time slots, and what is planned): every 10 minutes, as a stream.
  if (Date.now() - staat.planAt > 10 * 60_000) {
    try {
      const r = await haalPlan(GEBIED, staat.planEtag, UA);
      if (r) { staat.plan = r.kaart; staat.planEtag = r.etag; planNieuw = true; }
      staat.planAt = Date.now(); staat.planFout = null;
    } catch (e) { staat.planFout = String(e.message || e); staat.planAt = Date.now() - 7 * 60_000; console.error("[planning]", staat.planFout); }
  }
  try {
    const res = await fetch(NDW, { headers: { ...UA, ...(staat.ndwEtag ? { "if-none-match": staat.ndwEtag } : {}) }, signal: AbortSignal.timeout(30_000) });
    if (res.status === 304 && !(planNieuw && staat.xml)) { staat.opgehaald = new Date().toISOString(); staat.fout = null; laatsteOk = Date.now(); publiceer(); return; }
    if (res.status !== 304 && !res.ok) throw new Error(`NDW HTTP ${res.status}`);
    // Unchanged NDW file but a new planning feed: read the kept file again with the new planning.
    const xml = res.status === 304 ? staat.xml : zlib.gunzipSync(Buffer.from(await res.arrayBuffer())).toString("utf8");
    staat.xml = xml;
    const items = parseActueelBeeld(xml, GEBIED, Date.now(), staat.plan);
    const komt = gepland(staat.plan, GEBIED);
    // Street names: at most 15 new lookups per round (the rest follows next minute).
    await straten(items, 15);
    await straten(komt, 10);
    staat.items = items;
    staat.gepland = komt;
    staat.ndwTijd = (xml.match(/<com:publicationTime>([^<]+)</) || [])[1] || null;
    if (res.status !== 304) staat.ndwEtag = res.headers.get("etag");
    staat.opgehaald = new Date().toISOString();
    staat.fout = null;
    laatsteOk = Date.now();
  } catch (e) {
    staat.fout = String(e.message || e);
    console.error("[ndw]", staat.fout);
  }
  publiceer();
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/" || url.pathname === "/health") {
    // 503 when the data is stale (> 10 min): a Koyeb HTTP health check on /health then restarts the instance.
    const vers = Date.now() - laatsteOk < 10 * 60_000;
    res.writeHead(vers ? 200 : 503, { "content-type": "application/json" });
    return res.end(JSON.stringify({ ok: !staat.fout && vers, sinds: Math.round(process.uptime()), items: staat.items.length, gepland: staat.gepland.length, planning: staat.plan.size, flitsers: staat.flitsers.length,
      opgehaald: staat.opgehaald, fout: staat.fout, planFout: staat.planFout, vild: VILD_VERSIE }));
  }
  if (url.pathname === "/verkeer") {
    const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (!TOKEN || token.length !== TOKEN.length || !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(TOKEN))) {
      res.writeHead(401, { "content-type": "application/json" });
      return res.end('{"fout":"geen toegang"}');
    }
    if (!staat.json) { res.writeHead(503, { "retry-after": "30" }); return res.end(); }
    // x-opgehaald: when the NDW was last read, also on 304 (an unchanged list on a quiet night is still fresh).
    const opg = staat.opgehaald ? { "x-opgehaald": staat.opgehaald } : {};
    if (req.headers["if-none-match"] === staat.etag) { res.writeHead(304, { etag: staat.etag, ...opg }); return res.end(); }
    res.writeHead(200, { "content-type": "application/json", etag: staat.etag, "cache-control": "no-store", ...opg });
    return res.end(staat.json);
  }
  res.writeHead(404); res.end();
});

server.listen(PORT, () => console.log(`A-Alerts verkeer op poort ${PORT}, gebied ${JSON.stringify(GEBIED)}`));
await ronde();
setInterval(ronde, 60_000);
