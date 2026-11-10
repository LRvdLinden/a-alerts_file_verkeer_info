# A-Alerts verkeer

Kleine service die elke minuut de open data van de NDW leest en het verkeer in de regio Apeldoorn klaarzet voor A-Alerts:

- **Afsluitingen en werk**: afgesloten wegen (ook van de gemeente), rijstroken dicht, werkzaamheden, pijlwagens.
- **Ongevallen en pech**: ongevallen, voertuigen met pech, stilstaande voertuigen, obstakels of lading op de weg.
- **Files met vertraging**: langzaam rijdend of stilstaand verkeer van Rijkswaterstaat, met lengte en vertraging.
- **Flitsers**: vaste flitsers en trajectcontroles uit OpenStreetMap. Mobiele controles staan in geen enkele open bron.

Bronnen: [NDW open data](https://opendata.ndw.nu/) (`actueel_beeld.xml.gz`), straatnamen via de
[PDOK Locatieserver](https://www.pdok.nl/) en flitsers via OpenStreetMap (© OpenStreetMap-bijdragers, ODbL).
Geen gegevens van ANWB, Flitsmeister of andere apps.

## Hoe het werkt

1. De service haalt elke minuut `actueel_beeld.xml.gz` op (alleen als het bestand veranderd is), filtert op het gebied
   en maakt er een kleine lijst van (`src/ndw.js`).
2. De A-Alerts-server (Cloudflare Worker) vraagt elke minuut `GET /verkeer` op met het token. Daardoor blijft de gratis
   Koyeb-server ook wakker (die slaapt na een uur zonder verzoeken).
3. De app, de website en Homey lezen het verkeer bij de A-Alerts-server (`/v1/verkeer`), nooit hier.

| Pad | Wat |
|---|---|
| `GET /health` | Openbaar: aantal items, laatste ophaaltijd, fout |
| `GET /verkeer` | Met `Authorization: Bearer <VERKEER_TOKEN>`: de lijst (ETag, 304 als niets veranderd is) |

## Koyeb (gratis), eenmalig

1. Maak een account op [koyeb.com](https://www.koyeb.com) en koppel GitHub (alleen deze repo).
2. **Create Service → GitHub →** `LRvdLinden/a-alerts_file_verkeer_info`, branch `main`.
3. Builder: **Dockerfile** (staat in de repo).
4. Instance: **Free**, regio **Frankfurt**.
5. Port: **8000**, protocol HTTP, health check `/health`.
6. Environment variable: `VERKEER_TOKEN` = een lange willekeurige tekst (als **Secret**). Geef hetzelfde token aan de
   A-Alerts-server als GitHub-secret `VERKEER_TOKEN`, met het adres van de service als `VERKEER_URL`
   (bijvoorbeeld `https://<naam>.koyeb.app`).
7. Optioneel `GEBIED` = `noord,zuid,oost,west` in graden (standaard `52.33,52.05,6.15,5.75`).
8. Deploy. Controleer `https://<naam>.koyeb.app/health`.

## Ontwikkelen

```bash
npm test                 # parser en flitsers met een echt NDW-bestand uit test/fixtures
VERKEER_TOKEN=proef npm start
curl -H "Authorization: Bearer proef" localhost:8000/verkeer
```

De GitHub Action **Test** draait de tests en daarna de service één ronde tegen de live open data.
