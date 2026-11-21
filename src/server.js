// A-Alerts verkeer: hands the traffic of the region to the A-Alerts server (Cloudflare Worker) on GET /verkeer with a
// token. The worker asks every minute, which also keeps this free instance awake. Nothing is written anywhere.
//
// This main thread only answers HTTP and watches the work. Reading and parsing the NDW open data happens in a worker
// thread (werk.js). The service stopped answering twice (13 and 14 November 2026) and stayed dead until a new deploy:
// a stuck round froze everything, or the old watchdog ended the process and the host did not start it again. Now the
// process itself never stops: a worker that is silent for 5 minutes, crashes or runs out of memory is ended and
// started again, and /health keeps answering in the meantime.
import http from "node:http";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { Worker } from "node:worker_threads";

const PORT = Number(process.env.PORT) || 8000;
const TOKEN = process.env.VERKEER_TOKEN || "";
const UA = { "user-agent": "A-Alerts verkeer (+https://a-alerts.nl)" };
const STIL_MS = 5 * 60_000;

const staat = { json: null, etag: null, opgehaald: null, landelijk: null };
let gezond = {}, laatsteOk = Date.now(), laatsteTeken = Date.now(), starts = 0, werker = null, laatsteHerstart = null;

function start(reden) {
  starts++;
  if (reden) laatsteHerstart = { at: new Date().toISOString(), reden };
  laatsteTeken = Date.now();
  const w = new Worker(new URL("./werk.js", import.meta.url), { resourceLimits: { maxOldGenerationSizeMb: 300 } });
  werker = w;
  w.on("message", (m) => {
    laatsteTeken = Date.now();
    if (m.lijst) Object.assign(staat, m.lijst);
    if (m.gezond) { gezond = m.gezond; if (m.laatsteOk > laatsteOk) laatsteOk = m.laatsteOk; }
  });
  w.on("error", (e) => console.error("[werker] fout:", e.message || e));
  w.on("exit", (code) => {
    if (werker !== w) return;
    console.error(`[toezicht] werker gestopt (code ${code}), nieuwe over 5 s`);
    werker = null;
    setTimeout(() => start(`werker gestopt (code ${code})`), 5000);
  });
}
// A worker that gives no sign of life (it reports at the start and the end of every round): end it; "exit" starts a new one.
setInterval(() => {
  if (werker && Date.now() - laatsteTeken > STIL_MS) {
    console.error("[toezicht] werker 5 minuten stil, wordt gestopt");
    laatsteTeken = Date.now();
    const w = werker; werker = null;
    w.terminate().catch(() => {}).finally(() => start("5 minuten geen teken van leven"));
  }
}, 30_000);

// Helicopter positions for the A-Alerts Worker when adsb.lol refuses Cloudflare's shared addresses (HTTP 429):
// the same adsb.lol request from this service's own address, cached for 10 seconds. Only with the token.
const adsbCache = new Map();
async function adsb(req, res, url) {
  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!TOKEN || token.length !== TOKEN.length || !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(TOKEN))) {
    res.writeHead(401); return res.end();
  }
  const getal = (k, min, max) => { const v = Number(url.searchParams.get(k)); return Number.isFinite(v) && v >= min && v <= max ? v : null; };
  const lat = getal("lat", 50, 54), lon = getal("lon", 3, 8), nm = getal("nm", 1, 250);
  if (lat == null || lon == null || nm == null) { res.writeHead(400); return res.end(); }
  const key = `${lat}/${lon}/${nm}`, hit = adsbCache.get(key);
  if (hit && Date.now() - hit.at < 10_000) { res.writeHead(200, { "content-type": "application/json" }); return res.end(hit.body); }
  try {
    const r = await fetch(`https://api.adsb.lol/v2/point/${key}`, { headers: { accept: "application/json", ...UA }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) { res.writeHead(502, { "content-type": "application/json" }); return res.end(JSON.stringify({ fout: `adsb.lol HTTP ${r.status}` })); }
    const body = await r.text();
    adsbCache.clear(); adsbCache.set(key, { at: Date.now(), body });
    res.writeHead(200, { "content-type": "application/json" }); res.end(body);
  } catch (e) {
    res.writeHead(502, { "content-type": "application/json" }); res.end(JSON.stringify({ fout: String(e.message || e) }));
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/" || url.pathname === "/health") {
    // 503 when the data is stale (> 10 min): a Koyeb HTTP health check on /health then restarts the instance.
    const vers = Date.now() - laatsteOk < 10 * 60_000;
    res.writeHead(vers ? 200 : 503, { "content-type": "application/json" });
    return res.end(JSON.stringify({ ok: !gezond.fout && vers, sinds: Math.round(process.uptime()), ...gezond, herstarts: starts - 1, laatsteHerstart }));
  }
  if (url.pathname === "/adsb") return adsb(req, res, url);
  if (url.pathname === "/verkeer") {
    const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (!TOKEN || token.length !== TOKEN.length || !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(TOKEN))) {
      res.writeHead(401, { "content-type": "application/json" });
      return res.end('{"fout":"geen toegang"}');
    }
    // ?landelijk=1: all of the Netherlands (items with "regio": true/false). Without it: the region only, as before.
    const lijst = url.searchParams.get("landelijk") === "1" && staat.landelijk ? staat.landelijk : staat;
    if (!lijst.json) { res.writeHead(503, { "retry-after": "30" }); return res.end(); }
    // x-opgehaald: when the NDW was last read, also on 304 (an unchanged list on a quiet night is still fresh).
    const opg = staat.opgehaald ? { "x-opgehaald": staat.opgehaald } : {};
    if (req.headers["if-none-match"] === lijst.etag) { res.writeHead(304, { etag: lijst.etag, ...opg }); return res.end(); }
    // gzip when asked (the national list is some hundreds of kB; compressed a tenth of that). Kept per list version.
    if (/\bgzip\b/.test(req.headers["accept-encoding"] || "")) {
      if (lijst.gzEtag !== lijst.etag) { lijst.gz = zlib.gzipSync(lijst.json); lijst.gzEtag = lijst.etag; }
      res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip", vary: "accept-encoding", etag: lijst.etag, "cache-control": "no-store", ...opg });
      return res.end(lijst.gz);
    }
    res.writeHead(200, { "content-type": "application/json", etag: lijst.etag, "cache-control": "no-store", ...opg });
    return res.end(lijst.json);
  }
  res.writeHead(404); res.end();
});

server.listen(PORT, () => console.log(`A-Alerts verkeer op poort ${PORT}`));
start();
