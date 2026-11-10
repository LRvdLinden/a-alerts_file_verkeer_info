// A-Alerts verkeer: reads the NDW open data every minute, keeps the traffic items of the region (closures, roadworks,
// accidents, breakdowns, traffic jams) and the fixed speed cameras from OpenStreetMap, and hands them to the A-Alerts
// server (Cloudflare Worker) on GET /verkeer with a token. The worker asks every minute, which also keeps this free
// Koyeb instance awake. Nothing is written anywhere: this service only reads open data.
import http from "node:http";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { parseActueelBeeld } from "./ndw.js";
import { flitsersUitOverpass } from "./flitsers.js";

const PORT = Number(process.env.PORT) || 8000;
const TOKEN = process.env.VERKEER_TOKEN || "";
// Region: north, south, east, west (default: Apeldoorn with the A1, A50, the villages and Teuge).
const [noord, zuid, oost, west] = (process.env.GEBIED || "52.33,52.05,6.15,5.75").split(",").map(Number);
const GEBIED = { noord, zuid, oost, west };
const NDW = "https://opendata.ndw.nu/actueel_beeld.xml.gz";
const UA = { "user-agent": "A-Alerts verkeer (+https://a-alerts.nl)" };

const staat = { items: [], flitsers: [], ndwTijd: null, opgehaald: null, fout: null, etag: null, json: null, flitsersAt: 0, ndwEtag: null };
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
  const body = { bijgewerkt: staat.ndwTijd, opgehaald: staat.opgehaald, gebied: GEBIED, items: staat.items, flitsers: staat.flitsers };
  const json = JSON.stringify(body);
  const etag = `"${crypto.createHash("sha1").update(JSON.stringify([staat.items, staat.flitsers])).digest("base64url").slice(0, 16)}"`;
  staat.json = json; staat.etag = etag;
}

async function ronde() {
  try {
    const res = await fetch(NDW, { headers: { ...UA, ...(staat.ndwEtag ? { "if-none-match": staat.ndwEtag } : {}) }, signal: AbortSignal.timeout(30_000) });
    if (res.status === 304) { staat.opgehaald = new Date().toISOString(); staat.fout = null; return; }
    if (!res.ok) throw new Error(`NDW HTTP ${res.status}`);
    const xml = zlib.gunzipSync(Buffer.from(await res.arrayBuffer())).toString("utf8");
    const items = parseActueelBeeld(xml, GEBIED);
    // Street names: at most 15 new lookups per round (the rest follows next minute).
    let nieuw = 0;
    for (const i of items) {
      const key = `${i.lat.toFixed(4)},${i.lon.toFixed(4)}`;
      if (!straatCache.has(key) && nieuw++ >= 15) continue;
      const s = await straatBij(i.lat, i.lon);
      if (s) { i.weg = s.weg; i.plaats = s.plaats; }
    }
    staat.items = items;
    staat.ndwTijd = (xml.match(/<com:publicationTime>([^<]+)</) || [])[1] || null;
    staat.ndwEtag = res.headers.get("etag");
    staat.opgehaald = new Date().toISOString();
    staat.fout = null;
  } catch (e) {
    staat.fout = String(e.message || e);
    console.error("[ndw]", staat.fout);
  }
  publiceer();
  // Speed cameras: twice a day is plenty (they rarely change).
  if (Date.now() - staat.flitsersAt > 12 * 3600_000) {
    try { staat.flitsers = await flitsersUitOverpass(GEBIED); staat.flitsersAt = Date.now(); }
    catch (e) { console.error("[flitsers]", e.message || e); staat.flitsersAt = Date.now() - 11 * 3600_000; } // retry in an hour
    publiceer();
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/" || url.pathname === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ ok: !staat.fout, items: staat.items.length, flitsers: staat.flitsers.length, opgehaald: staat.opgehaald, fout: staat.fout }));
  }
  if (url.pathname === "/verkeer") {
    const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (!TOKEN || token.length !== TOKEN.length || !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(TOKEN))) {
      res.writeHead(401, { "content-type": "application/json" });
      return res.end('{"fout":"geen toegang"}');
    }
    if (!staat.json) { res.writeHead(503, { "retry-after": "30" }); return res.end(); }
    if (req.headers["if-none-match"] === staat.etag) { res.writeHead(304, { etag: staat.etag }); return res.end(); }
    res.writeHead(200, { "content-type": "application/json", etag: staat.etag, "cache-control": "no-store" });
    return res.end(staat.json);
  }
  res.writeHead(404); res.end();
});

server.listen(PORT, () => console.log(`A-Alerts verkeer op poort ${PORT}, gebied ${JSON.stringify(GEBIED)}`));
await ronde();
setInterval(ronde, 60_000);
