/* ================= config ================= */
const FAA = 'https://services6.arcgis.com/ssFJjBXIUyZDrSYZ/arcgis/rest/services';
const FT = 0.3048;
const MIN_ZOOM = 6;          // below this, don't hammer the FAA service
const MAX_BOX = 7;           // degrees – clamp the query envelope
const MAX_FEATURES = 6000;   // memory guard; past this we reset and reload the view

// Palette validated with the dataviz skill's checker (dark surface, --pairs all,
// which is the right test because every class is on screen at once):
// blue/magenta/yellow passes CVD and normal-vision separation on all pairs.
// Blue-B and magenta-C also match sectional convention. Class D is yellow rather
// than the chart's dashed blue, which would be indistinguishable from Class B here.
// SUA is a status colour, not a categorical slot — it always ships with a label.
const CLASSES = {
  B:   { on: true,  lo: '#9ecbf5', hi: '#14528f', w: 0.42, label: 'Class B' },
  C:   { on: true,  lo: '#f0aac4', hi: '#8e2f56', w: 0.68, label: 'Class C' },
  D:   { on: true,  lo: '#f2cf82', hi: '#8a5b00', w: 0.88, label: 'Class D' },
  E:   { on: false, lo: '#c3c2b7', hi: '#6b6a63', w: 0.55, label: 'Class E surface' },
  SUA: { on: true,  lo: '#f2a9a9', hi: '#a32d2c', w: 0.80, label: 'Restricted / MOA' }
};
// Within a class, floor altitude drives lightness: low shelves light, high shelves
// dark. That is what turns a fused blue lump into readable tiers.
const rampFor = c => ['interpolate', ['linear'], ['get', 'low'],
  0,    CLASSES[c].lo,
  1500, mix(CLASSES[c].lo, CLASSES[c].hi, 0.30),
  2500, mix(CLASSES[c].lo, CLASSES[c].hi, 0.50),
  4000, mix(CLASSES[c].lo, CLASSES[c].hi, 0.70),
  6000, mix(CLASSES[c].lo, CLASSES[c].hi, 0.86),
  9000, CLASSES[c].hi];

function mix(a, b, t) {
  const h = s => [1, 3, 5].map(i => parseInt(s.substr(i, 2), 16));
  const [r1, g1, b1] = h(a), [r2, g2, b2] = h(b);
  const c = v => Math.round(v).toString(16).padStart(2, '0');
  return '#' + c(r1 + (r2 - r1) * t) + c(g1 + (g2 - g1) * t) + c(b1 + (b2 - b1) * t);
}

/* Draw order is the whole ballgame, and it is not what it looks like.
 *
 * fill-extrusion is depth-tested AND depth-writing, and MapLibre draws layers in
 * stack order. So a layer drawn EARLIER occludes anything drawn later that sits
 * behind it — even when that earlier layer is nearly transparent. Class B used to
 * be first in the stack, which meant every Class C and D underneath the Bravo
 * failed the depth test and was thrown away. The basemap still showed through,
 * because a raster writes no depth. That is exactly the "I can see the ground but
 * not the Class D" symptom: it was never an opacity problem.
 *
 * The fix is to draw strictly back-to-front for a camera above the stack, i.e.
 * lowest floor first. Opacity has to stay a per-layer property (alpha inside
 * fill-extrusion-color is ignored by MapLibre — verified, it renders opaque), so
 * "sorted" has to mean one layer per floor band per class, emitted in order.
 *
 * Bands are cut where Bay Area airspace actually stacks: Class D and C floors sit
 * at SFC/1,500/2,500, and the SFO Bravo's 17 shelves floor at 1,500 through 8,000.
 */
const BANDS = [0, 1500, 2500, 3500, 5000, 7000, 9000, 12000, 1e9];
// Within one band the same back-to-front rule applies, so the big high lids go last.
const STACK = ['D', 'E', 'C', 'SUA', 'B'];
// ONE fixed vertical scale, deliberately. An earlier version derived this from the
// view width so every frame was individually optimal — and it was wrong: zooming
// changed the shape of the thing you were trying to learn. Constancy of the object
// beats per-frame prettiness. 6x reads sensibly from a single Class D up to a
// whole sectional, so it is simply constant.
const EXAG = 6;

const HOME = { center: [-122.28, 37.56], zoom: 9.05, pitch: 66, bearing: 335 };
// Top of the cut-away slider means "off". It used to be gated behind a separate
// "Slice the sky here" checkbox, so dragging the slider on its own did nothing at
// all except change a line of text — which read exactly like a broken control.
// The slider now IS the cut-away, and its maximum is the off position.
const CLIP_OFF = 12000;

const state = {
  exag: EXAG, opacity: 1.0, alt: CLIP_OFF,
  planeOn: false, labelsOn: true, airportsOn: true, rimsOn: true,
  footOn: true, evenOp: false, clipOn: false,
  snapshot: null,            // data/index.json when a baked dataset is present
  tilesLoaded: new Set(),
  feats: new Map(),          // dedupe key -> feature
  boxes: [],                 // envelopes already fetched
  eBoxes: [],                // envelopes already fetched for Class E surface
  busy: false
};

/* ================= basemaps ================= */
const rasterSources = {
  sectional: { type:'raster', tileSize:256, maxzoom:11, attribution:'FAA VFR Sectional',
    tiles:['https://tiles.arcgis.com/tiles/ssFJjBXIUyZDrSYZ/arcgis/rest/services/VFR_Sectional/MapServer/tile/{z}/{y}/{x}'] },
  tac: { type:'raster', tileSize:256, maxzoom:12, attribution:'FAA VFR Terminal Area Chart',
    tiles:['https://tiles.arcgis.com/tiles/ssFJjBXIUyZDrSYZ/arcgis/rest/services/VFR_Terminal/MapServer/tile/{z}/{y}/{x}'] },
  sat: { type:'raster', tileSize:256, maxzoom:18, attribution:'Esri World Imagery',
    tiles:['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'] },
  topo: { type:'raster', tileSize:256, maxzoom:16, attribution:'Esri World Topo',
    tiles:['https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}'] }
};

const map = new maplibregl.Map({
  container: 'map',
  style: {
    version: 8,
    sources: Object.assign({}, rasterSources, {
      airspace: { type:'geojson', data:{ type:'FeatureCollection', features:[] } },
      plane:    { type:'geojson', data:{ type:'FeatureCollection', features:[] } }
    }),
    layers: [
      { id:'bg', type:'background', paint:{ 'background-color':'#0d1117' } },
      { id:'bm-sectional', type:'raster', source:'sectional', paint:{ 'raster-opacity':0.70, 'raster-saturation':-0.35, 'raster-contrast':-0.15 } },
      { id:'bm-tac',  type:'raster', source:'tac',  layout:{ visibility:'none' }, paint:{ 'raster-opacity':0.70, 'raster-saturation':-0.35, 'raster-contrast':-0.15 } },
      { id:'bm-sat',  type:'raster', source:'sat',  layout:{ visibility:'none' } },
      { id:'bm-topo', type:'raster', source:'topo', layout:{ visibility:'none' } }
    ]
  },
  center: HOME.center, zoom: HOME.zoom, pitch: HOME.pitch, bearing: HOME.bearing,
  maxPitch: 85, antialias: true, attributionControl: { compact: true }
});
window.map = map;   // handy for debugging and automated screenshots
window.state = state;
map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
map.addControl(new maplibregl.ScaleControl({ unit: 'imperial' }), 'bottom-left');
map.addControl(new maplibregl.GeolocateControl({ trackUserLocation: false }), 'top-right');

/* ================= query helpers ================= */
const sleep = ms => new Promise(r => setTimeout(r, ms));
const transient = e => /too many requests|429|rate|timeout|network|failed to fetch/i.test(e.message || '');

// The FAA's ArcGIS service enforces a shared anonymous quota and answers with an
// HTTP 200 whose body is an error object. Back off and retry rather than giving up.
async function qs(url, params, tries = 4) {
  const u = new URL(url);
  Object.entries(params).forEach(([k, v]) => u.searchParams.set(k, v));
  const waits = [1500, 5000, 13000];
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(u.toString(), { mode: 'cors' });
      if (!r.ok) throw new Error(r.status + ' ' + r.statusText);
      const j = await r.json();
      if (j && j.error) throw new Error(j.error.message || ('service error ' + j.error.code));
      return j;
    } catch (e) {
      if (i >= tries - 1 || !transient(e)) throw e;
      status('FAA service is busy — retrying in ' + Math.round(waits[i] / 1000) + 's…', 'warn');
      await sleep(waits[i]);
    }
  }
}

// The visible trapezoid runs to the horizon at high pitch, so clamp it.
function viewBox(pad) {
  const b = map.getBounds(), c = map.getCenter();
  let w = Math.min(Math.abs(b.getEast() - b.getWest()), MAX_BOX);
  let h = Math.min(Math.abs(b.getNorth() - b.getSouth()), MAX_BOX);
  w = Math.min(Math.max(w, 0.35) * (1 + pad), MAX_BOX);
  h = Math.min(Math.max(h, 0.35) * (1 + pad), MAX_BOX);
  return { xmin: c.lng - w / 2, ymin: c.lat - h / 2, xmax: c.lng + w / 2, ymax: c.lat + h / 2,
           spatialReference: { wkid: 4326 } };
}
const covers = (a, b) => a.xmin <= b.xmin && a.ymin <= b.ymin && a.xmax >= b.xmax && a.ymax >= b.ymax;

const envParams = (where, box) => ({
  where, geometry: JSON.stringify(box),
  geometryType: 'esriGeometryEnvelope',
  inSR: '4326', outSR: '4326',
  spatialRel: 'esriSpatialRelIntersects',
  // '*' on purpose: Class_Airspace has CLASS/LOCAL_TYPE/WKHR_CODE, Special_Use_Airspace
  // has TYPE_CODE/TIMESOFUSE, and naming a field the layer lacks is a hard 400.
  outFields: '*', returnGeometry: 'true',
  resultRecordCount: '2000', f: 'geojson'
});

/* ================= normalising ================= */
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }

// FAA AIS quirks:
//  · LOWER_VAL/UPPER_VAL are numbers in Class_Airspace, strings in Special_Use_Airspace
//  · -9998 is the "no defined limit" sentinel, not an altitude
//  · LOWER_CODE 'SFC' means "referenced to the surface" (AGL), not "at the surface" —
//    Class E5 reads 700 ft / SFC, i.e. 700 AGL. Test the value, not the code.
function alt(val, uom) {
  let n = num(val);
  if (n === null || n <= -999) return null;
  const u = (uom || '').toUpperCase();
  if (u === 'FL' || u === 'FLT') n *= 100;
  return n;
}

function titleCase(s) {
  return String(s).toLowerCase()
    .replace(/\b([a-z])/g, m => m.toUpperCase())
    .replace(/\bMoa\b/g, 'MOA')
    .replace(/\b(Afb|Arb|Ang|Nas|Naf|Mcas|Intl|Rgnl|Muni|Us|Jr)\b/g, m => m.toUpperCase());
}

function normalise(fc, kind) {
  const out = [];
  (fc.features || []).forEach(f => {
    if (!f.geometry) return;
    const p = f.properties || {};
    let cls, type, name;

    if (kind === 'sua') {
      const tc = (p.TYPE_CODE || p.TYPE || '').toUpperCase();
      if (tc.startsWith('W')) return;               // offshore warning areas: enormous, rarely useful
      cls = 'SUA';
      type = tc.startsWith('MOA') ? 'MOA' : tc.startsWith('R') ? 'Restricted'
           : tc.startsWith('P') ? 'Prohibited' : tc.startsWith('A') ? 'Alert' : (tc || 'SUA');
      name = (p.NAME || p.IDENT || 'Special use airspace') + ' · ' + type;
    } else {
      const lt = (p.LOCAL_TYPE || '').toUpperCase();
      const c = (p.CLASS || '').toUpperCase();
      if (c === 'E' || lt.startsWith('CLASS_E')) {
        if (lt === 'CLASS_E5' || lt === 'CLASS_E') return;   // 700/1200 AGL blanket – visual noise
        cls = 'E'; type = lt.replace('CLASS_', 'Class ');
      } else if (c === 'B' || c === 'C' || c === 'D') {
        cls = c; type = 'Class ' + c;
      } else return;                                          // Class A, offshore, etc.
      name = p.NAME || p.IDENT || '';
    }

    let low = alt(p.LOWER_VAL, p.LOWER_UOM);
    let high = alt(p.UPPER_VAL, p.UPPER_UOM);
    const agl = low > 0 && String(p.LOWER_CODE || '').toUpperCase() === 'SFC';
    const openTop = high === null;
    if (low === null) low = 0;
    if (openTop) high = 18000;
    if (high <= low) high = low + 500;

    let c0 = f.geometry.coordinates;
    while (Array.isArray(c0) && typeof c0[0] !== 'number') c0 = c0[0];

    out.push({
      key: kind + ':' + (f.id != null ? f.id : name + low + high + c0.join(',')),
      type: 'Feature',
      geometry: f.geometry,
      properties: {
        cls, type,
        name: kind === 'sua' ? name : titleCase(name),
        hours: p.WKHR_CODE || p.TIMESOFUSE || '',
        low, high,
        lowLabel: low === 0 ? 'SFC' : low.toLocaleString() + (agl ? ' AGL' : ' MSL'),
        highLabel: openTop ? '18,000 (base of Class A)' : high.toLocaleString() + ' MSL',
        shelf: (high / 100) + '/' + (low === 0 ? 'SFC' : low / 100)
      }
    });
  });
  return out;
}

/* ---- baked snapshot (data/ built weekly by GitHub Actions) ---- */
function hydrate(f) {
  const p = f.properties;
  const open = p.open === 1, agl = p.agl === 1;
  let c0 = f.geometry.coordinates;
  while (Array.isArray(c0) && typeof c0[0] !== 'number') c0 = c0[0];
  return {
    key: 's:' + p.cls + p.name + p.low + p.high + c0.join(','),
    type: 'Feature',
    geometry: f.geometry,
    properties: Object.assign({}, p, {
      type: p.cls === 'SUA' ? 'Special use' : 'Class ' + p.cls,
      lowLabel: p.low === 0 ? 'SFC' : p.low.toLocaleString() + (agl ? ' AGL' : ' MSL'),
      highLabel: open ? '18,000 (base of Class A)' : p.high.toLocaleString() + ' MSL',
      shelf: (p.high / 100) + '/' + (p.low === 0 ? 'SFC' : p.low / 100)
    })
  };
}

function tilesFor(box, deg) {
  const keys = [];
  for (let lon = Math.floor(box.xmin / deg) * deg; lon <= box.xmax; lon += deg)
    for (let lat = Math.floor(box.ymin / deg) * deg; lat <= box.ymax; lat += deg)
      keys.push(lon + '_' + lat);
  return keys;
}

async function loadTiles() {
  const snap = state.snapshot;
  const box = viewBox(0.35);
  const cx = (box.xmin + box.xmax) / 2, cy = (box.ymin + box.ymax) / 2;
  const want = tilesFor(box, snap.tileDegrees)
    .filter(k => snap.tiles[k] && !state.tilesLoaded.has(k))
    // nearest first, so what you are actually looking at appears before the edges
    .sort((a, b) => {
      const d = k => { const [x, y] = k.split('_').map(Number);
                       return (x - cx) ** 2 + (y - cy) ** 2; };
      return d(a) - d(b);
    });
  if (!want.length) return false;

  status('Loading airspace…');
  // Claim the keys up front so an overlapping moveend can't queue them twice, and
  // fetch a few at a time: these are small static files, serialising them was the
  // single biggest reason the Bay Area took so long to appear.
  want.forEach(k => state.tilesLoaded.add(k));
  const v = encodeURIComponent(snap.generated || '');   // cache-bust the weekly refresh
  const queue = want.slice();
  const worker = async () => {
    for (let k; (k = queue.shift()) !== undefined; ) {
      try {
        const r = await fetch('data/tiles/' + k + '.json?v=' + v);
        if (!r.ok) throw new Error(r.status);
        const fc = await r.json();
        (fc.features || []).forEach(f => { const h = hydrate(f); state.feats.set(h.key, h); });
      } catch (e) {
        state.tilesLoaded.delete(k);   // let a later pass retry it
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, want.length) }, worker));

  const when = new Date(snap.generated).toLocaleDateString(undefined,
    { year: 'numeric', month: 'short', day: 'numeric' });
  status('<span class="ok"></span>' + state.feats.size + ' volumes · FAA ' + when +
         ' · heights ×' + EXAG, 'good');
  counts();
  refresh();
  return true;
}

/* ================= loading ================= */
function status(msg, cls) {
  const s = document.getElementById('status');
  s.className = cls || '';
  s.innerHTML = msg;
}

function counts() {
  const c = {};
  state.feats.forEach(f => { const k = f.properties.cls; c[k] = (c[k] || 0) + 1; });
  Object.keys(CLASSES).forEach(k => {
    const el = document.getElementById('n' + k);
    if (el) el.textContent = c[k] || 0;
  });
}

let loadSeq = 0;
async function loadView(force) {
  if (state.snapshot) {                     // static tiles: no quota, no zoom floor
    try { await loadTiles(); return; } catch (e) { /* fall through to live */ }
  }
  if (map.getZoom() < MIN_ZOOM) {
    status('Zoom in to load airspace — the FAA feed is queried for whatever you\'re looking at.');
    return;
  }
  const box = viewBox(0.35);
  const needMain = force || !state.boxes.some(b => covers(b, box));
  const needE = CLASSES.E.on && (force || !state.eBoxes.some(b => covers(b, box)));
  if (!needMain && !needE) return;

  const seq = ++loadSeq;
  state.busy = true;
  status('Loading airspace for this area…');
  const CA = FAA + '/Class_Airspace/FeatureServer/0/query';
  const SU = FAA + '/Special_Use_Airspace/FeatureServer/0/query';
  const empty = { features: [] };

  try {
    // Serial, not parallel: three simultaneous queries is what trips the quota.
    const results = [];
    if (needMain) {
      results.push(normalise(await qs(CA, envParams("CLASS IN ('B','C','D')", box)), 'as'));
      if (seq !== loadSeq) return;
      if (CLASSES.SUA.on) {
        try { results.push(normalise(await qs(SU, envParams('1=1', box)), 'sua')); } catch (e) {}
      }
    }
    if (needE) {
      if (seq !== loadSeq) return;
      try {
        results.push(normalise(await qs(CA, envParams("LOCAL_TYPE IN ('CLASS_E2','CLASS_E3','CLASS_E4')", box)), 'as'));
      } catch (e) {}
    }
    if (seq !== loadSeq) return;                       // a newer request superseded this one

    if (state.feats.size > MAX_FEATURES) { state.feats.clear(); state.boxes = []; state.eBoxes = []; }
    results.flat().forEach(f => state.feats.set(f.key, f));
    if (needMain) state.boxes.push(box);
    if (needE) state.eBoxes.push(box);

    status('<span class="ok"></span>' + state.feats.size +
           ' airspace volumes loaded · live from FAA AIS', 'good');
    counts();
    refresh();
  } catch (e) {
    if (seq !== loadSeq) return;
    status('FAA airspace service unavailable — ' + e.message +
           '<br><button id="retry" class="mini">Try again</button>', 'bad');
    const rb = document.getElementById('retry');
    if (rb) rb.addEventListener('click', () => loadView(true));
  } finally {
    state.busy = false;
  }
}

/* ================= rendering ================= */

const ringArea = r => {
  let s = 0;
  for (let i = 0, n = r.length - 1; i < n; i++) s += r[i][0] * r[i + 1][1] - r[i + 1][0] * r[i][1];
  return Math.abs(s) / 2;
};

/* ---- rim ribbons -----------------------------------------------------------
   A translucent box on its own is fog; what makes glass read as a solid is its
   edges. Two earlier attempts at this failed and are worth not repeating: full
   floor/ceiling PLATES were opaque sheets lying on whatever was below (a Bravo's
   floor plate left 21% of the light for the Class D under it), and an inward-
   OFFSET RING punched out as a hole self-intersected on concave and holed
   shelves, tessellating into visible wedges.

   So build the ribbon per segment instead of per ring. Each edge becomes its own
   little quad, using the corner bisector at each end so neighbouring quads share
   an edge exactly — no overlap to z-fight, no gap, and nothing global that can
   fold in on itself. A concave corner at worst produces one bent quad, which is a
   local nudge rather than a corrupted polygon. Area is perimeter x width, so a
   ribbon hides essentially nothing of whatever is underneath it.               */
function ribbonRing(ring, w, kx) {
  const n = ring.length - 1;                        // ring is closed
  if (n < 3) return [];
  const nx = [], ny = [];
  for (let i = 0; i < n; i++) {
    const p = ring[i], a = ring[(i - 1 + n) % n], b = ring[(i + 1) % n];
    const e1x = (p[0] - a[0]) * kx, e1y = p[1] - a[1];
    const e2x = (b[0] - p[0]) * kx, e2y = b[1] - p[1];
    const l1 = Math.hypot(e1x, e1y) || 1, l2 = Math.hypot(e2x, e2y) || 1;
    let bx = (e1y / l1) + (e2y / l2), by = -(e1x / l1) - (e2x / l2);
    const bl = Math.hypot(bx, by);
    if (bl < 1e-6) { bx = e1y / l1; by = -e1x / l1; }
    else {
      // Normalise, then undo the foreshortening of a sharp corner — but clamp it,
      // because a hairpin would otherwise throw the corner off to infinity.
      const miter = Math.min(3, 1 / Math.max(0.34, bl / 2));
      bx = bx / bl * miter; by = by / bl * miter;
    }
    nx.push(bx); ny.push(by);
  }
  const quads = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const p = ring[i], q = ring[j];
    const ax = nx[i] * w / kx, ay = ny[i] * w;
    const bx = nx[j] * w / kx, by = ny[j] * w;
    quads.push([[
      [p[0] - ax, p[1] - ay], [q[0] - bx, q[1] - by],
      [q[0] + bx, q[1] + by], [p[0] + ax, p[1] + ay],
      [p[0] - ax, p[1] - ay]
    ]]);
  }
  return quads;
}

// One ribbon width per volume, scaled to how big the volume is, so a 5 NM Class D
// and a 50 NM Bravo both read at their own natural zoom instead of one looking
// like a hairline and the other like a wall. The cap matters: measured, a wide
// Bravo rim was costing a third of the light reaching the Class D underneath it,
// which is the exact mistake the floor plates made. Keep rims thin.
function ribbonFor(geom, lat) {
  const kx = Math.max(0.2, Math.cos(lat * Math.PI / 180));
  const rings = geom.type === 'Polygon' ? geom.coordinates
              : geom.coordinates.reduce((a, p) => a.concat(p), []);
  let area = 0;
  for (const r of rings) area = Math.max(area, ringArea(r));
  if (!(area > 0)) return null;
  const w = Math.min(0.0075, Math.max(0.0010, Math.sqrt(area) * 0.016)) / 2;
  const quads = [];
  for (const r of rings) {
    for (const q of ribbonRing(r, w, kx)) quads.push(q);
  }
  return quads.length ? { type: 'MultiPolygon', coordinates: quads } : null;
}

function buildFC() {
  const feats = [];
  const clip = state.clipOn ? state.alt : Infinity;
  state.feats.forEach(f => {
    const p = f.properties;
    if (!CLASSES[p.cls].on) return;
    if (p.low >= clip) return;
    const lo = p.low * FT * state.exag;
    const hi = Math.min(p.high, clip) * FT * state.exag;
    feats.push({ type: 'Feature', geometry: f.geometry,
                 properties: Object.assign({}, p, { rim: 0, base: lo, top: hi }) });

    if (!state.rimsOn) return;
    if (!f._c) { f._c = centroid(f.geometry); f._a = areaOf(f.geometry); }
    if (f._rib === undefined) f._rib = ribbonFor(f.geometry, f._c[1]);
    if (!f._rib) return;
    // A rim is a thin slab, not a plate: thick enough to catch the eye from a
    // shallow angle, thin enough that it never reads as a surface. It STRADDLES
    // the boundary it marks rather than sitting inside it — flush faces would be
    // coplanar with the box's own floor and ceiling and z-fight with them.
    const t = 55 * FT * state.exag;
    const rim = (z) => feats.push({ type: 'Feature', geometry: f._rib,
      properties: Object.assign({}, p, { rim: 1, base: z - t / 2, top: z + t / 2 }) });
    rim(lo);                                          // floor: the shape that matters
    if (hi - lo > t * 3) rim(hi);                     // ceiling, if there's room for it
  });
  return { type: 'FeatureCollection', features: feats };
}

function refresh() {
  if (!map.getSource('airspace')) return;
  map.getSource('airspace').setData(buildFC());

  Object.keys(CLASSES).forEach(c => {
    const vis = CLASSES[c].on ? 'visible' : 'none';
    const set = (id, op) => {
      if (!map.getLayer(id)) return;
      map.setLayoutProperty(id, 'visibility', vis);
      map.setPaintProperty(id, 'fill-extrusion-opacity', op);
    };
    (LAYERS.body[c] || []).forEach(id => set(id, bodyOp(c)));
    (LAYERS.rim[c]  || []).forEach(id => set(id, state.rimsOn ? rimOp(c) : 0));
    if (map.getLayer('as-' + c + '-foot'))
      map.setLayoutProperty('as-' + c + '-foot', 'visibility',
        (CLASSES[c].on && state.footOn) ? 'visible' : 'none');
  });
  updatePlane();
  updateLabels();
  updateReadout();
}

function updatePlane() {
  const z = state.alt * FT * state.exag;
  let g = { type:'FeatureCollection', features: [] };
  if (state.planeOn) {
    const b = viewBox(1.2);
    g.features.push({ type:'Feature', properties:{ base:z, top:z + 12 * state.exag },
      geometry:{ type:'Polygon', coordinates:[[
        [b.xmin,b.ymin],[b.xmax,b.ymin],[b.xmax,b.ymax],[b.xmin,b.ymax],[b.xmin,b.ymin]]] } });
  }
  map.getSource('plane').setData(g);
}

function updateReadout() {
  const el = document.getElementById('inside');
  if (!state.clipOn) {
    el.innerHTML = 'Drag to slice the sky at an altitude and see what you\u2019d be in.';
    return;
  }
  const names = new Set();
  state.feats.forEach(f => {
    const p = f.properties;
    if (CLASSES[p.cls].on && p.low <= state.alt && p.high > state.alt) names.add(p.name);
  });
  el.innerHTML = names.size
    ? '<b>' + names.size + '</b> airspace' + (names.size > 1 ? 's' : '') +
      ' occupy ' + state.alt.toLocaleString() + '&thinsp;ft in the loaded area'
    : 'Nothing charted at ' + state.alt.toLocaleString() + '&thinsp;ft here';
}

/* ================= DOM markers (no glyph server needed) ================= */
let airportMarkers = [], labelMarkers = [];

/* Past the horizon, map.project() still hands back a screen position — it just
   lands up in the sky, which is where the stray labels were coming from. Nothing
   in the public API says "is this point over the horizon", but the transform
   itself has to know in order to draw the sky, so ask it. Shifting the test point
   UP by a margin means "at least that many pixels below the horizon", which also
   clears out the pile-up of infinitely-distant markers along the horizon line.
   If MapLibre ever drops the method, fall back to culling nothing.            */
function onGround(pt, margin) {
  const tr = map.transform;
  if (!tr || typeof tr.isPointOnMapSurface !== 'function') return true;
  return tr.isPointOnMapSurface({ x: pt.x, y: pt.y - (margin || 0) });
}

// big: [code, name, lon, lat, elev]   ·   small: [code, lon, lat, name]
function visibleAirports() {
  const z = map.getZoom();
  if (z < 6.8) return [];
  const v = viewBox(0);
  const W = v.xmin, E = v.xmax, S = v.ymin, N = v.ymax;
  const big = AIRPORTS.b
    .filter(a => a[2] >= W && a[2] <= E && a[3] >= S && a[3] <= N)
    .map(a => ({ id:a[0], n:a[1], lon:a[2], lat:a[3], e:a[4], big:true }));
  const small = z < 8.6 ? [] : AIRPORTS.s
    .filter(a => a[1] >= W && a[1] <= E && a[2] >= S && a[2] <= N)
    .map(a => ({ id:a[0], n:a[3], lon:a[1], lat:a[2], big:false }));
  // Cull over-the-horizon ones BEFORE the cap, or at high pitch most of the 140
  // slots go to airports floating in the sky.
  return big.concat(small)
    .filter(a => onGround(map.project([a.lon, a.lat]), 12))
    .slice(0, 140);
}

function makeAirports() {
  airportMarkers.forEach(m => m.remove());
  airportMarkers = [];
  if (!state.airportsOn) return;
  visibleAirports().forEach(a => {
    const el = document.createElement('div');
    el.className = 'apt' + (a.big ? ' big' : '');
    el.innerHTML = '<span class="dot"></span><span class="tag">' + a.id + '</span>';
    el.title = a.n + (a.e != null ? ' — field elev ' + a.e + ' ft' : '');
    airportMarkers.push(new maplibregl.Marker({ element: el, anchor: 'center' })
      .setLngLat([a.lon, a.lat]).addTo(map));
  });
}

const swatch = (c, low) => mix(CLASSES[c].lo, CLASSES[c].hi, Math.min(1, (low || 0) / 10000));

function centroid(geom) {
  let x = 0, y = 0, n = 0;
  const walk = c => { if (typeof c[0] === 'number') { x += c[0]; y += c[1]; n++; } else c.forEach(walk); };
  walk(geom.coordinates);
  return [x / n, y / n];
}

function areaOf(geom) {
  let s = 0;
  const ring = r => { for (let i = 0, n = r.length - 1; i < n; i++)
    s += r[i][0] * r[i + 1][1] - r[i + 1][0] * r[i][1]; };
  const walk = c => { if (typeof c[0][0] === 'number') ring(c); else c.forEach(walk); };
  walk(geom.coordinates);
  return Math.abs(s);
}

// DOM markers can't be lifted to a shelf's altitude, so instead of scattering a
// label on every polygon we place as many as fit without overlapping: biggest and
// lowest first, then anything that still has room. Re-run on every camera move.
function updateLabels() {
  labelMarkers.forEach(m => m.remove());
  labelMarkers = [];
  if (!state.labelsOn) return;

  const W = map.getCanvas().clientWidth, H = map.getCanvas().clientHeight;
  const cand = [];
  state.feats.forEach(f => {
    if (!CLASSES[f.properties.cls].on) return;
    if (state.clipOn && f.properties.low >= state.alt) return;
    if (!f._c) { f._c = centroid(f.geometry); f._a = areaOf(f.geometry); }
    const pt = map.project(f._c);
    if (pt.x < 60 || pt.y < 20 || pt.x > W - 20 || pt.y > H - 40) return;
    if (!onGround(pt, 14)) return;
    cand.push({ f, pt });
  });

  // low floors first (they're the ones hidden under everything), then by size
  cand.sort((a, b) => (a.f.properties.low - b.f.properties.low) || (b.f._a - a.f._a));

  const placed = [];
  const CLEAR_X = 46, CLEAR_Y = 17;
  for (const { f, pt } of cand) {
    if (placed.length >= 40) break;
    if (placed.some(q => Math.abs(q.x - pt.x) < CLEAR_X && Math.abs(q.y - pt.y) < CLEAR_Y)) continue;
    placed.push(pt);
    const el = document.createElement('div');
    el.className = 'shelf c' + f.properties.cls;
    el.textContent = f.properties.shelf;
    el.title = f.properties.name + ' — ' + f.properties.highLabel + ' down to ' + f.properties.lowLabel;
    labelMarkers.push(new maplibregl.Marker({ element: el, anchor: 'center' })
      .setLngLat(f._c).addTo(map));
  }
}

/* ================= layers =================
   Every volume is drawn as a glass box plus a thin bright rim at its floor and
   ceiling, with its outline on the ground underneath. The rims are what let the
   eye reassemble a box out of fog — and for the modern SFO Bravo they are the
   whole point, because all 17 of its areas are capped at 10,000 and the shape
   lives entirely in the stepped floor underneath.

   Order matters more than any of the paint: see the BANDS comment at the top. */

const bodyOp = c => Math.min(0.55, state.opacity * (state.evenOp ? 1 : CLASSES[c].w));
// A rim can afford to be near-solid — it is perimeter x a few hundred metres, so
// it hides essentially nothing of whatever is underneath it.
const rimOp  = c => Math.min(0.95, 0.5 + 0.45 * state.opacity);

const LAYERS = { body: {}, rim: {} };

function addLayers() {
  // Footprints first, on the ground: they say WHERE everything is regardless of
  // what the 3D is doing, and every box above tints them as it should.
  Object.keys(CLASSES).forEach(c => {
    map.addLayer({
      id: 'as-' + c + '-foot', type: 'line', source: 'airspace',
      filter: ['all', ['==', ['get', 'cls'], c], ['==', ['get', 'rim'], 0]],
      layout: { 'line-join': 'round' },
      paint: { 'line-color': rampFor(c), 'line-width': 1.6, 'line-opacity': 0.9 }
    });
    LAYERS.body[c] = [];
    LAYERS.rim[c] = [];
  });

  // Lowest floor band first. Within a band: rims before their own bodies (a floor
  // rim sits behind its own ceiling and would otherwise be depth-culled by it),
  // and the tall lids last.
  for (let b = 0; b < BANDS.length - 1; b++) {
    for (const c of STACK) {
      const band = [['>=', ['get', 'low'], BANDS[b]], ['<', ['get', 'low'], BANDS[b + 1]]];
      const layer = (kind, rim, op) => {
        const id = 'as-' + c + '-' + kind + b;
        map.addLayer({
          id, type: 'fill-extrusion', source: 'airspace',
          filter: ['all', ['==', ['get', 'cls'], c], ['==', ['get', 'rim'], rim], ...band],
          paint: {
            'fill-extrusion-color': rampFor(c),
            'fill-extrusion-vertical-gradient': false,
            'fill-extrusion-base': ['get', 'base'],
            'fill-extrusion-height': ['get', 'top'],
            'fill-extrusion-opacity': op
          }
        });
        return id;
      };
      LAYERS.rim[c].push(layer('r', 1, rimOp(c)));
      LAYERS.body[c].push(layer('', 0, bodyOp(c)));
    }
  }

  map.addLayer({
    id: 'alt-plane', type: 'fill-extrusion', source: 'plane',
    paint: {
      'fill-extrusion-color': '#ffd24a',
      'fill-extrusion-base': ['get', 'base'],
      'fill-extrusion-height': ['get', 'top'],
      'fill-extrusion-opacity': 0.3
    }
  });
}

/* ================= boot ================= */
map.on('load', async () => {
  addLayers();
  makeAirports();
  initGizmo();
  try {
    const r = await fetch('data/index.json', { cache: 'no-cache' });
    if (r.ok) {
      const j = await r.json();
      if (j && j.tiles && j.features) state.snapshot = j;
    }
  } catch (e) { /* no baked data — use the live FAA service */ }
  loadView(true);
});

let moveTimer;
map.on('moveend', () => {
  clearTimeout(moveTimer);
  moveTimer = setTimeout(() => { loadView(false); makeAirports(); updateLabels(); updatePlane(); }, 900);
});
map.on('rotate', syncCam);
map.on('pitch', syncCam);
let labelTick;
map.on('move', () => {
  if (!state.labelsOn || labelTick) return;
  labelTick = requestAnimationFrame(() => { labelTick = null; updateLabels(); });
});

/* ================= interaction ================= */
const popup = new maplibregl.Popup({ closeButton: true, maxWidth: '290px' });
map.on('click', e => {
  const layers = Object.keys(CLASSES)
    .flatMap(c => LAYERS.body[c] || []).filter(id => map.getLayer(id));
  const hits = map.queryRenderedFeatures(e.point, { layers });
  if (!hits.length) return popup.remove();
  const seen = new Set();
  const rows = hits
    .filter(h => { const k = h.properties.name + h.properties.low; if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => a.properties.low - b.properties.low)
    .slice(0, 7)
    .map(h => {
      const p = h.properties;
      return '<div class="row"><span class="sw" style="background:' + swatch(p.cls, p.low) + '"></span>' +
        '<div><div class="nm">' + p.name + '</div>' +
        '<div class="alt"><b>' + p.highLabel + '</b> down to <b>' + p.lowLabel + '</b></div>' +
        (p.hours ? '<div class="hrs">' + p.hours + '</div>' : '') + '</div></div>';
    }).join('');
  popup.setLngLat(e.lngLat).setHTML('<div class="pop">' + rows + '</div>').addTo(map);
});

/* ---- direct-manipulation camera: compass ring + tilt bar ---- */
const clampP = v => Math.max(0, Math.min(85, v));
const norm = b => { while (b > 180) b -= 360; while (b < -180) b += 360; return b; };

// Double-click flies toward the point you clicked, like Google Earth.
map.doubleClickZoom.disable();
map.on('dblclick', e => {
  const out = e.originalEvent.shiftKey;
  map.easeTo({
    center: out ? map.getCenter() : e.lngLat,
    zoom: map.getZoom() + (out ? -1.2 : 1.2),
    duration: 700
  });
});

// shift+scroll spins, alt+scroll tilts
map.getContainer().addEventListener('wheel', e => {
  if (!e.shiftKey && !e.altKey) return;
  e.preventDefault(); e.stopPropagation();
  if (e.shiftKey) map.setBearing(map.getBearing() + e.deltaY * 0.22);
  else map.setPitch(clampP(map.getPitch() - e.deltaY * 0.14));
}, { capture: true, passive: false });

function initGizmo() {
  const comp = document.getElementById('compass');
  const rose = document.getElementById('rose');
  const tilt = document.getElementById('tilt');
  const fill = document.getElementById('tiltFill');
  const knob = document.getElementById('tiltKnob');
  const TRACK = 104 - 14;

  // The compass is absolute, not relative: grab it anywhere and the bearing
  // follows your finger, exactly like turning a physical dial.
  let grabOffset = 0;
  const angleAt = e => {
    const r = comp.getBoundingClientRect();
    return Math.atan2(e.clientX - (r.left + r.width / 2),
                      (r.top + r.height / 2) - e.clientY) * 180 / Math.PI;
  };
  comp.addEventListener('pointerdown', e => {
    comp.setPointerCapture(e.pointerId);
    comp.classList.add('drag');
    grabOffset = norm(angleAt(e) + map.getBearing());
    e.preventDefault();
  });
  comp.addEventListener('pointermove', e => {
    if (!comp.hasPointerCapture(e.pointerId)) return;
    map.setBearing(norm(grabOffset - angleAt(e)));
  });
  const release = e => { comp.classList.remove('drag'); if (comp.hasPointerCapture(e.pointerId)) comp.releasePointerCapture(e.pointerId); };
  comp.addEventListener('pointerup', release);
  comp.addEventListener('pointercancel', release);
  comp.addEventListener('dblclick', () => map.easeTo({ bearing: 0, duration: 500 }));

  const setTiltFrom = e => {
    const r = tilt.getBoundingClientRect();
    const t = 1 - Math.max(0, Math.min(1, (e.clientY - r.top - 7) / TRACK));
    map.setPitch(clampP(t * 85));
  };
  tilt.addEventListener('pointerdown', e => {
    tilt.setPointerCapture(e.pointerId); setTiltFrom(e); e.preventDefault();
  });
  tilt.addEventListener('pointermove', e => {
    if (tilt.hasPointerCapture(e.pointerId)) setTiltFrom(e);
  });
  tilt.addEventListener('dblclick', () => map.easeTo({ pitch: 0, duration: 500 }));

  window.__syncGizmo = () => {
    rose.setAttribute('transform', `rotate(${-map.getBearing()} 50 50)`);
    const t = clampP(map.getPitch()) / 85;
    knob.style.bottom = (4 + t * TRACK) + 'px';
    fill.style.height = (7 + t * TRACK) + 'px';
  };
  window.__syncGizmo();
}

/* ================= controls ================= */
const $ = id => document.getElementById(id);
const on = (id, ev, fn) => $(id).addEventListener(ev, fn);

function syncCam() { if (window.__syncGizmo) window.__syncGizmo(); }

on('alt', 'input', e => {
  state.alt = +e.target.value;
  state.clipOn = state.alt < CLIP_OFF;
  $('altV').textContent = state.clipOn ? state.alt.toLocaleString() + ' ft' : 'off';
  refresh();
});

document.querySelectorAll('[data-cls]').forEach(cb => cb.addEventListener('change', e => {
  CLASSES[e.target.dataset.cls].on = e.target.checked;
  if (e.target.dataset.cls === 'E' && e.target.checked) loadView(false);
  refresh();
}));
on('fill',   'input',  e => { state.opacity = +e.target.value / 100;
  document.getElementById('fillV').textContent = e.target.value + '%'; refresh(); });


document.querySelectorAll('[data-base]').forEach(b => b.addEventListener('click', e => {
  document.querySelectorAll('[data-base]').forEach(x => x.classList.remove('on'));
  e.target.classList.add('on');
  ['sectional','tac','sat','topo'].forEach(k =>
    map.setLayoutProperty('bm-' + k, 'visibility', k === e.target.dataset.base ? 'visible' : 'none'));
}));

on('panelToggle', 'click', () => $('panel').classList.toggle('collapsed'));

/* ---- airport search ---- */
function search(term) {
  const t = term.trim().toUpperCase();
  if (t.length < 2) return [];
  // whole-word match on names, so "ASE" finds Aspen by code but not "Joint Base Andrews"
  const esc = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const word = new RegExp('\\b' + esc, 'i');
  const exact = [], byCode = [], byName = [];
  for (const a of AIRPORTS.b) {
    if (a[0] === t) exact.push({ id:a[0], n:a[1], lon:a[2], lat:a[3] });
    else if (a[0].startsWith(t)) byCode.push({ id:a[0], n:a[1], lon:a[2], lat:a[3] });
    else if (t.length > 2 && byName.length < 8 && word.test(a[1])) byName.push({ id:a[0], n:a[1], lon:a[2], lat:a[3] });
  }
  for (const a of AIRPORTS.s) {
    if (a[0] === t) exact.push({ id:a[0], n:a[3], lon:a[1], lat:a[2] });
    else if (byCode.length < 10 && a[0].startsWith(t)) byCode.push({ id:a[0], n:a[3], lon:a[1], lat:a[2] });
    else if (t.length > 2 && byName.length < 10 && word.test(a[3])) byName.push({ id:a[0], n:a[3], lon:a[1], lat:a[2] });
  }
  return exact.concat(byCode, byName).slice(0, 8);
}

function flyToAirport(a) {
  $('q').value = a.id;
  $('results').innerHTML = '';
  map.flyTo({ center:[a.lon, a.lat], zoom:10.2, pitch:Math.max(map.getPitch(), 70),
              bearing:map.getBearing(), duration:2000 });
}

on('q', 'input', e => {
  const res = search(e.target.value);
  $('results').innerHTML = res.map((a, i) =>
    '<div class="res" data-i="' + i + '"><b>' + a.id + '</b><span>' + (a.n || '') + '</span></div>').join('');
  $('results').querySelectorAll('.res').forEach(d =>
    d.addEventListener('click', () => flyToAirport(res[+d.dataset.i])));
});
on('q', 'keydown', e => {
  if (e.key !== 'Enter') return;
  const res = search(e.target.value);
  if (res.length) flyToAirport(res[0]);
});
