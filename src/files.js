// Traffic jams from the NDW loop detectors (open data), the way traffic sites compute them themselves:
// the measurement sites on the main carriageways in the region (measurement_current), and every minute the measured
// speeds (trafficspeed). A run of sites in a row on the same road and direction where traffic goes slower than
// 50 km/h is a jam, with its length, its delay compared to free flow and the stretch from the VILD table.
import zlib from "node:zlib";
import { beschrijf, trajectTekst } from "./vild.js";
import { inGebied } from "./ndw.js";

export const SITES_URL = "https://opendata.ndw.nu/measurement_current.xml.gz";
export const SPEED_URL = "https://opendata.ndw.nu/trafficspeed.xml.gz";

const DREMPEL = 50; // km/h: slower is a jam
const STIL = 25; // km/h: slower is standing traffic
const VRIJ = { A: 100, N: 80 }; // km/h free flow, for the delay

/**
 * The measurement sites of the region from the site table (gzip stream, about 10 MB, read in pieces):
 * only Rijkswaterstaat loops on main carriageways, with road and direction from the VILD table and the km from the id.
 */
export async function leesSites(gzStream, gebied) {
  const sites = new Map();
  const dec = new TextDecoder();
  let buf = "";
  const verwerk = (rec) => {
    const id = /^<measurementSiteRecord id="([^"]+)"/.exec(rec)?.[1];
    // RWS01_MONIBAS_0011hrl1368ra: road 001, main carriageway left/right (hrl/hrr), km 136.8
    const m = id && /^RWS01_MONIBAS_\d{4}(hr[lr])(\d{4})/.exec(id);
    if (!m) return;
    if (!/<carriageway>mainCarriageway</.test(rec)) return;
    const pos = /<locationForDisplay><latitude>([^<]+)<\/latitude><longitude>([^<]+)</.exec(rec);
    if (!pos) return;
    const lat = Number(pos[1]), lon = Number(pos[2]);
    if (!inGebied([lat, lon], gebied)) return;
    const loc = Number(/<alertCMethod4PrimaryPointLocation><alertCLocation><specificLocation>(\d+)/.exec(rec)?.[1]);
    const richting = /<alertCDirectionCoded>(\w+)</.exec(rec)?.[1];
    const b = loc ? beschrijf({ primary: loc, richting }) : null;
    if (!b?.weg || !/^[AN]\d/.test(b.weg)) return;
    sites.set(id, { id, lat, lon, loc, richting, weg: b.weg, naar: b.richting, vanaf: b.vanaf, km: Number(m[2]) / 10 });
  };
  for await (const stuk of gzStream.pipe(zlib.createGunzip())) {
    buf += dec.decode(stuk, { stream: true });
    let e;
    while ((e = buf.indexOf("</measurementSiteRecord>")) !== -1) {
      const s = buf.lastIndexOf("<measurementSiteRecord ", e);
      if (s !== -1) verwerk(buf.slice(s, e));
      buf = buf.slice(e + 24);
    }
    if (buf.length > 4_000_000) buf = buf.slice(-1_000_000);
  }
  return sites;
}

/**
 * Speed per site (flow-weighted average over the lanes) from the trafficspeed publication (gzip, ~1 MB; 50 MB as
 * text), read in pieces so memory stays low; only our sites.
 */
export async function leesSnelhedenStream(gzStream, sites) {
  const uit = new Map(), dec = new TextDecoder();
  let buf = "";
  for await (const stuk of gzStream.pipe(zlib.createGunzip())) {
    buf += dec.decode(stuk, { stream: true });
    let e;
    while ((e = buf.indexOf("</siteMeasurements>")) !== -1) {
      const s = buf.lastIndexOf("<siteMeasurements", e);
      if (s !== -1) snelheidVan(buf.slice(s, e), sites, uit);
      buf = buf.slice(e + 19);
    }
    if (buf.length > 2_000_000) buf = buf.slice(-500_000);
  }
  return uit;
}

export function leesSnelheden(xml, sites) {
  const uit = new Map();
  for (const deel of xml.split("<siteMeasurements").slice(1)) snelheidVan(deel, sites, uit);
  return uit;
}

function snelheidVan(deel, sites, uit) {
  {
    const id = /measurementSiteReference id="([^"]+)"/.exec(deel)?.[1];
    if (!id || !sites.has(id)) return;
    let som = 0, gewicht = 0, flow = null;
    for (const m of deel.matchAll(/<vehicleFlowRate>(-?\d+)<|<speed>(-?[\d.]+)</g)) {
      if (m[1] != null) flow = Number(m[1]);
      else {
        const v = Number(m[2]);
        if (v > 0 && flow !== 0) { const w = flow > 0 ? flow : 1; som += v * w; gewicht += w; }
        flow = null;
      }
    }
    if (gewicht) uit.set(id, som / gewicht);
  }
}

/** Jams: runs of slow sites per road and direction (one missing site in between is allowed). */
export function bepaalFiles(sites, snel, now = Date.now(), eerder = new Map()) {
  const groepen = new Map();
  for (const s of sites.values()) {
    const k = `${s.weg}|${s.richting}`;
    (groepen.get(k) || groepen.set(k, []).get(k)).push(s);
  }
  const files = [];
  for (const lijst of groepen.values()) {
    // In driving direction: positive = km going up for most roads is not guaranteed, so order by km and let the
    // alertC direction decide which end is the head (the downstream end).
    lijst.sort((a, b) => a.km - b.km);
    // The whole road through the region: "richting" from the farthest downstream site, "vanaf" from the farthest upstream.
    const op = lijst[0].richting === "positive";
    const eind = { naar: (op ? lijst[lijst.length - 1] : lijst[0]).naar, vanaf: (op ? lijst[0] : lijst[lijst.length - 1]).vanaf };
    let run = [], gat = 0;
    const sluit = () => {
      if (run.length >= 2) files.push(maakFile(run, snel, now, eerder, eind));
      run = []; gat = 0;
    };
    for (const s of lijst) {
      const v = snel.get(s.id);
      if (v != null && v < DREMPEL) { run.push(s); gat = 0; }
      else if (v == null && run.length && gat === 0) gat = 1;
      else sluit();
    }
    sluit();
  }
  return files.filter((f) => f.lengte_km >= 0.5);
}

function maakFile(run, snel, now, eerder, eind) {
  const s0 = { ...run[0], naar: eind.naar || run[0].naar, vanaf: eind.vanaf || run[0].vanaf };
  // Head = downstream end. Along the road the km either rise or fall in the driving direction; the alertC direction
  // "positive" follows the order of the location table, which on Dutch roads runs with the hectometre posts.
  const opKm = s0.richting === "positive";
  const kop = opKm ? run[run.length - 1] : run[0], staart = opKm ? run[0] : run[run.length - 1];
  const lengte = Math.abs(run[run.length - 1].km - run[0].km) + 0.3;
  const vrij = VRIJ[s0.weg[0]] || 80;
  let vertraging = 0, minSnel = Infinity;
  for (let i = 0; i < run.length; i++) {
    const v = Math.max(5, snel.get(run[i].id) ?? DREMPEL);
    minSnel = Math.min(minSnel, v);
    const stuk = i < run.length - 1 ? Math.abs(run[i + 1].km - run[i].km) : 0.3;
    vertraging += stuk * (60 / v - 60 / vrij);
  }
  const b = beschrijf({ primary: kop.loc, secondary: staart.loc !== kop.loc ? staart.loc : null, richting: s0.richting });
  const id = `file-${s0.weg}-${s0.richting}-${Math.round(kop.km)}`;
  const start = eerder.get(id) || new Date(now).toISOString();
  const lijn = (opKm ? run : [...run].reverse()).map((s) => [s.lon, s.lat]);
  return {
    id, soort: "file", titel: minSnel < STIL ? "Stilstaand verkeer" : "File",
    kop: `${s0.weg}${s0.naar ? ` richting ${s0.naar}` : ""}`, traject: trajectTekst(b), weg: s0.weg, richting: s0.naar || null,
    vanaf: s0.vanaf || null, oorzaak: null, toelichting: [], opmerking: null, rijstroken: null, max_snelheid: null,
    hinder: lengte >= 5 || vertraging >= 15 ? 3 : lengte >= 2 || vertraging >= 5 ? 2 : 1, omleiding: null, info_url: null,
    tijdvakken: [], bron: "meetlussen", start, einde: null, lat: kop.lat, lon: kop.lon, lijn,
    vertraging_min: Math.max(1, Math.round(vertraging)), lengte_km: Math.round(lengte * 10) / 10,
  };
}
