// Fixed speed cameras in the region from OpenStreetMap (Overpass API, ODbL: credit "© OpenStreetMap-bijdragers").
// Mobile speed checks are in no open source and are not shown.
export async function flitsersUitOverpass(g) {
  const q = `[out:json][timeout:25];(node["highway"="speed_camera"](${g.zuid},${g.west},${g.noord},${g.oost});node["enforcement"="maxspeed"](${g.zuid},${g.west},${g.noord},${g.oost}););out body;`;
  const res = await fetch("https://overpass-api.de/api/interpreter", {
    method: "POST", body: new URLSearchParams({ data: q }),
    headers: { "user-agent": "A-Alerts verkeer (+https://a-alerts.nl)" }, signal: AbortSignal.timeout(40_000),
  });
  if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`);
  return flitsersUitJson(await res.json());
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
