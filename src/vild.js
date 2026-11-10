// The VILD location table of the NDW (data/vild.json, from tools/maak_vild.py): turns ALERT-C location codes into
// "A1 richting Amersfoort, tussen afrit 22 Twello en afrit 18 Kootwijk".
import fs from "node:fs";

const { locaties: L = {}, versie = "" } = JSON.parse(fs.readFileSync(new URL("../data/vild.json", import.meta.url)));
export const VILD_VERSIE = versie;
const [TYPE, DES, WEG, NAAM1, NAAM2, AFRIT, LIJN] = [0, 1, 2, 3, 4, 5, 6];

/** Short name of a point: "afrit 19 Hoenderloo", "knp. Beekbergen", "Vundelaar". */
export function puntNaam(nr) {
  const p = L[nr];
  if (!p || p[TYPE] !== "P") return null;
  const naam = p[NAAM1] || p[NAAM2];
  if (!naam) return null;
  if (/^Knooppunt/i.test(p[DES])) return `knp. ${naam}`;
  if (/^(Afrit|Aansluiting)/i.test(p[DES]) && p[AFRIT]) return `afrit ${p[AFRIT]} ${naam}`;
  if (/^Verbindingsweg/i.test(p[DES])) return naam.replace(/^\w+\d* vanuit /, "verbindingsweg vanuit ");
  if (/^Parkeerplaats/i.test(p[DES])) return `parkeerplaats ${naam}`;
  return naam;
}

/**
 * Road, direction and the stretch of an ALERT-C location. a = { primary, secondary, richting: "positive"|"negative" }.
 * The primary point is where the event ends in the direction of travel, the secondary where it starts.
 * A line runs from its first to its second name: positive = towards the second, negative = towards the first.
 */
export function beschrijf(a) {
  if (!a?.primary) return null;
  const p = L[a.primary];
  if (!p) return null;
  const lijn = L[p[LIJN]];
  const weg = p[WEG] || lijn?.[WEG] || null;
  let richting = null;
  if (lijn && lijn[TYPE] === "L" && (a.richting === "positive" || a.richting === "negative")) {
    richting = (a.richting === "positive" ? lijn[NAAM2] : lijn[NAAM1]) || null;
  }
  const van = a.secondary && a.secondary !== a.primary ? puntNaam(a.secondary) : null;
  const tot = puntNaam(a.primary);
  return { weg, richting, van, tot, bij: !van ? tot : null };
}

/** "A1 richting Amersfoort" */
export const wegTekst = (b) => (b?.weg ? `${b.weg}${b.richting ? ` richting ${b.richting}` : ""}` : null);
/** "tussen afrit 22 Twello en afrit 18 Kootwijk" or "bij afrit 20 Apeldoorn-Zuid" */
export const trajectTekst = (b) => (b?.van && b?.tot ? `tussen ${b.van} en ${b.tot}` : b?.bij ? `bij ${b.bij}` : null);
