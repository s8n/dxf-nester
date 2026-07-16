import type { Entity } from './dxf/types'

const L = (x1: number, y1: number, x2: number, y2: number, layer = '0'): Entity => ({
  type: 'LINE',
  layer,
  a: { x: x1, y: y1 },
  b: { x: x2, y: y2 },
})

const C = (x: number, y: number, r: number, layer = '0'): Entity => ({
  type: 'CIRCLE',
  layer,
  center: { x, y },
  r,
})

function rect(x: number, y: number, w: number, h: number, layer = '0'): Entity {
  return {
    type: 'POLYLINE',
    layer,
    closed: true,
    verts: [
      { x, y, bulge: 0 },
      { x: x + w, y, bulge: 0 },
      { x: x + w, y: y + h, bulge: 0 },
      { x, y: y + h, bulge: 0 },
    ],
  }
}

/** Stadium slot (two straights + two semicircle bulges). */
function slot(x: number, y: number, len: number, r: number, layer = '0'): Entity {
  return {
    type: 'POLYLINE',
    layer,
    closed: true,
    verts: [
      { x, y: y - r, bulge: 0 },
      { x: x + len, y: y - r, bulge: 1 },
      { x: x + len, y: y + r, bulge: 0 },
      { x, y: y + r, bulge: 1 },
    ],
  }
}

function star(cx: number, cy: number, rOuter: number, rInner: number, n: number, layer = '0'): Entity {
  const verts = []
  for (let i = 0; i < n * 2; i++) {
    const r = i % 2 === 0 ? rOuter : rInner
    const a = (Math.PI * i) / n - Math.PI / 2
    verts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a), bulge: 0 })
  }
  return { type: 'POLYLINE', layer, closed: true, verts }
}

/** Demo entities exercising chaining, holes, bulges, arcs and hole-nesting. */
export function demoEntities(): Entity[] {
  const out: Entity[] = []

  // Plate with two round holes and a slot.
  out.push(rect(0, 0, 120, 80))
  out.push(C(25, 40, 11))
  out.push(C(95, 40, 11))
  out.push(slot(45, 62, 30, 5))

  // L-bracket built from individual lines (tests chaining).
  const lx = 160
  out.push(L(lx, 0, lx + 70, 0))
  out.push(L(lx + 70, 0, lx + 70, 22))
  out.push(L(lx + 70, 22, lx + 22, 22))
  out.push(L(lx + 22, 22, lx + 22, 70))
  out.push(L(lx + 22, 70, lx, 70))
  out.push(L(lx, 70, lx, 0))

  // Ring: big disc with a large hole — small parts can nest inside it.
  out.push(C(300, 45, 42))
  out.push(C(300, 45, 27))

  // Small discs (some fit into the ring's hole).
  out.push(C(380, 20, 11))
  out.push(C(380, 60, 11))

  // Star.
  out.push(star(460, 45, 34, 15, 5))

  // Triangle with an arc base (tests arc chaining).
  const tx = 520
  out.push(L(tx, 0, tx + 50, 0))
  out.push(L(tx + 50, 0, tx + 25, 45))
  out.push(L(tx + 25, 45, tx, 0))

  // Small rectangles.
  out.push(rect(600, 0, 34, 18))
  out.push(rect(600, 30, 34, 18))
  out.push(rect(600, 60, 26, 26))

  return out
}
