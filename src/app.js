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

// later is drawn on top, so the small low stuff wins
const DRAW = ['B', 'C', 'SUA', 'E', 'D'];
// ONE fixed vertical scale, deliberately. An earlier version derived this from the
// view width so every frame was individually optimal — and it was wrong: zooming
// changed the shape of the thing you were trying to learn. Constancy of the object
// beats per-frame prettiness. 6x reads sensibly from a single Class D up to a
// whole sectional, so it is simply constant.
const EXAG = 6;

const opacityFor = c => Math.min(0.97, state.opacity * (state.evenOp ? 1 : CLASSES[c].w));

const HOME = { center: [-122.28, 37.56], zoom: 9.05, pitch: 66, bearing: 335 };
const FRAMES = {
  over:    { pitch: 15 },
  tilt:    { pitch: 70 },
  low:     { pitch: 82 },
  profile: { pitch: 85 }
};

const state = {
  exag: EXAG, opacity: 1.0, alt: 3500,
  planeOn: false, sliceOn: false, labelsOn: true, airportsOn: true,
  orbitDrag: false, shape: 'solid', footOn: true, evenOp: false, clipOn: false,
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
  const want = tilesFor(box, snap.tileDegrees)
    .filter(k => snap.tiles[k] && !state.tilesLoaded.has(k));
  if (!want.length) return false;
  status('Loading airspace…');
  for (const k of want) {
    try {
      const r = await fetch('data/tiles/' + k + '.json');
      if (!r.ok) throw new Error(r.status);
      const fc = await r.json();
      (fc.features || []).forEach(f => { const h = hydrate(f); state.feats.set(h.key, h); });
      state.tilesLoaded.add(k);
    } catch (e) { /* a missing tile just means no airspace there */ }
  }
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

/* ---- edge bands ------------------------------------------------------------
   A "floor plate" spanning the whole polygon is a solid sheet lying directly on
   top of whatever is underneath — measured, a Bravo's floor plate let only 21% of
   the light through to the Class D below it. So the rims are rings, not plates:
   the polygon with an inward-offset copy punched out as a hole. You still get a
   crisp bright edge at the floor and ceiling, but the middle is open sky.        */
function offsetRing(ring, d, lat) {
  const kx = 1 / Math.max(0.2, Math.cos(lat * Math.PI / 180));
  const n = ring.length - 1;                       // ring is closed
  if (n < 3) return null;
  const out = [];
  for (let i = 0; i < n; i++) {
    const p = ring[i], a = ring[(i - 1 + n) % n], b = ring[(i + 1) % n];
    const e1x = (p[0] - a[0]) / kx, e1y = p[1] - a[1];
    const e2x = (b[0] - p[0]) / kx, e2y = b[1] - p[1];
    const l1 = Math.hypot(e1x, e1y) || 1, l2 = Math.hypot(e2x, e2y) || 1;
    // right-hand normals of the two edges, averaged into the corner bisector
    let bx = (e1y / l1) + (e2y / l2), by = -(e1x / l1) - (e2x / l2);
    const bl = Math.hypot(bx, by);
    if (bl < 1e-9) { bx = e1y / l1; by = -e1x / l1; } else { bx /= bl; by /= bl; }
    out.push([p[0] + bx * d * kx, p[1] + by * d]);
  }
  out.push(out[0].slice());
  return out;
}

const ringArea = r => {
  let s = 0;
  for (let i = 0, n = r.length - 1; i < n; i++) s += r[i][0] * r[i + 1][1] - r[i + 1][0] * r[i][1];
  return Math.abs(s) / 2;
};

// Offset inward whichever way shrinks the ring, and bail out if the result folds
// in on itself — a thin or spiky polygon just keeps its solid plate, which costs
// nothing because it was never big enough to hide anything.
function bandFor(poly, lat) {
  const build = (rings) => {
    const outer = rings[0];
    const A = ringArea(outer);
    if (A < 1e-6) return null;
    const d = Math.min(0.010, Math.max(0.0016, Math.sqrt(A) * 0.10));
    let best = null;
    for (const s of [d, -d]) {
      const inner = offsetRing(outer, s, lat);
      if (!inner) continue;
      const ia = ringArea(inner);
      if (ia < A * 0.97 && ia > A * 0.12) { best = inner; break; }
    }
    return best ? [outer, best] : null;
  };
  if (poly.type === 'Polygon') {
    const r = build(poly.coordinates);
    return r ? { type: 'Polygon', coordinates: r } : null;
  }
  const polys = [];
  for (const pc of poly.coordinates) {
    const r = build(pc);
    if (r) polys.push(r);
  }
  return polys.length ? { type: 'MultiPolygon', coordinates: polys } : null;
}

function buildFC() {
  const feats = [];
  const clip = state.clipOn ? state.alt : Infinity;
  state.feats.forEach(f => {
    if (!CLASSES[f.properties.cls].on) return;
    if (f.properties.low >= clip) return;
    const lo = f.properties.low * FT * state.exag;
    const hi = Math.min(f.properties.high, clip) * FT * state.exag;
    const slab = Math.max(12 * state.exag, Math.min(26 * state.exag, (hi - lo) * 0.10));
    const props = Object.assign({}, f.properties, {
      base: lo, top: hi, fbase: lo, ftop: lo + slab, cbase: hi - slab, ctop: hi
    });
    feats.push({ type: 'Feature', geometry: f.geometry, properties: Object.assign({ rim: 0 }, props) });

  });
  return { type: 'FeatureCollection', features: feats };
}

function refresh() {
  if (!map.getSource('airspace')) return;
  map.getSource('airspace').setData(buildFC());

  const S = state.shape;                       // solid | shells | floors
  Object.keys(CLASSES).forEach(c => {
    const on = CLASSES[c].on;
    const vis = v => (on && v) ? 'visible' : 'none';
    const set = (id, v, op) => {
      if (!map.getLayer(id)) return;
      map.setLayoutProperty(id, 'visibility', vis(v));
      if (op != null) map.setPaintProperty(id, 'fill-extrusion-opacity', op);
    };
    set('as-' + c, true, bodyOp(c));
    if (map.getLayer('as-' + c + '-foot'))
      map.setLayoutProperty('as-' + c + '-foot', 'visibility', vis(state.footOn));
    if (map.getLayer('as-' + c + '-hl')) {
      map.setLayoutProperty('as-' + c + '-hl', 'visibility', vis(state.sliceOn));
      map.setFilter('as-' + c + '-hl', ['all',
        ['==', ['get', 'cls'], c], ['==', ['get', 'rim'], 0],
        ['<=', ['get', 'low'], state.alt],
        ['>',  ['get', 'high'], state.alt]]);
    }
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
  return big.concat(small).slice(0, 140);
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
   A translucent box on its own is fog: overlap two and you get one blob. What makes
   a glass solid readable is its EDGES. So every volume is drawn four times —
   a very faint body, a bright plate at the floor, a softer plate at the ceiling,
   and its outline on the ground — and the eye reassembles the box from the rims.  */

const bodyOp = c => Math.min(0.55, state.opacity * (state.evenOp ? 1 : CLASSES[c].w));
const rimOp  = c => 0.92;   // safe to be solid: a band hides almost nothing

function addLayers() {
  DRAW.forEach(c => {
    const common = {
      type: 'fill-extrusion', source: 'airspace',
      paint: {
        'fill-extrusion-color': rampFor(c),
        'fill-extrusion-vertical-gradient': false
      }
    };
    const layer = (id, baseKey, topKey, op, rim, extra) => map.addLayer({
      id, ...common,
      filter: ['all', ['==', ['get', 'cls'], c], ['==', ['get', 'rim'], rim]],
      layout: extra?.layout || {},
      paint: Object.assign({}, common.paint, {
        'fill-extrusion-base':   ['get', baseKey],
        'fill-extrusion-height': ['get', topKey],
        'fill-extrusion-opacity': op
      })
    });

    // footprint on the ground: says WHERE the thing is, whatever the 3D is doing
    map.addLayer({
      id: 'as-' + c + '-foot', type: 'line', source: 'airspace',
      filter: ['all', ['==', ['get', 'cls'], c], ['==', ['get', 'rim'], 0]],
      layout: { 'line-join': 'round' },
      paint: { 'line-color': rampFor(c), 'line-width': 1.6, 'line-opacity': 0.9 }
    });

    layer('as-' + c,           'base',  'top',  bodyOp(c), 0);        // the glass box
    layer('as-' + c + '-hl',   'base',  'top',  0.92, 0, { layout: { visibility: 'none' } });
  });

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
    .flatMap(c => ['as-' + c, 'as-' + c + '-hl']).filter(id => map.getLayer(id));
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

on('alt',  'input', e => { state.alt = +e.target.value; $('altV').textContent = state.alt.toLocaleString() + ' ft'; refresh(); });

document.querySelectorAll('[data-cls]').forEach(cb => cb.addEventListener('change', e => {
  CLASSES[e.target.dataset.cls].on = e.target.checked;
  if (e.target.dataset.cls === 'E' && e.target.checked) loadView(false);
  refresh();
}));
on('clip',   'change', e => { state.clipOn = e.target.checked; refresh(); });
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
