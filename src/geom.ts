// Basic 2D geometry helpers + curve sampling used by the parser, nester and renderer.

export interface Pt {
  x: number
  y: number
}

export const TAU = Math.PI * 2

export function dist(a: Pt, b: Pt): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

/** Signed area (positive = CCW). */
export function polygonArea(pts: Pt[]): number {
  let s = 0
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    s += pts[j].x * pts[i].y - pts[i].x * pts[j].y
  }
  return s / 2
}

export interface BBox {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export function bboxOf(pts: Pt[], into?: BBox): BBox {
  const b = into ?? { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
  for (const p of pts) {
    if (p.x < b.minX) b.minX = p.x
    if (p.y < b.minY) b.minY = p.y
    if (p.x > b.maxX) b.maxX = p.x
    if (p.y > b.maxY) b.maxY = p.y
  }
  return b
}

export function emptyBBox(): BBox {
  return { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
}

/** Even-odd ray-cast point-in-polygon test. */
export function pointInPolygon(p: Pt, poly: Pt[]): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]
    const b = poly[j]
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside
    }
  }
  return inside
}

function arcSegments(r: number, sweep: number, tol: number): number {
  // Max angular step so the sagitta stays under `tol`.
  const clamped = Math.min(Math.max(tol, 1e-6), Math.max(r, 1e-6))
  const dmax = 2 * Math.acos(Math.max(-1, Math.min(1, 1 - clamped / Math.max(r, 1e-9))))
  return Math.max(2, Math.ceil(Math.abs(sweep) / Math.max(dmax, 0.02)))
}

/**
 * Sample a CCW arc from angle a0 to a1 (radians). A full circle is a0=0, a1=TAU.
 * Includes both endpoints.
 */
export function sampleArc(c: Pt, r: number, a0: number, a1: number, tol: number): Pt[] {
  let sweep = a1 - a0
  while (sweep <= 1e-9) sweep += TAU
  const n = arcSegments(r, sweep, tol)
  const pts: Pt[] = []
  for (let i = 0; i <= n; i++) {
    const a = a0 + (sweep * i) / n
    pts.push({ x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a) })
  }
  return pts
}

/**
 * Sample a polyline segment with bulge (bulge = tan(sweep/4), sign = CCW positive).
 * Returns points from p1 to p2 inclusive.
 */
export function sampleBulge(p1: Pt, p2: Pt, bulge: number, tol: number): Pt[] {
  if (!bulge || Math.abs(bulge) < 1e-12) return [p1, p2]
  const theta = 4 * Math.atan(bulge) // signed sweep
  const chord = dist(p1, p2)
  if (chord < 1e-12) return [p1, p2]
  const r = Math.abs(chord / (2 * Math.sin(theta / 2)))
  // Center sits on the chord's perpendicular bisector.
  const mx = (p1.x + p2.x) / 2
  const my = (p1.y + p2.y) / 2
  const d = Math.sqrt(Math.max(0, r * r - (chord * chord) / 4)) * (Math.abs(theta) > Math.PI ? -1 : 1)
  // Left normal of p1->p2; for CCW (bulge>0) center is left of the chord.
  const nx = -(p2.y - p1.y) / chord
  const ny = (p2.x - p1.x) / chord
  const s = bulge > 0 ? 1 : -1
  const cx = mx + nx * d * s
  const cy = my + ny * d * s
  const a0 = Math.atan2(p1.y - cy, p1.x - cx)
  const n = arcSegments(r, theta, tol)
  const pts: Pt[] = [p1]
  for (let i = 1; i < n; i++) {
    const a = a0 + (theta * i) / n
    pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) })
  }
  pts.push(p2)
  return pts
}

/**
 * Sample an ellipse given by center, major-axis endpoint vector, minor/major ratio
 * and start/end parameters (radians, CCW). Full ellipse: t0=0, t1=TAU.
 */
export function sampleEllipse(c: Pt, major: Pt, ratio: number, t0: number, t1: number, tol: number): Pt[] {
  const rx = Math.hypot(major.x, major.y)
  const minor = { x: -major.y * ratio, y: major.x * ratio }
  let sweep = t1 - t0
  while (sweep <= 1e-9) sweep += TAU
  const n = arcSegments(Math.max(rx, rx * ratio), sweep, tol)
  const pts: Pt[] = []
  for (let i = 0; i <= n; i++) {
    const t = t0 + (sweep * i) / n
    const ct = Math.cos(t)
    const st = Math.sin(t)
    pts.push({ x: c.x + major.x * ct + minor.x * st, y: c.y + major.y * ct + minor.y * st })
  }
  return pts
}

/** NURBS evaluation via de Boor on homogeneous coordinates. */
export function sampleSpline(
  ctrl: Pt[],
  degree: number,
  knots: number[] | undefined,
  weights: number[] | undefined,
  samples: number,
): Pt[] {
  if (ctrl.length < 2) return ctrl.slice()
  const k = Math.max(1, Math.min(degree || 3, ctrl.length - 1))
  let kn = knots && knots.length === ctrl.length + k + 1 ? knots.slice() : null
  if (!kn) {
    // Fallback: clamped uniform knot vector.
    kn = []
    for (let i = 0; i <= k; i++) kn.push(0)
    const inner = ctrl.length - k - 1
    for (let i = 1; i <= inner; i++) kn.push(i / (inner + 1))
    for (let i = 0; i <= k; i++) kn.push(1)
  }
  const w = weights && weights.length === ctrl.length ? weights : ctrl.map(() => 1)
  const t0 = kn[k]
  const t1 = kn[kn.length - 1 - k]
  if (!(t1 > t0)) return ctrl.slice()

  const out: Pt[] = []
  const px = new Float64Array(k + 1)
  const py = new Float64Array(k + 1)
  const pw = new Float64Array(k + 1)
  for (let si = 0; si <= samples; si++) {
    const t = si === samples ? t1 : t0 + ((t1 - t0) * si) / samples
    // Find knot span s with kn[s] <= t < kn[s+1].
    let s = k
    let hi = kn.length - k - 2
    while (s < hi && t >= kn[s + 1]) s++
    for (let j = 0; j <= k; j++) {
      const idx = s - k + j
      const cw = w[idx]
      px[j] = ctrl[idx].x * cw
      py[j] = ctrl[idx].y * cw
      pw[j] = cw
    }
    for (let r = 1; r <= k; r++) {
      for (let j = k; j >= r; j--) {
        const i = s - k + j
        const den = kn[i + k - r + 1] - kn[i]
        const alpha = den > 1e-12 ? (t - kn[i]) / den : 0
        px[j] = (1 - alpha) * px[j - 1] + alpha * px[j]
        py[j] = (1 - alpha) * py[j - 1] + alpha * py[j]
        pw[j] = (1 - alpha) * pw[j - 1] + alpha * pw[j]
      }
    }
    const ww = pw[k] || 1
    out.push({ x: px[k] / ww, y: py[k] / ww })
  }
  return out
}
