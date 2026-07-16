import { describe, expect, it } from 'vitest'
import { parseDxf } from '../src/dxf/parse'
import { writeDxf } from '../src/dxf/write'
import type { Entity } from '../src/dxf/types'

function dxfOf(entityLines: string[]): string {
  return ['0', 'SECTION', '2', 'ENTITIES', ...entityLines, '0', 'ENDSEC', '0', 'EOF'].join('\n')
}

describe('dxf parser', () => {
  it('parses LINE, CIRCLE, ARC', () => {
    const text = dxfOf([
      '0', 'LINE', '8', 'cut', '10', '0', '20', '0', '11', '10', '21', '5',
      '0', 'CIRCLE', '8', 'cut', '10', '3', '20', '4', '40', '2.5',
      '0', 'ARC', '8', 'cut', '10', '0', '20', '0', '40', '5', '50', '0', '51', '90',
    ])
    const { entities } = parseDxf(text)
    expect(entities).toHaveLength(3)
    expect(entities[0]).toMatchObject({ type: 'LINE', layer: 'cut', a: { x: 0, y: 0 }, b: { x: 10, y: 5 } })
    expect(entities[1]).toMatchObject({ type: 'CIRCLE', center: { x: 3, y: 4 }, r: 2.5 })
    const arc = entities[2] as Extract<Entity, { type: 'ARC' }>
    expect(arc.start).toBeCloseTo(0)
    expect(arc.end).toBeCloseTo(Math.PI / 2)
  })

  it('parses LWPOLYLINE with bulge and closed flag', () => {
    const text = dxfOf([
      '0', 'LWPOLYLINE', '8', '0', '90', '4', '70', '1',
      '10', '0', '20', '0',
      '10', '10', '20', '0', '42', '1',
      '10', '10', '20', '10',
      '10', '0', '20', '10',
    ])
    const { entities } = parseDxf(text)
    expect(entities).toHaveLength(1)
    const pl = entities[0] as Extract<Entity, { type: 'POLYLINE' }>
    expect(pl.closed).toBe(true)
    expect(pl.verts).toHaveLength(4)
    expect(pl.verts[1].bulge).toBe(1)
  })

  it('expands INSERT with rotation and scale', () => {
    const text = [
      '0', 'SECTION', '2', 'BLOCKS',
      '0', 'BLOCK', '2', 'B1', '10', '0', '20', '0',
      '0', 'LINE', '8', '0', '10', '0', '20', '0', '11', '10', '21', '0',
      '0', 'ENDBLK',
      '0', 'ENDSEC',
      '0', 'SECTION', '2', 'ENTITIES',
      '0', 'INSERT', '2', 'B1', '10', '100', '20', '50', '41', '2', '42', '2', '50', '90',
      '0', 'ENDSEC',
      '0', 'EOF',
    ].join('\n')
    const { entities } = parseDxf(text)
    expect(entities).toHaveLength(1)
    const line = entities[0] as Extract<Entity, { type: 'LINE' }>
    expect(line.a.x).toBeCloseTo(100)
    expect(line.a.y).toBeCloseTo(50)
    // (10,0) scaled x2 then rotated 90° => (0, 20) offset.
    expect(line.b.x).toBeCloseTo(100)
    expect(line.b.y).toBeCloseTo(70)
  })

  it('roundtrips through the writer', () => {
    const entities: Entity[] = [
      { type: 'LINE', layer: 'a', a: { x: 0, y: 0 }, b: { x: 5, y: 5 } },
      { type: 'CIRCLE', layer: 'a', center: { x: 1, y: 2 }, r: 3 },
      {
        type: 'POLYLINE',
        layer: 'b',
        closed: true,
        verts: [
          { x: 0, y: 0, bulge: 0 },
          { x: 10, y: 0, bulge: 0.5 },
          { x: 10, y: 10, bulge: 0 },
        ],
      },
    ]
    const text = writeDxf([{ entities, origin: { x: 0, y: 0 }, theta: 0, mirror: false, t: { x: 0, y: 0 } }], {
      mergeLines: false,
      mergeTol: 0.01,
      curveTol: 0.05,
    })
    const { entities: back } = parseDxf(text)
    expect(back).toHaveLength(3)
    expect(back.map((e) => e.type).sort()).toEqual(['CIRCLE', 'LINE', 'POLYLINE'])
    const pl = back.find((e) => e.type === 'POLYLINE') as Extract<Entity, { type: 'POLYLINE' }>
    expect(pl.closed).toBe(true)
    expect(pl.verts[1].bulge).toBeCloseTo(0.5)
  })

  it('merge option deduplicates coincident segments', () => {
    const entities: Entity[] = [
      { type: 'LINE', layer: 'a', a: { x: 0, y: 0 }, b: { x: 10, y: 0 } },
      { type: 'LINE', layer: 'a', a: { x: 10, y: 0 }, b: { x: 0, y: 0 } }, // reversed duplicate
      { type: 'LINE', layer: 'a', a: { x: 0, y: 5 }, b: { x: 10, y: 5 } },
    ]
    const text = writeDxf([{ entities, origin: { x: 0, y: 0 }, theta: 0, mirror: false, t: { x: 0, y: 0 } }], {
      mergeLines: true,
      mergeTol: 0.05,
      curveTol: 0.05,
    })
    const { entities: back } = parseDxf(text)
    expect(back.filter((e) => e.type === 'LINE')).toHaveLength(2)
  })

  it('applies placement transforms on export', () => {
    const entities: Entity[] = [{ type: 'LINE', layer: 'a', a: { x: 10, y: 10 }, b: { x: 20, y: 10 } }]
    const text = writeDxf(
      [{ entities, origin: { x: 10, y: 10 }, theta: Math.PI / 2, mirror: false, t: { x: 100, y: 100 } }],
      { mergeLines: false, mergeTol: 0.01, curveTol: 0.05 },
    )
    const { entities: back } = parseDxf(text)
    const line = back[0] as Extract<Entity, { type: 'LINE' }>
    expect(line.a.x).toBeCloseTo(100)
    expect(line.a.y).toBeCloseTo(100)
    expect(line.b.x).toBeCloseTo(100)
    expect(line.b.y).toBeCloseTo(110)
  })
})
