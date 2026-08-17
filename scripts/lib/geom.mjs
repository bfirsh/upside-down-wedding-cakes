/* Geometry helpers shared by build-data.mjs and retile.mjs.
 *
 * The FAA serves arcs as densely tessellated polylines: a plain 5 NM Class D
 * circle arrives as ~5,000 vertices, and San Jose's Class C as 4,535. Baked
 * straight to disk that made data/tiles/-125_35.json 4.2 MB for 112 volumes,
 * which is why the Bay Area took seconds to appear. Simplifying to the
 * precision the coordinates are already stored at (4 dp ≈ 11 m) throws away
 * nothing you can see and takes that file to a fraction of the size.
 */

/* Ramer–Douglas–Peucker, iterative so a 5,000-point ring can't blow the stack.
   Tolerance is in degrees; longitude is scaled by cos(lat) so the tolerance is
   an honest distance rather than being ~4x looser east-west at Bay Area
   latitudes than north-south. */
function rdp(pts, tol, kx) {
  const n = pts.length;
  if (n < 3) return pts.slice();
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack = [[0, n - 1]];
  const tol2 = tol * tol;

  while (stack.length) {
    const [i0, i1] = stack.pop();
    if (i1 <= i0 + 1) continue;
    const ax = pts[i0][0] * kx, ay = pts[i0][1];
    const bx = pts[i1][0] * kx, by = pts[i1][1];
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;

    let far = -1, best = tol2;
    for (let i = i0 + 1; i < i1; i++) {
      const px = pts[i][0] * kx, py = pts[i][1];
      let d2;
      if (len2 === 0) {
        d2 = (px - ax) ** 2 + (py - ay) ** 2;
      } else {
        let t = ((px - ax) * dx + (py - ay) * dy) / len2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        d2 = (px - ax - t * dx) ** 2 + (py - ay - t * dy) ** 2;
      }
      if (d2 > best) { best = d2; far = i; }
    }
    if (far > 0) {
      keep[far] = 1;
      stack.push([i0, far], [far, i1]);
    }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(pts[i]);
  return out;
}

/* A closed ring has no natural endpoints for RDP to anchor on, and anchoring on
   the arbitrary start vertex leaves a visible flat spot there. Split the ring at
   its two most distant vertices and simplify each half, so the anchors are real
   corners of the shape. */
function simplifyRing(ring, tol, kx) {
  if (ring.length < 5) return ring;
  const closed = ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1];
  const pts = closed ? ring.slice(0, -1) : ring.slice();
  const n = pts.length;
  if (n < 5) return ring;

  let far = 0, best = -1;
  for (let i = 1; i < n; i++) {
    const d = ((pts[i][0] - pts[0][0]) * kx) ** 2 + (pts[i][1] - pts[0][1]) ** 2;
    if (d > best) { best = d; far = i; }
  }
  const a = rdp(pts.slice(0, far + 1), tol, kx);
  const b = rdp(pts.concat([pts[0]]).slice(far), tol, kx);
  const out = a.concat(b.slice(1));

  // A ring needs 3 distinct vertices to have any area at all.
  if (out.length < 4) return ring;
  return out;
}

const ringArea = r => {
  let s = 0;
  for (let i = 0, n = r.length - 1; i < n; i++) s += r[i][0] * r[i + 1][1] - r[i + 1][0] * r[i][1];
  return Math.abs(s) / 2;
};

export function simplifyGeometry(geom, tol = 0.00012) {
  const lat = centroidLat(geom);
  const kx = Math.max(0.2, Math.cos(lat * Math.PI / 180));
  const doRings = rings => {
    const out = [];
    for (let i = 0; i < rings.length; i++) {
      const s = simplifyRing(rings[i], tol, kx);
      // Drop interior holes that simplification has collapsed to a sliver, but
      // never drop the outer ring — that would delete the volume.
      if (i > 0 && ringArea(s) < tol * tol * 12) continue;
      out.push(s);
    }
    return out;
  };
  if (geom.type === 'Polygon') return { type: 'Polygon', coordinates: doRings(geom.coordinates) };
  if (geom.type === 'MultiPolygon')
    return { type: 'MultiPolygon', coordinates: geom.coordinates.map(doRings) };
  return geom;
}

function centroidLat(geom) {
  let s = 0, n = 0;
  const walk = c => { if (typeof c[0] === 'number') { s += c[1]; n++; } else c.forEach(walk); };
  walk(geom.coordinates);
  return n ? s / n : 38;
}

export function countPoints(geom) {
  let n = 0;
  const walk = c => { if (typeof c[0] === 'number') n++; else c.forEach(walk); };
  walk(geom.coordinates);
  return n;
}

export function bboxOf(geom) {
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

/* A feature lands in every tile its bbox touches, so a viewport query never
   misses a shelf that straddles a tile edge. */
export function tileFeatures(feats, TILE) {
  const tiles = new Map();
  for (const f of feats) {
    const [x0, y0, x1, y1] = bboxOf(f.geometry);
    for (let lon = Math.floor(x0 / TILE) * TILE; lon <= x1; lon += TILE) {
      for (let lat = Math.floor(y0 / TILE) * TILE; lat <= y1; lat += TILE) {
        const k = `${lon}_${lat}`;
        if (!tiles.has(k)) tiles.set(k, []);
        tiles.get(k).push(f);
      }
    }
  }
  return tiles;
}
