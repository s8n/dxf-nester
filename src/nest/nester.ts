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

/** One greedy placement pass: an instance order (indices into ctx.instances),
 * a position policy, and optionally a per-instance target sheet. Plain data so
 * specs can be shipped to workers. */
export interface PassSpec {
  order: number[]
  policy: Policy
  /** Target sheet for each order entry (balanced distribution); fallback is any sheet. */
  assign?: number[]
}

/** Serializable outcome of one pass — enough to compare passes and to build
 * the final NestResult from the winner. */
export interface PassResult {
  placements: Placement[]
  sheets: SheetInfo[]
  placedArea: number
  stockArea: number
  /** Sum of per-sheet used bounding areas — lower = more compact nests, bigger offcuts. */
  usedArea: number
  failures: number[]
}

/**
 * Everything a pass needs, derived deterministically from (parts, opts): sizing,
 * resolution, the sorted instance list, candidate orders and the (lazy) mask
 * cache. Workers build their own identical context once and then run any number
 * of PassSpecs against it, so runPassSpec(ctx, spec) yields the same result on
 * every thread and passes can be compared purely by spec order.
 */
export interface NestContext {
  opts: NestOptions
  rotations: number[]
  mirrors: boolean[]
  margin: number
  sheetW: number
  sheetH: number | null
  innerWU: number
  innerHU: number | null
  res: number
  scale: number
  innerW: number
  innerH: number | null
  gapPx: number
  pad: number
  padC: number
  totalArea: number
  /** Placement instances (one entry per copy), biggest first. */
  instances: NestPart[]
  /** Candidate placement orders as indices into `instances`. */
  orders: number[][]
  maskCache: Map<string, Mask | null>
}

/** Build the shared per-nest context; null when there is nothing to place. */
export function createNestContext(parts: NestPart[], opts: NestOptions): NestContext | null {
  const usable = parts.filter((p) => p.count > 0 && (p.rings.length > 0 || p.opens.length > 0))
  if (usable.length === 0) return null
  const rotations: number[] = [0]
  if (opts.rotationStep > 0) {
    for (let a = opts.rotationStep; a < 360 - 1e-9; a += opts.rotationStep) rotations.push(a)
  }
  const mirrors = opts.mirror ? [false, true] : [false]

  // Minimal bbox width each part can present, over all allowed orientations.
  let maxPartMinW = 0
  let minPartDim = Infinity
  let totalArea = 0
  for (const p of usable) {
    let best = Infinity
    for (const rot of rotations) {
      const { w } = orientedBBox(p, (rot * Math.PI) / 180)
      if (w < best) best = w
    }
    maxPartMinW = Math.max(maxPartMinW, best)
    minPartDim = Math.min(minPartDim, Math.min(p.width, p.height))
    totalArea += p.area * p.count
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
  const pad = gapPx
  // The contact grid uses one extra pad pixel so a mask's cells can coincide with
  // zones dilated one px past the gap: overlap there = "touching across the gap".
  const padC = pad + 1

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
  const base = instances.map((_, i) => i)
  const orders: number[][] = [base]
  const isContainer = (p: NestPart) => voidArea(p) >= p.area
  const containers = usable.filter(isContainer)
  const couldNest = containers.some(
    (c) => c.count > 1 || usable.some((p) => p !== c && p.area <= voidArea(c))
  )
  if (instances.length > 1 && couldNest) {
    // `base` is area-sorted, so these keep biggest-first within each class.
    const contIdx = base.filter((i) => isContainer(instances[i]))
    const nonIdx = base.filter((i) => !isContainer(instances[i]))
    const leads = [...new Set([contIdx.length, 1, 2])].filter((k) => k >= 1 && k <= contIdx.length)
    for (const k of leads) {
      const order = [...contIdx.slice(0, k), ...nonIdx, ...contIdx.slice(k)]
      const sameAs = (o: number[]) => order.every((idx, i) => instances[idx].id === instances[o[i]].id)
      if (!orders.some(sameAs)) orders.push(order)
    }
  }

  return {
    opts,
    rotations,
    mirrors,
    margin,
    sheetW,
    sheetH,
    innerWU,
    innerHU,
    res,
    scale,
    innerW,
    innerH,
    gapPx,
    pad,
    padC,
    totalArea,
    instances,
    orders,
    maskCache: new Map(),
  }
}

function getMask(ctx: NestContext, p: NestPart, rot: number, mir: boolean): Mask | null {
  const key = `${p.id}|${rot}|${mir}`
  let m = ctx.maskCache.get(key)
  if (m !== undefined) return m
  m = buildMask(p, (rot * Math.PI) / 180, mir, ctx.scale)
  if (m && (m.w > ctx.innerW || (ctx.innerH != null && m.h > ctx.innerH))) m = null
  ctx.maskCache.set(key, m)
  return m
}

/** Stage-1 passes: contact-scored passes over every candidate order, plus one
 * classic bottom-left pass on the plain order as a safety net for shapes where
 * snug placement loses. */
export function planStage1(ctx: NestContext): PassSpec[] {
  return [
    ...ctx.orders.map((order) => ({ order, policy: 'contact' as Policy })),
    { order: ctx.orders[0], policy: 'bl' as Policy },
  ]
}

/**
 * Stage-2 passes, planned from the stage-1 winner. Greedy top-up fills early
 * sheets with whatever fits, which can strand an awkward remainder (e.g. all
 * the bulky solids on sheet 1, all the sparse frames on sheet 2). When several
 * fixed-size sheets are needed anyway, additionally try balanced distributions:
 * pre-open a pool of sheets and spread the instances across them by area (each
 * to the least-loaded sheet, in placement order), so complementary shapes can
 * pair up on every sheet. Greedy can also overshoot the necessary sheet count
 * outright — e.g. parts that only pack when grouped right, like half-frames
 * enclosing their panels — so try pools smaller than the greedy result too,
 * down to the area lower bound; a pass that fits everything on fewer sheets
 * wins in betterPass().
 */
export function planBalanced(ctx: NestContext, best: PassResult): PassSpec[] {
  const wantSheets = best.sheets.length
  if (ctx.sheetH == null || wantSheets <= 1 || ctx.instances.length <= wantSheets || best.failures.length > 0) {
    return []
  }
  const areaBound = Math.ceil(ctx.totalArea / (ctx.innerWU * ctx.innerHU!) - 1e-9)
  const lowK = Math.max(2, wantSheets - 2, Math.min(areaBound, wantSheets))
  const specs: PassSpec[] = []
  for (let pool = lowK; pool <= wantSheets; pool++) {
    for (const order of ctx.orders) {
      const load = new Array<number>(pool).fill(0)
      const assign = order.map((idx) => {
        let si = 0
        for (let k = 1; k < pool; k++) if (load[k] < load[si]) si = k
        load[si] += ctx.instances[idx].area
        return si
      })
      specs.push({ order, policy: 'contact', assign })
    }
  }
  return specs
}

/**
 * Pass comparison: more parts placed > fewer sheets > less stock consumed >
 * tighter per-sheet nests. The used-area tiebreak matters for fixed-size
 * sheets, where every layout with the same sheet count consumes the same stock:
 * preferring compact per-sheet bounding boxes keeps each sheet's leftover a
 * large usable offcut. Ties keep `b`, so folding in spec order keeps the
 * earlier pass regardless of which thread finished first.
 */
export function betterPass(a: PassResult, b: PassResult): boolean {
  if (a.placements.length !== b.placements.length) return a.placements.length > b.placements.length
  if (a.sheets.length !== b.sheets.length) return a.sheets.length < b.sheets.length
  if (Math.abs(a.stockArea - b.stockArea) > 1e-9) return a.stockArea < b.stockArea
  return a.usedArea < b.usedArea - 1e-9
}

/** Run one greedy placement pass. Pure w.r.t. (ctx's parts+opts, spec). */
export function runPassSpec(ctx: NestContext, spec: PassSpec, onProgress?: ProgressFn): PassResult {
  const { innerW, innerH, gapPx, pad: PAD, padC: PADC, margin, res, mirrors, rotations, sheetW, sheetH, opts } = ctx
  const order = spec.order.map((i) => ctx.instances[i])
  const policy = spec.policy
  const assign = spec.assign

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

  const stamp = (sheet: Sheet, mask: Mask, x: number, y: number): void => {
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
  const bestOnSheet = (p: NestPart, sheet: Sheet): { mask: Mask; x: number; y: number } | null => {
    let sheetBest: { mask: Mask; x: number; y: number } | null = null
    let bestContact = -1
    for (const mir of mirrors) {
      for (const rot of rotations) {
        const mask = getMask(ctx, p, rot, mir)
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

  interface PlacedItem {
    p: NestPart
    mask: Mask
    x: number
    y: number
    sheet: number
  }

  // With `assign`, the pass distributes work across a fixed pool of sheets:
  // assign[i] is the sheet order[i] should land on (fallback: any sheet that
  // fits). Without it, earlier sheets win outright so partially filled stock
  // gets topped up first.
  const sheets: Sheet[] = []
  if (assign) {
    let pool = 0
    for (const si of assign) pool = Math.max(pool, si + 1)
    while (sheets.length < pool) sheets.push(newSheet())
  }
  const items: PlacedItem[] = []
  const failures = new Set<number>()
  let placedArea = 0
  let done = 0

  for (let oi = 0; oi < order.length; oi++) {
    const p = order[oi]
    let best: { sheet: number; mask: Mask; x: number; y: number } | null = null
    const target = assign?.[oi]
    if (target != null && target < sheets.length) {
      const found = bestOnSheet(p, sheets[target])
      if (found) best = { sheet: target, ...found }
    }
    for (let si = 0; si < sheets.length && !best; si++) {
      if (si === target) continue
      const found = bestOnSheet(p, sheets[si])
      if (found) best = { sheet: si, ...found }
    }
    if (!best) {
      let fitsEmpty = false
      for (const mir of mirrors) for (const rot of rotations) if (getMask(ctx, p, rot, mir)) fitsEmpty = true
      if (fitsEmpty) {
        sheets.push(newSheet())
        const si = sheets.length - 1
        const found = bestOnSheet(p, sheets[si])
        if (found) best = { sheet: si, ...found }
      }
      if (!best) {
        failures.add(p.id)
        done++
        onProgress?.(done, order.length)
        continue
      }
    }

    stamp(sheets[best.sheet], best.mask, best.x, best.y)
    items.push({ p, mask: best.mask, x: best.x, y: best.y, sheet: best.sheet })
    placedArea += p.area
    done++
    onProgress?.(done, order.length)
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
  return { placements, sheets: sheetInfos, placedArea, stockArea, usedArea, failures: [...failures] }
}

/** Build the final NestResult from the winning pass. */
export function finalizeNest(ctx: NestContext, best: PassResult): NestResult {
  return {
    placements: best.placements,
    sheets: best.sheets,
    sheetW: ctx.sheetW,
    sheetH: ctx.sheetH ?? null,
    resolution: ctx.res,
    utilization: best.stockArea > 0 ? best.placedArea / best.stockArea : 0,
    failures: best.failures,
  }
}

/** Sequential driver: plan, run every pass in order, keep the best, finalize.
 * The app runs the same stages on a worker pool instead (see nest/worker.ts). */
export function nest(parts: NestPart[], opts: NestOptions, onProgress?: ProgressFn): NestResult {
  const ctx = createNestContext(parts, opts)
  if (!ctx) {
    return { placements: [], sheets: [], sheetW: 0, sheetH: null, resolution: 1, utilization: 0, failures: [] }
  }
  const n = ctx.instances.length
  const stage1 = planStage1(ctx)
  let total = n * stage1.length
  let done = 0
  const run = (spec: PassSpec): PassResult => {
    const pass = runPassSpec(ctx, spec, (d) => onProgress?.(done + d, total))
    done += n
    return pass
  }
  let best = run(stage1[0])
  for (let i = 1; i < stage1.length; i++) {
    const pass = run(stage1[i])
    if (betterPass(pass, best)) best = pass
  }
  const stage2 = planBalanced(ctx, best)
  total += n * stage2.length
  for (const spec of stage2) {
    const pass = run(spec)
    if (betterPass(pass, best)) best = pass
  }
  return finalizeNest(ctx, best)
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
 * Rows are scanned exhaustively in x — collide()'s skip distances only jump over
 * positions proven to collide — so narrow slots, e.g. a snug pocket inside
 * another part, are never skipped over.
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
    for (let x = 0; x <= maxX; ) {
      const d = collide(occ, mask.grid, x + PAD, y + PAD)
      if (d === 0) {
        // Found room in this band — refine to the lowest-left position inside it.
        for (let fy = Math.max(0, y - st + 1); fy < y; fy++) {
          for (let fx = 0; fx <= maxX; ) {
            const fd = collide(occ, mask.grid, fx + PAD, fy + PAD)
            if (fd === 0) return { x: fx, y: fy }
            fx += fd
          }
        }
        return { x, y }
      }
      x += d
    }
  }
  // Nothing inside the used region — place on top if the height limit allows.
  if (sheet.topNest <= yLimit) {
    occ.ensureRows(sheet.topNest + PAD + mask.h)
    return { x: 0, y: sheet.topNest }
  }
  return null
}
