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
- Ideas not done yet: screen off for the touch PC (as in livecam's /view), charts/history.

## Conventions

- UI texts and README in German, code and comments in English.
- Bump `version` in both `package.json` and `io-package.json` and add a `news` entry.
- Install on the ioBroker host: `iobroker url https://github.com/andreaslampl/ioBroker.smartview`.
- Run `npm test` before committing.
- Don't put the owner's IP addresses in the repository (use x.x.x.x / 192.168.1.x examples).
- Controlling stays limited to data points configured as control fields in the layout.
