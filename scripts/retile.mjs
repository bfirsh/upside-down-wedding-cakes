#!/usr/bin/env node
/**
 * Re-simplifies and re-tiles whatever is already in data/, without going back to
 * the FAA. Use it when the tiling parameters change (or to migrate an old bake);
 * the weekly Action calls build-data.mjs, which now produces this shape directly.
 *
 * Run: node scripts/retile.mjs
 */
import { readdir, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { simplifyGeometry, countPoints, tileFeatures, bboxOf } from './lib/geom.mjs';

const OUT = 'data';
const TILE = 1;                 // degrees — see build-data.mjs
const TOL = 0.00012;

const idx = JSON.parse(await readFile(`${OUT}/index.json`, 'utf8'));
const names = (await readdir(`${OUT}/tiles`)).filter(f => f.endsWith('.json'));

// Features are duplicated into every tile their bbox touches, so gather and dedupe.
const seen = new Map();
for (const n of names) {
  const fc = JSON.parse(await readFile(`${OUT}/tiles/${n}`, 'utf8'));
  for (const f of fc.features || []) {
    const p = f.properties;
    const k = [p.cls, p.name, p.low, p.high, p.agl, p.open, p.hours,
               bboxOf(f.geometry).join(','), countPoints(f.geometry)].join('|');
    if (!seen.has(k)) seen.set(k, f);
  }
}
const feats = [...seen.values()];

let before = 0, after = 0;
for (const f of feats) {
  before += countPoints(f.geometry);
  f.geometry = simplifyGeometry(f.geometry, TOL);
  after += countPoints(f.geometry);
}
console.log(`${feats.length} volumes · ${before.toLocaleString()} → ${after.toLocaleString()} vertices ` +
            `(${(100 - after / before * 100).toFixed(1)}% smaller)`);

const tiles = tileFeatures(feats, TILE);
await rm(`${OUT}/tiles`, { recursive: true, force: true });
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
  generated: idx.generated,
  source: idx.source,
  tileDegrees: TILE,
  features: feats.length,
  byClass,
  tiles: counts
}, null, 2));

console.log(`Wrote ${tiles.size} tiles, ${(bytes / 1e6).toFixed(1)} MB total`);
