import type { BBox, Pt } from './geom'
import { bboxOf, emptyBBox, pointInPolygon, polygonArea } from './geom'
import type { Entity } from './dxf/types'
import { sampleEntityPoints } from './dxf/transform'

/**
 * How source entities are grouped into nestable parts:
 *  - 'auto':   chain entities into loops; a loop contained in another becomes a hole
 *              of that part (alternating), loops inside holes become new parts.
 *  - 'layer':  everything on one layer moves as a single rigid part.
 *  - 'loop':   every closed loop is its own part — contained loops are NOT holes,
 *              they nest independently.
 *  - 'entity': every DXF entity is its own part (no chaining at all).
 */
export type GroupingMode = 'auto' | 'layer' | 'loop' | 'entity'

export interface Part {
  id: number
  name: string
  source: string
  entities: Entity[]
  /** Closed loops, part-local coords (origin at bbox min). Filled with even-odd rule. */
  rings: Pt[][]
  /** Open chains (engraving lines etc.), part-local coords. */
  opens: Pt[][]
  /** World position of the part's bbox min; local = world - origin. */
  origin: Pt
  width: number
  height: number
  /** Net material area (outer minus holes). */
  area: number
  count: number
}

export interface BuildOptions {
  mode: GroupingMode
  joinTol: number
  curveTol: number
}

interface Loop {
  pts: Pt[]
  entities: Entity[]
  closed: boolean
}

let nextPartId = 1

export function resetPartIds(): void {
  nextPartId = 1
}

export function buildParts(source: string, entities: Entity[], opts: BuildOptions): Part[] {
  const drafts: { rings: Loop[]; opens: Loop[]; name?: string }[] = []

  if (opts.mode === 'entity') {
    // No chaining at all — every entity stands alone.
    for (const e of entities) {
      const { pts, closed } = sampleEntityPoints(e, opts.curveTol)
      if (pts.length < 2) continue
      const loop: Loop = { pts, entities: [e], closed }
      drafts.push(closed && pts.length >= 3 ? { rings: [loop], opens: [] } : { rings: [], opens: [loop] })
    }
    return finalizeParts(source, drafts)
  }

  const loops = buildLoops(entities, opts)
  if (opts.mode === 'loop') {
    for (const l of loops.closed) drafts.push({ rings: [l], opens: [] })
    for (const l of loops.open) drafts.push({ rings: [], opens: [l] })
  } else if (opts.mode === 'layer') {
    const byLayer = new Map<string, { rings: Loop[]; opens: Loop[] }>()
    const get = (layer: string) => {
      let d = byLayer.get(layer)
      if (!d) byLayer.set(layer, (d = { rings: [], opens: [] }))
      return d
    }
    for (const l of loops.closed) get(l.entities[0]?.layer ?? '0').rings.push(l)
    for (const l of loops.open) get(l.entities[0]?.layer ?? '0').opens.push(l)
    for (const [layer, d] of byLayer) drafts.push({ ...d, name: layer })
  } else {
    // 'auto': containment tree over closed loops.
    const rings = loops.closed
      .map((l) => ({ loop: l, area: Math.abs(polygonArea(l.pts)), parent: -1, depth: 0 }))
      .sort((a, b) => b.area - a.area)
    for (let i = 0; i < rings.length; i++) {
      // Smallest enclosing ring = last one in descending order that contains us.
      for (let j = 0; j < i; j++) {
        if (rings[j].area <= rings[i].area) continue
        if (pointInPolygon(rings[i].loop.pts[0], rings[j].loop.pts)) rings[i].parent = j
      }
      rings[i].depth = rings[i].parent >= 0 ? rings[rings[i].parent].depth + 1 : 0
    }
    const partOfRing = new Map<number, number>() // ring index -> draft index
    for (let i = 0; i < rings.length; i++) {
      if (rings[i].depth % 2 === 0) {
        partOfRing.set(i, drafts.length)
        drafts.push({ rings: [rings[i].loop], opens: [] })
      } else {
        const d = drafts[partOfRing.get(rings[i].parent)!]
        d.rings.push(rings[i].loop)
        partOfRing.set(i, partOfRing.get(rings[i].parent)!)
      }
    }
    // Open chains ride along with the innermost loop that contains them.
    for (const open of loops.open) {
      const probe = open.pts[Math.floor(open.pts.length / 2)]
      let best = -1
      for (let i = 0; i < rings.length; i++) {
        if (pointInPolygon(probe, rings[i].loop.pts)) {
          if (best < 0 || rings[i].area < rings[best].area) best = i
        }
      }
      if (best >= 0) drafts[partOfRing.get(best)!].opens.push(open)
      else drafts.push({ rings: [], opens: [open] })
    }
  }

  return finalizeParts(source, drafts)
}

function finalizeParts(source: string, drafts: { rings: Loop[]; opens: Loop[]; name?: string }[]): Part[] {
  const parts: Part[] = []
  let idx = 0
  for (const d of drafts) {
    idx++
    const all = [...d.rings, ...d.opens]
    if (all.length === 0) continue
    const box = emptyBBox()
    for (const l of all) bboxOf(l.pts, box)
    if (!Number.isFinite(box.minX)) continue
    const origin = { x: box.minX, y: box.minY }
    const shift = (pts: Pt[]) => pts.map((p) => ({ x: p.x - origin.x, y: p.y - origin.y }))
    const rings = d.rings.map((l) => shift(l.pts)).filter((r) => r.length >= 3)
    const opens = d.opens.map((l) => shift(l.pts)).filter((r) => r.length >= 2)
    if (rings.length === 0 && opens.length === 0) continue
    parts.push({
      id: nextPartId++,
      name: d.name !== undefined ? `${source} · layer ${d.name}` : `${source} · ${idx}`,
      source,
      entities: dedupeEntities(all.flatMap((l) => l.entities)),
      rings,
      opens,
      origin,
      width: box.maxX - box.minX,
      height: box.maxY - box.minY,
      area: evenOddArea(rings, opens, box),
      count: 1,
    })
  }
  return parts
}

function dedupeEntities(entities: Entity[]): Entity[] {
  const seen = new Set<Entity>()
  const out: Entity[] = []
  for (const e of entities) {
    if (seen.has(e)) continue
    seen.add(e)
    out.push(e)
  }
  return out
}

/** Net area under the even-odd rule via a containment/parity pass over this part's rings. */
function evenOddArea(rings: Pt[][], opens: Pt[][], box: BBox): number {
  const info = rings
    .map((pts) => ({ pts, area: Math.abs(polygonArea(pts)) }))
    .sort((a, b) => b.area - a.area)
  let total = 0
  for (let i = 0; i < info.length; i++) {
    let depth = 0
    for (let j = 0; j < i; j++) {
      if (info[j].area > info[i].area && pointInPolygon(info[i].pts[0], info[j].pts)) depth++
    }
    total += depth % 2 === 0 ? info[i].area : -info[i].area
  }
  if (total <= 0) {
    // Open-only "part": fall back to its bbox footprint so sorting/utilization behave.
    total = Math.max(1e-9, (box.maxX - box.minX) * (box.maxY - box.minY) * 0.25)
  }
  return total
}

interface LoopSets {
  closed: Loop[]
  open: Loop[]
}

/** Sample all entities and chain open ones whose endpoints coincide into loops. */
export function buildLoops(entities: Entity[], opts: BuildOptions): LoopSets {
  const closed: Loop[] = []
  interface Edge {
    pts: Pt[]
    entity: Entity
    n0: number
    n1: number
    used: boolean
  }
  const edges: Edge[] = []
  const nodeIds = new Map<string, number>()
  let nodeCount = 0
  const tol = Math.max(opts.joinTol, 1e-9)
  const nodeOf = (p: Pt): number => {
    const key = `${Math.round(p.x / tol)},${Math.round(p.y / tol)}`
    let id = nodeIds.get(key)
    if (id === undefined) nodeIds.set(key, (id = nodeCount++))
    return id
  }

  for (const e of entities) {
    const { pts, closed: isClosed } = sampleEntityPoints(e, opts.curveTol)
    if (pts.length < 2) continue
    if (isClosed) {
      if (pts.length >= 3) closed.push({ pts, entities: [e], closed: true })
      continue
    }
    const n0 = nodeOf(pts[0])
    const n1 = nodeOf(pts[pts.length - 1])
    edges.push({ pts, entity: e, n0, n1, used: false })
  }

  // Node -> incident edges.
  const incident = new Map<number, Edge[]>()
  for (const e of edges) {
    for (const n of [e.n0, e.n1]) {
      let list = incident.get(n)
      if (!list) incident.set(n, (list = []))
      list.push(e)
    }
  }

  const open: Loop[] = []
  const takeNext = (node: number): Edge | null => {
    const list = incident.get(node)
    if (!list) return null
    const candidates = list.filter((e) => !e.used)
    // Only continue through unambiguous (degree-2) junctions.
    return candidates.length === 1 ? candidates[0] : null
  }

  for (const seed of edges) {
    if (seed.used) continue
    seed.used = true
    // Chain as an ordered list of directed edges.
    const chainPts: Pt[] = seed.pts.slice()
    const chainEnts: Entity[] = [seed.entity]
    let startNode = seed.n0
    let endNode = seed.n1
    // Extend forward.
    for (;;) {
      if (endNode === startNode) break
      const nxt = takeNext(endNode)
      if (!nxt) break
      nxt.used = true
      const forward = nxt.n0 === endNode
      const pts = forward ? nxt.pts : nxt.pts.slice().reverse()
      for (let i = 1; i < pts.length; i++) chainPts.push(pts[i])
      chainEnts.push(nxt.entity)
      endNode = forward ? nxt.n1 : nxt.n0
    }
    // Extend backward.
    for (;;) {
      if (endNode === startNode) break
      const prv = takeNext(startNode)
      if (!prv) break
      prv.used = true
      const forward = prv.n1 === startNode
      const pts = forward ? prv.pts : prv.pts.slice().reverse()
      for (let i = pts.length - 2; i >= 0; i--) chainPts.unshift(pts[i])
      chainEnts.push(prv.entity)
      startNode = forward ? prv.n0 : prv.n1
    }
    if (endNode === startNode && chainPts.length > 3) {
      chainPts.pop() // last point coincides with first
      closed.push({ pts: chainPts, entities: chainEnts, closed: true })
    } else {
      open.push({ pts: chainPts, entities: chainEnts, closed: false })
    }
  }

  return { closed, open }
}
