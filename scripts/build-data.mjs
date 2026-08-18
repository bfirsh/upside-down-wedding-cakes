#!/usr/bin/env node
/**
 * Downloads the whole US airspace dataset from the FAA and bakes it into static
 * 1-degree tiles under data/, so the published page never has to touch the FAA's
 * rate-limited ArcGIS service at runtime.
 *
 * Run: node scripts/build-data.mjs
 */
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { simplifyGeometry, countPoints, tileFeatures } from './lib/geom.mjs';

const FAA = 'https://services6.arcgis.com/ssFJjBXIUyZDrSYZ/arcgis/rest/services';
const CLASS_URL = `${FAA}/Class_Airspace/FeatureServer/0/query`;
const SUA_URL   = `${FAA}/Special_Use_Airspace/FeatureServer/0/query`;
const PAGE = 1000;              // well under the service's 2000 maxRecordCount
// 1 degree ≈ 60 x 50 NM here, so a viewport pulls a handful of small tiles rather
// than one enormous one. At 5 degrees the Bay Area meant downloading a 4.2 MB file
// covering everything from Big Sur to Oregon before a single box could be drawn.
const TILE = 1;                 // degrees
const OUT  = 'data';
// The FAA tessellates arcs to ~5,000 vertices per circle. Simplifying to the 11 m
// precision the coordinates are rounded to anyway cuts the bake by ~97% and moves
// no boundary by more than about 13 m. See scripts/lib/geom.mjs.
const TOL  = 0.00012;

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

  let before = 0, after = 0;
  for (const f of feats) {
    before += countPoints(f.geometry);
    f.geometry = simplifyGeometry(f.geometry, TOL);
    after += countPoints(f.geometry);
  }
  console.log(`Simplified ${before.toLocaleString()} → ${after.toLocaleString()} vertices ` +
              `(${(100 - after / before * 100).toFixed(1)}% smaller)`);

  const tiles = tileFeatures(feats, TILE);

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
