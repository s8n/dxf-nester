# DXF Nester

A browser-based DXF nesting tool: drop in DXF files and it packs the parts onto the
smallest possible sheet (or onto your fixed-size workpieces), then exports a nested DXF.
Everything runs locally in the browser — files never leave your machine.

Built with TypeScript + Vite, no runtime dependencies.

## Usage

```bash
npm install
npm run dev       # start dev server
npm run build     # typecheck + production build into dist/
npm test          # run the unit tests
```

Open the app, drop one or more `.dxf` files (or click *load demo parts*), tweak the
settings, hit **Nest parts**, and download the nested DXF. All distances are in the
drawing units of your DXF.

## Features

- **Spacing between parts** — minimum clearance between adjacent parts. Set it to `0`
  to let parts touch for common-line cutting; the optional **merge coincident cut
  lines** switch then deduplicates shared edges in the exported DXF (export is exploded
  to lines/arcs when enabled).
- **Part grouping switches**:
  - *Auto* — entities are chained into closed loops (endpoints joined within the join
    tolerance); a loop contained in another becomes a hole of that part, loops inside
    holes become independent parts again.
  - *By layer* — everything on a layer moves as one rigid part.
  - *Each closed loop separately* — contained loops are **not** treated as holes and
    nest independently.
  - *Each entity separately* — no chaining at all.
- **Sheet / workpiece modes**:
  - *Auto* — picks a strip width aiming for the smallest, roughly square bounding area.
  - *Fixed width* — strip nesting on material of known width, unlimited length.
  - *Fixed size* — match your actual workpiece; parts that don't fit overflow onto
    additional sheets (first-fit, earlier sheets are topped up before a new one is
    opened). Sheets are laid side by side in the preview and the exported DXF.
- **Rotations** (none / 90° / 45° / 30° / 15° steps) and optional **mirrored**
  placement.
- **Hole nesting** — small parts are placed inside the holes of bigger parts when they
  fit (spacing respected).
- **Sheet margin**, per-part **quantities**, live progress with cancel (nesting runs in
  a Web Worker), pan/zoom preview, utilization stats.

## Supported DXF input

`LINE`, `ARC`, `CIRCLE`, `LWPOLYLINE` (incl. bulges), `POLYLINE`/`VERTEX`, `ELLIPSE`,
`SPLINE` (NURBS, sampled), and `INSERT` (blocks, incl. rotation, non-uniform scale and
grid inserts). Entities with a flipped extrusion direction (OCS `210 = 0,0,-1`) are
handled. Text, dimensions and hatches are ignored with a warning.

The export is written as R12-style DXF (`LINE`, `ARC`, `CIRCLE`, `POLYLINE` with
bulges) for maximum compatibility; ellipses and splines are exported as fine polylines.
Original layers are preserved.

## How the nesting works

Parts are rasterized onto a bitset grid (with holes kept open, plus a conservative
1-pixel outline so thin features never vanish), sorted by area, and placed greedily
bottom-left, trying every allowed orientation and keeping the lowest position. Spacing
is enforced by morphologically dilating each placed part's footprint before stamping it
into the occupancy grid — so clearances hold for concave shapes and holes too, not just
bounding boxes.

Accuracy is bounded by the **nesting resolution** (auto-chosen from sheet and part
sizes, overridable under *Advanced*): placements are accurate to about one grid cell.
Finer resolution nests tighter but takes longer. This is a heuristic packer — it aims
for a very good nest quickly, not a provably optimal one.

## Limitations

- 2D only; Z coordinates and 3D polylines are ignored/skipped.
- Common-line placement at spacing 0 is approximate to the nesting resolution — check
  the merged export before cutting.
- No kerf compensation (apply it in CAM).
