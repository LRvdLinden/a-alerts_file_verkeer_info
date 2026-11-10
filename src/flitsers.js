// Fixed speed cameras in the region from OpenStreetMap (Overpass API, ODbL: credit "© OpenStreetMap-bijdragers").
// Mobile speed checks are in no open source and are not shown.
export async function flitsersUitOverpass(g) {
  const q = `[out:json][timeout:25];(node["highway"="speed_camera"](${g.zuid},${g.west},${g.noord},${g.oost});node["enforcement"="maxspeed"](${g.zuid},${g.west},${g.noord},${g.oost}););out body;`;
  // The main Overpass server is often busy (502/504): then the public mirrors.
  const fouten = [];
  for (const server of ["https://overpass-api.de/api/interpreter", "https://overpass.private.coffee/api/interpreter", "https://maps.mail.ru/osm/tools/overpass/api/interpreter"]) {
    try {
      const res = await fetch(server, {
        method: "POST", body: new URLSearchParams({ data: q }),
        headers: { "user-agent": "A-Alerts-verkeer/1.0 (+https://a-alerts.nl)", accept: "application/json" }, signal: AbortSignal.timeout(40_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return flitsersUitJson(await res.json());
    } catch (e) { fouten.push(`${new URL(server).host}: ${e.message || e}`); }
  }
  throw new Error(`Overpass: ${fouten.join("; ")}`);
}

export function flitsersUitJson(d) {
  const gezien = new Set();
  return (d?.elements || [])
    .filter((e) => e.type === "node" && Number.isFinite(e.lat) && Number.isFinite(e.lon))
    .filter((e) => { const k = `${e.lat.toFixed(4)},${e.lon.toFixed(4)}`; if (gezien.has(k)) return false; gezien.add(k); return true; })
    .map((e) => ({
      id: `osm:${e.id}`, lat: Math.round(e.lat * 1e5) / 1e5, lon: Math.round(e.lon * 1e5) / 1e5,
      max: Number.parseInt(e.tags?.maxspeed, 10) || null, soort: /average|traject/i.test(e.tags?.["speed_camera"] || e.tags?.enforcement || "") ? "trajectcontrole" : "flitser",
    }));
}
