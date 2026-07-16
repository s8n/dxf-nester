import { beforeEach, describe, expect, it } from 'vitest'
import { buildParts, resetPartIds } from '../src/parts'
import type { Entity } from '../src/dxf/types'

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

const opts = { joinTol: 0.01, curveTol: 0.02 }

beforeEach(() => resetPartIds())

describe('part detection', () => {
  it('chains four lines into one closed part', () => {
    const parts = buildParts('t', [L(0, 0, 10, 0), L(10, 0, 10, 10), L(10, 10, 0, 10), L(0, 10, 0, 0)], {
      ...opts,
      mode: 'auto',
    })
    expect(parts).toHaveLength(1)
    expect(parts[0].rings).toHaveLength(1)
    expect(parts[0].area).toBeCloseTo(100, 3)
    expect(parts[0].width).toBeCloseTo(10)
    expect(parts[0].height).toBeCloseTo(10)
  })

  it('chains lines out of order and reversed', () => {
    const parts = buildParts('t', [L(10, 0, 10, 10), L(0, 10, 10, 10), L(0, 0, 10, 0), L(0, 0, 0, 10)], {
      ...opts,
      mode: 'auto',
    })
    expect(parts).toHaveLength(1)
    expect(parts[0].area).toBeCloseTo(100, 3)
  })

  it('auto mode: contained circle becomes a hole', () => {
    const parts = buildParts('t', [C(5, 5, 5), C(5, 5, 2)], { ...opts, mode: 'auto' })
    expect(parts).toHaveLength(1)
    expect(parts[0].rings).toHaveLength(2)
    // Net area = big minus small.
    expect(parts[0].area).toBeCloseTo(Math.PI * 25 - Math.PI * 4, 0)
  })

  it('auto mode: loop inside a hole becomes its own part', () => {
    const parts = buildParts('t', [C(5, 5, 5), C(5, 5, 3), C(5, 5, 1)], { ...opts, mode: 'auto' })
    expect(parts).toHaveLength(2)
  })

  it('loop mode: every closed loop is separate', () => {
    const parts = buildParts('t', [C(5, 5, 5), C(5, 5, 2)], { ...opts, mode: 'loop' })
    expect(parts).toHaveLength(2)
  })

  it('layer mode groups per layer', () => {
    const parts = buildParts('t', [C(0, 0, 2, 'A'), C(10, 0, 2, 'A'), C(20, 0, 2, 'B')], { ...opts, mode: 'layer' })
    expect(parts).toHaveLength(2)
    const a = parts.find((p) => p.name.includes('layer A'))!
    expect(a.rings).toHaveLength(2)
  })

  it('entity mode splits everything', () => {
    const parts = buildParts('t', [C(5, 5, 5), C(5, 5, 2), L(0, 0, 1, 1)], { ...opts, mode: 'entity' })
    expect(parts).toHaveLength(3)
  })

  it('keeps open chains as parts', () => {
    const parts = buildParts('t', [L(0, 0, 10, 0), L(10, 0, 10, 10)], { ...opts, mode: 'auto' })
    expect(parts).toHaveLength(1)
    expect(parts[0].rings).toHaveLength(0)
    expect(parts[0].opens).toHaveLength(1)
  })

  it('attaches engraving lines inside a loop to that part', () => {
    const parts = buildParts('t', [C(5, 5, 5), L(4, 5, 6, 5)], { ...opts, mode: 'auto' })
    expect(parts).toHaveLength(1)
    expect(parts[0].opens).toHaveLength(1)
  })
})
