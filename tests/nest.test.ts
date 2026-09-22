import { describe, expect, it } from 'vitest'
import {
  betterPass,
  createNestContext,
  finalizeNest,
  nest,
  planBalanced,
  planStage1,
  runPassSpec,
} from '../src/nest/nester'
import type { NestPart, Placement } from '../src/nest/nester'
import { BitGrid, bandMask, collide, overlapCount } from '../src/nest/raster'
import type { Pt } from '../src/geom'

function rectPart(id: number, w: number, h: number, count = 1): NestPart {
  const rings: Pt[][] = [
    [
      { x: 0, y: 0 },
      { x: w, y: 0 },
      { x: w, y: h },
      { x: 0, y: h },
    ],
  ]
  return { id, rings, opens: [], width: w, height: h, area: w * h, count }
}

/** Axis-aligned bbox of a placed rectangle part. */
function placedBBox(part: NestPart, pl: Placement): { minX: number; minY: number; maxX: number; maxY: number } {
  const cos = Math.cos(pl.theta)
  const sin = Math.sin(pl.theta)
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const ring of part.rings) {
    for (const p of ring) {
      const x0 = pl.mirror ? -p.x : p.x
      const x = x0 * cos - p.y * sin + pl.tx
      const y = x0 * sin + p.y * cos + pl.ty
      minX = Math.min(minX, x)
      minY = Math.min(minY, y)
      maxX = Math.max(maxX, x)
      maxY = Math.max(maxY, y)
    }
  }
  return { minX, minY, maxX, maxY }
}

const baseOpts = {
  gap: 2,
  margin: 0,
  resolution: 0.5,
  sheetWidth: null,
  sheetHeight: null,
  rotationStep: 90,
  mirror: false,
}

describe('bandMask', () => {
  it('only rejects band positions where every row collides', () => {
    let seed = 7
    const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32)
    for (let trial = 0; trial < 40; trial++) {
      const mask = new BitGrid(5 + Math.floor(rnd() * 40), 3 + Math.floor(rnd() * 20))
      for (let y = 0; y < mask.h; y++) for (let x = 0; x < mask.w; x++) if (rnd() < 0.8) mask.set(x, y)
      const occ = new BitGrid(90, 60)
      for (let i = 0; i < 12; i++) occ.set(Math.floor(rnd() * 90), Math.floor(rnd() * 60))
      const st = 1 + Math.floor(rnd() * 8)
      const band = bandMask(mask, st)
      for (let oy = 0; oy + mask.h + st - 1 <= occ.h; oy++) {
        for (let ox = 0; ox + mask.w <= occ.w; ox++) {
          const d = collide(occ, band, ox, oy)
          if (d === 0) continue
          for (let k = 0; k < st; k++) {
            for (let j = 0; j < d; j++) {
              if (ox + j + mask.w <= occ.w) expect(collide(occ, mask, ox + j, oy + k)).toBeGreaterThan(0)
            }
          }
        }
      }
    }
  })
})

describe('overlapCount', () => {
  it('counts coinciding bits across word boundaries', () => {
    const occ = new BitGrid(96, 8)
    for (let x = 28; x < 40; x++) for (let y = 2; y < 6; y++) occ.set(x, y)
    const mask = new BitGrid(10, 4) // fully set 10x4 block
    for (let x = 0; x < 10; x++) for (let y = 0; y < 4; y++) mask.set(x, y)
    // Fully inside the occupied block.
    expect(overlapCount(occ, mask, 29, 2)).toBe(40)
    // Straddling the left edge of the block (and the 32-bit word boundary).
    expect(overlapCount(occ, mask, 22, 2)).toBe(4 * 4)
    // Rows partially outside the occupied band.
    expect(overlapCount(occ, mask, 30, 4)).toBe(10 * 2)
    // No overlap at all.
    expect(overlapCount(occ, mask, 50, 2)).toBe(0)
  })
})

describe('collide', () => {
  function bruteCollides(occ: BitGrid, mask: BitGrid, ox: number, oy: number): boolean {
    for (let y = 0; y < mask.h; y++) {
      for (let x = 0; x < mask.w; x++) {
        if (mask.get(x, y) && occ.get(ox + x, oy + y)) return true
      }
    }
    return false
  }

  it('returns sound skip distances, never jumping past a free position', () => {
    const occ = new BitGrid(160, 12)
    occ.fillSpan(3, 40, 55)
    occ.fillSpan(4, 90, 92)
    occ.fillSpan(5, 10, 12)
    occ.fillSpan(6, 120, 141)
    occ.set(7, 63)
    // Mask with holes: solid bottom row, then two prongs with a wide gap.
    const mask = new BitGrid(34, 5)
    mask.fillSpan(0, 0, 33)
    for (let y = 1; y < 5; y++) {
      mask.fillSpan(y, 0, 5)
      mask.fillSpan(y, 28, 33)
    }
    for (let oy = 0; oy <= 7; oy++) {
      for (let ox = 0; ox + mask.w <= occ.w; ) {
        const d = collide(occ, mask, ox, oy)
        expect(d === 0).toBe(!bruteCollides(occ, mask, ox, oy))
        if (d === 0) {
          ox++
        } else {
          // Every skipped position must also collide.
          for (let k = 1; k < d && ox + k + mask.w <= occ.w; k++) {
            expect(bruteCollides(occ, mask, ox + k, oy)).toBe(true)
          }
          ox += d
        }
      }
    }
  })
})

describe('nest', () => {
  it('places all instances without overlap and respects spacing', () => {
    const parts = [rectPart(1, 20, 10, 4), rectPart(2, 15, 15, 2)]
    const res = nest(parts, { ...baseOpts, sheetWidth: 50 })
    expect(res.failures).toHaveLength(0)
    expect(res.placements).toHaveLength(6)
    const byId = new Map(parts.map((p) => [p.id, p]))
    const boxes = res.placements.map((pl) => placedBBox(byId.get(pl.partId)!, pl))
    // Every part inside the sheet.
    for (const b of boxes) {
      expect(b.minX).toBeGreaterThanOrEqual(-0.6)
      expect(b.maxX).toBeLessThanOrEqual(50.6)
      expect(b.minY).toBeGreaterThanOrEqual(-0.6)
    }
    // Pairwise: rectangles must be separated by at least gap minus raster slack.
    const slack = 2 * 0.5 + 1e-6 // 2 pixels of resolution
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i]
        const b = boxes[j]
        const sepX = Math.max(a.minX - b.maxX, b.minX - a.maxX)
        const sepY = Math.max(a.minY - b.maxY, b.minY - a.maxY)
        expect(Math.max(sepX, sepY)).toBeGreaterThanOrEqual(2 - slack)
      }
    }
  })

  it('gap 0 allows touching but not overlapping', () => {
    const parts = [rectPart(1, 10, 10, 4)]
    const res = nest(parts, { ...baseOpts, gap: 0, sheetWidth: 21, resolution: 0.25 })
    expect(res.placements).toHaveLength(4)
    const boxes = res.placements.map((pl) => placedBBox(parts[0], pl))
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i]
        const b = boxes[j]
        const sepX = Math.max(a.minX - b.maxX, b.minX - a.maxX)
        const sepY = Math.max(a.minY - b.maxY, b.minY - a.maxY)
        // No interpenetration beyond raster slack.
        expect(Math.max(sepX, sepY)).toBeGreaterThanOrEqual(-0.5)
      }
    }
  })

  it('rotates long parts to fit a narrow sheet', () => {
    const parts = [rectPart(1, 40, 5)]
    const res = nest(parts, { ...baseOpts, sheetWidth: 12 })
    expect(res.failures).toHaveLength(0)
    expect(res.placements).toHaveLength(1)
    const b = placedBBox(parts[0], res.placements[0])
    expect(b.maxX - b.minX).toBeLessThan(12.1)
  })

  it('small part nests inside a big part hole', () => {
    // Square ring: 40x40 outer, 30x30 hole; a 20x20 square should land inside the hole.
    const ring: NestPart = {
      id: 1,
      rings: [
        [
          { x: 0, y: 0 },
          { x: 40, y: 0 },
          { x: 40, y: 40 },
          { x: 0, y: 40 },
        ],
        [
          { x: 5, y: 5 },
          { x: 35, y: 5 },
          { x: 35, y: 35 },
          { x: 5, y: 35 },
        ],
      ],
      opens: [],
      width: 40,
      height: 40,
      area: 40 * 40 - 30 * 30,
      count: 1,
    }
    const small = rectPart(2, 20, 20)
    const res = nest([ring, small], { ...baseOpts, resolution: 0.25, sheetWidth: 41 })
    expect(res.placements).toHaveLength(2)
    const smallPl = res.placements.find((p) => p.partId === 2)!
    const b = placedBBox(small, smallPl)
    // Inside the hole region of the ring placed at origin.
    const ringPl = res.placements.find((p) => p.partId === 1)!
    const rb = placedBBox(ring, ringPl)
    expect(b.minX).toBeGreaterThan(rb.minX + 4)
    expect(b.maxX).toBeLessThan(rb.maxX - 4)
    expect(b.minY).toBeGreaterThan(rb.minY + 4)
    expect(b.maxY).toBeLessThan(rb.maxY - 4)
  })

  it('nests parts inside the pocket of a C-shaped part', () => {
    // C-channel: 100x60 outer, 10-thick walls and floor -> 80x50 pocket open at the
    // top. Two bars stand inside the pocket, protruding through the opening. Area
    // order alone would place the (heavier) bars first and the channel on top.
    const channel: NestPart = {
      id: 1,
      rings: [
        [
          { x: 0, y: 0 },
          { x: 100, y: 0 },
          { x: 100, y: 60 },
          { x: 90, y: 60 },
          { x: 90, y: 10 },
          { x: 10, y: 10 },
          { x: 10, y: 60 },
          { x: 0, y: 60 },
        ],
      ],
      opens: [],
      width: 100,
      height: 60,
      area: 100 * 60 - 80 * 50,
      count: 1,
    }
    const bar = rectPart(2, 36, 80, 2)
    const res = nest([channel, bar], { ...baseOpts, resolution: 0.25, sheetWidth: 120 })
    expect(res.failures).toHaveLength(0)
    expect(res.placements).toHaveLength(3)
    // Bars stand inside the pocket -> the whole nest stays below y=100. Without
    // in-part nesting the channel has to sit above the bars (y >= 136).
    expect(res.sheets[0].usedH).toBeLessThan(100)
    const chPl = res.placements.find((p) => p.partId === 1)!
    const chBox = placedBBox(channel, chPl)
    for (const pl of res.placements.filter((p) => p.partId === 2)) {
      const b = placedBBox(bar, pl)
      // Each bar overlaps the channel's bbox substantially: it is inside the pocket.
      const ovX = Math.min(b.maxX, chBox.maxX) - Math.max(b.minX, chBox.minX)
      const ovY = Math.min(b.maxY, chBox.maxY) - Math.max(b.minY, chBox.minY)
      expect(ovX).toBeGreaterThan(30)
      expect(ovY).toBeGreaterThan(30)
    }
  })

  it('splits across multiple sheets when a workpiece size is set', () => {
    const parts = [rectPart(1, 30, 30, 5)]
    const res = nest(parts, { ...baseOpts, sheetWidth: 40, sheetHeight: 40, gap: 2 })
    expect(res.failures).toHaveLength(0)
    expect(res.placements).toHaveLength(5)
    expect(res.sheets.length).toBe(5) // only one 30x30 fits a 40x40 sheet
    for (const pl of res.placements) {
      const b = placedBBox(parts[0], pl)
      expect(b.maxX).toBeLessThanOrEqual(40.6)
      expect(b.maxY).toBeLessThanOrEqual(40.6)
    }
  })

  it('balances parts across fixed sheets when that nests tighter per sheet', () => {
    // 2x 70x70 and 4x 30x30 on 102x102 sheets, gap 0. Greedy top-up crams one 70
    // plus all four 30s onto sheet 1 (used ~100x100) and strands the second 70
    // alone on sheet 2. Splitting evenly (one 70 + two 30s per sheet) uses only
    // ~100x70 per sheet, so the balanced pass must win the used-area tiebreak
    // at equal sheet count.
    const parts = [rectPart(1, 70, 70, 2), rectPart(2, 30, 30, 4)]
    const res = nest(parts, { ...baseOpts, gap: 0, resolution: 0.25, sheetWidth: 102, sheetHeight: 102 })
    expect(res.failures).toHaveLength(0)
    expect(res.placements).toHaveLength(6)
    expect(res.sheets.length).toBe(2)
    for (const si of [0, 1]) {
      const onSheet = res.placements.filter((p) => p.sheet === si)
      expect(onSheet.filter((p) => p.partId === 1)).toHaveLength(1)
      expect(onSheet.filter((p) => p.partId === 2)).toHaveLength(2)
    }
  })

  it('staged pass API produces the same result as nest()', () => {
    // The app runs passes on a worker pool via createNestContext/planStage1/
    // planBalanced/runPassSpec; folding their results in spec order must be
    // exactly equivalent to the sequential nest() driver.
    const parts = [rectPart(1, 70, 70, 2), rectPart(2, 30, 30, 4), rectPart(3, 45, 20, 3)]
    const opts = { ...baseOpts, gap: 0, resolution: 0.25, sheetWidth: 102, sheetHeight: 102 }
    const direct = nest(parts, opts)

    const ctx = createNestContext(parts, opts)!
    expect(ctx).not.toBeNull()
    const stage1 = planStage1(ctx).map((spec) => runPassSpec(ctx, spec))
    let best = stage1[0]
    for (const pass of stage1.slice(1)) if (betterPass(pass, best)) best = pass
    for (const spec of planBalanced(ctx, best)) {
      const pass = runPassSpec(ctx, spec)
      if (betterPass(pass, best)) best = pass
    }
    expect(finalizeNest(ctx, best)).toEqual(direct)
  })

  // findFit used to test only every st-th row (st up to 8), so a slot a few
  // rows tall between tested rows was never found.
  it('finds a tight hole between coarse scan rows', () => {
    const frame: NestPart = {
      id: 1,
      rings: [
        [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }],
        [{ x: 20, y: 23 }, { x: 80, y: 23 }, { x: 80, y: 73 }, { x: 20, y: 73 }],
      ],
      opens: [],
      width: 100,
      height: 100,
      area: 100 * 100 - 60 * 50,
      count: 1,
    }
    const insert = rectPart(2, 55, 46)
    const opts = { ...baseOpts, gap: 0, resolution: 1, sheetWidth: 102, sheetHeight: 102, rotationStep: 0 }
    const res = nest([frame, insert], opts)
    expect(res.sheets).toHaveLength(1)
    const b = placedBBox(insert, res.placements.find((pl) => pl.partId === 2)!)
    expect(b.minY).toBeGreaterThanOrEqual(23)
    expect(b.maxY).toBeLessThanOrEqual(73)
  })

  // ...and rows between the last coarse row and the height limit were skipped,
  // opening an extra sheet for a part that fits in the top strip.
  it('fits a part into the top strip under the height limit', () => {
    const lShape: NestPart = {
      id: 1,
      rings: [[{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 55 }, { x: 20, y: 55 }, { x: 20, y: 98 }, { x: 0, y: 98 }]],
      opens: [],
      width: 100,
      height: 98,
      area: 100 * 55 + 20 * 43,
      count: 1,
    }
    const opts = { ...baseOpts, gap: 0, resolution: 1, sheetWidth: 102, sheetHeight: 100, rotationStep: 0 }
    const res = nest([lShape, rectPart(2, 50, 40)], opts)
    expect(res.failures).toHaveLength(0)
    expect(res.sheets).toHaveLength(1)
  })

  it('never rounds the pixel gap below the requested gap', () => {
    // At 1 unit/px a 1.4 gap used to round to 1 px; with this part width the
    // real clearance then came out at 1.01.
    const part = rectPart(1, 9.99, 10, 2)
    const res = nest([part], { ...baseOpts, gap: 1.4, resolution: 1, sheetWidth: 25, rotationStep: 0 })
    expect(res.placements).toHaveLength(2)
    const [a, b] = res.placements.map((pl) => placedBBox(part, pl))
    const sep = Math.max(b.minX - a.maxX, a.minX - b.maxX, b.minY - a.maxY, a.minY - b.maxY)
    expect(sep).toBeGreaterThanOrEqual(1.4)
  })

  it('reports parts too big for the workpiece', () => {
    const parts = [rectPart(1, 100, 100)]
    const res = nest(parts, { ...baseOpts, sheetWidth: 50, sheetHeight: 50 })
    expect(res.failures).toEqual([1])
    expect(res.placements).toHaveLength(0)
  })

  it('respects the margin', () => {
    const parts = [rectPart(1, 10, 10)]
    const res = nest(parts, { ...baseOpts, sheetWidth: 30, margin: 5 })
    const b = placedBBox(parts[0], res.placements[0])
    expect(b.minX).toBeGreaterThanOrEqual(5 - 0.6)
    expect(b.minY).toBeGreaterThanOrEqual(5 - 0.6)
  })
})
