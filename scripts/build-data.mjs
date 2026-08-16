#!/usr/bin/env node
/**
 * Downloads the whole US airspace dataset from the FAA and bakes it into static
 * 5-degree tiles under data/, so the published page never has to touch the FAA's
 * rate-limited ArcGIS service at runtime.
 *
 * Run: node scripts/build-data.mjs
 */
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const FAA = 'https://services6.arcgis.com/ssFJjBXIUyZDrSYZ/arcgis/rest/services';
const CLASS_URL = `${FAA}/Class_Airspace/FeatureServer/0/query`;
const SUA_URL   = `${FAA}/Special_Use_Airspace/FeatureServer/0/query`;
const PAGE = 1000;              // well under the service's 2000 maxRecordCount
const TILE = 5;                 // degrees
const OUT  = 'data';

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function get(url, params, attempt = 0) {
  const u = new URL(url);
  Object.entries(params).forEach(([k, v]) => u.searchParams.set(k, v));
  try {
    const r = await fetch(u, { headers: { 'User-Agent': 'us-airspace-3d/1.0' } });
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    const j = await r.json();
    if (j.error) throw new Error(j.error.message || `service error ${j.error.code}`);
    return j;
  } catch (e) {
    if (attempt >= 6) throw e;
    const wait = Math.min(60000, 2000 * 2 ** attempt);
    console.log(`  retry ${attempt + 1} in ${wait / 1000}s — ${e.message}`);
    await sleep(wait);
    return get(url, params, attempt + 1);
  }
}

async function fetchAll(url, where, label) {
  const feats = [];
  for (let offset = 0; ; offset += PAGE) {
    const j = await get(url, {
      where,
      outFields: '*',
      returnGeometry: 'true',
      outSR: '4326',
      resultOffset: offset,
      resultRecordCount: PAGE,
      f: 'geojson'
    });
    const got = j.features || [];
    feats.push(...got);
    process.stdout.write(`\r  ${label}: ${feats.length}`);
    if (got.length < PAGE && !j.properties?.exceededTransferLimit) break;
    if (got.length === 0) break;
    await sleep(400);                      // stay well inside the quota
  }
  console.log('');
  return feats;
}

/* ---- normalising: mirrors the logic in index.html ---- */
const num = v => { const n = Number(v); return Number.isFinite(n) ? n : null; };

function alt(val, uom) {
  let n = num(val);
  if (n === null || n <= -999) return null;         // -9998 = no defined limit
  if (String(uom || '').toUpperCase().startsWith('FL')) n *= 100;
  return n;
}

const titleCase = s => String(s).toLowerCase()
  .replace(/\b([a-z])/g, m => m.toUpperCase())
  .replace(/\bMoa\b/g, 'MOA')
  .replace(/\b(Afb|Arb|Ang|Nas|Naf|Mcas|Intl|Rgnl|Muni|Us|Jr)\b/g, m => m.toUpperCase());

// 4 decimal places is ~11 m — far finer than any airspace boundary needs.
const round = c => (typeof c[0] === 'number')
  ? [Math.round(c[0] * 1e4) / 1e4, Math.round(c[1] * 1e4) / 1e4]
  : c.map(round);

// Drop consecutive duplicate vertices left behind by rounding.
function dedupeRing(ring) {
  const out = [];
  for (const p of ring) {
    const q = out[out.length - 1];
    if (!q || q[0] !== p[0] || q[1] !== p[1]) out.push(p);
  }
  if (out.length > 2) {
    const a = out[0], b = out[out.length - 1];
    if (a[0] !== b[0] || a[1] !== b[1]) out.push([a[0], a[1]]);
  }
  return out.length >= 4 ? out : null;
}

function cleanGeometry(g) {
  const r = round(g.coordinates);
  if (g.type === 'Polygon') {
    const rings = r.map(dedupeRing).filter(Boolean);
    return rings.length ? { type: 'Polygon', coordinates: rings } : null;
  }
  if (g.type === 'MultiPolygon') {
    const polys = r.map(p => p.map(dedupeRing).filter(Boolean)).filter(p => p.length);
    return polys.length ? { type: 'MultiPolygon', coordinates: polys } : null;
  }
  return null;
}

function normalise(features, kind) {
  const out = [];
  for (const f of features) {
    if (!f.geometry) continue;
    const p = f.properties || {};
    let cls, name;

    if (kind === 'sua') {
      const tc = String(p.TYPE_CODE || p.TYPE || '').toUpperCase();
      if (tc.startsWith('W')) continue;             // offshore warning areas
      const type = tc.startsWith('MOA') ? 'MOA' : tc.startsWith('R') ? 'Restricted'
                 : tc.startsWith('P') ? 'Prohibited' : tc.startsWith('A') ? 'Alert' : (tc || 'SUA');
      cls = 'SUA';
      name = `${p.NAME || p.IDENT || 'Special use airspace'} · ${type}`;
    } else {
      const lt = String(p.LOCAL_TYPE || '').toUpperCase();
      const c = String(p.CLASS || '').toUpperCase();
      if (c === 'E' || lt.startsWith('CLASS_E')) {
        if (lt === 'CLASS_E5' || lt === 'CLASS_E') continue;   // 700/1200 AGL blanket
        cls = 'E';
      } else if (c === 'B' || c === 'C' || c === 'D') {
        cls = c;
      } else continue;                                          // Class A, offshore
      name = titleCase(p.NAME || p.IDENT || '');
    }

    const geometry = cleanGeometry(f.geometry);
    if (!geometry) continue;

    let low = alt(p.LOWER_VAL, p.LOWER_UOM);
    let high = alt(p.UPPER_VAL, p.UPPER_UOM);
    const agl = low > 0 && String(p.LOWER_CODE || '').toUpperCase() === 'SFC';
    const openTop = high === null;
    if (low === null) low = 0;
    if (openTop) high = 18000;
    if (high <= low) high = low + 500;

    out.push({
      type: 'Feature',
      geometry,
      properties: {
        cls, low, high, agl: agl ? 1 : 0, open: openTop ? 1 : 0,
        name,
        hours: p.WKHR_CODE || p.TIMESOFUSE || ''
      }
    });
  }
  return out;
}

/* ---- tiling ---- */
const tileKey = (lon, lat) => `${Math.floor(lon / TILE) * TILE}_${Math.floor(lat / TILE) * TILE}`;

function bboxOf(geom) {
  let x0 = 180, y0 = 90, x1 = -180, y1 = -90;
  const walk = c => {
    if (typeof c[0] === 'number') {
      if (c[0] < x0) x0 = c[0]; if (c[0] > x1) x1 = c[0];
      if (c[1] < y0) y0 = c[1]; if (c[1] > y1) y1 = c[1];
    } else c.forEach(walk);
  };
  walk(geom.coordinates);
  return [x0, y0, x1, y1];
}

const main = async () => {
  console.log('Downloading Class B/C/D…');
  const bcd = await fetchAll(CLASS_URL, "CLASS IN ('B','C','D')", 'class B/C/D');
  console.log('Downloading Class E surface areas…');
  const esfc = await fetchAll(CLASS_URL, "LOCAL_TYPE IN ('CLASS_E2','CLASS_E3','CLASS_E4')", 'class E');
  console.log('Downloading special use airspace…');
  const sua = await fetchAll(SUA_URL, '1=1', 'SUA');

  const feats = [
    ...normalise(bcd, 'as'),
    ...normalise(esfc, 'as'),
    ...normalise(sua, 'sua')
  ];
  console.log(`\n${feats.length} usable volumes after normalising`);

  // A feature lands in every tile its bbox touches, so a viewport query never
  // misses a shelf that straddles a tile edge.
  const tiles = new Map();
  for (const f of feats) {
    const [x0, y0, x1, y1] = bboxOf(f.geometry);
    for (let lon = Math.floor(x0 / TILE) * TILE; lon <= x1; lon += TILE) {
      for (let lat = Math.floor(y0 / TILE) * TILE; lat <= y1; lat += TILE) {
        const k = tileKey(lon + 0.001, lat + 0.001);
        if (!tiles.has(k)) tiles.set(k, []);
        tiles.get(k).push(f);
      }
    }
  }

  if (existsSync(OUT)) await rm(OUT, { recursive: true });
  await mkdir(`${OUT}/tiles`, { recursive: true });

  let bytes = 0;
  const counts = {};
  for (const [k, list] of tiles) {
    const body = JSON.stringify({ type: 'FeatureCollection', features: list });
    bytes += body.length;
    counts[k] = list.length;
    await writeFile(`${OUT}/tiles/${k}.json`, body);
  }

  const byClass = {};
  for (const f of feats) byClass[f.properties.cls] = (byClass[f.properties.cls] || 0) + 1;

  await writeFile(`${OUT}/index.json`, JSON.stringify({
    generated: new Date().toISOString(),
    source: 'FAA Aeronautical Information Services',
    tileDegrees: TILE,
    features: feats.length,
    byClass,
    tiles: counts
  }, null, 2));

  console.log(`Wrote ${tiles.size} tiles, ${(bytes / 1e6).toFixed(1)} MB total`);
  console.log('By class:', byClass);
};

main().catch(e => { console.error(e); process.exit(1); });
