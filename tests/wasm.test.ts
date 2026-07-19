import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, it } from 'vitest'
import { initSync, NestSession } from '../nest-core/pkg/nest_core'
import {
  betterPass,
  createNestContext,
  finalizeNest,
  planBalanced,
  planStage1,
  runPassSpec,
} from '../src/nest/nester'
import type { NestOptions, NestPart, PassResult, PassSpec } from '../src/nest/nester'
import { parseDxf } from '../src/dxf/parse'
import { buildParts, resetPartIds } from '../src/parts'
import fancaseDxf from './fixtures/fancase.dxf?raw'

// The Rust core must be a bit-exact port of the TS engine: same instance
// ordering, same rasterization, same placements, same floats. Each scenario
// runs every planned pass through both engines and compares the raw
// PassResults structurally (JSON roundtrip normalizes -0 etc.).

beforeAll(() => {
  const bytes = readFileSync(new URL('../nest-core/pkg/nest_core_bg.wasm', import.meta.url))
  initSync({ module: bytes })
})

function rectPart(id: number, w: number, h: number, count = 1): NestPart {
  const rings = [
    [
      { x: 0, y: 0 },
      { x: w, y: 0 },
      { x: w, y: h },
      { x: 0, y: h },
    ],
  ]
  return { id, rings, opens: [], width: w, height: h, area: w * h, count }
}

/** Run the full staged flow on both engines, comparing pass-by-pass. */
function compareEngines(parts: NestPart[], opts: NestOptions): { ts: PassResult; passes: number } {
  const ctx = createNestContext(parts, opts)!
  expect(ctx).not.toBeNull()
  const session = new NestSession(JSON.stringify(parts), JSON.stringify(opts))
  expect(session.instanceCount()).toBe(ctx.instances.length)

  let passes = 0
  const runBoth = (spec: PassSpec): PassResult => {
    const ts = runPassSpec(ctx, spec)
    const wasm = JSON.parse(session.runPass(JSON.stringify(spec), undefined)) as PassResult
    expect(wasm).toEqual(JSON.parse(JSON.stringify(ts)))
    passes++
    return ts
  }

  const stage1 = planStage1(ctx).map(runBoth)
  let best = stage1[0]
  for (const pass of stage1.slice(1)) if (betterPass(pass, best)) best = pass
  for (const spec of planBalanced(ctx, best)) {
    const pass = runBoth(spec)
    if (betterPass(pass, best)) best = pass
  }
  session.free()
  return { ts: best, passes }
}

describe('wasm engine equivalence', () => {
  it('matches the TS engine on mixed rectangles (fixed sheets)', () => {
    const parts = [rectPart(1, 70, 70, 2), rectPart(2, 30, 30, 4), rectPart(3, 45, 20, 3)]
    const { passes } = compareEngines(parts, {
      gap: 0,
      margin: 0,
      resolution: 0.25,
      sheetWidth: 102,
      sheetHeight: 102,
      rotationStep: 90,
      mirror: false,
    })
    expect(passes).toBeGreaterThan(1)
  })

  it('matches the TS engine with rotation, mirror, margin and auto sheet', () => {
    const lShape: NestPart = {
      id: 1,
      rings: [
        [
          { x: 0, y: 0 },
          { x: 30, y: 0 },
          { x: 30, y: 8 },
          { x: 8, y: 8 },
          { x: 8, y: 22 },
          { x: 0, y: 22 },
        ],
      ],
      opens: [],
      width: 30,
      height: 22,
      area: 30 * 8 + 14 * 8,
      count: 4,
    }
    compareEngines([lShape, rectPart(2, 20, 12, 3)], {
      gap: 1.5,
      margin: 2,
      resolution: null,
      sheetWidth: null,
      sheetHeight: null,
      rotationStep: 45,
      mirror: true,
    })
  })

  it('matches the TS engine on the fan case fixture and packs 2 sheets', () => {
    const { entities } = parseDxf(fancaseDxf)
    resetPartIds()
    const parts = buildParts('fancase', entities, { mode: 'auto', joinTol: 0.01, curveTol: 0.05 })
    const nestParts: NestPart[] = parts.map((p) => ({
      id: p.id,
      rings: p.rings,
      opens: p.opens,
      width: p.width,
      height: p.height,
      area: p.area,
      count: p.count,
    }))
    const opts: NestOptions = {
      gap: 2,
      margin: 0,
      resolution: null,
      sheetWidth: 613,
      sheetHeight: 613,
      rotationStep: 90,
      mirror: false,
    }
    const { ts } = compareEngines(nestParts, opts)
    const ctx = createNestContext(nestParts, opts)!
    const final = finalizeNest(ctx, ts)
    expect(final.failures).toHaveLength(0)
    expect(final.placements).toHaveLength(8)
    expect(final.sheets).toHaveLength(2)
  }, 240_000)
})
