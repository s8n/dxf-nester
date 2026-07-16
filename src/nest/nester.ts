import type { Pt } from '../geom'
import { BitGrid, collide, dilate, orInto, rasterize } from './raster'

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
}

interface Sheet {
  occ: BitGrid
  /** First empty nest-space row (px): all rows >= topNest are guaranteed free. */
  topNest: number
  usedWU: number
  usedHU: number
  placed: number
}

export type ProgressFn = (done: number, total: number) => void

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

  const sheets: Sheet[] = []
  const newSheet = (): Sheet => {
    const s: Sheet = { occ: new BitGrid(innerW + 2 * PAD, 128), topNest: 0, usedWU: 0, usedHU: 0, placed: 0 }
    sheets.push(s)
    return s
  }

  const placements: Placement[] = []
  const failures = new Set<number>()
  let placedArea = 0
  let done = 0

  // Best bottom-left position for any allowed orientation of p on one sheet.
  const bestOnSheet = (p: NestPart, si: number): { mask: Mask; x: number; y: number } | null => {
    let sheetBest: { mask: Mask; x: number; y: number } | null = null
    for (const mir of mirrors) {
      for (const rot of rotations) {
        const mask = getMask(p, rot, mir)
        if (!mask) continue
        const pos = findFit(sheets[si], mask, innerW, innerH, PAD)
        if (pos && (!sheetBest || pos.y < sheetBest.y || (pos.y === sheetBest.y && pos.x < sheetBest.x))) {
          sheetBest = { mask, x: pos.x, y: pos.y }
        }
      }
    }
    return sheetBest
  }

  for (const p of instances) {
    let best: { sheet: number; mask: Mask; x: number; y: number } | null = null
    // Earlier sheets win outright so partially filled stock gets topped up first.
    for (let si = 0; si < sheets.length && !best; si++) {
      const found = bestOnSheet(p, si)
      if (found) best = { sheet: si, ...found }
    }
    if (!best) {
      let fitsEmpty = false
      for (const mir of mirrors) for (const rot of rotations) if (getMask(p, rot, mir)) fitsEmpty = true
      if (fitsEmpty) {
        const si = sheets.length
        newSheet()
        const found = bestOnSheet(p, si)
        if (found) best = { sheet: si, ...found }
      }
      if (!best) {
        failures.add(p.id)
        done++
        onProgress?.(done, instances.length)
        continue
      }
    }

    const sheet = sheets[best.sheet]
    const mask = best.mask
    if (!mask.dilated) mask.dilated = dilate(mask.grid, gapPx)
    // Occupancy coords are nest coords + PAD; the dilated stamp cancels the pad.
    orInto(sheet.occ, mask.dilated, best.x, best.y)
    sheet.topNest = Math.max(sheet.topNest, best.y + mask.h + gapPx)
    sheet.usedWU = Math.max(sheet.usedWU, margin + best.x * res + mask.wU)
    sheet.usedHU = Math.max(sheet.usedHU, margin + best.y * res + mask.hU)
    sheet.placed++
    placements.push({
      partId: p.id,
      sheet: best.sheet,
      theta: mask.theta,
      mirror: mask.mirror,
      tx: margin + best.x * res - mask.offX,
      ty: margin + best.y * res - mask.offY,
    })
    placedArea += p.area
    done++
    onProgress?.(done, instances.length)
  }

  const sheetInfos: SheetInfo[] = sheets.map((s) => ({
    usedW: s.usedWU + margin,
    usedH: s.usedHU + margin,
    placed: s.placed,
  }))
  let stockArea = 0
  for (const s of sheetInfos) {
    stockArea += sheetH != null ? sheetW * sheetH : (opts.sheetWidth != null ? sheetW : s.usedW) * s.usedH
  }
  return {
    placements,
    sheets: sheetInfos,
    sheetW,
    sheetH: sheetH ?? null,
    resolution: res,
    utilization: stockArea > 0 ? placedArea / stockArea : 0,
    failures: [...failures],
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
  return { grid, w, h, offX: minX, offY: minY, wU, hU, theta, mirror, dilated: null }
}

/**
 * Bottom-left first fit: scan upward, coarse stride first, then refine the band.
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
    for (let x = 0; x <= maxX; x += st) {
      if (!collide(occ, mask.grid, x + PAD, y + PAD)) {
        // Found a band with room — refine to the lowest-left position inside it.
        const y0 = Math.max(0, y - st + 1)
        for (let fy = y0; fy <= y; fy++) {
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
