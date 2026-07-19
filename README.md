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
- **Nesting inside parts** — parts are placed inside the holes, pockets and
  concavities of other parts when they fit (spacing respected). Works for open
  profiles too: a part may protrude through the opening of a C-channel while its body
  sits in the pocket.
- **Sheet margin** (for fixed-size material — auto mode shrink-wraps the sheet around
  the parts, so no margin applies), per-part **quantities**, live progress with cancel
  (nesting runs in a Web Worker), pan/zoom preview, utilization stats.

## Supported DXF input

`LINE`, `ARC`, `CIRCLE`, `LWPOLYLINE` (incl. bulges), `POLYLINE`/`VERTEX`, `ELLIPSE`,
`SPLINE` (NURBS, sampled), and `INSERT` (blocks, incl. rotation, non-uniform scale and
grid inserts). Entities with a flipped extrusion direction (OCS `210 = 0,0,-1`) are
handled. Text, dimensions and hatches are ignored with a warning.

The export is written as R12-style DXF (`LINE`, `ARC`, `CIRCLE`, `POLYLINE` with
bulges) for maximum compatibility; ellipses and splines are exported as fine polylines.
Layers are remade on export: every detected part gets its own layer, named after the
part, so importers like LightBurn can select and configure each part directly. With
*By layer* grouping the original layers are kept instead. All layers are declared in
a layer table with distinct colors.

## How the nesting works

Parts are rasterized onto a bitset grid (with holes and pockets kept open, plus a
conservative 1-pixel outline so thin features never vanish) and placed greedily from
the bottom up. For each part every allowed orientation's lowest fit is found, and the
winner is chosen by **touching perimeter**: the orientation whose placement touches
the most already-placed material or sheet edge wins. That snugs parts into pockets,
corners and interlocks instead of just stacking columns. Spacing is enforced by
morphologically dilating each placed part's footprint before stamping it into the
occupancy grid — so clearances hold for concave shapes and holes too, not just
bounding boxes.

Several placement orders are tried and the best result wins: plain biggest-first, plus
orders that promote "container" parts (more empty bbox space than material — C-channels,
frames, brackets) so their pockets exist before the parts that could fill them are
placed. Leading with only one or two containers is also tried, which keeps pockets
available for big parts instead of letting containers interlock with each other first.
A classic bottom-left pass runs as a safety net, and the best pass by parts placed,
sheet count and stock consumed is kept.

Accuracy is bounded by the **nesting resolution** (auto-chosen from sheet and part
sizes, overridable under *Advanced*): placements are accurate to about one grid cell.
Finer resolution nests tighter but takes longer. This is a heuristic packer — it aims
for a very good nest quickly, not a provably optimal one.

## Limitations

- 2D only; Z coordinates and 3D polylines are ignored/skipped.
- Common-line placement at spacing 0 is approximate to the nesting resolution — check
  the merged export before cutting.
- No kerf compensation (apply it in CAM).
