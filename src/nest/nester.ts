import type { Pt } from '../geom'
import { BitGrid, collide, dilate, orInto, overlapCount, rasterize } from './raster'

export interface NestPart {
  id: number
  rings: Pt[][]
  opens: Pt[][]
  width: number
  height: number
  area: number
  count: number
}

export interface NestOptions {
  /** Minimum distance between parts (0 = parts may touch / share cut lines). */
  gap: number
  /** Clearance from sheet edges. */
  margin: number
  /** Grid resolution in drawing units per pixel; null = auto. */
  resolution: number | null
  /** Sheet width incl. margins; null = auto (aim for a compact, roughly square nest). */
  sheetWidth: number | null
  /** Optional workpiece height limit — parts overflow onto additional sheets. */
  sheetHeight: number | null
  /** Allowed rotation step in degrees (0 = no rotation). */
  rotationStep: number
  /** Also try mirrored placements. */
  mirror: boolean
}

export interface Placement {
  partId: number
  sheet: number
  /** Rotation in radians. Sheet-local world = R(theta) * Mirror(local) + (tx, ty). */
  theta: number
  mirror: boolean
  tx: number
  ty: number
}

export interface SheetInfo {
  usedW: number
  usedH: number
  placed: number
}

export interface NestResult {
  placements: Placement[]
  sheets: SheetInfo[]
  sheetW: number
  sheetH: number | null
  resolution: number
  utilization: number
  /** Part ids that could not be placed at all (too big for the sheet). */
  failures: number[]
}

interface Mask {
  grid: BitGrid
  w: number
  h: number
  offX: number
  offY: number
  wU: number
  hU: number
  theta: number
  mirror: boolean
  dilated: BitGrid | null
  /** Mask dilated by gap+1 px: the "contact zone" stamped into Sheet.occC. */
  dilatedC: BitGrid | null
}

interface Sheet {
  occ: BitGrid
  /** Contact zones (stamps dilated one px past the gap, plus sheet edges). */
  occC: BitGrid
  /** Rows of occC whose edge columns have been marked so far. */
  contactRows: number
  /** First empty nest-space row (px): all rows >= topNest are guaranteed free. */
  topNest: number
  usedWU: number
  usedHU: number
  placed: number
}

export type ProgressFn = (done: number, total: number) => void

/** Empty bbox space inside a part (pockets, concavities, holes) other parts could nest into. */
function voidArea(p: NestPart): number {
  return Math.max(0, p.width * p.height - p.area)
}

/**
 * Position-selection policy for a placement pass. 'bl' is classic bottom-left.
 * 'contact' prefers the orientation whose fit touches the most existing material
 * or sheet edge ("touching perimeter"), which snugs parts into pockets and
 * corners instead of starting fresh columns.
 */
type Policy = 'bl' | 'contact'

export function nest(parts: NestPart[], opts: NestOptions, onProgress?: ProgressFn): NestResult {
  const usable = parts.filter((p) => p.count > 0 && (p.rings.length > 0 || p.opens.length > 0))
  const rotations: number[] = [0]
  if (opts.rotationStep > 0) {
    for (let a = opts.rotationStep; a < 360 - 1e-9; a += opts.rotationStep) rotations.push(a)
  }
  const mirrors = opts.mirror ? [false, true] : [false]

  // Minimal bbox width each part can present, over all allowed orientations.
  let maxPartMinW = 0
  let maxPartMinH = 0
  let minPartDim = Infinity
  let totalArea = 0
  for (const p of usable) {
    let best = Infinity
    let bestH = Infinity
    for (const rot of rotations) {
      const { w, h } = orientedBBox(p, (rot * Math.PI) / 180)
      if (w < best) {
        best = w
        bestH = h
      }
    }
    maxPartMinW = Math.max(maxPartMinW, best)
    maxPartMinH = Math.max(maxPartMinH, bestH)
    minPartDim = Math.min(minPartDim, Math.min(p.width, p.height))
    totalArea += p.area * p.count
  }
  if (usable.length === 0) {
    return { placements: [], sheets: [], sheetW: 0, sheetH: null, resolution: 1, utilization: 0, failures: [] }
  }

  const margin = Math.max(0, opts.margin)
  const sheetW =
    opts.sheetWidth ?? Math.max(Math.sqrt(totalArea * 1.8), maxPartMinW * 1.02 + 2 * opts.gap) + 2 * margin
  const sheetH = opts.sheetWidth != null ? opts.sheetHeight : null
  const innerWU = Math.max(sheetW - 2 * margin, 1e-6)
  const innerHU = sheetH != null ? Math.max(sheetH - 2 * margin, 1e-6) : null

  let res = opts.resolution ?? autoResolution(innerWU, minPartDim)
  res = Math.max(res, 1e-4)
  const scale = 1 / res

  const innerW = Math.max(1, Math.round(innerWU * scale))
  const innerH = innerHU != null ? Math.max(1, Math.floor(innerHU * scale)) : null
  const gapPx = Math.max(0, Math.round(opts.gap * scale))
  const PAD = gapPx

  // Build instance list, biggest first.
  const instances: NestPart[] = []
  for (const p of usable) for (let i = 0; i < p.count; i++) instances.push(p)
  instances.sort((a, b) => b.area - a.area || Math.max(b.width, b.height) - Math.max(a.width, a.height))

  // Placement order strategies. Beyond plain biggest-first, mostly-empty parts
  // (C-channels, frames, brackets — more void than material inside their bbox) are
  // promoted so later parts can nest into their pockets and concavities: the pocket
  // has to exist before it can be filled, but area order alone places such
  // containers last since their material area is small. Leading with only 1-2
  // containers keeps their pockets available for the big parts that follow instead
  // of letting the containers interlock with each other first; each candidate
  // ordering runs a full greedy pass and the best result wins.
  const orders: NestPart[][] = [instances]
  const isContainer = (p: NestPart) => voidArea(p) >= p.area
  const containers = usable.filter(isContainer)
  const couldNest = containers.some(
    (c) => c.count > 1 || usable.some((p) => p !== c && p.area <= voidArea(c))
  )
  if (instances.length > 1 && couldNest) {
    // instances is area-sorted, so these keep biggest-first within each class.
    const contList = instances.filter(isContainer)
    const nonList = instances.filter((p) => !isContainer(p))
    const leads = [...new Set([contList.length, 1, 2])].filter((k) => k >= 1 && k <= contList.length)
    for (const k of leads) {
      const order = [...contList.slice(0, k), ...nonList, ...contList.slice(k)]
      if (orders.every((o) => order.some((p, i) => p !== o[i]))) orders.push(order)
    }
  }

  const maskCache = new Map<string, Mask | null>()
  const getMask = (p: NestPart, rot: number, mir: boolean): Mask | null => {
    const key = `${p.id}|${rot}|${mir}`
    let m = maskCache.get(key)
    if (m !== undefined) return m
    m = buildMask(p, (rot * Math.PI) / 180, mir, scale)
    if (m && (m.w > innerW || (innerH != null && m.h > innerH))) m = null
    maskCache.set(key, m)
    return m
  }

  interface Pass {
    placements: Placement[]
    sheets: SheetInfo[]
    placedArea: number
    stockArea: number
    /** Sum of per-sheet used bounding areas — lower = more compact nests, bigger offcuts. */
    usedArea: number
    failures: Set<number>
  }

  // Contact-scored passes over every candidate order, plus one classic bottom-left
  // pass on the plain order as a safety net for shapes where snug placement loses.
  const passes: { order: NestPart[]; policy: Policy }[] = [
    ...orders.map((order) => ({ order, policy: 'contact' as Policy })),
    { order: instances, policy: 'bl' as Policy },
  ]
  let total = instances.length * passes.length
  let done = 0

  interface PlacedItem {
    p: NestPart
    mask: Mask
    x: number
    y: number
    sheet: number
  }

  // The contact grid uses one extra pad pixel so a mask's cells can coincide with
  // zones dilated one px past the gap: overlap there = "touching across the gap".
  const PADC = PAD + 1

  const newSheet = (): Sheet => {
    const occC = new BitGrid(innerW + 2 * PADC, 128)
    // Sheet floor counts as contact.
    for (let y = 0; y <= PADC; y++) occC.fillSpan(y, 0, occC.w - 1)
    return {
      occ: new BitGrid(innerW + 2 * PAD, 128),
      occC,
      contactRows: 0,
      topNest: 0,
      usedWU: 0,
      usedHU: 0,
      placed: 0,
    }
  }

  // Keep occC's left/right sheet-edge columns marked as rows grow.
  const ensureContact = (sheet: Sheet, rows: number): void => {
    const g = sheet.occC
    g.ensureRows(rows)
    if (sheet.contactRows < g.h) {
      for (let y = sheet.contactRows; y < g.h; y++) {
        g.fillSpan(y, 0, PADC)
        g.fillSpan(y, PADC + innerW - 1, g.w - 1)
      }
      sheet.contactRows = g.h
    }
  }

  /** Touching-perimeter score: mask cells within one px of placed material or a sheet edge. */
  const contactAt = (sheet: Sheet, mask: Mask, x: number, y: number): number => {
    ensureContact(sheet, y + PADC + mask.h)
    return overlapCount(sheet.occC, mask.grid, x + PADC, y + PADC)
  }

  const stamp = (sheet: Sheet, mask: Mask, x: number, y: number, policy: Policy): void => {
    if (!mask.dilated) mask.dilated = dilate(mask.grid, gapPx)
    // Occupancy coords are nest coords + PAD; the dilated stamp cancels the pad.
    orInto(sheet.occ, mask.dilated, x, y)
    sheet.topNest = Math.max(sheet.topNest, y + mask.h + gapPx)
    if (policy === 'contact') {
      if (!mask.dilatedC) mask.dilatedC = dilate(mask.grid, gapPx + 1)
      ensureContact(sheet, y + mask.dilatedC.h)
      orInto(sheet.occC, mask.dilatedC, x, y)
    }
  }

  const posBetter = (y: number, x: number, cur: { y: number; x: number }): boolean =>
    y < cur.y || (y === cur.y && x < cur.x)

  // Best position for any allowed orientation of p on one sheet: the policy picks
  // among each orientation's lowest-left fit.
  const bestOnSheet = (p: NestPart, sheet: Sheet, policy: Policy): { mask: Mask; x: number; y: number } | null => {
    let sheetBest: { mask: Mask; x: number; y: number } | null = null
    let bestContact = -1
    for (const mir of mirrors) {
      for (const rot of rotations) {
        const mask = getMask(p, rot, mir)
        if (!mask) continue
        const pos = findFit(sheet, mask, innerW, innerH, PAD)
        if (!pos) continue
        if (policy === 'contact') {
          const c = contactAt(sheet, mask, pos.x, pos.y)
          if (!sheetBest || c > bestContact || (c === bestContact && posBetter(pos.y, pos.x, sheetBest))) {
            sheetBest = { mask, x: pos.x, y: pos.y }
            bestContact = c
          }
        } else if (!sheetBest || posBetter(pos.y, pos.x, sheetBest)) {
          sheetBest = { mask, x: pos.x, y: pos.y }
        }
      }
    }
    return sheetBest
  }

  // With `assign`, the pass distributes work across a fixed pool of sheets:
  // assign[i] is the sheet order[i] should land on (fallback: any sheet that
  // fits). Without it, earlier sheets win outright so partially filled stock
  // gets topped up first.
  const runPass = (order: NestPart[], policy: Policy, assign?: number[]): Pass => {
    const sheets: Sheet[] = []
    if (assign) {
      let pool = 0
      for (const si of assign) pool = Math.max(pool, si + 1)
      while (sheets.length < pool) sheets.push(newSheet())
    }
    const items: PlacedItem[] = []
    const failures = new Set<number>()
    let placedArea = 0

    for (let oi = 0; oi < order.length; oi++) {
      const p = order[oi]
      let best: { sheet: number; mask: Mask; x: number; y: number } | null = null
      const target = assign?.[oi]
      if (target != null && target < sheets.length) {
        const found = bestOnSheet(p, sheets[target], policy)
        if (found) best = { sheet: target, ...found }
      }
      for (let si = 0; si < sheets.length && !best; si++) {
        if (si === target) continue
        const found = bestOnSheet(p, sheets[si], policy)
        if (found) best = { sheet: si, ...found }
      }
      if (!best) {
        let fitsEmpty = false
        for (const mir of mirrors) for (const rot of rotations) if (getMask(p, rot, mir)) fitsEmpty = true
        if (fitsEmpty) {
          sheets.push(newSheet())
          const si = sheets.length - 1
          const found = bestOnSheet(p, sheets[si], policy)
          if (found) best = { sheet: si, ...found }
        }
        if (!best) {
          failures.add(p.id)
          done++
          onProgress?.(done, total)
          continue
        }
      }

      stamp(sheets[best.sheet], best.mask, best.x, best.y, policy)
      items.push({ p, mask: best.mask, x: best.x, y: best.y, sheet: best.sheet })
      placedArea += p.area
      done++
      onProgress?.(done, total)
    }

    // Derive per-sheet stats and placements from the final item list.
    for (const it of items) {
      const sheet = sheets[it.sheet]
      sheet.usedWU = Math.max(sheet.usedWU, margin + it.x * res + it.mask.wU)
      sheet.usedHU = Math.max(sheet.usedHU, margin + it.y * res + it.mask.hU)
      sheet.placed++
    }
    // Drop sheets that ended up empty (possible with `assign`) and renumber.
    const remap = new Map<number, number>()
    const liveSheets = sheets.filter((s, i) => {
      if (s.placed === 0) return false
      remap.set(i, remap.size)
      return true
    })
    const placements: Placement[] = items.map((it) => ({
      partId: it.p.id,
      sheet: remap.get(it.sheet)!,
      theta: it.mask.theta,
      mirror: it.mask.mirror,
      tx: margin + it.x * res - it.mask.offX,
      ty: margin + it.y * res - it.mask.offY,
    }))

    const sheetInfos: SheetInfo[] = liveSheets.map((s) => ({
      usedW: s.usedWU + margin,
      usedH: s.usedHU + margin,
      placed: s.placed,
    }))
    let stockArea = 0
    let usedArea = 0
    for (const s of sheetInfos) {
      stockArea += sheetH != null ? sheetW * sheetH : (opts.sheetWidth != null ? sheetW : s.usedW) * s.usedH
      usedArea += s.usedW * s.usedH
    }
    return { placements, sheets: sheetInfos, placedArea, stockArea, usedArea, failures }
  }

  // More parts placed > fewer sheets > less stock consumed > tighter per-sheet
  // nests. The used-area tiebreak matters for fixed-size sheets, where every
  // layout with the same sheet count consumes the same stock: preferring compact
  // per-sheet bounding boxes keeps each sheet's leftover a large usable offcut.
  // Ties keep the earlier (plain biggest-first) pass.
  const better = (a: Pass, b: Pass): boolean => {
    if (a.placements.length !== b.placements.length) return a.placements.length > b.placements.length
    if (a.sheets.length !== b.sheets.length) return a.sheets.length < b.sheets.length
    if (Math.abs(a.stockArea - b.stockArea) > 1e-9) return a.stockArea < b.stockArea
    return a.usedArea < b.usedArea - 1e-9
  }

  let best = runPass(passes[0].order, passes[0].policy)
  for (let i = 1; i < passes.length; i++) {
    const pass = runPass(passes[i].order, passes[i].policy)
    if (better(pass, best)) best = pass
  }

  // Greedy top-up fills early sheets with whatever fits, which can strand an
  // awkward remainder (e.g. all the bulky solids on sheet 1, all the sparse
  // frames on sheet 2). When several fixed-size sheets are needed anyway,
  // additionally try balanced distributions: pre-open a pool of sheets and
  // spread the instances across them by area (each to the least-loaded sheet,
  // in placement order), so complementary shapes can pair up on every sheet.
  // Greedy can also overshoot the necessary sheet count outright — e.g. parts
  // that only pack when grouped right, like half-frames enclosing their panels —
  // so try pools smaller than the greedy result too, down to the area lower
  // bound; a pass that fits everything on fewer sheets wins in better().
  const wantSheets = best.sheets.length
  if (sheetH != null && wantSheets > 1 && instances.length > wantSheets && best.failures.size === 0) {
    const areaBound = Math.ceil(totalArea / (innerWU * innerHU!) - 1e-9)
    const lowK = Math.max(2, wantSheets - 2, Math.min(areaBound, wantSheets))
    const balanced: { order: NestPart[]; assign: number[] }[] = []
    for (let pool = lowK; pool <= wantSheets; pool++) {
      for (const order of orders) {
        const load = new Array<number>(pool).fill(0)
        const assign = order.map((p) => {
          let si = 0
          for (let k = 1; k < pool; k++) if (load[k] < load[si]) si = k
          load[si] += p.area
          return si
        })
        balanced.push({ order, assign })
      }
    }
    total += instances.length * balanced.length
    for (const { order, assign } of balanced) {
      const pass = runPass(order, 'contact', assign)
      if (better(pass, best)) best = pass
    }
  }

  return {
    placements: best.placements,
    sheets: best.sheets,
    sheetW,
    sheetH: sheetH ?? null,
    resolution: res,
    utilization: best.stockArea > 0 ? best.placedArea / best.stockArea : 0,
    failures: [...best.failures],
  }
}

function autoResolution(innerWU: number, minPartDim: number): number {
  const base = innerWU / 900
  const floor = innerWU / 4000
  const fine = Number.isFinite(minPartDim) && minPartDim > 0 ? minPartDim / 6 : base
  return Math.max(floor, Math.min(base, fine))
}

function orientedBBox(p: NestPart, theta: number): { w: number; h: number } {
  const c = Math.cos(theta)
  const s = Math.sin(theta)
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  const visit = (pt: Pt) => {
    const x = pt.x * c - pt.y * s
    const y = pt.x * s + pt.y * c
    if (x < minX) minX = x
    if (y < minY) minY = y
    if (x > maxX) maxX = x
    if (y > maxY) maxY = y
  }
  for (const r of p.rings) for (const pt of r) visit(pt)
  for (const o of p.opens) for (const pt of o) visit(pt)
  if (!Number.isFinite(minX)) return { w: 0, h: 0 }
  return { w: maxX - minX, h: maxY - minY }
}

function buildMask(p: NestPart, theta: number, mirror: boolean, scale: number): Mask | null {
  const c = Math.cos(theta)
  const s = Math.sin(theta)
  const xf = (pt: Pt): Pt => {
    const px = mirror ? -pt.x : pt.x
    return { x: px * c - pt.y * s, y: px * s + pt.y * c }
  }
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  const rings = p.rings.map((r) => r.map(xf))
  const opens = p.opens.map((o) => o.map(xf))
  for (const poly of [...rings, ...opens]) {
    for (const pt of poly) {
      if (pt.x < minX) minX = pt.x
      if (pt.y < minY) minY = pt.y
      if (pt.x > maxX) maxX = pt.x
      if (pt.y > maxY) maxY = pt.y
    }
  }
  if (!Number.isFinite(minX)) return null
  const shift = (poly: Pt[]) => {
    for (const pt of poly) {
      pt.x -= minX
      pt.y -= minY
    }
    return poly
  }
  rings.forEach(shift)
  opens.forEach(shift)
  const wU = maxX - minX
  const hU = maxY - minY
  const w = Math.max(1, Math.ceil(wU * scale) + 1)
  const h = Math.max(1, Math.ceil(hU * scale) + 1)
  if (w * h > 64_000_000) return null // pathological resolution/part combination
  const grid = rasterize(rings, opens, scale, w, h)
  return { grid, w, h, offX: minX, offY: minY, wU, hU, theta, mirror, dilated: null, dilatedC: null }
}

/**
 * Bottom-left first fit: scan upward with a coarse row stride, then refine the band.
 * Rows are scanned exhaustively in x (collide exits early on occupied spots), so
 * narrow slots — e.g. a snug pocket inside another part — are not skipped over.
 * Returns nest-space pixel coords, or null if the mask cannot fit (height limit).
 */
function findFit(sheet: Sheet, mask: Mask, innerW: number, innerH: number | null, PAD: number): { x: number; y: number } | null {
  const maxX = innerW - mask.w
  if (maxX < 0) return null
  const yLimit = innerH != null ? innerH - mask.h : Infinity
  if (yLimit < 0) return null
  const scanTop = Math.min(sheet.topNest, yLimit)
  const st = Math.max(1, Math.min(8, Math.floor(Math.min(mask.w, mask.h) / 6)))
  const occ = sheet.occ
  for (let y = 0; y <= scanTop; y += st) {
    occ.ensureRows(y + PAD + mask.h)
    for (let x = 0; x <= maxX; x++) {
      if (!collide(occ, mask.grid, x + PAD, y + PAD)) {
        // Found room in this band — refine to the lowest-left position inside it.
        for (let fy = Math.max(0, y - st + 1); fy < y; fy++) {
          for (let fx = 0; fx <= maxX; fx++) {
            if (!collide(occ, mask.grid, fx + PAD, fy + PAD)) return { x: fx, y: fy }
          }
        }
        return { x, y }
      }
    }
  }
  // Nothing inside the used region — place on top if the height limit allows.
  if (sheet.topNest <= yLimit) {
    occ.ensureRows(sheet.topNest + PAD + mask.h)
    return { x: 0, y: sheet.topNest }
  }
  return null
}
