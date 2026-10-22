# ioBroker.smartview

ioBroker adapter "SmartView": visualization for the owner's iPhone and Windows touch PC (replacing
the Gira HomeServer app over time). Same web app on HTTP (port 8098: touch PC, VIS-2 iframe) and
HTTPS (8099, own CA: iPhone home screen app with Web Push). Owner asked for floor plans with
switches/buttons on them.

## Layout

- `lib/layout.js` – layout model and validation (`cleanLayout`): pages (`tiles`, `list` or `plan` with
  an uploaded image; plan tiles have x/y in %), optional `showDate`, `hideNav`, `side` (split
  screen), tile types in `TYPES` (data point fields r/w + options), ring (doorbell state/camera/door), push rules. `stateIds()` = what the page reads / may write -
  the server refuses writes to anything else. `LayoutStore`: layout.json + files/ (uploads).
- `lib/certs.js` – own CA (10 years) + server cert (800 days, iOS limit 825, SAN with all local
  IPs/hostnames + publicHost, renewed 30 days before expiry or when an address is new; old names
  kept) in certs.json; `.mobileconfig` profile and DER download for iOS/Windows/Android.
- `lib/push.js` – web-push (VAPID keys + subscriptions in push.json, 404/410 removes the device);
  `triggers()` fires when a rule's condition becomes true (not while it stays true); `fill()`
  replaces {value} (words by role: offen/zu, Bewegung/Ruhe, Alarm/OK).
- `lib/server.js` – HTTP + HTTPS servers sharing one handler; app files, /zertifikat (lib/pages.js),
  manifest (start_url carries ?key), /api (layout, objects/values for the picker, cameras, upload,
  push), /files, /cam/<livecam channel>.jpg|.mjpeg proxied from livecam's snapshotUrl/mjpegUrl
  states (no mixed content on HTTPS), /ws (init with states + writable list, state pushes, set).
  Access key: ?key= once -> HttpOnly cookie.
- `main.js` – subscribes layout + push rule data points, `stateInfo` (val/ack/ts + type/role/unit/
  states/min/max), writes commands with the object's type (ack=false), push rules, push.message.
- `www/` – vanilla JS: `app.js` (render, `renderPageInto` for main and side panels, tiles, list rows,
  plan markers, control sheet, cameras by single image polling, ring overlay, menu with push enable), `edit.js` (edit mode: tile/page dialogs, plan upload,
  tap to add marker, drag to move, settings with ring + push rules), `picker.js` (same object
  browser as ioBroker.logik), `icons.js` (own SVG line icons), `sw.js` (push + notificationclick).
- `lib/intercom.js` – `IntercomProxy`: livecam's intercom inside SmartView (layout `ring.intercom` =
  'livecam.N'; livecam address + key taken from its `cameras.*.snapshotUrl` states). One upstream ws
  to livecam /ws per browser on `/intercom/ws` (livecam must know who answered), `/api/intercom/
  history[/<id>.jpg]` passthrough. WebRTC audio flows browser <-> livecam directly.
  `lib/tones.js` is a copy of livecam's (keep in sync), served as `/tones-engine.js`;
  `www/intercom.js` = call screen (answer/reject/hang up/door), ring tone from livecam's `view`
  message, missed badge, call list, per-device ring tone switch.
- `lib/users.js` – optional users (0.6.0): users.json (scrypt hash, sessions = cookie `sv_session`,
  kept until logout/password change/delete), rights admin / pages / control / intercom, login rate limit.
  `layoutFor()` filters the layout per user; server.js checks everything (layout, ws read+write per
  connection re-checked via `_version`, cameras, timers, intercom, admin-only editor APIs). No users =
  open as before; instance option `usersOff` = emergency (forgotten password). `www/users.js` = login
  form, menu entries, management dialog.
- `lib/timers.js` – `Timers`: time switches per tile in timers.json (`page/tile` keys, not in the
  layout so they work without edit mode), weekdays, fixed time or sunrise/sunset ± min (`lib/sun.js`
  copied from ioBroker.logik, location from system.config); tick every 15 s, fires once per day up to
  5 min late, passed times are not caught up at start. `main.fireTimer` writes like the buttons
  (invert, switchState, closed100). API `GET /api/timers`, `PUT /api/timers/<page>/<tile>`, ws
  `{type:'timers'}`. UI `www/timers.js` (editor, ⏰ badge, long press -> sheet with ⏰ button).
- `www/vendor/` – pdf.js 4.10.38 legacy build (pdf.min.mjs + worker, Apache-2.0), copied from
  pdfjs-dist on purpose: the npm package pulls the native optional @napi-rs/canvas onto the ioBroker
  host. `edit.js` `pdfToPng()` renders the chosen PDF page (~3000 px, <= 16 MP for iOS) and trims
  white margins, then uploads it as PNG.
- `test/` – `node --test`; `fake-iobroker.js` (adapter-core stub, demo house with KNX/Shelly/livecam
  objects); units (layout, push rules, certificates incl. TLS with the CA) and adapter (API, ws,
  write permission, push rule, camera proxy, upload, https, access key). Browser checks with
  Playwright are in the scratchpad, not in npm test.

## Status

- 0.2.0: owner showed their Gira HomeServer QuadClient (menu of area buttons, room pages as rows with
  EIN/AUS + status lamp, right half with tabbed panels for cameras/intercom and weather, multi-value
  weather tiles, date in the header). The owner likes SmartView's own look too, so everything from it is
  optional: list pages, `page` and `multi` tile types, `showDate`, `hideNav` (back button to the first
  page), `side` panels (touch only; those pages leave the page bar). Defaults keep 0.1.0's look.
- 0.1.0: built and checked in headless Chromium (desktop + phone viewport) against the fake house.
  Not yet on the owner's ioBroker / iPhone: real push delivery via Apple, iOS profile install and
  trust, standalone app behaviour are untested.
- 0.3.0: owner wants to move the touch PC from livecam's camera wall to SmartView, so the intercom
  (ring tone, answer/talk, door, call list) was added via livecam. Checked end to end in the scratchpad:
  real livecam CamServer + Intercom, fake 2N over SIP, Chromium with fake mic through SmartView.
  Background: on the touch PC the camera wall sometimes did not ring after long idle times; suspected
  Edge sleeping tabs (owner got Edge/kiosk settings), Windows only turns the monitor off.
- 0.3.1 field: "Keine Sprechstelle" toast appeared while editing (Intercom.sync used the draft, the
  server only knows the saved layout); gone after saving. Fixed + `intercomTarget()` now also tries
  the objects and the instance settings (port, same host), logs what is missing, caches 60 s.
- 0.4.0: owner asked for a time switch with weekdays and astro on every switch/dimmer/blind.
- 0.5.0: owner asked for a real heating control: thermostat tile = room controller (setStatus, humidity,
  mode + modeStatus with KNX HVAC defaults or `modes` texts or common.states, heating bool or valve %,
  window, min/max). Only state and mode are writable.
- 0.6.0: owner asked for users so not everybody can edit (✎) or see everything. Push still goes to
  all devices (not per user yet).
- 0.7.0: owner's iPhone belongs to the company, no own certificates allowed -> push rules also via the
  telegram adapter (layout `telegram` {instance, users, ring}, rule `via` all/app/telegram; sendTo
  'send' with HTML text + link to SmartView; ring = camera jpg as Buffer type photo; `tgSend` resolves
  null after 15 s if the adapter does not answer). Owner wanted both (app push + telegram).
- 0.8.0: owner still wanted real Web Push on the company iPhone -> optional Let's Encrypt certificate from
  the acme adapter (instance option `certCollection`; read from `system.certificates`
  native.collections[id] {key, cert, chain, domains, tsExpires, staging}; https links use the cert's
  domain; objectChange -> `server.updateCertificate()` = setSecureContext, no restart). Suggested
  route: DuckDNS name with the LAN IP + acme DNS-01 (no port forwarding); router DNS rebind exception.
- 0.8.1 field: "Timers is not defined" on the PC via the duckdns name - app.js started before the later
  scripts had loaded (fetch answered while timers.js was still downloading); now starts on
  DOMContentLoaded (reproduced with a delayed timers.js in Playwright).
- 0.8.1 field, confirmed: Web Push works on the owner's company iPhone with the Let's Encrypt route
  (DuckDNS name -> LAN IP, acme DNS-01 DuckDNS, collection "Donauschwabe" - case matters).
  Pitfalls seen: acme still had its example collection and staging on; a stored staging account gave
  "KeyID header contained an invalid account URL" -> deleting/re-creating the acme instance fixed it.
  The company iPhone could not reach https on 8099 (http 8098 worked) -> HTTPS port 443 solved it.
- 0.9.0: owner asked for WhatsApp too -> whatsapp-cmb adapter (CallMeBot, text only): layout `whatsapp`
  {instance, phone, ring}; push rules have `channels` {app, telegram, whatsapp} (old `via` migrated in
  `channels()`); links in messages via `appLink()` (https when the acme certificate is in use).
- 0.10.0: owner shows a window status table in VIS-2 (basic HTML widget fed by a script state
  javascript.0.FensterUeberwachung.OverviewTable) -> tile type `html`: read-only, rendered in a shadow
  root (styles stay inside), `safeHtml()` strips scripts/handlers/frames/forms/javascript: URLs since
  SmartView can switch things. Full width, auto height. Relative image URLs of VIS would not resolve.
- 0.11.0: owner asked to build the window table without a script -> tile type `windows` (rows {label,
  state, tilt, invert}; tilt contact wins, then contact; "seit …" from the newest lc of both, refreshed
  every 30 s; tile alert when one is open). The HTML tile stays for other scripts.
- Ideas not done yet: screen off for the touch PC (as in livecam's /view), charts/history.

## Conventions

- UI texts and README in German, code and comments in English.
- Bump `version` in both `package.json` and `io-package.json` and add a `news` entry.
- Install on the ioBroker host: `iobroker url https://github.com/andreaslampl/ioBroker.smartview`.
- Run `npm test` before committing.
- Don't put the owner's IP addresses in the repository (use x.x.x.x / 192.168.1.x examples).
- Controlling stays limited to data points configured as control fields in the layout.
