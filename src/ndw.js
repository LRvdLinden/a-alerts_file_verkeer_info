// Parses the NDW "actueel beeld" (DATEX II v3, https://opendata.ndw.nu/actueel_beeld.xml.gz) into a small list of
// traffic items in a region: closures, roadworks, accidents, breakdowns, obstacles and traffic jams.
// No XML library: the feed is regular, so every situation record is read with a few regular expressions.

const tekst = (s) => String(s ?? "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const open = (tag) => `<[\\w]+:${tag}(?:\\s[^>]*)?>`;
const eerste = (xml, tag) => { const m = xml.match(new RegExp(`${open(tag)}([^<]*)</[\\w]+:${tag}>`)); return m ? tekst(m[1]) : null; };
const alle = (xml, tag) => [...xml.matchAll(new RegExp(`${open(tag)}([^<]*)</[\\w]+:${tag}>`, "g"))].map((m) => tekst(m[1]));
/** Text inside a block (e.g. generalPublicComment > values > value). */
const waardenIn = (xml, blok) => {
  const m = xml.match(new RegExp(`${open(blok)}([\\s\\S]*?)</[\\w]+:${blok}>`));
  return m ? alle(m[1], "value").filter(Boolean) : [];
};

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

const inGebied = ([la, lo], g) => la >= g.zuid && la <= g.noord && lo >= g.west && lo <= g.oost;

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

/**
 * The items of the feed in the region, newest first.
 * gebied = { noord, zuid, oost, west } in degrees. now = ms (for the validity window).
 */
export function parseActueelBeeld(xml, gebied, now = Date.now()) {
  const uit = [];
  for (const sm of xml.matchAll(/<sit:situation\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/sit:situation>/g)) {
    const [, sitId, sitXml] = sm;
    for (const rm of sitXml.matchAll(/<sit:situationRecord\b([^>]*)>([\s\S]*?)<\/sit:situationRecord>/g)) {
      const attrs = rm[1], x = rm[2];
      const type = (attrs.match(/xsi:type="[\w]+:(\w+)"/) || [])[1];
      const id = (attrs.match(/\bid="([^"]+)"/) || [])[1] || sitId;
      const s = soortVan(type, x);
      if (!s) continue;
      const lijnen = delen(x);
      const alle_ = lijnen.flat();
      if (!alle_.length || !alle_.some((p) => inGebied(p, gebied))) continue;
      const start = Date.parse(eerste(x, "overallStartTime") || "") || null;
      const einde = Date.parse(eerste(x, "overallEndTime") || "") || null;
      if (start && start > now + 60_000) continue; // planned, not yet running
      if (einde && einde < now) continue;
      // The longest line part is the route on the map; a point when there is no line.
      const lijn = lijnen.filter((l) => l.length > 1).sort((a, b) => b.length - a.length)[0] || null;
      const punt = lijn ? lijn[Math.floor(lijn.length / 2)] : alle_[0];
      const bron = waardenIn(x, "sourceName")[0] || null;
      const opmerking = [...new Set([...waardenIn(x, "generalPublicComment"), ...waardenIn(x, "causeDescription")])]
        .filter((t) => !/^(pijlwagen|voorwaarschuwing|botsabsorber)$/i.test(t)).join(" ") || null;
      const vertraging = Number(eerste(x, "delayTimeValue"));
      const lengte = Number(eerste(x, "queueLength"));
      uit.push({
        sitId, id, soort: s.soort, titel: s.titel, opmerking,
        bron: bron && /^(NLRWS|RWS\d*|ON-|MN-|ZN-|WNN|WNZ|NN-)/.test(bron) ? "Rijkswaterstaat" : bron && /^NDW|TSNED|RoadSafety/i.test(bron) ? "NDW" : bron,
        start: start ? new Date(start).toISOString() : null, einde: einde ? new Date(einde).toISOString() : null,
        lat: punt[0], lon: punt[1],
        lijn: lijn ? vereenvoudig(lijn).map(([la, lo]) => [lo, la]) : null, // [lon, lat] like GeoJSON
        vertraging_min: Number.isFinite(vertraging) && vertraging > 0 ? Math.round(vertraging / 60) : null,
        lengte_km: Number.isFinite(lengte) && lengte > 0 ? Math.round(lengte / 100) / 10 : null,
      });
    }
  }
  // A situation often has several records (lane closed + lanes moved + speed): one item per situation, the most
  // important kind wins; the line of the longest record is kept. Same kind on the same spot: one item.
  const RANG = { ongeval: 0, afsluiting: 1, file: 2, pech: 3, werk: 4 };
  const perSit = new Map();
  for (const i of uit) {
    const oud = perSit.get(i.sitId);
    if (!oud || RANG[i.soort] < RANG[oud.soort] || (RANG[i.soort] === RANG[oud.soort] && (i.lijn?.length || 0) > (oud.lijn?.length || 0))) {
      perSit.set(i.sitId, oud && !i.lijn && oud.lijn ? { ...i, lijn: oud.lijn, lat: oud.lat, lon: oud.lon } : i);
    }
  }
  const gezien = new Set();
  return [...perSit.values()]
    .map(({ sitId, ...i }) => ({ ...i, id: sitId }))
    .sort((a, b) => (RANG[a.soort] - RANG[b.soort]) || ((Date.parse(b.start || 0) || 0) - (Date.parse(a.start || 0) || 0)))
    .filter((i) => { const k = `${i.soort}|${i.titel}|${i.lat.toFixed(3)}|${i.lon.toFixed(3)}`; if (gezien.has(k)) return false; gezien.add(k); return true; });
}
