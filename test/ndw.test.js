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

import { beschrijf, wegTekst, trajectTekst } from "../src/vild.js";
import { opmerkingen, leesSituatie, parseActueelBeeld as parse2, gepland as gepland2 } from "../src/ndw.js";

test("VILD: road, direction and stretch", () => {
  const b = beschrijf({ primary: "9423", secondary: "9427", richting: "negative" });
  assert.equal(wegTekst(b), "A50 richting Arnhem");
  assert.equal(trajectTekst(b), "tussen afrit 26 Vaassen en afrit 24 Apeldoorn");
  assert.equal(trajectTekst(beschrijf({ primary: "7068", richting: "positive" })), "bij knp. Beekbergen");
});

test("opmerkingen: numbered placeholders, projects, contacts and names are left out", () => {
  assert.deepEqual(opmerkingen(["Beperking 1", "Omleiding 2", "Project: 31194610 ROK", "Weg dicht in beide richtingen", "MIOG: 180829-2026 Havikshorst 2-132 inrichten van bouwplaats",
    "Contactinformatie: loket", "Hooghe Tuinen door Nikkels projectleider X", "Beperking 1: Binnen de afspraken"]),
  ["Weg dicht in beide richtingen", "Havikshorst 2-132 inrichten van bouwplaats", "Binnen de afspraken"]);
});

test("planning: cause, comment, time slot and 'Gepland'", () => {
  const sitXml = `<sit:situationRecord xsi:type="sit:RoadOrCarriagewayOrLaneManagement" id="R1" version="1">
    <sit:source><com:sourceName><com:values><com:value lang="nl">Gemeente Apeldoorn</com:value></com:values></com:sourceName></sit:source>
    <sit:validity><com:validityTimeSpecification><com:overallStartTime>2026-11-12T06:00:00Z</com:overallStartTime><com:overallEndTime>2026-11-12T16:00:00Z</com:overallEndTime>
    <com:validPeriod><com:startOfPeriod>2026-11-12T06:00:00Z</com:startOfPeriod><com:endOfPeriod>2026-11-12T16:00:00Z</com:endOfPeriod></com:validPeriod></com:validityTimeSpecification></sit:validity>
    <sit:cause><sit:causeDescription><com:values><com:value lang="nl">Kabels / Leidingen</com:value></com:values></sit:causeDescription><sit:causeType>roadMaintenance</sit:causeType></sit:cause>
    <sit:generalPublicComment><sit:comment><com:values><com:value lang="nl">Weg dicht in beide richtingen</com:value></com:values></sit:comment></sit:generalPublicComment>
    <sit:locationReference><loc:gmlLineString><loc:posList>52.2100 5.9600 52.2110 5.9620</loc:posList></loc:gmlLineString></sit:locationReference>
    <sit:roadOrCarriagewayOrLaneManagementType>carriagewayClosures</sit:roadOrCarriagewayOrLaneManagementType></sit:situationRecord>`;
  const plan = new Map([["NDW03_1", leesSituatie(sitXml, "NDW03_1")]]);
  const g = gepland2(plan, GEBIED, Date.parse("2026-11-10T12:00:00Z"));
  assert.equal(g.length, 1);
  assert.equal(g[0].soort, "afsluiting");
  assert.equal(g[0].oorzaak, "Kabels / Leidingen");
  assert.deepEqual(g[0].toelichting, ["Weg dicht in beide richtingen"]);
  assert.deepEqual(g[0].tijdvakken, [["2026-11-12T06:00:00.000Z", "2026-11-12T16:00:00.000Z"]]);
  assert.equal(g[0].bron, "Gemeente Apeldoorn");
});

test("actueel beeld: motorway items get road, direction and stretch", () => {
  const r = parse2(xml, GEBIED, NU);
  assert.ok(r.some((i) => /^A(1|50) richting /.test(i.kop || "") && /^(tussen|bij) /.test(i.traject || "")));
});

test("jams from loop detectors: a slow run on one road and direction, head downstream", async () => {
  const { bepaalFiles } = await import("../src/files.js");
  const s = (id, km, rij = "positive") => [id, { id, lat: 52.18, lon: 5.9 + km / 100, loc: 0, richting: rij, weg: "A1", naar: "Hengelo", vanaf: "Amersfoort", km }];
  const sites = new Map([s("a", 80), s("b", 80.5), s("c", 81), s("d", 81.5), s("e", 82)]);
  const snel = new Map([["a", 100], ["b", 30], ["c", 20], ["d", 40], ["e", 100]]);
  const [f] = bepaalFiles(sites, snel, Date.parse("2026-11-11T08:00:00Z"));
  assert.equal(f.soort, "file");
  assert.equal(f.titel, "Stilstaand verkeer");
  assert.equal(f.richting, "Hengelo");
  assert.equal(f.lengte_km, 1.3);
  assert.equal(f.lon, 5.9 + 81.5 / 100, "head = farthest downstream (km up on positive)");
  assert.ok(f.vertraging_min >= 1);
  assert.equal(bepaalFiles(sites, new Map([["b", 30]])).length, 0, "one slow site is no jam");
});
