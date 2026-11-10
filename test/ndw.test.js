import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import zlib from "node:zlib";
import { parseActueelBeeld, vereenvoudig } from "../src/ndw.js";
import { flitsersUitJson } from "../src/flitsers.js";

const xml = zlib.gunzipSync(fs.readFileSync(new URL("./fixtures/actueel_beeld.xml.gz", import.meta.url))).toString();
const GEBIED = { noord: 52.33, zuid: 52.05, oost: 6.15, west: 5.75 };
const NU = Date.parse("2026-11-10T10:35:00Z");

test("only items in the region, one per situation, most important first", () => {
  const r = parseActueelBeeld(xml, GEBIED, NU);
  assert.ok(r.length > 3);
  assert.ok(r.every((i) => ["ongeval", "afsluiting", "file", "pech", "werk"].includes(i.soort)));
  assert.equal(new Set(r.map((i) => i.id)).size, r.length);
  assert.equal(r[0].soort, "ongeval");
  assert.equal(r[0].opmerking, "Ongeval met vrachtwagen");
  assert.equal(r[0].bron, "Rijkswaterstaat");
  const ap = r.find((i) => i.bron === "Gemeente Apeldoorn");
  assert.equal(ap.soort, "afsluiting");
  assert.equal(ap.einde, "2026-12-01T16:00:00.000Z");
  assert.ok(Array.isArray(ap.lijn) && ap.lijn[0].length === 2 && ap.lijn[0][0] > 5 && ap.lijn[0][0] < 7); // [lon, lat]
  const pech = r.find((i) => /technische storing/.test(i.opmerking || ""));
  assert.equal(pech.soort, "pech");
});

test("planned items and items outside the region are left out", () => {
  const r = parseActueelBeeld(xml, GEBIED, NU);
  assert.ok(!r.some((i) => i.start && Date.parse(i.start) > NU + 60_000));
  assert.ok(!r.some((i) => i.bron === "Gemeente Deventer"));
  assert.equal(parseActueelBeeld(xml, { noord: 1, zuid: 0, oost: 1, west: 0 }, NU).length, 0);
});

test("vereenvoudig keeps the ends and at most 80 points", () => {
  const lijn = Array.from({ length: 500 }, (_, i) => [52 + i * 0.0001, 5 + Math.sin(i / 10) * 0.001]);
  const v = vereenvoudig(lijn);
  assert.ok(v.length <= 80);
  assert.deepEqual(v[0], [52, 5]);
});

test("flitsers from Overpass", () => {
  const f = flitsersUitJson({ elements: [
    { type: "node", id: 1, lat: 52.2, lon: 5.9, tags: { highway: "speed_camera", maxspeed: "50" } },
    { type: "node", id: 2, lat: 52.2, lon: 5.9, tags: { enforcement: "maxspeed" } },
    { type: "node", id: 3, lat: 52.1, lon: 5.95, tags: { highway: "speed_camera", speed_camera: "average_speed" } }] });
  assert.equal(f.length, 2);
  assert.deepEqual(f[0], { id: "osm:1", lat: 52.2, lon: 5.9, max: 50, soort: "flitser" });
  assert.equal(f[1].soort, "trajectcontrole");
});
