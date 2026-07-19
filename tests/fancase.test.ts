import { describe, expect, it } from 'vitest'
import fancaseDxf from './fixtures/fancase.dxf?raw'
import { parseDxf } from '../src/dxf/parse'
import { buildParts, resetPartIds } from '../src/parts'
import { nest } from '../src/nest/nester'
import type { NestPart } from '../src/nest/nester'

// Real-world regression: a fan case cut from 613x613 sheets. The file holds
// four 189x517 panels and four 517x272.5 half-frames; two half-frames enclose
// two panels, so everything fits on two sheets — but only when the parts are
// dealt to the sheets in matched groups (frame, panel, panel, frame). Greedy
// top-up used to strand the leftovers across three sheets because the balanced
// redistribution never tried fewer sheets than the greedy pass produced.
describe('fancase fixture', () => {
  it('packs the fan case onto two 613x613 sheets', () => {
    const { entities, warnings } = parseDxf(fancaseDxf)
    expect(warnings).toHaveLength(0)
    resetPartIds()
    const parts = buildParts('fancase', entities, { mode: 'auto', joinTol: 0.01, curveTol: 0.05 })
    expect(parts).toHaveLength(8)

    const nestParts: NestPart[] = parts.map((p) => ({
      id: p.id,
      rings: p.rings,
      opens: p.opens,
      width: p.width,
      height: p.height,
      area: p.area,
      count: p.count,
    }))
    const res = nest(nestParts, {
      gap: 2,
      margin: 0,
      resolution: null,
      sheetWidth: 613,
      sheetHeight: 613,
      rotationStep: 90,
      mirror: false,
    })

    expect(res.failures).toHaveLength(0)
    expect(res.placements).toHaveLength(8)
    expect(res.sheets).toHaveLength(2)

    // Each sheet pairs two half-frames (the wide, mostly-empty parts) with two
    // panels nested inside them.
    const byId = new Map(nestParts.map((p) => [p.id, p]))
    for (let si = 0; si < res.sheets.length; si++) {
      const onSheet = res.placements.filter((pl) => pl.sheet === si).map((pl) => byId.get(pl.partId)!)
      const frames = onSheet.filter((p) => p.width > p.height)
      const panels = onSheet.filter((p) => p.width < p.height)
      expect(frames).toHaveLength(2)
      expect(panels).toHaveLength(2)
    }
  }, 120_000)
})
