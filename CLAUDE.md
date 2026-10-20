# ioBroker.smartview

ioBroker adapter "SmartView": visualization for the owner's iPhone and Windows touch PC (replacing
the Gira HomeServer app over time). Same web app on HTTP (port 8098: touch PC, VIS-2 iframe) and
HTTPS (8099, own CA: iPhone home screen app with Web Push). Owner asked for floor plans with
switches/buttons on them.

## Layout

- `lib/layout.js` – layout model and validation (`cleanLayout`): pages (`tiles` or `plan` with an
  uploaded image; plan tiles have x/y in %), tile types in `TYPES` (data point fields r/w + options),
  ring (doorbell state/camera/door), push rules. `stateIds()` = what the page reads / may write -
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
- `www/` – vanilla JS: `app.js` (render, tiles, plan markers, control sheet, cameras by single image
  polling, ring overlay, menu with push enable), `edit.js` (edit mode: tile/page dialogs, plan upload,
  tap to add marker, drag to move, settings with ring + push rules), `picker.js` (same object
  browser as ioBroker.logik), `icons.js` (own SVG line icons), `sw.js` (push + notificationclick).
- `test/` – `node --test`; `fake-iobroker.js` (adapter-core stub, demo house with KNX/Shelly/livecam
  objects); units (layout, push rules, certificates incl. TLS with the CA) and adapter (API, ws,
  write permission, push rule, camera proxy, upload, https, access key). Browser checks with
  Playwright are in the scratchpad, not in npm test.

## Status

- 0.1.0: built and checked in headless Chromium (desktop + phone viewport) against the fake house.
  Not yet on the owner's ioBroker / iPhone: real push delivery via Apple, iOS profile install and
  trust, standalone app behaviour are untested.
- Ideas not done yet: screen off for the touch PC (as in livecam's /view), answering the intercom
  (WebRTC from livecam) inside SmartView, charts/history.

## Conventions

- UI texts and README in German, code and comments in English.
- Bump `version` in both `package.json` and `io-package.json` and add a `news` entry.
- Install on the ioBroker host: `iobroker url https://github.com/andreaslampl/ioBroker.smartview`.
- Run `npm test` before committing.
- Don't put the owner's IP addresses in the repository (use x.x.x.x / 192.168.1.x examples).
- Controlling stays limited to data points configured as control fields in the layout.
