# mailwarden icon

A shield with an envelope inside: the mailbox, and the warden around it. One colour on a slate
ground, drawn on a 1000-unit grid so every size below is the same shape.

- `icon.svg` — the source. Edit this one; the PNGs are renders of the same geometry.
- `render.py` — draws the same geometry with Pillow and rewrites every PNG here plus
  `.claude-plugin/icon.png` (`python assets/icon/render.py` from the repo root).
- `icon-512.png`, `icon-1024.png`, `icon-2048.png` — square renders with the rounded slate ground.
  `.claude-plugin/icon.png` is the 1024 render, where the Claude plugin directory looks for it
  (square PNG, 512 to 2048 px, under 2 MB; SVG is not accepted there).
- `glyph-slate.png`, `glyph-white.png` — the strokes alone on a transparent ground, for light and
  dark surfaces.
- `favicon.ico` (16/32/48/64), `favicon-32.png`, `apple-touch-icon.png` (180) — for a web page.

None of this ships in the npm package (`files` in `package.json` lists `dist`, `README.md`,
`SECURITY.md`, `LICENSE`); it lives in the repository for the plugin directory and the website.
