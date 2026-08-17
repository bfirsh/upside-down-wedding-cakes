# Upside Down Wedding Cakes — context for Claude Code

Live: https://bfirsh.github.io/upside-down-wedding-cakes/
Repo: https://github.com/bfirsh/upside-down-wedding-cakes

A 3D viewer for US airspace, built for Ben (student pilot, flies out of **KSQL San
Carlos**, San Carlos Flight Center syllabus). The point is to *understand the shapes*
of stacked airspace — especially the SFO Class B over the peninsula — not to navigate.
Everything below is hard-won; several of these decisions were made, reversed, and
re-made, so please read before changing them.

## Build

`index.html` is **generated** — do not hand-edit it. Sources are in `src/`.

```
npm pack maplibre-gl@5 && tar xzf maplibre-gl-*.tgz   # once, vendors MapLibre
python3 build.py                                       # → index.html (~1.7 MB)
```

| file | what |
|---|---|
| `src/shell.html` | markup + all CSS, with `/*__MLCSS__*/ /*__MLJS__*/ /*__APTS__*/ /*__APP__*/` slots |
| `src/app.js` | all logic |
| `src/ap.json` | 917 large/medium + 13,160 small US airports, from [OurAirports](https://ourairports.com/data/) (public domain) |
| `scripts/build-data.mjs` | downloads + tiles the national airspace dataset |
| `.github/workflows/refresh-airspace.yml` | runs that weekly, commits `data/` |

MapLibre is vendored, not CDN-loaded, so the file works offline and can't break when
a CDN does. That's why `index.html` is 1.7 MB.

## Data

Airspace comes from FAA Aeronautical Information Services:

- `https://services6.arcgis.com/ssFJjBXIUyZDrSYZ/arcgis/rest/services/Class_Airspace/FeatureServer/0`
- `.../Special_Use_Airspace/FeatureServer/0`
- Sectional/TAC raster tiles: `https://tiles.arcgis.com/tiles/ssFJjBXIUyZDrSYZ/arcgis/rest/services/VFR_Sectional/MapServer` (also `VFR_Terminal`, `IFR_High`, `IFR_AreaLow`)

**The page does not query that service at runtime any more.** The Action bakes the
whole country into `data/tiles/<lon>_<lat>.json` on a 5° grid plus `data/index.json`,
and the page loads only the tiles covering the viewport. Current bake: **3,671
volumes** — 423 B, 411 C, 652 D, 855 surface E, 1,330 SUA — in 114 tiles. If `data/`
is missing the page falls back to live viewport queries (`loadView()`), which still
works but is rate-limited.

### Five traps in the FAA data — all of these bit me

1. `LOWER_VAL`/`UPPER_VAL` are **numbers** in `Class_Airspace` but **strings** in
   `Special_Use_Airspace`.
2. `-9998` is a sentinel for "no defined limit", not an altitude.
3. `LOWER_CODE = 'SFC'` means *referenced to the surface* (i.e. AGL), **not** *at the
   surface*. Class E5 returns `700 ft / SFC` meaning 700 AGL. Test the value, not the code.
4. The two layers have **different field sets** — `Class_Airspace` has
   `CLASS`/`LOCAL_TYPE`/`WKHR_CODE`, `Special_Use_Airspace` has `TYPE_CODE`/`TIMESOFUSE`.
   Naming a field a layer lacks is a hard **400**, not an empty result. Hence
   `outFields: '*'`. I broke this once "optimising" and it looked like an outage.
5. The service returns **quota errors as HTTP 200** with an `{error:{code:429}}` body
   ("6000 request units per minute", shared across all anonymous clients). `qs()`
   detects that and backs off 1.5s → 5s → 13s.

Class E5 (the 700/1200 AGL blanket) is filtered out everywhere — it covers everything
and is pure visual noise. Offshore Warning areas (`TYPE_CODE` starting `W`) too.

## Rendering — the decisions that matter

**Fixed 6× vertical exaggeration (`EXAG` in app.js).** I once made this adapt to view
width so every frame was individually optimal. It was wrong and Ben caught it
immediately: zooming changed the *shape of the object he was trying to learn*.
Constancy of the object beats per-frame prettiness. Don't reintroduce this.

**Solid glass boxes, no floor/ceiling plates.** Each volume is one `fill-extrusion`
from floor to ceiling, plus a ground-level `line` footprint. I previously drew bright
thin plates at the floor and ceiling for crispness — they looked great and were
catastrophic, because a Class B's floor plate is a full-area opaque-ish sheet lying
directly on top of every Class D beneath it. Measured budget: ceiling plate 0.42 ×
body 0.084 × floor plate 0.60 left **21%** of light reaching the Class D, which then
contributed **3.6% of the pixel**. Invisible at any body opacity. I tried rebuilding
the plates as edge *bands* (polygon with an inward-offset ring punched out — the
`offsetRing`/`bandFor` code is still in `app.js`, unused) and it measured fine but
self-intersected on concave and holed shelves, producing visible wedges. Both plates
are gone. If you want crisper edges, that band code is the starting point, but it
needs a real polygon-offset library.

**Per-class opacity weights** (`CLASSES[].w`, multiplied by the `Fill` slider). Class B
is the big lid you look *through*, so it's thinnest (0.42); Class D is small, low, and
the thing you're trying to see, so it's densest (0.88). Class D still reads at ~51% of
the pixel through a Bravo.

**Tuning warning.** I tuned opacity twice against a flat pale grey stand-in ground in a
sandbox (I can't reach FAA tile servers from there) and shipped two versions that were
invisible over a real sectional. **Do not trust a synthetic basemap for opacity work.**
Ask Ben, or screenshot the real site. Related: the Claude-in-Chrome extension does
*not* composite the WebGL canvas into screenshots — the map comes back black — so you
cannot verify rendering that way either.

**Colour.** Class → hue, floor altitude → lightness within that hue (`rampFor`), which
is what makes a stack of nine Bravo shelves read as tiers instead of one lump.
Palette validated with the `dataviz` skill's checker on the dark surface with
`--pairs all` (correct test: every class is on screen simultaneously):

- blue `#3987e5` / magenta `#d55181` / yellow `#c98500` → **passes** everything
- blue / magenta / **aqua** — closest to chart convention — **fails**, deuteran ΔE 1.6

So Class D is yellow rather than the chart's dashed blue, which would have been
indistinguishable from Class B in 3D anyway. Keep B blue and C magenta; those match
sectionals. SUA is treated as a status colour, always labelled.

**Labels** are DOM markers (no glyph server needed), with greedy screen-space collision
culling — lowest floors and largest areas win a slot, re-solved every camera frame,
capped at 40. Format is ceiling/floor in hundreds: `100/15` = 10,000 down to 1,500.

**Navigation.** No modal drag toggle — I built one and it was the wrong pattern. Left
drag pans, right drag orbits, double-click flies in, shift/alt+scroll spin and tilt,
and there's a compass gizmo bottom-right (absolute dial: grab it anywhere and bearing
follows your finger) with a tilt bar beside it.

**Panel is deliberately minimal.** Ben asked twice for fewer options. Removed: shape
modes, exaggeration, hollow shells, even-opacity, altitude plane, highlight-at-altitude,
label toggle, airport toggle, camera presets. What survives: class checkboxes, Fill,
cut-away, search, basemap. The dead `state` flags for the removed features are still in
`app.js` — harmless, but tidy them if you touch that area.

## Bay Area facts worth knowing

- **SFO Class B was redesigned effective 16 Aug 2018** into a route-based design with
  **17 areas, A–Q**, all capped at 10,000 MSL. Lots of third-party datasets still ship
  the old 11-area wedding cake. I developed against a 2013 snapshot, so **nobody has
  yet looked at how the real 17-area Bravo renders** — that's the first thing to check.
- OAK Class C ceiling is **4,000**, not 2,100 (a popular old dataset gets this wrong).
- **SQL and PAO revert to Class G when the tower closes**, while HWD/NUQ/SJC get
  part-time Class E surface areas. Real difference in night VFR minimums.
- R-2531 (Tracy, SFC–4,000) and A-682 (Travis) are the only nearby SUA.
- There's a fuller reference in Ben's "Flying" Claude project: `claude/bay-area-airspace-reference.md`.

## Open items

1. **Verify the real 17-area Bravo reads well.** Never seen it rendered.
2. **Is 6× the right constant?** One number at the top of `app.js`.
3. Footer text and `README` may still say 10× in places — grep for it.
4. The cut-away slider ("hide everything above") — Ben questioned whether it earns its
   place now that see-through works. His call.
5. `data/` has no cache-busting; browsers may hold stale tiles for a while after a
   weekly refresh.
6. Class E surface areas are fetched and tiled but off by default.

## Testing

There's no test suite. What I did: serve the built file locally, drive it with
Playwright + Chromium (`--use-gl=swiftshader`), jump the camera to fixed viewpoints via
`window.map` (exposed deliberately), screenshot, and *look*. Assert on
`state.feats.size` and layer visibility rather than pixels —
`canvas.toDataURL()`/`drawImage` return blank because MapLibre runs without
`preserveDrawingBuffer`. I wasted a debugging cycle on that.
