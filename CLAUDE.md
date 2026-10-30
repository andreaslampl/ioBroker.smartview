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
- `lib/homekit.js` (0.13.0) – link to homekit-easy (0.4.0+): tile `homekit` = device type there (`CHOICES` per
  tile type), `hkId` = linked existing device (imported), else id `sv-<page>-<tile>`. `devicesFor()` (duplicate
  labels get the page name), `toTile()` for the import. main.js `syncHomekit()` after each layout save, at start
  and when `system.adapter.homekit-easy.N.alive` turns true (sendTo 'sync', also once with [] after the last tick
  is gone); `/api/homekit`, `/api/homekit/devices`. Editor: `homekitField()`, `importHomekit()` (+ Kachel).
  0.13.1 (`common.messagebox`): messages only from homekit-easy.N: `tiles` (`homekitTiles()`), `link` {tiles} ->
  `linkTiles()` ticks them, saves the layout, broadcasts, syncs (owner asked for "Aus SmartView" in homekit-easy).
- Energy tile (0.14.0): type `energy` {instance 'energie.N', show flow|stats}; `state` is always forced to
  `<instance>.live` (JSON of ioBroker.energie, subscribed like any read state). `www/energy-view.js` = copy of
  energie's `www/render.js` (keep in sync). `energyTile()` builds the SVG once and only updates it (refresh()
  would restart the animation otherwise); sheet `energySheet()` with day chart via `/api/energy/day` ->
  sendTo energie 'day' (only for instances of tiles the user can see).
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
  SmartView can switch things. Auto height, max 720 px (size l = full width). 0.11.2 field: VIS symbols
  missing -> img src "/…" or relative are rewritten to `web/…`, server proxies image files only from the
  first ioBroker web instance (`webBase()`, 127.0.0.1:port), SVG with a no-script CSP.
- 0.11.0: owner asked to build the window table without a script -> tile type `windows` (rows {label,
  state, tilt, invert}; tilt contact wins, then contact; "seit …" from the newest lc of both, refreshed
  every 30 s; tile alert when one is open). The HTML tile stays for other scripts. 0.11.1: own icons
  win-closed / win-tilt / win-open per state (owner asked).
- 0.12.0: owner asked to move tiles after creating them -> `Editor.sortable()` (edit mode, tile grid and
  list rows): mouse drags after 8 px, touch after a 350 ms hold (a quick swipe still scrolls), DOM reordered
  live, page.tiles sorted on drop; `justDragged()` swallows the click after a drop. Checked in Playwright.
  Field: owner re-added the home screen icon via the DuckDNS name; test push and rule push from a data
  point both arrive on the company iPhone (push is enabled in the app menu, not in iOS settings).
- 0.13.0: owner asked for "auch homekit easy" so devices are not entered twice (and the other way round for
  people who started with homekit-easy). Checked in Playwright with the real homekit-easy DeviceStore.
- 0.14.0: owner asked for a PV display "like energiefluss but better and simpler" -> new adapter
  ioBroker.energie + this tile. Checked in Playwright with the real energie adapter in a second process.
- 0.15.0: owner: blinds up/down reversed, plan symbols too big for a site plan, wall lamp symbol. Blind on a
  boolean data point (KNX 1-bit up/down) used to get 100/0 -> setValue made both false; now false = up / true =
  down (client `blindWrite` by the state's type, main.fireTimer by meta type); `closed100` is labelled
  "Auf/Ab umdrehen" and also swaps the boolean. Plan pages: `markerSize` xs|s|m|l (CSS .plan.ms-*). Icons
  walllamp, ceiling, lantern.
- 0.15.1: owner asked to rotate all symbols -> tile `rotate` (degrees, 45° steps in the dialog), `tileIc(t)`
  renders every tile/row/marker/sheet symbol rotated; preview on the selected symbol in the picker.
- 0.16.0: owner: moving only goes left/right, wants free placement -> tile pages `free` + `cols` (3-12), tiles
  `gx`/`gy`; app.js `freeSpan()` (heading full width, html/windows/energy 2 or all, w/l 2, l 2 rows),
  `layoutFree()` (first free cell for tiles without/with clashing place; dropped tile keeps its place),
  edit mode shows empty `.cell`s (+1 row); drop on a cell = move, on a tile = swap. Narrow screens
  (`freeNarrow`: column < 105 px) fall back to the normal grid ordered by row/column.
- 0.17.0: owner wanted the parts of the energy view as separately movable tiles -> energy `show`
  flow|stats|today|chart; chart tiles load `/api/energy/day` at most every 5 min.
- 0.17.2 field: moving tiles did not work on the owner's Windows touch PC (long press = right click there,
  suspected) -> grip `.dragh` (app.js `dragHandle()` in fillTile/fillRow/energyTile, edit mode only, touch-action
  none) starts the drag at once for every pointer type; the long press stays for the rest of the tile.
- 0.17.3 field: owner used the mouse on a normal PC. A tile grabbed at its range slider (dimmer) never moved (the
  input takes the pointer), camera <img> can start a native drag -> in edit mode inputs/buttons/img/flow svg get
  pointer-events none (the tile gets click and drag), dragstart prevented.
- 0.18.0: owner asked for push rules with "longer than" / "and" or a link to logik -> rule `delay` (minutes) and
  `and` {state, cond, value}; main `checkRules()`/`evalRule()` (fires when both become true, after the delay only
  if it stayed true; timers per rule, `resetRules()` after each resubscribe - nothing sent for already true rules).
  logik 0.4.0 has a `notify` block writing JSON {title, text} to smartview.N.push.message.
- 0.19.0: owner asked for awning/blind wind+rain protection with lock (shown) and a gate tile. Blind options `kind`
  (blind|awning: texts Einfahren/Ausfahren), `windAlarm` (+ `windMin` threshold for speeds), `rainAlarm`, `protect`
  up|down|none, `lockTime` + `lockUnit` (min|s). main `checkProtection()` (after resubscribe and on alarm changes):
  alarm -> `driveSafe()` once (force) and lock; alarm gone -> lock until lockTime; `setValue` rejects locked
  state/stop unless `force`; locks pushed as {type:'locks'} with `left` ms (client counts with its clock).
  Gate tile: gateMode separate|single, single level|impulse, impulse for separate, stop, posOpen/posClosed,
  confirm; client `gateStatus()`/`gateCmd()` ("schon offen/zu" -> nothing sent; impulse + unknown -> ask);
  ws {type:'pulse', id, ms} writes true then false (force).
- 0.20.0: owner wanted every tile resizable and floor plans adjustable / several on one page. Tiles `sw`/`sh`
  (columns 1-12, rows 1-8; empty = default by type/size): `freeSpan()` honours them, `sizeTile()` sets span +
  height (min-height for content tiles html/windows/energy/planview), normal grid `applySizes()` clamps to the
  real column count (phone 2). Edit mode grip `.sizeh` ◢ (sortable listener with stopImmediatePropagation).
  Tile type `planview` {target: plan page id}: `planTile()` renders the plan with markers (`renderMarker(.., inTile)`,
  click stops propagation; in edit mode markers inert), with own height the plan is fitted. Pages `hidden`.
- 0.21.0: owner's wallbox (Siemens VersiCharge, so far only in evcc) -> new adapter ioBroker.versicharge + surplus
  charging in energie 0.4.0 + tile type `wallbox` {state power, status, plugged, energy (session kWh), mode (w,
  energie.N.wallbox.mode), ctrl (energie's control text), current (w)}; options `charger` 'versicharge.N' / `instance`
  'energie.N' fill empty fields (or those of another instance) in `fillWallbox()` on save. app.js `wb*` helpers:
  big = power while charging else mode; line = control text while not charging; sheet with mode buttons, − / + current
  only in mode manual (else energie would overwrite it); mode buttons on the tile only when size l or sh >= 2.
  Icon `charger`. Checked in Playwright; not yet with the real wallbox.
- 0.21.1: owner asked to see on the tile when the car is limited by the heat pump (energie 0.5.x). `wbLimited()` =
  ctrl text mentions Wärmepumpe/Bezugsgrenze -> the line shows the ctrl text also while charging, class `wblim` (orange).
- 0.22.0: owner asked for camera symbols on the plan with hover preview + click large, and buttons on the plan to
  show/hide trades (light, blinds, fire, ...) because the plan gets too busy. Tile field `layer` (layout `LAYERS`,
  '' = auto); app.js `tileLayer()` (dialog value, else `LAYER_TYPE`, else `LAYER_ICON` by symbol, else sonstiges),
  `layerBar(page, small)` (only layers in use, >= 2; on the plan page in .plantools, small overlay in planview tiles),
  hidden set per page in localStorage `sv.layers.<page>`, `applyLayers()` updates all views; CSS
  `.marker.lhidden:not(.alert)` = markers in alarm stay visible. `camPop()` = fixed preview (single image polling via
  camimg) on pointerenter with pointerType mouse, removed on leave/click/renderPlan. Editor field "Ebene im Lageplan"
  only on plan pages. Checked in Playwright.
- 0.23.0: owner's window contacts (MK): tilted = one contact open while the "closed" contact is still closed, open =
  both open; other installations differ -> windows rows `logic` tilt (default, old behaviour) | both | table + `map`
  (4 letters z/t/o for: both closed, only 1 open, only 2 open, both open), `invert2` for contact 2. app.js
  `windowStates()`; editor `windowsField()` (table only shown for logic table, new rows copy the previous row's wiring).
- 0.23.1 field: in the free grid an energy tile (content height, 1 row) made row 1 as tall as itself -> dead space
  beside it without cells. Now AUTO_H tiles without `sh` get align-self start + min-height --th, `watchRows()`
  (ResizeObserver) measures their natural height, stores the rows in `autoRows` (WeakMap per tile object, not saved)
  used by `freeSpan()`, and re-renders page + side once when that changes (not while a tile is dragged).
- 0.23.2: owner did not know how to remove a data point picked by mistake (emptying the field worked, but was not
  obvious) -> `stateField()` has a ✕ button (`.clearbtn`, only visible with a value) that empties the field.
- 0.24.0: owner asked for heating circuits to switch within one heating tile (as many as wanted, tile stays small) and
  whether the tile is for single-room control (yes). Thermostat options `circLabel` + `circuits` [{label, state,
  setStatus, status, humidity, mode, modeStatus, heating, window}] (max 12; stateIds: same r/w as the tile's own fields).
  app.js `thermoCircuits()` (own fields = circuit 1), `thermoCur(t)` = tile merged with the chosen circuit (index per
  device in localStorage `sv.circ.<id>.<label>`), used by tile/row/marker/sheet/plus/minus/mode; `circSwitcher()` ‹ › on
  the tile (replaces the label line), chips in the sheet, ⇄ in list rows; `circSwitch()` re-renders. Editor
  `circuitsField()`. Checked in Playwright.
- 0.24.1 field: mode buttons were built from the modeStatus data point's states when set - with the Ochsner the status
  codes differ from the mode codes, so buttons sent wrong values ("schaltet wirr"). Now `thermoModes()` only uses
  `modes` texts or the `mode` data point's states; highlight = `thermoModeKey()` (value of `mode`); `thermoMode()`
  shows modeStatus with its own states (row labelled "Status"). Circuits have their own `modes` (FBH 4 = Normal,
  radiators 2 = Normal).
- 0.24.2 field: still gaps between camera rows - a content tile with an own height (`sh`) only had min-height, taller
  content (the owner's HTML/windows list) stretched the rows it spans. Now `sizeTile()` gives AUTO_H tiles with `sh` a
  fixed height + class `fixh` (overflow hidden; .htmlhost / .wlist scroll, energy flow svg scaled to fit).
- 0.25.0: owner asked that the display turns on when it rings -> `www/screen.js` (`Screen`): per device
  localStorage `sv.screenOff` minutes (menu cycles 0/1/2/5/10/30/60, "jetzt ausschalten"), black `.screenoff` overlay
  (z-index 1000; pointerdown swallowed, wake on click so the waking tap switches nothing), not while a ring/call
  overlay is open or in edit mode; screen wake lock while awake, released when dark, requested again on ring
  (`Screen.ring()` from `checkRing()` and intercom.js `update()`); without the feature the ring lock is released after
  3 min. A browser cannot reliably switch on a monitor Windows turned off - recommended: Windows display off "never".
  Checked in Playwright (tap does not switch the tile below, ring wakes, off ignored while ringing).
- 0.26.0: owner asked that SmartView adapts to any browser/resolution -> tile page option `fit` width|screen +
  `designW` (320-4000, editor "Breite dieses Bildschirms übernehmen"): `fitWidth(page)` (not on the phone, not while
  editing), grid `.fit` with fixed width + CSS `zoom` (`applyFit`, again on resize; screen = also fits the height of
  #main), fixed --th/columns; `freeNarrow` uses designW; `watchRows` divides the rect by `grid._zoom` (Chromium's
  standardized zoom reports zoomed rects). Same time: full screen left when the tablet locks -> `Screen.fullscreen()`
  remembers the wish (localStorage `sv.fullscreen`), first tap afterwards only re-enters full screen (pointerdown
  swallowed, request in click); an exit without a visibility change within 2 s (Esc, back) clears the wish.
  Both checked in Playwright.
- 0.26.1: owner missed the option on floor plan pages -> `fit`/`designW` also for plan pages: `.plan.fit` gets
  width designW + CSS zoom (`applyPlanFit`: frame width / designW, screen = also the height left below the frame top,
  times the −/+ planZoom), so the symbols scale with the plan. Checked in Playwright (symbol = 3.14 % of the plan at
  every size, clicks still switch).
- 0.26.2: owner: "bei allen Arten von Ansichten" -> list pages too (`.list.fit`, same `applyFit`); fit is now kept for
  every page type. Screen mode keeps 10 px spare and floors the zoom (a 6 px scroll bar came back with lists).
- 0.26.3: owner: blind percent reversed (100 % = open) while up/down was right -> blind option `posInvert` ("Prozent
  umdrehen"): percent means 100 = closed when `closed100 XOR posInvert` (app.js `pctClosed100()`, main driveSafe/
  fireTimer, homekit.js sends the effective closed100); the boolean up/down still follows `closed100` only.
- 0.26.4: homekit-easy 0.4.2 got an up/down field `move` for blinds; a boolean blind state is treated as up/down there.
  homekit.js sends `moveInvert` when `closed100` is ticked, import of a move-only device -> tile state = move.
- 0.27.0: owner asked (as options) for several contacts per area ("Küche 1 offen"), showing only open ones (all closed =
  heading only) and other ideas -> windows rows `group` (stored only when set), tile options `onlyOpen`, `warnMin`
  (min, row class `long` + ⚠), `warnWhen` (read state, `windowsWarn()`: true and something open/tilted -> header
  badge `warnText`, rows `warnnow`, tile alert), `warnText`. app.js `windowEntries()` (groups: worst status, detail =
  open/tilted members, ts = since the first one opened). Checked in Playwright.
- 0.28.0: owner asked for an alarm tile with PIN protection (also for doors, on all tiles) and the suggested window
  messages. `lib/pin.js`: PIN only as scrypt hash `pinHash` in the layout; browsers get `pin: true` (`publicLayout()`
  on GET/PUT /api/layout), the editor sends digits (new), true (keep, `resolvePins()` copies the old hash) or nothing;
  server `_pinOk()` checks every ws set/pulse to a data point of ANY protected tile (`protectedIds()` +
  `tileWriteIds()`), replies {type:'pin', result need|wrong|locked}; `PinGuard` 5 wrong per address -> 5 min lock.
  No timers for PIN tiles (API 403, fireTimer skips, Timers.supports). Client `withPin()`/`askPin()` (pad + keyboard,
  PIN cached 20 s per data point), wrong PIN restores the previous state. Tile type `alarm` {status, command, alarm,
  error, valueOff/Arm/Home, area -> `fillAlarm()` for NOX}. Window logic moved to `www/winlogic.js` (page + adapter);
  windows option `notify` -> main `checkWindows()` (on state changes + every 30 s; once per opening / per warning,
  nothing for what is already open at start) -> `notify()` app push + Telegram + WhatsApp. Checked in Playwright.
- 0.29.0: owner asked for several areas per alarm tile (like heating circuits) and, as a must, "scharfschaltbereit" and
  which detectors are open / triggered -> alarm states `ready`, `openText`, `alarmText` (NOX 0.1.7: areas.N.ready /
  openInputs / alarmInputs, filled by `fillAlarm()`), options `areaLabel` + `areas` [{label, area, status, command, …,
  values}] (each filled; stateIds/tileWriteIds include them). app.js `ALARM_KEYS`, `alarmAreas()`, `alarmCur()` (reuses
  circIndex/circSwitch/circSwitcher), `alarmLine(t, c, a)` (ALARM + detectors / ALARM in other area / not ready + open /
  ready / error), `alarmElsewhere(t)`; arming a not-ready area asks (confirm). Editor `alarmAreasField()`. Playwright.
- 0.29.1: owner: "bei der SPC auch" -> spc-edp 0.2.0 has areas.N.ready/openInputs/openCount/alarmInputs; `fillAlarm()`
  maps an spc-edp area (mode/setMode/triggered, no error state, values 0/3 and home 1 = part set A).
- 0.30.0: owner asked for a tick to make the alarm tile display only / switchable and to switch detectors off and on.
  Alarm options `control` (without: no buttons AND stateIds/tileWriteIds give no write ids for alarm tiles -
  `alarmWrites()`), `showDetectors` -> on PUT /api/layout server calls main `fillDetectors()` (async, before
  resolvePins/save): per area `detectors` [{label, open, deact}] from `<inst>.inputs.*.area` (NOX, deact =
  inputs.N.deactivated) or `<inst>.zones.*.area` (SPC, no deact); read always, deact writable with control (PIN
  protected via tileWriteIds). Sheet `alarmDetectors()` (offen/zu/abgeschaltet + Abschalten/Einschalten), info row
  "Abgeschaltet". PIN cache is now one {pin, until} for 20 s (several detectors = one PIN). Checked in Playwright.
- 0.31.0: owner asked for a tile for ioBroker.sonos-radio so its page need not open -> tile type `radio` {station (w),
  playing (w), volume (w), title, group, online; `roomLabel`, `rooms` [{label, station, …}] max 12}; layout `fillRadio()`
  fills the rest from `<inst>.rooms.<id>.station`. app.js `RADIO_KEYS`, `radioRooms()`/`radioCur()` (circIndex/circSwitch
  like alarm areas), sheet: station buttons from the station state's common.states, Stopp (playing false), volume ±5 (±2 since 0.31.5, owner asked).
  Grouping stays on the sonos-radio page. Checked in Playwright with fake states; not with real Sonos.
- 0.31.1: owner wanted a surveillance camera symbol for the site plan (the photo camera looked like a camera) -> icons
  `cctv` (default for camera tiles) and `dome`, both in layer kamera.
- 0.31.2: owner: PIN was not asked the second time ("eigentlich nicht gut") -> no PIN cache at all, `withPin()` asks
  before every protected command (also each detector).
- 0.31.3 field: owner saw setpoint 10 after "only hovering" over + (heating + floor heating). Hover writes nothing
  (checked in Playwright); but `thermoStep()` took an unknown/empty setpoint as 0 -> +0.5 clamped to min 10. Now it uses
  shown setpoint, else command, else feedback (comma strings parsed), else toast and no write. Cause in the field
  (which data point was empty) not confirmed.
- 0.31.4 field: log "warmwasser_soll ... value 10 less than min 35" (owner's own Ochsner data point, likely in a heating tile
  with min 10 for the rooms). `thermoStep()` clamps to the narrower of tile and data point limits; if they contradict
  (tile 10-30, data point 35-60) the data point's own range wins.
- 0.32.0: owner asked for a magnet contact symbol on the site plan (red open, orange tilted, optionally gone when closed) and
  a dehumidifier / air conditioner tile. Tile `contact` {state, tilt; invert, invert2, logic, map, hideClosed}: app.js
  `contactStatus()` = WinLogic.states with one row, tileState 'warn' (new orange class on tile/row/marker; contact markers
  filled red/orange), marker class `chide` (`contactHidden()`, never in edit mode). Tile `climate` {state, status, target,
  temp, humidity, mode, fan, alarm (w: state/target/mode/fan); climKind dehum|ac (icon dehum/aircon, step 5 / 0.5),
  invert, step, min, max, modes, fans}: `climChoices()` (own texts or data point states), `climStep()` reuses
  thermoStep, timers on/off (www + lib/timers ACTIONS, main.fireTimer like switch). Icons contact, dehum, aircon.
  Pitfall: classList.toggle(x, undefined) toggles - always pass a boolean. Checked in Playwright.
- Ideas not done yet: charts/history.

## Conventions

- UI texts and README in German, code and comments in English.
- Bump `version` in both `package.json` and `io-package.json` and add a `news` entry.
- Install on the ioBroker host: `iobroker url https://github.com/andreaslampl/ioBroker.smartview`.
- Run `npm test` before committing.
- Don't put the owner's IP addresses in the repository (use x.x.x.x / 192.168.1.x examples).
- Controlling stays limited to data points configured as control fields in the layout.
