'use strict';

/*
 * "Verknüpfung": a tile of type `ref` points to another tile ('page/tile') and shows exactly that tile - same data
 * points, settings, PIN, time switch and locks - only position, size, label and layer are its own. Used by the page
 * (window.RefLogic) and by the adapter (require) for read / write permissions and the PIN check.
 */
(function (root) {
  // what the link keeps of its own
  const OWN = ['id', 'x', 'y', 'gx', 'gy', 'sw', 'sh', 'size', 'device', 'layer', 'rotate'];

  function find(layout, key) {
    const [pageId, tileId] = String(key || '').split('/');
    const page = (layout.pages || []).find(p => p.id === pageId);
    return page ? page.tiles.find(t => t.id === tileId) || null : null;
  }

  /** the tile as shown: the original's fields + the link's own ones; `_ref` = key of the original; null if missing */
  function resolve(t, layout) {
    if (!t || t.type !== 'ref') return t;
    const orig = find(layout, t.ref);
    if (!orig || orig.type === 'ref') return null;
    const out = { ...orig, _ref: t.ref, label: t.label || orig.label };
    delete out.homekit;
    delete out.hkId;
    for (const k of OWN) {
      if (t[k] !== undefined) out[k] = t[k];
      else if (k !== 'id') delete out[k];
    }
    return out;
  }

  /** layout with every link replaced by its resolved tile (missing originals: the link stays as type ref) */
  function resolveAll(layout) {
    return {
      ...layout,
      pages: (layout.pages || []).map(p => ({ ...p, tiles: p.tiles.map(t => (t.type === 'ref' ? resolve(t, layout) || t : t)) })),
    };
  }

  const api = { resolve, resolveAll, find };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RefLogic = api;
})(this);
