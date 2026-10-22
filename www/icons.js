'use strict';

/* Line icons (24x24, stroke), drawn for SmartView. */
const ICON_PATHS = {
  bulb: '<path d="M9 18h6M10 21h4"/><path d="M12 3a6 6 0 0 0-3.6 10.8c.7.6 1.1 1.3 1.1 2.2h5c0-.9.4-1.6 1.1-2.2A6 6 0 0 0 12 3z"/>',
  lamp: '<path d="M8 3h8l3 8H5z"/><path d="M12 11v8M8 21h8"/>',
  power: '<path d="M12 3v8"/><path d="M6.3 6.3a8 8 0 1 0 11.4 0"/>',
  socket: '<rect x="4" y="4" width="16" height="16" rx="4"/><path d="M9.5 10v2M14.5 10v2"/><path d="M10 15.5h4"/>',
  blind: '<rect x="4" y="3" width="16" height="18" rx="1.5"/><path d="M4 7h16M4 11h16M4 15h16"/><path d="M12 15v4"/>',
  window: '<rect x="5" y="3" width="14" height="18" rx="1.5"/><path d="M12 3v18M5 12h14"/>',
  // window states for the window overview: frame + sash closed / swung open / tilted at the top
  'win-closed': '<rect x="4" y="3" width="16" height="18" rx="1"/><rect x="6.5" y="5.5" width="11" height="13" rx=".5"/><path d="M15 11v3"/>',
  'win-open': '<rect x="4" y="3" width="16" height="18" rx="1"/><path d="M5 4l7 2.5v11L5 20z" fill="currentColor" fill-opacity=".25"/><path d="M10 11v2.5"/>',
  'win-tilt': '<rect x="4" y="3" width="16" height="18" rx="1"/><path d="M6.5 5.5h11" stroke-dasharray="1.5 2"/><path d="M6.5 18.5h11l-1.6-9.5H8.1z" fill="currentColor" fill-opacity=".25"/><path d="M12 15.5v-2"/>',
  door: '<path d="M6 21V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v17"/><path d="M4 21h16"/><circle cx="14.5" cy="12" r="1"/>',
  garage: '<path d="M3 10l9-6 9 6v11H3z"/><path d="M7 21v-8h10v8M7 16h10"/>',
  gate: '<path d="M3 20V8M21 20V8"/><path d="M3 10c3-2 15-2 18 0"/><path d="M7 9.5V20M11 9V20M15 9V20M19 9.5V20"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/><path d="M12 15v2"/>',
  alarm: '<path d="M12 3l8 3v6c0 4.5-3.4 8-8 9-4.6-1-8-4.5-8-9V6z"/><path d="M12 8v5M12 16v.5"/>',
  shield: '<path d="M12 3l8 3v6c0 4.5-3.4 8-8 9-4.6-1-8-4.5-8-9V6z"/><path d="M8.5 12l2.5 2.5 4.5-5"/>',
  motion: '<circle cx="13" cy="4.5" r="1.8"/><path d="M9 21l2.5-6 2.5 2v4"/><path d="M7 11l3-3h4l2 4 3 1"/><path d="M11.5 15l1.5-7"/>',
  thermometer: '<path d="M14 14.8V5a2 2 0 0 0-4 0v9.8a4 4 0 1 0 4 0z"/><path d="M12 9v7"/>',
  heat: '<path d="M7 20c-2-3 2-5 0-9M12 20c-2-3 2-5 0-9M17 20c-2-3 2-5 0-9"/><path d="M4 5h16"/>',
  drop: '<path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z"/>',
  fan: '<circle cx="12" cy="12" r="1.8"/><path d="M12 10.2C11 6 12.5 3 15 3.5c2.3.5 1.5 4.5-3 6.7zM13.8 12c4.2-1 7.2.5 6.7 3-.5 2.3-4.5 1.5-6.7-3zM12 13.8c1 4.2-.5 7.2-3 6.7-2.3-.5-1.5-4.5 3-6.7zM10.2 12C6 13 3 11.5 3.5 9c.5-2.3 4.5-1.5 6.7 3z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>',
  bolt: '<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>',
  energy: '<rect x="3" y="7" width="16" height="10" rx="2"/><path d="M21 10v4"/><path d="M11 9l-2 3h4l-2 3"/>',
  camera: '<path d="M3 8a2 2 0 0 1 2-2h2l1.5-2h7L17 6h2a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><circle cx="12" cy="13" r="3.5"/>',
  bell: '<path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4z"/><path d="M10 20a2 2 0 0 0 4 0"/>',
  music: '<path d="M9 18V5l11-2v13"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="17.5" cy="16" r="2.5"/>',
  tv: '<rect x="3" y="5" width="18" height="12" rx="2"/><path d="M8 21h8M12 17v4"/>',
  scene: '<path d="M4 20l11-11"/><path d="M13 7l2-2 2 2-2 2z"/><path d="M19 3v2M18 4h2M8 4v2M7 5h2M19 12v2M18 13h2"/>',
  home: '<path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/><path d="M10 20v-6h4v6"/>',
  fire: '<path d="M12 21a7 7 0 0 0 7-7c0-4-3-6-4-9-1 3-3 4-4 2-1 2-6 4-6 7a7 7 0 0 0 7 7z"/><path d="M12 21a3 3 0 0 0 3-3c0-2-2-3-3-5-1 2-3 3-3 5a3 3 0 0 0 3 3z"/>',
  water: '<path d="M3 15c2 0 2 1.5 4.5 1.5S9.5 15 12 15s2.5 1.5 4.5 1.5S19 15 21 15"/><path d="M3 19c2 0 2 1.5 4.5 1.5S9.5 19 12 19s2.5 1.5 4.5 1.5S19 19 21 19"/><path d="M12 3s4 4 4 7a4 4 0 0 1-8 0c0-3 4-7 4-7z"/>',
  car: '<path d="M5 16V12l2-5h10l2 5v4"/><path d="M3 12h18v4H3z"/><circle cx="7.5" cy="16.5" r="1.5"/><circle cx="16.5" cy="16.5" r="1.5"/>',
  tree: '<path d="M12 3l6 8h-3l4 5H5l4-5H6z"/><path d="M12 16v5"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/>',
  star: '<path d="M12 3l2.6 5.6 6 .7-4.5 4.1 1.2 6-5.3-3-5.3 3 1.2-6L3.4 9.3l6-.7z"/>',
  gauge: '<path d="M4 18a9 9 0 1 1 16 0"/><path d="M12 14l4-5"/><circle cx="12" cy="14" r="1.2"/>',
  // UI
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M14 6l4 4"/>',
  menu: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9L7 7M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/>',
  up: '<path d="M6 15l6-6 6 6"/>',
  down: '<path d="M6 9l6 6 6-6"/>',
  stop: '<rect x="7" y="7" width="10" height="10" rx="1.5"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  map: '<path d="M3 6l6-3 6 3 6-3v15l-6 3-6-3-6 3z"/><path d="M9 3v15M15 6v15"/>',
  grid: '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  fullscreen: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
};

const ICON_LABELS = {
  bulb: 'Licht', lamp: 'Lampe', power: 'Ein/Aus', socket: 'Steckdose', blind: 'Rollladen', window: 'Fenster',
  door: 'Tür', garage: 'Garage', gate: 'Tor', lock: 'Schloss', alarm: 'Alarm', shield: 'Sicherheit',
  motion: 'Bewegung', thermometer: 'Temperatur', heat: 'Heizung', drop: 'Feuchte', fan: 'Lüftung', sun: 'Sonne',
  moon: 'Nacht', bolt: 'Strom', energy: 'Energie', camera: 'Kamera', bell: 'Klingel', music: 'Musik', tv: 'TV',
  scene: 'Szene', home: 'Haus', fire: 'Brand', water: 'Wasser', car: 'Auto', tree: 'Garten', info: 'Info',
  star: 'Favorit', gauge: 'Anzeige',
};

function icon(name, cls) {
  const p = ICON_PATHS[name] || ICON_PATHS.info;
  return '<svg class="ic' + (cls ? ' ' + cls : '') + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + p + '</svg>';
}
