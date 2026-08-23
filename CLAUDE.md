# Upside Down Wedding Cakes — context for Claude Code

Live: https://bfirsh.github.io/upside-down-wedding-cakes/
Repo: https://github.com/bfirsh/upside-down-wedding-cakes

A 3D viewer for US airspace, focused on the Bay Area and **KSQL San Carlos**. The
point is to *understand the shapes* of stacked airspace — especially the SFO Class B
over the peninsula — not to navigate.
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
| `scripts/build-data.mjs` | downloads, simplifies + tiles the national airspace dataset |
| `scripts/lib/geom.mjs` | RDP simplification + tiling, shared by the two scripts below |
| `scripts/retile.mjs` | re-simplifies/re-tiles whatever is in `data/` without re-downloading |
| `.github/workflows/refresh-airspace.yml` | runs that weekly, commits `data/` |

MapLibre is vendored, not CDN-loaded, so the file works offline and can't break when
a CDN does. That's why `index.html` is 1.7 MB.

## Data

Airspace comes from FAA Aeronautical Information Services:

- `https://services6.arcgis.com/ssFJjBXIUyZDrSYZ/arcgis/rest/services/Class_Airspace/FeatureServer/0`
- `.../Special_Use_Airspace/FeatureServer/0`
- Sectional/TAC raster tiles: `https://tiles.arcgis.com/tiles/ssFJjBXIUyZDrSYZ/arcgis/rest/services/VFR_Sectional/MapServer` (also `VFR_Terminal`, `IFR_High`, `IFR_AreaLow`)

**The page does not query that service at runtime any more.** The Action bakes the
whole country into `data/tiles/<lon>_<lat>.json` on a **1° grid** plus `data/index.json`,
and the page loads only the tiles covering the viewport, six at a time, nearest
first, with `?v=<generated>` for cache-busting. Current bake: **3,667 volumes** —
423 B, 411 C, 652 D, 854 surface E, 1,327 SUA — in 1,353 tiles, 10.7 MB. If `data/`
is missing the page falls back to live viewport queries (`loadView()`), which still
works but is rate-limited.

**Simplify the geometry or nothing else matters.** The FAA tessellates arcs into
polylines at absurd density — a plain 5 NM Class D circle arrives as ~5,000
vertices, San Jose's Class C as 4,535, Stockton's Class D as 5,405. Baked raw at 5°
that made the Bay Area tile **4.2 MB for 112 volumes**, and the default view pulled
**14 MB** of JSON before a single box could be drawn. `scripts/lib/geom.mjs` runs
Ramer–Douglas–Peucker at 0.00012° (~13 m, which is the precision the coordinates are
already rounded to): **6.35 M → 197 K vertices, 96.9% smaller**, no boundary moved
more than 13.3 m, and the polygonal Bravo shelves are barely touched (35 → 33
points). With 1° tiles the default view is now **0.18 MB**. Do not remove this step.

RDP runs iteratively, not recursively, because a 5,000-point ring overflows the
stack; and rings are split at their two most distant vertices before simplifying, so
the anchor is a real corner rather than an arbitrary start vertex leaving a flat spot.

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

**Layer order is depth order, and getting it wrong deletes airspace.** This was the
bug behind "I can see the map on the ground but not the Class D". `fill-extrusion`
is depth-tested *and* depth-writing, and MapLibre draws layers in stack order, so a
layer drawn **earlier** occludes anything drawn later that sits behind it — no
matter how transparent it is. `DRAW` used to be `['B','C','SUA','E','D']` with the
comment "later is drawn on top, so the small low stuff wins". That is true of 2D
fills and exactly backwards for extrusions: Class B went down first, and every
Class C and D underneath the Bravo failed the depth test and was thrown away. The
basemap still showed through because a raster writes no depth — which is precisely
what made it look like an opacity problem.

Verify it in ten lines if you ever doubt it: two overlapping extrusions, big
translucent lid and small box beneath. Lid first → the box is *gone*. Box first →
it reads perfectly through the lid.

So volumes are now drawn strictly back-to-front for a camera above the stack:
lowest floor first. Opacity has to stay a per-layer property — **alpha inside
`fill-extrusion-color` is ignored by MapLibre**, it renders fully opaque (tested) —
so "sorted" means one layer per (floor band × class), emitted in order. That is
`BANDS` × `STACK` in `app.js`, ~91 layers. Measured on the peninsula, the share of
a Class D's own contrast that survives under the Bravo went **14% → 52%** looking
down (and the residual 14% in the old build was only the ground footprint *line*,
not the volume). Near-plan with rims off it measures 58.8%, which is exactly the
0.58 transmittance of one 0.42-opacity Bravo lid — i.e. the physics is now right,
and the old per-class opacity weights do what they were always meant to do.

**Rim ribbons, built per segment.** Each volume gets a thin bright slab at its floor
and ceiling. This is the third attempt at edges and the first that works, so note
what the other two got wrong: full floor/ceiling **plates** were opaque sheets lying
on everything below (a Bravo's floor plate left 21% of the light for the Class D);
an inward-**offset ring** punched out as a hole self-intersected on concave and
holed shelves and tessellated into visible wedges. The fix is to stop building
anything global — each edge becomes its own quad, using the corner bisector at both
ends so neighbouring quads share an edge exactly. No overlap to z-fight, no gap, and
a bad corner is one bent quad rather than a corrupted polygon. Rims **straddle** the
boundary they mark; flush faces would be coplanar with the box's own floor/ceiling
and z-fight with them.

Keep rims thin — this is the same trap as the plates. Width is `sqrt(area) × 0.016`
capped at 0.0075°; at the first, wider setting the Bravo's rim was costing a third
of the light reaching the Class D underneath, measurably.

**Rim every volume the same way, always.** I once dropped ceiling rims above
6,500 ft, reasoning that you never fly over a Bravo's 10,000 lid and that its 11
shelves all share that ceiling, so those rims only traced the internal partitions of
one continuous flat lid. The logic is sound and the result was worse. The verdict
from testing over the real chart was *"it looks really weird when just some things have lines and some don't — more
messy and hard to parse."* A rule the eye can't learn costs more than the density it
removes. **Consistency of treatment beats per-case cleverness** — the same lesson as
the fixed `EXAG`. If it's too busy, dim everything together via `RIM_BASE`/`RIM_GAIN`,
which is exactly what those two numbers are for.

They are currently 0.10/0.26, i.e. rim opacity 0.23 at the 50% default — **picked
from three variants viewed over the real sectional.** Against the sandbox's flat grey
stand-in that setting looks like it loses the staircase; over an actual chart it does
not, because the rims are saturated colour against a busy coloured ground rather than
against neutral grey. This is the trap at the top of this file in miniature: the
sandbox can rank *relative* changes honestly and cannot judge absolute appearance.
Don't "restore" these to something that screenshots better here.

**Fade with height, but fade bodies and rims at different rates.** `fadeBody` falls
to 0.40 by 8,000 and `fadeRim` only to 0.78. The body is fog and can fall away hard
so you can see through the stack; the rim is the *signal* — it is what draws the
staircase under the Bravo — so it only dims enough to sit back. I first faded them
together at one rate: it looked tidy and threw the shape away along with the clutter.
The test to keep is: *"I like how the lines create the shape."*
This is free because there is already one layer per floor band — the band is the
fade step. Ground footprints follow the body's rate.

Note a fade is *gradual*, which is why it doesn't trip the consistency problem above:
every volume still has every line, some are just quieter.

**Fixed 6× vertical exaggeration (`EXAG` in app.js).** I once made this adapt to view
width so every frame was individually optimal. It was wrong and was caught
immediately: zooming changed the *shape of the object he was trying to learn*.
Constancy of the object beats per-frame prettiness. Don't reintroduce this.

**Never full-area plates.** Kept here because it is the mistake most likely to be
made again: bright thin plates at the floor and ceiling look great and are
catastrophic, because a Class B's floor plate is a full-area opaque-ish sheet lying
directly on top of every Class D beneath it. Measured budget: ceiling plate 0.42 ×
body 0.084 × floor plate 0.60 left **21%** of light reaching the Class D, which then
contributed **3.6% of the pixel**. Invisible at any body opacity. The rim ribbons
above are the replacement — anything you add at a volume's floor or ceiling has to
be *perimeter*-sized, not *area*-sized.

**Per-class opacity weights** (`CLASSES[].w`, multiplied by the `Fill` slider). Class B
is the big lid you look *through*, so it's thinnest by a long way (0.21); Class D is
small, low, and the thing you're trying to see, so it's densest (0.65).

**Class B's weight is set by accumulation, not by one shelf.** The 17 Bravo areas tile
the plan, so looking straight down you cross exactly one — but at a shallow angle you
look sideways through several in a row, and alpha multiplies. At the old 0.42 weight
and 80% fill that was 0.336 per shelf, i.e. four shelves in the line of sight left
**19%** of the light and the Bravo simply blanked out whatever was behind it. At 0.21
it is 0.168 per shelf and four shelves still pass **48%**. If Class B ever "blocks out
what's behind it" again, that multiplication is why, and `CLASSES.B.w` is the lever —
not the Fill slider, which moves every class together.

**Fill defaults to 80%, and that number came from looking at the real sectional** —
which is the one judgement this sandbox cannot make. Do not "restore" it. The weights
were rebalanced at the same time so 80% reads denser than the old 50% default for
every class *except* B, which got thinner in absolute terms. Measured, a Class D under
the Bravo keeps **77% of its own contrast at pitch 55, 73% near-plan, and 92% at
pitch 78** — that last one being the shallow view where the accumulation used to bite.

**Tuning warning.** I tuned opacity twice against a flat pale grey stand-in ground in a
sandbox (I can't reach FAA tile servers from there) and shipped two versions that were
invisible over a real sectional. **Do not trust a synthetic basemap for opacity work.**
Check the live site instead. Related: the Claude-in-Chrome extension does
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

**Cull markers past the horizon.** `map.project()` happily returns a screen position
for a point beyond the horizon — it just lands in the sky, which is where the stray
labels floating above the terrain came from (26 airport tags at pitch 66, 42 at
pitch 80). There is no public "is this over the horizon" call, but the transform has
to know in order to draw the sky, so `onGround()` asks
`map.transform.isPointOnMapSurface`, shifting the test point up a few pixels so the
infinitely-distant pile-up along the horizon line goes too. Cull *before* the 140-marker
cap, otherwise at high pitch most of the budget is spent on sky. Guard the call — it
is semi-internal, so fall back to culling nothing if it ever disappears.

**Navigation.** No modal drag toggle — I built one and it was the wrong pattern. Left
drag pans, right drag orbits, double-click flies in, shift/alt+scroll spin and tilt,
and there's a compass gizmo bottom-right (absolute dial: grab it anywhere and bearing
follows your finger) with a tilt bar beside it.

**Panel is deliberately minimal.** Fewer options has been asked for twice. Removed: shape
modes, exaggeration, hollow shells, even-opacity, altitude plane, highlight-at-altitude,
label toggle, airport toggle, camera presets. What survives: class checkboxes, Fill,
cut-away, search, basemap.

**One control per job.** The cut-away used to be a slider labelled "Hide everything
above" *plus* a separate "Slice the sky here" checkbox that armed it — so dragging the
slider on its own changed a line of text and nothing else, which reads exactly like a
broken control. This was hit in use. The slider is now the whole cut-away and its maximum
(`CLIP_OFF`, 12,000) is the off position; the readout underneath doubles as the hint
that the control exists. Note the max is off *in effect* (`buildFC` clips at `Infinity`),
which matters because a few SUA floor as high as 45,000. The dead `state` flags for the removed features are still in
`app.js` — harmless, but tidy them if you touch that area.

## Bay Area facts worth knowing

- **SFO Class B was redesigned effective 16 Aug 2018** into a route-based design with
  **17 areas, A–Q**, all capped at 10,000 MSL. Lots of third-party datasets still ship
  the old 11-area wedding cake.
- **The current bake has all 17, and the shape is entirely in the floor.** Floors in
  the data are SFC / 1,500 / 1,600 / 2,100 / 2,300 / 3,000 (×2) / 4,000 / 5,000 (×2) /
  6,000 (×2) / 7,000 (×2) / 8,000 (×2), every one of them topping out at 10,000. So
  from above it is a flat lid and there is nothing to see; **you have to get under it**,
  which is what the whole draw-order and rim work above is for. It is a genuinely
  upside-down wedding cake in a way the pre-2018 design was not. The shelves are also
  cheap geometry (4–35 points each) — it is the Class C/D circles that were huge.
- OAK Class C ceiling is **4,000**, not 2,100 (a popular old dataset gets this wrong).
- **SQL and PAO revert to Class G when the tower closes**, while HWD/NUQ/SJC get
  part-time Class E surface areas. Real difference in night VFR minimums.
- R-2531 (Tracy, SFC–4,000) and A-682 (Travis) are the only nearby SUA.

## Open items

1. **Is 6× the right constant?** One number at the top of `app.js`.
2. The cut-away slider ("hide everything above") — it's been questioned whether it
   earns its place now that see-through works. Still an open call, though it is at least honest now
   that it is a single control.
3. Class E surface areas are fetched and tiled but off by default.
4. Absolute appearance over a real sectional is still only checkable on the
   live site — the ratios above are measured against a stand-in ground, which answers
   "does the Class D survive" and nothing about how it looks over a real chart. The
   50% Fill default came from the real thing; treat it as settled.
5. 1° tiles mean a wide, high-pitch view asks for ~40 files. They are ~20 KB each and
   fetch six at a time over HTTP/2, so it is fine, but if it ever isn't, the fix is a
   coarser grid for low zooms rather than a bigger `MAX_BOX`.
6. The altitude plane (`plane` source, `alt-plane` layer, `updatePlane`, `state.planeOn`)
   is dead — nothing sets `planeOn` since the control was removed. Left in place rather
   than widen this change; delete it whenever you are next in `addLayers`.

Done since the last handover: the 17-area Bravo is verified (see above), the `10×`
references were already gone, and `data/` now cache-busts on `index.json`'s
`generated` timestamp.

## Testing

There's no test suite. What I did: serve the built file locally, drive it with
Playwright + Chromium (`--use-gl=swiftshader`), jump the camera to fixed viewpoints via
`window.map` (exposed deliberately), screenshot, and *look*. Assert on
`state.feats.size` and layer visibility rather than pixels —
`canvas.toDataURL()`/`drawImage` return blank because MapLibre runs without
`preserveDrawingBuffer`. I wasted a debugging cycle on that. `page.screenshot()` *does*
capture the WebGL canvas, so screenshots are the way to read pixels.

`window.map`, `window.state` and the top-level functions (`refresh`, `buildFC`, …) are
all reachable from the harness — top-level `function` declarations are already on
`window` in a classic script. **Do not add `window.refresh = () => refresh()`**: it
overwrites the global it means to wrap and recurses until the stack blows. I did that,
and because `loadTiles()` calls `refresh()` inside a `try`, `loadView()` swallowed it
and quietly fell through to the live FAA path — the visible symptom was a spurious
"FAA airspace service unavailable".

**Occlusion is measurable without a real basemap.** Render the same frame four ways
(D+B / B only / D only / neither), mask to pixels where a Class D and a Bravo are both
present, and compare `|both − Bonly|` against `|Donly − neither|`. That ratio is "how
much of the Class D's own contrast survives the Bravo", and being a ratio it does not
care what the ground looks like — which is the one opacity-adjacent question a sandbox
*can* answer honestly. Absolute appearance still needs the real sectional.
