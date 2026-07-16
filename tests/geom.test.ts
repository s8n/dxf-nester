import { describe, expect, it } from 'vitest'
import { pointInPolygon, polygonArea, sampleArc, sampleBulge } from '../src/geom'

describe('geom', () => {
  it('computes signed polygon area', () => {
    const sq = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ]
    expect(polygonArea(sq)).toBeCloseTo(100)
    expect(polygonArea([...sq].reverse())).toBeCloseTo(-100)
  })

  it('point in polygon (even-odd)', () => {
    const sq = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ]
    expect(pointInPolygon({ x: 5, y: 5 }, sq)).toBe(true)
    expect(pointInPolygon({ x: 15, y: 5 }, sq)).toBe(false)
  })

  it('samples full circles', () => {
    const pts = sampleArc({ x: 0, y: 0 }, 5, 0, Math.PI * 2, 0.01)
    expect(pts.length).toBeGreaterThan(16)
    for (const p of pts) expect(Math.hypot(p.x, p.y)).toBeCloseTo(5, 6)
  })

  it('samples bulge arcs on the correct side', () => {
    // bulge = +1: CCW semicircle from (0,0) to (10,0) around center (5,0),
    // i.e. from angle 180° CCW through 270° to 360° — it passes through (5,-5).
    const pts = sampleBulge({ x: 0, y: 0 }, { x: 10, y: 0 }, 1, 0.01)
    expect(pts[0]).toEqual({ x: 0, y: 0 })
    expect(pts[pts.length - 1]).toEqual({ x: 10, y: 0 })
    // All points on the circle of radius 5 around (5, 0).
    for (const p of pts) expect(Math.hypot(p.x - 5, p.y)).toBeCloseTo(5, 6)
    // The arc apex must be at (5, -5): a positive bulge sweeps CCW, i.e. below a +x chord.
    const lowest = pts.reduce((m, p) => (p.y < m.y ? p : m))
    expect(lowest.y).toBeCloseTo(-5, 1)
    expect(lowest.x).toBeCloseTo(5, 0)
  })

  it('negative bulge mirrors the arc side', () => {
    const pos = sampleBulge({ x: 0, y: 0 }, { x: 10, y: 0 }, 1, 0.01)
    const neg = sampleBulge({ x: 0, y: 0 }, { x: 10, y: 0 }, -1, 0.01)
    const midPos = pos[Math.floor(pos.length / 2)]
    const midNeg = neg[Math.floor(neg.length / 2)]
    expect(Math.sign(midPos.y)).toBe(-Math.sign(midNeg.y))
  })
})
