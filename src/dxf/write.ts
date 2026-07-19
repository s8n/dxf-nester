import type { Pt } from '../geom'
import { TAU } from '../geom'
import type { Entity, PolyVertex } from './types'
import { sampleEntityPoints, transformEntity } from './transform'

export interface PlacedGroup {
  entities: Entity[]
  /** Part-local origin subtracted before rotating (world coords of the part's bbox min). */
  origin: Pt
  theta: number
  mirror: boolean
  /** Final translation applied after rotation. */
  t: Pt
  /** Optional source-layer -> output-layer renames (e.g. one layer per part). */
  layerMap?: Record<string, string>
}

export interface WriteOptions {
  /** Explode polylines and drop duplicate coincident segments (for common-line cutting). */
  mergeLines: boolean
  /** Coordinate tolerance used when matching coincident segments. */
  mergeTol: number
  curveTol: number
}

export function writeDxf(groups: PlacedGroup[], opts: WriteOptions): string {
  let entities: Entity[] = []
  for (const g of groups) {
    for (const e of g.entities) {
      const t = transformEntity(e, { pre: g.origin, mirror: g.mirror, theta: g.theta, t: g.t }, opts.curveTol)
      const renamed = g.layerMap?.[t.layer]
      if (renamed != null) t.layer = renamed
      entities.push(t)
    }
  }
  if (opts.mergeLines) entities = mergeCoincident(explode(entities), opts.mergeTol)

  const out: string[] = []
  const push = (code: number, value: string | number) => {
    out.push(String(code), typeof value === 'number' ? fmt(value) : value)
  }
  push(0, 'SECTION')
  push(2, 'HEADER')
  push(9, '$ACADVER')
  push(1, 'AC1009')
  push(0, 'ENDSEC')
  writeLayerTable(push, entities)
  push(0, 'SECTION')
  push(2, 'ENTITIES')
  for (const e of entities) writeEntity(push, e, opts.curveTol)
  push(0, 'ENDSEC')
  push(0, 'EOF')
  return out.join('\n') + '\n'
}

/** ACI colors cycled over layers: visually distinct, no white/black (7). */
const LAYER_COLORS = [1, 3, 5, 2, 4, 6, 30, 90, 210, 40, 130, 200, 11, 96, 176, 21]

/**
 * Emit a TABLES section declaring every layer the entities use, each with its
 * own color. Importers like LightBurn map DXF layers to their own layers, so
 * declared, color-coded layers make per-part selection and per-layer settings
 * straightforward.
 */
function writeLayerTable(push: (c: number, v: string | number) => void, entities: Entity[]): void {
  const layers: string[] = []
  const seen = new Set<string>()
  for (const e of entities) {
    if (!seen.has(e.layer)) {
      seen.add(e.layer)
      layers.push(e.layer)
    }
  }
  push(0, 'SECTION')
  push(2, 'TABLES')
  push(0, 'TABLE')
  push(2, 'LTYPE')
  push(70, 1)
  push(0, 'LTYPE')
  push(2, 'CONTINUOUS')
  push(70, 64)
  push(3, 'Solid line')
  push(72, 65)
  push(73, 0)
  push(40, 0)
  push(0, 'ENDTAB')
  push(0, 'TABLE')
  push(2, 'LAYER')
  push(70, layers.length)
  for (let i = 0; i < layers.length; i++) {
    push(0, 'LAYER')
    push(2, layers[i])
    push(70, 64)
    push(62, LAYER_COLORS[i % LAYER_COLORS.length])
    push(6, 'CONTINUOUS')
  }
  push(0, 'ENDTAB')
  push(0, 'ENDSEC')
}

function fmt(v: number): string {
  if (!Number.isFinite(v)) return '0'
  const s = v.toFixed(6)
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s
}

function writeEntity(push: (c: number, v: string | number) => void, e: Entity, curveTol: number): void {
  switch (e.type) {
    case 'LINE':
      push(0, 'LINE')
      push(8, e.layer)
      push(10, e.a.x)
      push(20, e.a.y)
      push(30, 0)
      push(11, e.b.x)
      push(21, e.b.y)
      push(31, 0)
      return
    case 'CIRCLE':
      push(0, 'CIRCLE')
      push(8, e.layer)
      push(10, e.center.x)
      push(20, e.center.y)
      push(30, 0)
      push(40, e.r)
      return
    case 'ARC':
      push(0, 'ARC')
      push(8, e.layer)
      push(10, e.center.x)
      push(20, e.center.y)
      push(30, 0)
      push(40, e.r)
      push(50, (e.start * 180) / Math.PI)
      push(51, (e.end * 180) / Math.PI)
      return
    case 'POLYLINE':
      push(0, 'POLYLINE')
      push(8, e.layer)
      push(66, 1)
      push(70, e.closed ? 1 : 0)
      for (const v of e.verts) {
        push(0, 'VERTEX')
        push(8, e.layer)
        push(10, v.x)
        push(20, v.y)
        push(30, 0)
        if (v.bulge) push(42, v.bulge)
      }
      push(0, 'SEQEND')
      return
    case 'ELLIPSE':
    case 'SPLINE': {
      // R12 has no ellipse/spline entity — emit a sampled polyline.
      const sampled = samplePolyline(e, curveTol)
      if (sampled) writeEntity(push, sampled, curveTol)
      return
    }
  }
}

function samplePolyline(e: Entity, tol: number): Entity | null {
  const { pts, closed } = sampleEntityPoints(e, tol)
  if (pts.length < 2) return null
  return {
    type: 'POLYLINE',
    layer: e.layer,
    closed,
    verts: pts.map((p) => ({ x: p.x, y: p.y, bulge: 0 })),
  }
}

/** Break polylines into individual LINE/ARC entities so duplicates can be dropped. */
function explode(entities: Entity[]): Entity[] {
  const out: Entity[] = []
  for (const e of entities) {
    if (e.type !== 'POLYLINE') {
      out.push(e)
      continue
    }
    const n = e.verts.length
    const segCount = e.closed ? n : n - 1
    for (let i = 0; i < segCount; i++) {
      const v = e.verts[i]
      const w = e.verts[(i + 1) % n]
      if (v.bulge) {
        const arc = bulgeToArc(v, w, v.bulge)
        if (arc) {
          out.push({ type: 'ARC', layer: e.layer, ...arc })
          continue
        }
      }
      out.push({ type: 'LINE', layer: e.layer, a: { x: v.x, y: v.y }, b: { x: w.x, y: w.y } })
    }
  }
  return out
}

function bulgeToArc(p1: PolyVertex, p2: PolyVertex, bulge: number): { center: Pt; r: number; start: number; end: number } | null {
  const theta = 4 * Math.atan(bulge)
  const chord = Math.hypot(p2.x - p1.x, p2.y - p1.y)
  if (chord < 1e-12) return null
  const r = Math.abs(chord / (2 * Math.sin(theta / 2)))
  const d = Math.sqrt(Math.max(0, r * r - (chord * chord) / 4)) * (Math.abs(theta) > Math.PI ? -1 : 1)
  const nx = -(p2.y - p1.y) / chord
  const ny = (p2.x - p1.x) / chord
  const s = bulge > 0 ? 1 : -1
  const cx = (p1.x + p2.x) / 2 + nx * d * s
  const cy = (p1.y + p2.y) / 2 + ny * d * s
  let a0 = Math.atan2(p1.y - cy, p1.x - cx)
  let a1 = Math.atan2(p2.y - cy, p2.x - cx)
  // DXF arcs are CCW from start to end; a CW bulge swaps endpoints.
  if (bulge < 0) [a0, a1] = [a1, a0]
  return { center: { x: cx, y: cy }, r, start: norm(a0), end: norm(a1) }
}

function norm(a: number): number {
  a %= TAU
  if (a < 0) a += TAU
  return a
}

function mergeCoincident(entities: Entity[], tol: number): Entity[] {
  const q = (v: number) => Math.round(v / Math.max(tol, 1e-9))
  const seen = new Set<string>()
  const out: Entity[] = []
  for (const e of entities) {
    let key: string | null = null
    if (e.type === 'LINE') {
      const a = `${q(e.a.x)},${q(e.a.y)}`
      const b = `${q(e.b.x)},${q(e.b.y)}`
      if (a === b) continue // zero-length
      key = a < b ? `L:${a}|${b}` : `L:${b}|${a}`
    } else if (e.type === 'ARC') {
      key = `A:${q(e.center.x)},${q(e.center.y)},${q(e.r)},${Math.round((e.start * 180) / Math.PI)},${Math.round((e.end * 180) / Math.PI)}`
    } else if (e.type === 'CIRCLE') {
      key = `C:${q(e.center.x)},${q(e.center.y)},${q(e.r)}`
    }
    if (key) {
      if (seen.has(key)) continue
      seen.add(key)
    }
    out.push(e)
  }
  return out
}
