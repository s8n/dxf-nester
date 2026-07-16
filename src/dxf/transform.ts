import { sampleArc, sampleBulge, sampleEllipse, sampleSpline, TAU } from '../geom'
import type { Pt } from '../geom'
import type { Entity, PolyVertex } from './types'

/**
 * Conformal transform applied to an entity, in this order:
 *   q = R(theta) * ( scale * Mirror(p - pre) ) + t
 * Mirror flips x (x -> -x). Entities that cannot be transformed natively
 * (ellipse under mirror) are converted to a sampled POLYLINE.
 */
export interface TransformSpec {
  pre?: Pt
  mirror?: boolean
  theta?: number
  scale?: number
  t?: Pt
}

export function xfPt(p: Pt, spec: TransformSpec): Pt {
  const pre = spec.pre ?? { x: 0, y: 0 }
  const s = spec.scale ?? 1
  let x = (p.x - pre.x) * s
  let y = (p.y - pre.y) * s
  if (spec.mirror) x = -x
  const th = spec.theta ?? 0
  if (th) {
    const c = Math.cos(th)
    const sn = Math.sin(th)
    const rx = x * c - y * sn
    y = x * sn + y * c
    x = rx
  }
  const t = spec.t ?? { x: 0, y: 0 }
  return { x: x + t.x, y: y + t.y }
}

function norm(a: number): number {
  a %= TAU
  if (a < 0) a += TAU
  return a
}

export function transformEntity(e: Entity, spec: TransformSpec, curveTol: number): Entity {
  const s = spec.scale ?? 1
  const th = spec.theta ?? 0
  const m = !!spec.mirror
  switch (e.type) {
    case 'LINE':
      return { type: 'LINE', layer: e.layer, a: xfPt(e.a, spec), b: xfPt(e.b, spec) }
    case 'CIRCLE':
      return { type: 'CIRCLE', layer: e.layer, center: xfPt(e.center, spec), r: e.r * s }
    case 'ARC': {
      const center = xfPt(e.center, spec)
      // Mirroring maps angle a -> PI - a and reverses direction, so swap ends.
      const start = m ? norm(th + Math.PI - e.end) : norm(e.start + th)
      const end = m ? norm(th + Math.PI - e.start) : norm(e.end + th)
      return { type: 'ARC', layer: e.layer, center, r: e.r * s, start, end }
    }
    case 'POLYLINE': {
      const verts: PolyVertex[] = e.verts.map((v) => {
        const q = xfPt(v, spec)
        return { x: q.x, y: q.y, bulge: m ? -v.bulge : v.bulge }
      })
      return { type: 'POLYLINE', layer: e.layer, closed: e.closed, verts }
    }
    case 'ELLIPSE': {
      if (m) {
        const pts = sampleEllipse(e.center, e.major, e.ratio, e.start, e.end, curveTol).map((p) => xfPt(p, spec))
        const closed = Math.abs(norm(e.end - e.start)) < 1e-9 || Math.abs(e.end - e.start - TAU) < 1e-6
        return {
          type: 'POLYLINE',
          layer: e.layer,
          closed,
          verts: pts.map((p) => ({ x: p.x, y: p.y, bulge: 0 })),
        }
      }
      const c = Math.cos(th)
      const sn = Math.sin(th)
      const major = { x: (e.major.x * c - e.major.y * sn) * s, y: (e.major.x * sn + e.major.y * c) * s }
      return { type: 'ELLIPSE', layer: e.layer, center: xfPt(e.center, spec), major, ratio: e.ratio, start: e.start, end: e.end }
    }
    case 'SPLINE': {
      // B-splines are affine-invariant: transforming control points is exact.
      return {
        type: 'SPLINE',
        layer: e.layer,
        degree: e.degree,
        closed: e.closed,
        ctrl: e.ctrl.map((p) => xfPt(p, spec)),
        knots: e.knots.slice(),
        weights: e.weights?.slice(),
      }
    }
  }
}

/** Arbitrary affine map (used for non-uniform INSERT scales): samples curves first. */
export function transformEntityAffine(e: Entity, map: (p: Pt) => Pt, curveTol: number): Entity {
  if (e.type === 'LINE') return { type: 'LINE', layer: e.layer, a: map(e.a), b: map(e.b) }
  if (e.type === 'SPLINE') {
    return { ...e, ctrl: e.ctrl.map(map), knots: e.knots.slice(), weights: e.weights?.slice() }
  }
  const sampled = sampleEntityPoints(e, curveTol)
  return {
    type: 'POLYLINE',
    layer: e.layer,
    closed: sampled.closed,
    verts: sampled.pts.map((p) => {
      const q = map(p)
      return { x: q.x, y: q.y, bulge: 0 }
    }),
  }
}

export function sampleEntityPoints(e: Entity, tol: number): { pts: Pt[]; closed: boolean } {
  switch (e.type) {
    case 'LINE':
      return { pts: [e.a, e.b], closed: false }
    case 'CIRCLE':
      return { pts: dedupeClosed(sampleArc(e.center, e.r, 0, TAU, tol)), closed: true }
    case 'ARC':
      return { pts: sampleArc(e.center, e.r, e.start, e.end, tol), closed: false }
    case 'POLYLINE': {
      const pts: Pt[] = []
      const n = e.verts.length
      if (n === 0) return { pts, closed: false }
      const segCount = e.closed ? n : n - 1
      pts.push({ x: e.verts[0].x, y: e.verts[0].y })
      for (let i = 0; i < segCount; i++) {
        const v = e.verts[i]
        const w = e.verts[(i + 1) % n]
        const seg = sampleBulge({ x: v.x, y: v.y }, { x: w.x, y: w.y }, v.bulge, tol)
        for (let j = 1; j < seg.length; j++) pts.push(seg[j])
      }
      if (e.closed && pts.length > 1) pts.pop() // drop duplicated first point
      return { pts, closed: e.closed }
    }
    case 'ELLIPSE': {
      const sweep = Math.abs(e.end - e.start)
      const closed = sweep < 1e-9 || Math.abs(sweep - TAU) < 1e-6
      const pts = sampleEllipse(e.center, e.major, e.ratio, e.start, closed ? e.start + TAU : e.end, tol)
      return { pts: closed ? dedupeClosed(pts) : pts, closed }
    }
    case 'SPLINE': {
      const n = Math.max(24, e.ctrl.length * 8)
      let pts = sampleSpline(e.ctrl, e.degree, e.knots, e.weights, n)
      let closed = e.closed
      if (!closed && pts.length > 2) {
        const a = pts[0]
        const b = pts[pts.length - 1]
        closed = Math.hypot(a.x - b.x, a.y - b.y) < 1e-6
      }
      if (closed) pts = dedupeClosed(pts)
      return { pts, closed }
    }
  }
}

function dedupeClosed(pts: Pt[]): Pt[] {
  if (pts.length > 1) {
    const a = pts[0]
    const b = pts[pts.length - 1]
    if (Math.hypot(a.x - b.x, a.y - b.y) < 1e-9) return pts.slice(0, -1)
  }
  return pts
}
