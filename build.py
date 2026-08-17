#!/usr/bin/env python3
"""Inlines everything into a single self-contained index.html.

src/shell.html   markup + CSS, with /*__MLCSS__*/ /*__MLJS__*/ /*__APTS__*/ /*__APP__*/ slots
src/app.js       all application logic
src/ap.json      airport index (917 towered/large + 13,160 small, from OurAirports)

MapLibre is vendored from npm rather than a CDN so the page works offline and
can't break when a CDN does:  npm pack maplibre-gl@5 && tar xzf maplibre-gl-*.tgz
"""
import os, sys

ML = 'package/dist'
if not os.path.exists(f'{ML}/maplibre-gl.js'):
    sys.exit("Missing MapLibre. Run: npm pack maplibre-gl@5 && tar xzf maplibre-gl-*.tgz")

out = open('src/shell.html').read()
out = out.replace('/*__MLCSS__*/', open(f'{ML}/maplibre-gl.css').read())
out = out.replace('/*__MLJS__*/',  open(f'{ML}/maplibre-gl.js').read())
out = out.replace('/*__APTS__*/',  open('src/ap.json').read())
out = out.replace('/*__APP__*/',   open('src/app.js').read())
open('index.html', 'w').write(out)
print(f'index.html  {os.path.getsize("index.html")/1e6:.2f} MB')
