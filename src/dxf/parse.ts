import type { Pt } from '../geom'
import type { Entity, PolyVertex } from './types'
import { transformEntity, transformEntityAffine, xfPt } from './transform'

interface Pair {
  code: number
  value: string
}

interface InsertEntity {
  type: 'INSERT'
  layer: string
  block: string
  at: Pt
  sx: number
  sy: number
  rotation: number // radians
  cols: number
  rows: number
  colSpacing: number
  rowSpacing: number
}

type ParsedEntity = Entity | InsertEntity

interface Block {
  base: Pt
  entities: ParsedEntity[]
}

export interface ParseResult {
  entities: Entity[]
  warnings: string[]
}

const CURVE_TOL = 0.01 // only used for degenerate transform fallbacks during parsing

export function parseDxf(text: string): ParseResult {
  const pairs = tokenize(text)
  const warnings: string[] = []
  const blocks = new Map<string, Block>()
  const top: ParsedEntity[] = []
  const skipped = new Map<string, number>()

  let i = 0
  const n = pairs.length
  while (i < n) {
    const p = pairs[i]
    if (p.code === 0 && p.value === 'SECTION') {
      const name = i + 1 < n && pairs[i + 1].code === 2 ? pairs[i + 1].value : ''
      i += 2
      if (name === 'ENTITIES') {
        i = parseEntityList(pairs, i, 'ENDSEC', top, skipped)
      } else if (name === 'BLOCKS') {
        i = parseBlocks(pairs, i, blocks, skipped)
      } else {
        while (i < n && !(pairs[i].code === 0 && pairs[i].value === 'ENDSEC')) i++
      }
    }
    i++
  }

  for (const [type, count] of skipped) warnings.push(`Skipped ${count}× unsupported entity ${type}`)

  const out: Entity[] = []
  expandInto(out, top, blocks, 0, warnings)
  if (out.length === 0) warnings.push('No usable entities found (supported: LINE, ARC, CIRCLE, LWPOLYLINE, POLYLINE, ELLIPSE, SPLINE, INSERT)')
  return { entities: out, warnings }
}

function tokenize(text: string): Pair[] {
  const lines = text.split(/\r\n|\r|\n/)
  const pairs: Pair[] = []
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = parseInt(lines[i].trim(), 10)
    if (Number.isNaN(code)) continue
    pairs.push({ code, value: lines[i + 1].trim() })
  }
  return pairs
}

function parseBlocks(pairs: Pair[], i: number, blocks: Map<string, Block>, skipped: Map<string, number>): number {
  const n = pairs.length
  while (i < n && !(pairs[i].code === 0 && pairs[i].value === 'ENDSEC')) {
    if (pairs[i].code === 0 && pairs[i].value === 'BLOCK') {
      i++
      let name = ''
      const base: Pt = { x: 0, y: 0 }
      while (i < n && pairs[i].code !== 0) {
        const p = pairs[i]
        if (p.code === 2) name = p.value
        else if (p.code === 10) base.x = parseFloat(p.value)
        else if (p.code === 20) base.y = parseFloat(p.value)
        i++
      }
      const ents: ParsedEntity[] = []
      i = parseEntityList(pairs, i, 'ENDBLK', ents, skipped)
      if (name) blocks.set(name, { base, entities: ents })
    }
    i++
  }
  return i
}

/** Parses entities until pairs[i] is (0, terminator). Returns index of the terminator. */
function parseEntityList(pairs: Pair[], i: number, terminator: string, out: ParsedEntity[], skipped: Map<string, number>): number {
  const n = pairs.length
  while (i < n) {
    const p = pairs[i]
    if (p.code !== 0) {
      i++
      continue
    }
    if (p.value === terminator) return i
    const type = p.value
    // Collect this entity's pairs (POLYLINE also swallows VERTEX/SEQEND).
    const start = i + 1
    let end = start
    while (end < n && pairs[end].code !== 0) end++
    let next = end
    let entity: ParsedEntity | null = null
    switch (type) {
      case 'LINE':
        entity = parseLine(pairs, start, end)
        break
      case 'CIRCLE':
        entity = parseCircle(pairs, start, end, false)
        break
      case 'ARC':
        entity = parseCircle(pairs, start, end, true)
        break
      case 'LWPOLYLINE':
        entity = parseLwPolyline(pairs, start, end)
        break
      case 'POLYLINE': {
        const res = parsePolyline(pairs, start, n)
        entity = res.entity
        next = res.next
        break
      }
      case 'ELLIPSE':
        entity = parseEllipseEnt(pairs, start, end)
        break
      case 'SPLINE':
        entity = parseSplineEnt(pairs, start, end)
        break
      case 'INSERT':
        entity = parseInsert(pairs, start, end)
        break
      case 'POINT':
      case 'VERTEX':
      case 'SEQEND':
        break // silently ignore
      default:
        skipped.set(type, (skipped.get(type) ?? 0) + 1)
    }
    if (entity) out.push(applyOcs(entity, pairs, start, end))
    i = next
  }
  return i
}

/** Handle extrusion direction (210/220/230): Z=-1 mirrors X in world coords. */
function applyOcs(e: ParsedEntity, pairs: Pair[], start: number, end: number): ParsedEntity {
  let nz = 1
  for (let i = start; i < end; i++) if (pairs[i].code === 230) nz = parseFloat(pairs[i].value)
  if (nz >= 0 || e.type === 'INSERT') return e
  return transformEntity(e, { mirror: true }, CURVE_TOL)
}

function grab(pairs: Pair[], start: number, end: number): Map<number, number> {
  const m = new Map<number, number>()
  for (let i = start; i < end; i++) {
    const v = parseFloat(pairs[i].value)
    if (!m.has(pairs[i].code)) m.set(pairs[i].code, v)
  }
  return m
}

function layerOf(pairs: Pair[], start: number, end: number): string {
  for (let i = start; i < end; i++) if (pairs[i].code === 8) return pairs[i].value
  return '0'
}

function parseLine(pairs: Pair[], s: number, e: number): Entity | null {
  const m = grab(pairs, s, e)
  if (!m.has(10) || !m.has(11)) return null
  return {
    type: 'LINE',
    layer: layerOf(pairs, s, e),
    a: { x: m.get(10)!, y: m.get(20) ?? 0 },
    b: { x: m.get(11)!, y: m.get(21) ?? 0 },
  }
}

function parseCircle(pairs: Pair[], s: number, e: number, isArc: boolean): Entity | null {
  const m = grab(pairs, s, e)
  const r = m.get(40)
  if (!m.has(10) || r === undefined || r <= 0) return null
  const center = { x: m.get(10)!, y: m.get(20) ?? 0 }
  const layer = layerOf(pairs, s, e)
  if (!isArc) return { type: 'CIRCLE', layer, center, r }
  const start = ((m.get(50) ?? 0) * Math.PI) / 180
  const end = ((m.get(51) ?? 360) * Math.PI) / 180
  return { type: 'ARC', layer, center, r, start, end }
}

function parseLwPolyline(pairs: Pair[], s: number, e: number): Entity | null {
  const verts: PolyVertex[] = []
  let closed = false
  for (let i = s; i < e; i++) {
    const p = pairs[i]
    if (p.code === 70) closed = (parseInt(p.value, 10) & 1) === 1
    else if (p.code === 10) verts.push({ x: parseFloat(p.value), y: 0, bulge: 0 })
    else if (p.code === 20 && verts.length) verts[verts.length - 1].y = parseFloat(p.value)
    else if (p.code === 42 && verts.length) verts[verts.length - 1].bulge = parseFloat(p.value)
  }
  if (verts.length < 2) return null
  return { type: 'POLYLINE', layer: layerOf(pairs, s, e), closed, verts }
}

function parsePolyline(pairs: Pair[], s: number, n: number): { entity: Entity | null; next: number } {
  // Header pairs.
  let i = s
  let closed = false
  let is3dOrMesh = false
  let layer = '0'
  while (i < n && pairs[i].code !== 0) {
    const p = pairs[i]
    if (p.code === 8) layer = p.value
    else if (p.code === 70) {
      const f = parseInt(p.value, 10)
      closed = (f & 1) === 1
      if (f & (8 | 16 | 64)) is3dOrMesh = true
    }
    i++
  }
  const verts: PolyVertex[] = []
  while (i < n && pairs[i].code === 0 && pairs[i].value === 'VERTEX') {
    i++
    let x = 0
    let y = 0
    let bulge = 0
    let isControl = false
    while (i < n && pairs[i].code !== 0) {
      const p = pairs[i]
      if (p.code === 10) x = parseFloat(p.value)
      else if (p.code === 20) y = parseFloat(p.value)
      else if (p.code === 42) bulge = parseFloat(p.value)
      else if (p.code === 70 && parseInt(p.value, 10) & (16 | 8)) isControl = true
      i++
    }
    if (!isControl) verts.push({ x, y, bulge })
  }
  if (i < n && pairs[i].code === 0 && pairs[i].value === 'SEQEND') {
    i++
    while (i < n && pairs[i].code !== 0) i++
  }
  if (is3dOrMesh || verts.length < 2) return { entity: null, next: i }
  return { entity: { type: 'POLYLINE', layer, closed, verts }, next: i }
}

function parseEllipseEnt(pairs: Pair[], s: number, e: number): Entity | null {
  const m = grab(pairs, s, e)
  if (!m.has(10) || !m.has(11)) return null
  return {
    type: 'ELLIPSE',
    layer: layerOf(pairs, s, e),
    center: { x: m.get(10)!, y: m.get(20) ?? 0 },
    major: { x: m.get(11)!, y: m.get(21) ?? 0 },
    ratio: m.get(40) ?? 1,
    start: m.get(41) ?? 0,
    end: m.get(42) ?? Math.PI * 2,
  }
}

function parseSplineEnt(pairs: Pair[], s: number, e: number): Entity | null {
  const ctrl: Pt[] = []
  const knots: number[] = []
  const weights: number[] = []
  let degree = 3
  let closed = false
  for (let i = s; i < e; i++) {
    const p = pairs[i]
    if (p.code === 71) degree = parseInt(p.value, 10)
    else if (p.code === 70) closed = (parseInt(p.value, 10) & 1) === 1
    else if (p.code === 40) knots.push(parseFloat(p.value))
    else if (p.code === 41) weights.push(parseFloat(p.value))
    else if (p.code === 10) ctrl.push({ x: parseFloat(p.value), y: 0 })
    else if (p.code === 20 && ctrl.length) ctrl[ctrl.length - 1].y = parseFloat(p.value)
  }
  if (ctrl.length < 2) return null
  return {
    type: 'SPLINE',
    layer: layerOf(pairs, s, e),
    degree,
    closed,
    ctrl,
    knots,
    weights: weights.length === ctrl.length ? weights : undefined,
  }
}

function parseInsert(pairs: Pair[], s: number, e: number): InsertEntity | null {
  const m = grab(pairs, s, e)
  let block = ''
  for (let i = s; i < e; i++) if (pairs[i].code === 2) block = pairs[i].value
  if (!block) return null
  return {
    type: 'INSERT',
    layer: layerOf(pairs, s, e),
    block,
    at: { x: m.get(10) ?? 0, y: m.get(20) ?? 0 },
    sx: m.get(41) ?? 1,
    sy: m.get(42) ?? 1,
    rotation: ((m.get(50) ?? 0) * Math.PI) / 180,
    cols: Math.max(1, Math.round(m.get(70) ?? 1)),
    rows: Math.max(1, Math.round(m.get(71) ?? 1)),
    colSpacing: m.get(44) ?? 0,
    rowSpacing: m.get(45) ?? 0,
  }
}

function expandInto(out: Entity[], list: ParsedEntity[], blocks: Map<string, Block>, depth: number, warnings: string[]): void {
  if (depth > 8) {
    warnings.push('INSERT nesting deeper than 8 levels — truncated')
    return
  }
  for (const e of list) {
    if (e.type !== 'INSERT') {
      out.push(e)
      continue
    }
    const block = blocks.get(e.block)
    if (!block) {
      if (!e.block.startsWith('*')) warnings.push(`INSERT references missing block "${e.block}"`)
      continue
    }
    // Expand the block once (recursively), then stamp per grid cell.
    const inner: Entity[] = []
    expandInto(inner, block.entities, blocks, depth + 1, warnings)
    const cos = Math.cos(e.rotation)
    const sin = Math.sin(e.rotation)
    for (let row = 0; row < e.rows; row++) {
      for (let col = 0; col < e.cols; col++) {
        // Column/row offsets apply in the insert's rotated frame.
        const ox = col * e.colSpacing
        const oy = row * e.rowSpacing
        const t = { x: e.at.x + ox * cos - oy * sin, y: e.at.y + ox * sin + oy * cos }
        const conformal = Math.abs(Math.abs(e.sx) - Math.abs(e.sy)) < 1e-9 && e.sx !== 0
        for (const child of inner) {
          if (conformal) {
            const scale = Math.abs(e.sx)
            const mirror = e.sx < 0 !== e.sy < 0
            const theta = e.rotation + (e.sy < 0 ? Math.PI : 0)
            out.push(transformEntity(child, { pre: block.base, mirror, theta, scale, t }, CURVE_TOL))
          } else {
            const map = (p: Pt): Pt => {
              const x = (p.x - block.base.x) * e.sx
              const y = (p.y - block.base.y) * e.sy
              return { x: t.x + x * cos - y * sin, y: t.y + x * sin + y * cos }
            }
            out.push(transformEntityAffine(child, map, CURVE_TOL))
          }
        }
      }
    }
  }
}
