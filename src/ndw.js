// Parses the NDW open data (DATEX II v3) into a small list of traffic items in a region:
//  - "actueel beeld" (https://opendata.ndw.nu/actueel_beeld.xml.gz): what is going on now: closures, roadworks,
//    accidents, breakdowns, obstacles and traffic jams, with lanes, speed limit and delay;
//  - the planning feed (planningsfeed_wegwerkzaamheden_en_evenementen.xml.gz): the same works with their cause
//    ("Groot onderhoud A1", "Kabels / leidingen"), comments ("Weg dicht in beide richtingen"), hindrance, time slots,
//    detours, and the works planned for the coming days.
// Road, direction and stretch come from the VILD location table ("A1 richting Amersfoort, tussen … en …").
// No XML library: the feed is regular, so every situation is read with a few regular expressions.
import { beschrijf, wegTekst, trajectTekst } from "./vild.js";

const tekst = (s) => String(s ?? "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const open = (tag) => `<[\\w]+:${tag}(?:\\s[^>]*)?>`;
const eerste = (xml, tag) => { const m = xml.match(new RegExp(`${open(tag)}([^<]*)</[\\w]+:${tag}>`)); return m ? tekst(m[1]) : null; };
const alle = (xml, tag) => [...xml.matchAll(new RegExp(`${open(tag)}([^<]*)</[\\w]+:${tag}>`, "g"))].map((m) => tekst(m[1]));
/** Texts inside every block with this name (e.g. generalPublicComment > comment > values > value). */
const waardenIn = (xml, blok) => [...xml.matchAll(new RegExp(`${open(blok)}([\\s\\S]*?)</[\\w]+:${blok}>`, "g"))].flatMap((m) => alle(m[1], "value")).filter(Boolean);

/** All coordinates of a record: lines (posList "lat lon lat lon …") and points. [[lat, lon], …] per part. */
function delen(xml) {
  const uit = [];
  for (const m of xml.matchAll(/<[\w]+:posList>([^<]*)<\/[\w]+:posList>/g)) {
    const v = m[1].trim().split(/\s+/).map(Number);
    const lijn = [];
    for (let i = 0; i + 1 < v.length; i += 2) if (Number.isFinite(v[i]) && Number.isFinite(v[i + 1])) lijn.push([v[i], v[i + 1]]);
    if (lijn.length) uit.push(lijn);
  }
  for (const m of xml.matchAll(/<[\w]+:pointCoordinates>\s*<[\w]+:latitude>([^<]*)<\/[\w]+:latitude>\s*<[\w]+:longitude>([^<]*)<\/[\w]+:longitude>/g)) {
    const p = [Number(m[1]), Number(m[2])];
    if (p.every(Number.isFinite)) uit.push([p]);
  }
  return uit;
}

/** Fewer points (Douglas-Peucker in degrees, ~10 m), at most max points. */
export function vereenvoudig(lijn, tol = 0.0001, max = 80) {
  if (lijn.length <= 2) return lijn;
  const dp = (pts, t) => {
    if (pts.length <= 2) return pts;
    const [a, b] = [pts[0], pts[pts.length - 1]];
    let best = -1, idx = 0;
    for (let i = 1; i < pts.length - 1; i++) {
      const [y, x] = pts[i], [y1, x1] = a, [y2, x2] = b;
      const dx = x2 - x1, dy = y2 - y1, l = dx * dx + dy * dy;
      const t0 = l ? Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / l)) : 0;
      const d = Math.hypot(x - (x1 + t0 * dx), y - (y1 + t0 * dy));
      if (d > best) { best = d; idx = i; }
    }
    if (best <= t) return [a, b];
    return [...dp(pts.slice(0, idx + 1), t).slice(0, -1), ...dp(pts.slice(idx), t)];
  };
  let t = tol, uit = dp(lijn, t);
  while (uit.length > max) { t *= 2; uit = dp(lijn, t); }
  return uit.map(([la, lo]) => [Math.round(la * 1e5) / 1e5, Math.round(lo * 1e5) / 1e5]);
}

// Region: the rectangle as a quick first check, then (when given) the municipal border of Apeldoorn incl. Teuge
// (g.poly, [lon, lat] points) with a margin of about 1 km, so roads along the border still count.
function binnenPoly(la, lo, poly) {
  let binnen = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > la) !== (yj > la) && lo < ((xj - xi) * (la - yi)) / (yj - yi) + xi) binnen = !binnen;
  }
  return binnen;
}
function dichtBijRand(la, lo, poly, km) {
  const kx = 111.32 * Math.cos((la * Math.PI) / 180), ky = 110.57; // km per degree
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const ax = (poly[j][0] - lo) * kx, ay = (poly[j][1] - la) * ky, bx = (poly[i][0] - lo) * kx, by = (poly[i][1] - la) * ky;
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    const t = l2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / l2)) : 0;
    if (Math.hypot(ax + t * dx, ay + t * dy) <= km) return true;
  }
  return false;
}
export const inGebied = ([la, lo], g) => la >= g.zuid && la <= g.noord && lo >= g.west && lo <= g.oost
  && (!g.poly || binnenPoly(la, lo, g.poly) || dichtBijRand(la, lo, g.poly, g.marge ?? 1)
    || (g.extra || []).some((e) => Math.hypot((la - e.lat) * 110.57, (lo - e.lon) * 111.32 * Math.cos((la * Math.PI) / 180)) <= e.km));

/**
 * Jams on the motorways people from the region drive on, in a wider strip than the region itself:
 * gebied.strook = { noord, zuid, oost, west, wegen: ["A1", "A50"] }. Only jams, only those roads.
 */
export const inStrook = ([la, lo], g) => Boolean(g.strook) && la >= g.strook.zuid && la <= g.strook.noord && lo >= g.strook.west && lo <= g.strook.oost;
export const strookWeg = (weg, g) => Boolean(g.strook) && g.strook.wegen.includes(weg);

/** ALERT-C location of a record: primary and secondary point code and the direction. */
function alertC(x) {
  const prim = x.match(/PrimaryPointLocation>[\s\S]*?<[\w]+:specificLocation>(\d+)</);
  const sec = x.match(/SecondaryPointLocation>[\s\S]*?<[\w]+:specificLocation>(\d+)</);
  const enkel = !prim && x.match(/<[\w]+:specificLocation>(\d+)</);
  const p = prim?.[1] || enkel?.[1];
  return p ? { primary: p, secondary: sec?.[1] || null, richting: eerste(x, "alertCDirectionCoded") } : null;
}

// Comments that say nothing to a road user, or that name people: left out.
const LEEG = /^(beperking|omleiding|werkvak|fase|werkzaamheden)\s*\d*\s*[:.]?\s*$|^project\s*:|^contactinformatie|projectleider|^overig,?$|^\d+$/i;
/** The useful comments of a situation: "Weg dicht in beide richtingen", "Havikshorst 2-132: inrichten van bouwplaats". */
export function opmerkingen(teksten) {
  const uit = [];
  for (let t of teksten) {
    t = tekst(t)
      .replace(/^(?:MIOG|MOIG)\s*:\s*[\d-]+\s*/i, "")
      .replace(/^(beperking|omleiding|werkvak|fase)\s*\d+\s*[:.-]\s*/i, "")
      .trim();
    if (!t || LEEG.test(t) || t.length < 4) continue;
    if (t.length > 220) t = `${t.slice(0, 217).replace(/\s+\S*$/, "")}…`;
    if (!uit.some((u) => u.toLowerCase() === t.toLowerCase())) uit.push(t);
  }
  return uit;
}

/** One situation (<sit:situation>…) → its id and records with what we need of them. */
export function leesSituatie(sitXml, sitId) {
  const records = [];
  for (const rm of sitXml.matchAll(/<sit:situationRecord\b([^>]*)>([\s\S]*?)<\/sit:situationRecord>/g)) {
    const attrs = rm[1], x = rm[2];
    records.push({
      type: (attrs.match(/xsi:type="[\w]+:(\w+)"/) || [])[1],
      id: (attrs.match(/\bid="([^"]+)"/) || [])[1] || sitId,
      x,
      ref: eerste(x, "situationRecordCreationReference"),
    });
  }
  return { id: sitId, records };
}

/** Every situation in a feed (string). */
export function* situaties(xml) {
  for (const sm of xml.matchAll(/<sit:situation\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/sit:situation>/g)) yield leesSituatie(sm[2], sm[1]);
}

/**
 * What kind of item a record is, with its Dutch title. null = not shown (diversions, speed limits, hard shoulder
 * running, bridge openings, weather: those are not what a driver in the region looks for here).
 */
function soortVan(type, x) {
  const oorzaak = alle(x, "causeType");
  const ongevalOorzaak = oorzaak.includes("accident");
  const commentaar = [...waardenIn(x, "generalPublicComment"), ...waardenIn(x, "causeDescription")].join(" ");
  switch (type) {
    case "Accident":
      return { soort: "ongeval", titel: "Ongeval" };
    case "VehicleObstruction": {
      const v = eerste(x, "vehicleObstructionType");
      if (/pijlwagen|voorwaarschuwing|botsabsorber/i.test(commentaar)) return { soort: "werk", titel: "Pijlwagen bij werk of incident" };
      if (v === "brokenDownVehicle") return { soort: "pech", titel: "Voertuig met pech" };
      return { soort: "pech", titel: "Stilstaand voertuig" };
    }
    case "GeneralObstruction":
      return { soort: "pech", titel: eerste(x, "obstructionType") === "spillageOnTheRoad" ? "Lading of vloeistof op de weg" : "Obstakel op de weg" };
    case "AbnormalTraffic": {
      const a = eerste(x, "abnormalTrafficType");
      return { soort: "file", titel: a === "stationaryTraffic" ? "Stilstaand verkeer" : a === "queuingTraffic" ? "File" : "Langzaam rijdend verkeer" };
    }
    case "MaintenanceWorks":
      return { soort: "werk", titel: "Werkzaamheden" };
    case "RoadOrCarriagewayOrLaneManagement": {
      const m = eerste(x, "roadOrCarriagewayOrLaneManagementType");
      if (ongevalOorzaak) return { soort: "ongeval", titel: m === "laneClosures" ? "Ongeval, rijstrook dicht" : "Ongeval, weg afgesloten" };
      if (m === "carriagewayClosures" || m === "roadClosed") {
        if (oorzaak.includes("publicEvent")) return { soort: "afsluiting", titel: "Afgesloten voor evenement" };
        // Only a slip road or a link road closed: say which.
        const baan = alle(x, "carriageway");
        if (baan.includes("exitSlipRoad")) return { soort: "afsluiting", titel: "Afrit dicht" };
        if (baan.includes("entrySlipRoad")) return { soort: "afsluiting", titel: "Oprit dicht" };
        if (baan.includes("connectingCarriageway")) return { soort: "afsluiting", titel: "Verbindingsweg dicht" };
        return { soort: "afsluiting", titel: oorzaak.includes("roadMaintenance") || oorzaak.includes("constructionWork") ? "Afgesloten voor werkzaamheden" : "Weg afgesloten" };
      }
      const werk = oorzaak.some((o) => ["roadMaintenance", "constructionWork"].includes(o));
      if (!werk && m === "laneClosures") {
        if (/storing|pech|berger|gestrand|defect/i.test(commentaar)) return { soort: "pech", titel: "Voertuig met pech, rijstrook dicht" };
        if (/ongeval|aanrijding|botsing/i.test(commentaar)) return { soort: "ongeval", titel: "Ongeval, rijstrook dicht" };
        return { soort: "pech", titel: "Rijstrook dicht" };
      }
      if (["laneClosures", "lanesDeviated", "narrowLanes", "other", "useOfSpecifiedLanesOrCarriagewaysAllowed"].includes(m)) {
        if (!oorzaak.some((o) => ["roadMaintenance", "constructionWork", "other"].includes(o)) && m === "other") return null;
        return { soort: "werk", titel: m === "laneClosures" ? "Rijstrook dicht voor werkzaamheden" : m === "narrowLanes" ? "Versmalde rijstroken" : m === "lanesDeviated" ? "Rijstroken verlegd" : "Werkzaamheden" };
      }
      return null;
    }
    default:
      return null;
  }
}

const RANG = { ongeval: 0, afsluiting: 1, file: 2, pech: 3, werk: 4 };
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const BRON_RWS = /^(NLRWS|RWS\d*|ON\b|ON-|MN-|ZN-|WNN|WNZ|NN-|NN\b|ZN\b|MN\b|WN)/;
const bronNaam = (b) => (b && BRON_RWS.test(b) ? "Rijkswaterstaat" : b && /^NDW|TSNED|RoadSafety/i.test(b) ? "NDW" : b);

/** Everything a situation tells us beyond its kind: road, lanes, speed, cause, comments, hindrance, time slots. */
function details(sit, hoofd = null) {
  const recs = sit.records.filter((r) => r.type !== "ReroutingManagement");
  const x = recs.map((r) => r.x).join("\n");
  const lijnRec = [hoofd, ...recs].find((r) => r && /alertC(Linear|Point)/.test(r.x));
  const ac = lijnRec ? alertC(lijnRec.x) : null;
  const b = ac ? beschrijf(ac) : null;
  // Only motorways and provincial roads by their number ("A1", "N345"); municipal VILD roads ("G042") get the street name.
  const hoofdweg = /^[AN]\d+/.test(b?.weg || "");
  const dicht = Math.max(0, ...alle(x, "numberOfLanesRestricted").map(Number).filter(Number.isFinite));
  const open_ = alle(x, "numberOfOperationalLanes").map(Number).filter(Number.isFinite);
  const totaal = Math.max(0, ...alle(x, "originalNumberOfLanes").map(Number).filter(Number.isFinite));
  const snelheid = Math.min(...alle(x, "temporarySpeedLimit").map(Number).filter((v) => v > 0), Infinity);
  const hinder = Math.max(0, ...alle(x, "roadworkHindranceClass").map((h) => Number(h.replace(/\D/g, ""))).filter(Number.isFinite));
  const vertraging = Math.max(0, ...alle(x, "delayTimeValue").map(Number).filter(Number.isFinite));
  const oorzaken = [...new Set(waardenIn(x, "causeDescription")
    .map((t) => t.split(/\s*,\s*/).filter((d) => d.length > 3 && !/^overig$/i.test(d)).join(", ").replace(/[.,]\s*$/, ""))
    .filter(Boolean))];
  const periodes = [...x.matchAll(/<[\w]+:startOfPeriod>([^<]+)<\/[\w]+:startOfPeriod>\s*<[\w]+:endOfPeriod>([^<]+)</g)]
    .map((m) => [Date.parse(m[1]), Date.parse(m[2])]).filter(([a, e]) => a && e);
  return {
    weg: hoofdweg ? b.weg : null, richting: b?.richting || null, vanaf: hoofdweg ? b?.vanaf || null : null, kop: hoofdweg ? wegTekst(b) : null, traject: trajectTekst(b),
    rijstroken: open_.length ? { open: Math.min(...open_), totaal: totaal || (Math.min(...open_) + dicht) || null } : null,
    max_snelheid: Number.isFinite(snelheid) ? Math.round(snelheid) : null,
    oorzaak: oorzaken[0] || null,
    // Municipal permits repeat street, kind and number ("Woestijnweg Vaassen Herinrichting … (607293)"): left out.
    toelichting: opmerkingen(waardenIn(x, "generalPublicComment")).filter((t) => !/^(pijlwagen|voorwaarschuwing|botsabsorber)$/i.test(t) && !/\(\d{5,}\)\s*$/.test(t)).slice(0, 2),
    hinder: hinder || null,
    vertraging_min: vertraging > 0 ? Math.round(vertraging / 60) : null,
    omleiding: sit.records.some((r) => r.type === "ReroutingManagement") || /omleiding/i.test(x.match(/generalPublicComment[\s\S]*?<\/[\w]+:generalPublicComment>/g)?.join(" ") || ""),
    info_url: (alle(x, "urlLinkAddress").find((u) => /^https:\/\//.test(u) && !/melvin\.ndw\.nu\/attachment/.test(u))) || null,
    periodes,
  };
}

/** The next time slots (at most 3, within 14 days), as ISO pairs. */
function volgendeTijdvakken(periodes, now) {
  const uniek = [...new Map(periodes.map((p) => [`${p[0]}-${p[1]}`, p])).values()];
  return uniek.filter(([, e]) => e > now).sort((a, b) => a[0] - b[0]).slice(0, 3)
    .filter(([a]) => a < now + 14 * 86_400_000).map(([a, e]) => [new Date(a).toISOString(), new Date(e).toISOString()]);
}

/** The keys under which a situation of "actueel beeld" can be found in the planning feed. */
export function planSleutels(sit) {
  const k = new Set([sit.id, sit.id.replace(/_WWA$/, "")]);
  for (const r of sit.records) {
    if (!r.ref) continue;
    k.add(r.ref.replace(/_WWA$/, ""));
    const m = r.ref.match(/^(NDW\d+_\d+)_/);
    if (m) k.add(m[1]);
    const rws = r.ref.match(/^(RWS\d+)_M(\d+)_/);
    if (rws) k.add(`${rws[1]}_SM${rws[2]}_D2`);
  }
  return [...k];
}

/** One situation → one item (the most important record wins), or null. */
function itemVan(sit, gebied, now, { gepland = false, plan = null } = {}) {
  let beste = null;
  for (const r of sit.records) {
    const s = soortVan(r.type, r.x);
    if (!s) continue;
    if (!beste || RANG[s.soort] < RANG[beste.s.soort]) beste = { r, s };
  }
  if (!beste) return null;
  // A diversion can run far outside the region: only the place of the works itself counts.
  const lijnen = sit.records.filter((r) => r.type !== "ReroutingManagement").flatMap((r) => delen(r.x));
  const punten = lijnen.flat();
  if (!punten.length) return null;
  // Outside the region only a jam counts, and only in the strip along the A1 and A50 (checked on the road name below).
  const alleenStrook = !punten.some((p) => inGebied(p, gebied));
  if (alleenStrook && !(beste.s.soort === "file" && !gepland && punten.some((p) => inStrook(p, gebied)))) return null;
  const x = beste.r.x;
  const start = Math.min(...sit.records.map((r) => Date.parse(eerste(r.x, "overallStartTime") || "") || Infinity));
  const eindes = sit.records.map((r) => Date.parse(eerste(r.x, "overallEndTime") || "") || 0).filter(Boolean);
  const einde = eindes.length ? Math.max(...eindes) : null;
  if (!gepland && Number.isFinite(start) && start > now + 60_000) return null; // planned, not yet running
  if (einde && einde < now) return null;
  const lijn = lijnen.filter((l) => l.length > 1).sort((a, b) => b.length - a.length)[0] || null;
  const punt = lijn ? lijn[Math.floor(lijn.length / 2)] : punten[0];
  const d = details(sit, beste.r);
  const p = plan ? details(plan) : null;
  const lengte = num(eerste(x, "queueLength"));
  if (alleenStrook && !strookWeg(d.weg || p?.weg || null, gebied)) return null;
  return {
    id: sit.id, soort: beste.s.soort, titel: beste.s.titel,
    // "A1 richting Amersfoort" and "tussen afrit 22 Twello en afrit 18 Kootwijk" (roads of Rijkswaterstaat).
    kop: d.kop || p?.kop || null, traject: d.traject || p?.traject || null, weg: d.weg || p?.weg || null, richting: d.richting || p?.richting || null,
    // "Apeldoorn → Amersfoort": where the stretch comes from and goes to (motorways and provincial roads).
    vanaf: d.vanaf || p?.vanaf || null,
    oorzaak: d.oorzaak || p?.oorzaak || null,
    toelichting: [...new Set([...d.toelichting, ...(p?.toelichting || [])])].slice(0, 2),
    opmerking: [...new Set([...waardenIn(x, "generalPublicComment"), ...waardenIn(x, "causeDescription")])]
      .filter((t) => !/^(pijlwagen|voorwaarschuwing|botsabsorber|overig)$/i.test(t)).join(" ") || null,
    rijstroken: d.rijstroken || p?.rijstroken || null, max_snelheid: d.max_snelheid || p?.max_snelheid || null,
    hinder: d.hinder || p?.hinder || null, omleiding: d.omleiding || Boolean(p?.omleiding),
    info_url: d.info_url || p?.info_url || null,
    tijdvakken: volgendeTijdvakken([...d.periodes, ...(p?.periodes || [])], now),
    bron: bronNaam(waardenIn(x, "sourceName")[0] || null),
    start: Number.isFinite(start) ? new Date(start).toISOString() : null, einde: einde ? new Date(einde).toISOString() : null,
    lat: punt[0], lon: punt[1],
    lijn: lijn ? vereenvoudig(lijn).map(([la, lo]) => [lo, la]) : null, // [lon, lat] like GeoJSON
    vertraging_min: (beste.s.soort === "file" ? d.vertraging_min : null) ?? null,
    lengte_km: lengte && lengte > 0 ? Math.round(lengte / 100) / 10 : null,
  };
}

function sorteer(items) {
  const gezien = new Set();
  return items
    .sort((a, b) => (RANG[a.soort] - RANG[b.soort]) || ((Date.parse(b.start || 0) || 0) - (Date.parse(a.start || 0) || 0)))
    .filter((i) => { const k = `${i.soort}|${i.titel}|${i.lat.toFixed(3)}|${i.lon.toFixed(3)}`; if (gezien.has(k)) return false; gezien.add(k); return true; });
}

/**
 * What is going on now in the region. gebied = { noord, zuid, oost, west } in degrees; now = ms;
 * plan = Map of planning-feed situations by id (for cause, comments, hindrance, time slots).
 */
export function parseActueelBeeld(xml, gebied, now = Date.now(), plan = null) {
  const uit = [];
  for (const sit of situaties(xml)) {
    const p = plan ? planSleutels(sit).map((k) => plan.get(k)).find(Boolean) || null : null;
    const i = itemVan(sit, gebied, now, { plan: p });
    if (i) uit.push(i);
  }
  return sorteer(uit);
}

/** A planning-feed situation is in the region (cheap check before the full read). */
export function inRegio(sitXml, gebied) {
  for (const m of sitXml.matchAll(/<[\w]+:posList>([^<]*)</g)) {
    const v = m[1].trim().split(/\s+/).map(Number);
    for (let i = 0; i + 1 < v.length; i += 2) if (inGebied([v[i], v[i + 1]], gebied)) return true;
  }
  for (const m of sitXml.matchAll(/<[\w]+:latitude>([^<]*)<\/[\w]+:latitude>\s*<[\w]+:longitude>([^<]*)</g)) if (inGebied([Number(m[1]), Number(m[2])], gebied)) return true;
  return false;
}

/** Works and events in the planning feed that start in the coming days (not yet running): "Gepland". */
export function gepland(plan, gebied, now = Date.now(), dagen = 7) {
  const uit = [];
  for (const sit of plan.values()) {
    const starts = sit.records.map((r) => Date.parse(eerste(r.x, "overallStartTime") || "") || Infinity);
    const start = Math.min(...starts);
    if (!(start > now + 60_000 && start < now + dagen * 86_400_000)) continue;
    const i = itemVan(sit, gebied, now, { gepland: true, plan: sit });
    if (i && (i.soort === "afsluiting" || i.soort === "werk")) uit.push(i);
  }
  return uit.sort((a, b) => Date.parse(a.start) - Date.parse(b.start)).slice(0, 40);
}
