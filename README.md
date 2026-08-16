# Upside Down Wedding Cakes

All of US airspace, in 3D, over the FAA sectional. Tilt it, spin it, cut the lid off.

**→ [bfirsh.github.io/upside-down-wedding-cakes](https://bfirsh.github.io/upside-down-wedding-cakes/)**

Every EFB draws airspace as flat outlines on a 2D chart, and every product that
advertises "3D" — ForeFlight, Garmin Pilot, iFly, FlyQ — means 3D *terrain* or a 3D
*runway preview*, not airspace volumes. This draws the actual shapes: Class B, C, D,
surface Class E, and restricted/MOA/alert areas, extruded from their true floor to
their true ceiling in feet MSL.

## What's in it

- **Every US airspace volume**, not just one metro. Search any of ~14,000 airports by
  code or name and it loads the airspace around it.
- **Real basemaps** — the FAA's own VFR sectional and terminal area chart tile
  services, plus satellite and topo.
- **Cut away** — set an altitude and everything above it disappears, which is the
  only sane way to see a Class D buried under a Bravo shelf.
- **Hollow shells** — reduce each volume to a thin floor and ceiling so you can see
  straight through a stack.
- **Your altitude** — a reference plane at any MSL altitude, plus a highlight mode
  that lights up only the airspace you'd be inside at that altitude.
- **Vertical exaggeration**, because 10,000 ft across 100 miles is invisible at 1:1.
- Click anything for its floor, ceiling and hours of operation.

## Where the data comes from

Airspace polygons come from the [FAA Aeronautical Information Services open data
portal](https://adds-faa.opendata.arcgis.com/) — the `Class_Airspace` and
`Special_Use_Airspace` feature services, which are the authoritative source and are
republished on the 28-day chart cycle.

That service is rate-limited (6,000 request units/minute, shared across every
anonymous client), so the site doesn't query it at runtime. Instead
[a GitHub Action](.github/workflows/refresh-airspace.yml) runs weekly, downloads the
entire national dataset, normalises it, and commits it to `data/` as 5-degree tiles
that GitHub Pages serves as plain static JSON. The page loads only the tiles covering
your viewport. If `data/` is missing it falls back to querying the FAA live.

Sectional charts are hotlinked from the FAA's
[`VFR_Sectional`](https://tiles.arcgis.com/tiles/ssFJjBXIUyZDrSYZ/arcgis/rest/services/VFR_Sectional/MapServer)
tile cache — a CDN, not a quota'd query service, so there's nothing to mirror.

Airport positions and names are from [OurAirports](https://ourairports.com/data/)
(public domain).

### Three traps in the FAA data, documented here so nobody rediscovers them

1. `LOWER_VAL` / `UPPER_VAL` are **numbers** in `Class_Airspace` but **strings** in
   `Special_Use_Airspace`.
2. `-9998` is a sentinel meaning "no defined limit", not an altitude.
3. `LOWER_CODE = 'SFC'` means *referenced to the surface* (i.e. AGL), **not** *at the
   surface*. Class E5 comes back as `700 ft / SFC`, meaning 700 AGL. Test the value,
   not the code.

Also worth knowing: SFO's Class B was redesigned effective 16 August 2018 from the
classic wedding cake into a route-based design with **17 areas, A through Q**, all
capped at 10,000 MSL. Plenty of third-party airspace datasets still ship the old
11-area version.

## Running it

`index.html` is a single self-contained file — MapLibre GL and the airport index are
inlined, so you can open it straight from disk. It needs network access for map tiles
and, absent a baked `data/` directory, for the FAA feed.

To rebuild the airspace data locally:

```
node scripts/build-data.mjs
```

Takes a few minutes and writes `data/index.json` plus `data/tiles/*.json`.

## Not for navigation

Obviously. It's called Upside Down Wedding Cakes. Verify everything against current
charts and NOTAMs.
