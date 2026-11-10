// The planning feed of the NDW (works and events, ~15 MB gzip, ~200 MB of XML): read as a stream, situation by
// situation, keeping only the ones in the region, so the free 512 MB instance never holds the whole file.
import zlib from "node:zlib";
import { Readable } from "node:stream";
import { inRegio, leesSituatie } from "./ndw.js";

export const PLAN_URL = "https://opendata.ndw.nu/planningsfeed_wegwerkzaamheden_en_evenementen.xml.gz";
const EIND = "</sit:situation>";

/** Situations of a gzip stream (Node Readable) in the region → Map(id → situation). */
export async function leesPlanStream(gz, gebied) {
  const kaart = new Map();
  let buf = "";
  const unzip = gz.pipe(zlib.createGunzip());
  unzip.setEncoding("utf8");
  for await (const stuk of unzip) {
    buf += stuk;
    let e;
    while ((e = buf.indexOf(EIND)) >= 0) {
      const deel = buf.slice(0, e);
      buf = buf.slice(e + EIND.length);
      const s = deel.lastIndexOf("<sit:situation ");
      if (s < 0) continue;
      const sitXml = deel.slice(s);
      const id = (sitXml.match(/^<sit:situation\b[^>]*\bid="([^"]+)"/) || [])[1];
      if (!id || !inRegio(sitXml, gebied)) continue;
      const body = sitXml.slice(sitXml.indexOf(">") + 1);
      kaart.set(id, leesSituatie(body, id));
    }
    if (buf.length > 4_000_000) buf = buf.slice(-2_000_000); // never a runaway buffer
  }
  return kaart;
}

/** Fetches and reads the planning feed (ETag: unchanged → null). */
export async function haalPlan(gebied, etag, ua) {
  const res = await fetch(PLAN_URL, { headers: { ...ua, ...(etag ? { "if-none-match": etag } : {}) }, signal: AbortSignal.timeout(120_000) });
  if (res.status === 304) return null;
  if (!res.ok) throw new Error(`planning HTTP ${res.status}`);
  const kaart = await leesPlanStream(Readable.fromWeb(res.body), gebied);
  return { kaart, etag: res.headers.get("etag") };
}
