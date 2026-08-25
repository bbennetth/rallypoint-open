// Hand-built fixture resembling the CRSSD Fall '26 artists page
// (https://www.crssdfest.com/artists/) — a JS-heavy grid whose visible
// text is artist names grouped by stage. Used by the lineup-ingest D1
// tests as the pasted_text source (the dev sandbox can't reach the live
// site, and tests must not depend on it anyway). The names are the real
// Fall '26 announcement so the fixture keeps the shapes the pipeline
// must survive: b2b pairings with ×, colons in names, all-caps
// rendering, a marketing footer that is NOT lineup content.

export const CRSSD_ARTISTS_HTML = `<!doctype html>
<html>
<head>
  <title>Artists — CRSSD ‡ Festival Fall '26</title>
  <style>.grid{display:flex}</style>
  <script>window.__NUXT__={config:{}}</script>
</head>
<body>
  <header><h1>CRSSD FESTIVAL — FALL '26</h1><p>Waterfront Park, San Diego · September 26 &amp; 27, 2026 · 21+</p></header>
  <main>
    <section>
      <h2>OCEAN VIEW</h2>
      <ul class="grid">
        <li>MOCHAKK</li>
        <li>CHRIS LAKE × DISCLOSURE</li>
        <li>KETTAMA</li>
        <li>PROSPA</li>
        <li>SONNY FODERA</li>
        <li>AYYBO</li>
        <li>LAYTON GIORDANI</li>
        <li>CHASEWEST</li>
      </ul>
    </section>
    <section>
      <h2>CITY STEPS</h2>
      <ul class="grid">
        <li>VTSS</li>
        <li>HELENA HAUFF</li>
        <li>KAS:ST</li>
        <li>BEN UFO</li>
        <li>SALUTE</li>
        <li>MPH</li>
        <li>SON OF SON</li>
        <li>ARODES</li>
      </ul>
    </section>
    <section>
      <h2>THE PALMS</h2>
      <ul class="grid">
        <li>Local support to be announced</li>
      </ul>
    </section>
  </main>
  <footer><p>CRSSD After Dark returns to venues across San Diego. Tickets on sale now.</p></footer>
</body>
</html>`
