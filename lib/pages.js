'use strict';

/** Install page for the certificate (German, like the app). */
function certPage({ urls, hasCert, secure }) {
    const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
    const httpsUrl = urls.https || '';
    return `<!doctype html>
<html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>SmartView – Zertifikat</title>
<style>
 body{font-family:system-ui,-apple-system,sans-serif;background:#0f1216;color:#e8eaed;margin:0;padding:16px;line-height:1.5}
 main{max-width:720px;margin:0 auto}
 h1{font-size:22px} h2{font-size:17px;margin-top:28px}
 a.btn{display:inline-block;background:#2f81f7;color:#fff;text-decoration:none;padding:10px 16px;border-radius:10px;margin:4px 0;font-weight:600}
 ol{padding-left:22px} li{margin:6px 0} code{background:#1d232b;padding:1px 6px;border-radius:5px}
 .box{background:#171c22;border:1px solid #2a313a;border-radius:12px;padding:12px 16px;margin:12px 0}
 .ok{color:#3fb950}
</style></head><body><main>
<h1>SmartView sicher (HTTPS) verwenden</h1>
${secure ? '<p class="ok">✓ Diese Seite ist gerade über HTTPS geöffnet – das Zertifikat ist auf diesem Gerät schon installiert.</p>' : ''}
<p>Für <b>Mitteilungen am iPhone</b> muss SmartView über HTTPS laufen. Dafür erzeugt der Adapter ein eigenes
Zertifikat, das jedes Gerät <b>einmal</b> installieren muss. Am Touch-PC reicht auch die normale Adresse
${urls.http ? `<code>${esc(urls.http)}</code>` : ''} (ohne Mitteilungen).</p>
${
    hasCert
        ? `<h2>iPhone / iPad</h2>
<div class="box"><ol>
 <li>Diese Seite in <b>Safari</b> öffnen (nicht in Chrome).</li>
 <li><a class="btn" href="smartview.mobileconfig">Profil laden</a> → „Zulassen“.</li>
 <li><b>Einstellungen</b> → oben „Profil geladen“ → <b>Installieren</b> (Code eingeben) → Installieren.</li>
 <li><b>Einstellungen → Allgemein → Info → Zertifikatsvertrauenseinstellungen</b> →
     bei „SmartView CA“ den Schalter <b>einschalten</b>.</li>
 <li>SmartView öffnen: ${httpsUrl ? `<a class="btn" href="${esc(httpsUrl)}">${esc(httpsUrl)}</a>` : 'die https-Adresse'}</li>
 <li>Teilen-Symbol <b>□↑</b> → <b>Zum Home-Bildschirm</b>. Danach SmartView <b>vom Home-Bildschirm</b> starten
     und im Menü ⚙ <b>Mitteilungen aktivieren</b>.</li>
</ol></div>
<h2>Windows (Touch-PC)</h2>
<div class="box"><ol>
 <li><a class="btn" href="smartview-ca.crt">Zertifikat laden</a> und öffnen.</li>
 <li><b>Zertifikat installieren</b> → <b>Lokaler Computer</b> → „Alle Zertifikate in folgendem Speicher speichern“ →
     <b>Vertrauenswürdige Stammzertifizierungsstellen</b> → Fertig stellen.</li>
 <li>Browser neu starten und ${httpsUrl ? `<code>${esc(httpsUrl)}</code>` : 'die https-Adresse'} öffnen.</li>
</ol></div>
<h2>Android</h2>
<div class="box"><ol>
 <li><a class="btn" href="smartview-ca.crt">Zertifikat laden</a></li>
 <li><b>Einstellungen → Sicherheit → Weitere Einstellungen → Verschlüsselung und Anmeldedaten →
     Zertifikat installieren → CA-Zertifikat</b> und die Datei wählen.</li>
</ol></div>
<p>Das Zertifikat gilt nur für SmartView in deinem Heimnetz. Wird das Zertifikat neu erzeugt (z. B. nach
Löschen der Instanz), muss es neu installiert werden.</p>`
        : '<p>HTTPS ist in den Instanz-Einstellungen ausgeschaltet.</p>'
}
</main></body></html>`;
}

module.exports = { certPage };
