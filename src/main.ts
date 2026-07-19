import './style.css'
import type { Pt } from './geom'
import { parseDxf } from './dxf/parse'
import type { Entity } from './dxf/types'
import { writeDxf } from './dxf/write'
import type { PlacedGroup } from './dxf/write'
import { buildParts, resetPartIds } from './parts'
import type { GroupingMode, Part } from './parts'
import { betterPass, createNestContext, finalizeNest, planBalanced, planStage1 } from './nest/nester'
import type { NestContext, NestOptions, NestPart, NestResult, PassResult, PassSpec } from './nest/nester'
import { CanvasView, drawPartShape, layoutSheets, partColor } from './render'
import { demoEntities } from './demo'
import NestWorker from './nest/worker?worker'
import type { WorkerRequest, WorkerResponse } from './nest/worker'

interface LoadedFile {
  name: string
  entities: Entity[]
}

const state = {
  files: [] as LoadedFile[],
  parts: [] as Part[],
  result: null as NestResult | null,
  tab: 'parts' as 'parts' | 'nested',
  pool: null as Worker[] | null,
}

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T

const els = {
  drop: $('drop'),
  fileInput: $<HTMLInputElement>('file-input'),
  demoLink: $('demo-link'),
  partsSection: $('parts-section'),
  partsList: $('parts-list'),
  partCount: $('part-count'),
  clearParts: $('clear-parts'),
  gap: $<HTMLInputElement>('opt-gap'),
  merge: $<HTMLInputElement>('opt-merge'),
  grouping: $<HTMLSelectElement>('opt-grouping'),
  rotation: $<HTMLSelectElement>('opt-rotation'),
  mirror: $<HTMLInputElement>('opt-mirror'),
  sheetMode: $<HTMLSelectElement>('opt-sheet-mode'),
  sheetDims: $('sheet-dims'),
  marginRow: $('margin-row'),
  sheetW: $<HTMLInputElement>('opt-sheet-w'),
  sheetH: $<HTMLInputElement>('opt-sheet-h'),
  margin: $<HTMLInputElement>('opt-margin'),
  resolution: $<HTMLInputElement>('opt-resolution'),
  joinTol: $<HTMLInputElement>('opt-join-tol'),
  curveTol: $<HTMLInputElement>('opt-curve-tol'),
  mergeTol: $<HTMLInputElement>('opt-merge-tol'),
  nestBtn: $<HTMLButtonElement>('nest-btn'),
  cancelBtn: $<HTMLButtonElement>('cancel-btn'),
  busy: $('nest-busy'),
  progress: $<HTMLProgressElement>('nest-progress'),
  resultSection: $('result-section'),
  stats: $('stats'),
  downloadBtn: $<HTMLButtonElement>('download-btn'),
  messages: $('messages'),
  tabParts: $<HTMLButtonElement>('tab-parts'),
  tabNested: $<HTMLButtonElement>('tab-nested'),
  canvas: $<HTMLCanvasElement>('view'),
}

// ---------- numeric input helpers ----------

const num = (el: HTMLInputElement, fallback: number): number => {
  const v = parseFloat(el.value)
  return Number.isFinite(v) ? v : fallback
}

const buildOpts = () => ({
  mode: els.grouping.value as GroupingMode,
  joinTol: Math.max(num(els.joinTol, 0.01), 1e-9),
  curveTol: Math.max(num(els.curveTol, 0.05), 1e-4),
})

// ---------- messages ----------

function clearMessages(): void {
  els.messages.innerHTML = ''
}

function message(text: string, kind: 'info' | 'warn' | 'error' = 'info'): void {
  const div = document.createElement('div')
  div.className = `msg ${kind === 'info' ? '' : kind}`.trim()
  div.textContent = text
  els.messages.appendChild(div)
  while (els.messages.children.length > 6) els.messages.removeChild(els.messages.firstChild!)
}

// ---------- file loading & part building ----------

async function addFiles(files: FileList | File[]): Promise<void> {
  clearMessages()
  for (const f of files) {
    try {
      const text = await f.text()
      const { entities, warnings } = parseDxf(text)
      for (const w of warnings.slice(0, 3)) message(`${f.name}: ${w}`, 'warn')
      if (entities.length === 0) {
        message(`${f.name}: no supported entities found`, 'error')
        continue
      }
      state.files.push({ name: f.name.replace(/\.dxf$/i, ''), entities })
    } catch (err) {
      message(`${f.name}: ${err instanceof Error ? err.message : String(err)}`, 'error')
    }
  }
  rebuildParts()
}

function loadDemo(): void {
  clearMessages()
  state.files = state.files.filter((f) => f.name !== 'demo')
  state.files.push({ name: 'demo', entities: demoEntities() })
  rebuildParts()
}

function rebuildParts(): void {
  // Preserve counts across grouping changes where part shapes line up by name.
  const oldCounts = new Map(state.parts.map((p) => [p.name, p.count]))
  resetPartIds()
  const opts = buildOpts()
  state.parts = state.files.flatMap((f) => buildParts(f.name, f.entities, opts))
  for (const p of state.parts) p.count = oldCounts.get(p.name) ?? p.count
  state.result = null
  setTab('parts')
  syncUi()
  fitPartsView()
}

// ---------- parts list UI ----------

function syncUi(): void {
  const has = state.parts.length > 0
  els.partsSection.hidden = !has
  els.nestBtn.disabled = !has || state.pool != null
  els.partCount.textContent = String(state.parts.length)
  els.resultSection.hidden = state.result == null
  els.tabNested.disabled = state.result == null

  els.partsList.innerHTML = ''
  for (const p of state.parts) {
    const li = document.createElement('li')
    const sw = document.createElement('span')
    sw.className = 'swatch'
    sw.style.background = partColor(p.id, 0.9)
    const meta = document.createElement('div')
    meta.className = 'meta'
    const name = document.createElement('div')
    name.className = 'name'
    name.textContent = p.name
    name.title = p.name
    const dims = document.createElement('div')
    dims.className = 'dims'
    dims.textContent = `${fmt(p.width)} × ${fmt(p.height)} u`
    meta.append(name, dims)
    const count = document.createElement('input')
    count.type = 'number'
    count.min = '0'
    count.step = '1'
    count.value = String(p.count)
    count.title = 'Quantity to nest'
    count.addEventListener('change', () => {
      p.count = Math.max(0, Math.round(parseFloat(count.value) || 0))
      count.value = String(p.count)
    })
    li.append(sw, meta, count)
    els.partsList.appendChild(li)
  }
}

function fmt(v: number): string {
  return v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)
}

// ---------- canvas ----------

const canvasView = new CanvasView(els.canvas, (ctx, view) => {
  if (state.tab === 'nested' && state.result) drawNested(ctx, view)
  else drawParts(ctx, view)
})

interface PartSlot {
  part: Part
  x: number
  y: number
}

function partSlots(): { slots: PartSlot[]; w: number; h: number } {
  const slots: PartSlot[] = []
  const pad = state.parts.reduce((m, p) => Math.max(m, p.width, p.height), 10) * 0.12
  const targetW = Math.sqrt(state.parts.reduce((s, p) => s + (p.width + pad) * (p.height + pad), 0)) * 1.4
  let x = 0
  let y = 0
  let rowH = 0
  let maxW = 0
  for (const p of state.parts) {
    if (x > 0 && x + p.width > targetW) {
      x = 0
      y += rowH + pad
      rowH = 0
    }
    slots.push({ part: p, x, y })
    x += p.width + pad
    rowH = Math.max(rowH, p.height)
    maxW = Math.max(maxW, x)
  }
  return { slots, w: maxW, h: y + rowH }
}

function drawParts(ctx: CanvasRenderingContext2D, view: { k: number; x: number; y: number }): void {
  const { slots } = partSlots()
  for (const s of slots) {
    const map = (p: Pt): Pt => ({ x: p.x + s.x, y: p.y + s.y })
    drawPartShape(ctx, view, s.part, map, partColor(s.part.id, 0.45), partColor(s.part.id, 1))
    if (s.part.count !== 1) {
      const c = canvasView.toScreen({ x: s.x + s.part.width / 2, y: s.y + s.part.height / 2 })
      ctx.fillStyle = '#e6edf3'
      ctx.font = '600 13px system-ui'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(`×${s.part.count}`, c.x, c.y)
    }
  }
}

function fitPartsView(): void {
  const { w, h } = partSlots()
  if (state.parts.length) canvasView.fit(0, 0, Math.max(w, 1), Math.max(h, 1))
  canvasView.request()
}

function drawNested(ctx: CanvasRenderingContext2D, view: { k: number; x: number; y: number }): void {
  const result = state.result!
  const layout = layoutSheets(result)
  const partById = new Map(state.parts.map((p) => [p.id, p]))

  // Sheet outlines.
  for (let i = 0; i < result.sheets.length; i++) {
    const ox = layout.offsets[i]
    const w = result.sheetH != null ? result.sheetW : Math.max(result.sheets[i].usedW, 1e-6)
    const h = result.sheetH ?? result.sheets[i].usedH
    const a = canvasView.toScreen({ x: ox, y: 0 })
    const b = canvasView.toScreen({ x: ox + w, y: h })
    ctx.fillStyle = 'rgba(255,255,255,0.03)'
    ctx.strokeStyle = '#3b4759'
    ctx.lineWidth = 1
    ctx.setLineDash([6, 4])
    ctx.beginPath()
    ctx.rect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y))
    ctx.fill()
    ctx.stroke()
    ctx.setLineDash([])
    // Dimension label.
    ctx.fillStyle = '#8b98a9'
    ctx.font = '11px system-ui'
    ctx.textAlign = 'left'
    ctx.textBaseline = 'bottom'
    ctx.fillText(`sheet ${i + 1}: ${fmt(w)} × ${fmt(h)} u`, Math.min(a.x, b.x), Math.min(a.y, b.y) - 4)
  }

  for (const pl of result.placements) {
    const part = partById.get(pl.partId)
    if (!part) continue
    const cos = Math.cos(pl.theta)
    const sin = Math.sin(pl.theta)
    const ox = layout.offsets[pl.sheet] ?? 0
    const map = (p: Pt): Pt => {
      const x = pl.mirror ? -p.x : p.x
      return { x: x * cos - p.y * sin + pl.tx + ox, y: x * sin + p.y * cos + pl.ty }
    }
    drawPartShape(ctx, view, part, map, partColor(part.id, 0.45), partColor(part.id, 1))
  }
}

function fitNestedView(): void {
  if (!state.result) return
  const layout = layoutSheets(state.result)
  canvasView.fit(0, 0, layout.totalW, Math.max(layout.totalH, 1e-6))
}

function setTab(tab: 'parts' | 'nested'): void {
  state.tab = tab
  els.tabParts.classList.toggle('active', tab === 'parts')
  els.tabNested.classList.toggle('active', tab === 'nested')
  canvasView.request()
}

// ---------- nesting ----------

function nestOptions(): NestOptions {
  const mode = els.sheetMode.value
  return {
    gap: Math.max(0, num(els.gap, 0)),
    // Auto mode sizes the sheet around the parts, so an edge margin is meaningless.
    margin: mode === 'auto' ? 0 : Math.max(0, num(els.margin, 0)),
    resolution: els.resolution.value.trim() === '' ? null : Math.max(num(els.resolution, 0.5), 0.001),
    sheetWidth: mode === 'auto' ? null : Math.max(num(els.sheetW, 1000), 1),
    sheetHeight: mode === 'wh' ? Math.max(num(els.sheetH, 500), 1) : null,
    rotationStep: parseInt(els.rotation.value, 10) || 0,
    mirror: els.mirror.checked,
  }
}

function startNest(): void {
  if (state.pool || state.parts.length === 0) return
  clearMessages()
  const nestParts: NestPart[] = state.parts
    .filter((p) => p.count > 0)
    .map((p) => ({
      id: p.id,
      rings: p.rings,
      opens: p.opens,
      width: p.width,
      height: p.height,
      area: p.area,
      count: p.count,
    }))
  if (nestParts.length === 0) {
    message('All part quantities are 0, nothing to nest.', 'warn')
    return
  }
  const opts = nestOptions()
  // Planning is cheap (masks rasterize lazily inside workers); the main-thread
  // context only sizes the sheet, orders instances and finalizes the winner.
  const ctx = createNestContext(nestParts, opts)
  if (!ctx) {
    message('Nothing to nest: no usable geometry in the selected parts.', 'warn')
    return
  }
  const stage1 = planStage1(ctx)
  const poolSize = Math.max(1, Math.min((navigator.hardwareConcurrency || 4) - 1, 8, stage1.length))
  const pool: Worker[] = []
  for (let i = 0; i < poolSize; i++) {
    const w = new NestWorker()
    w.postMessage({ kind: 'init', parts: nestParts, opts } satisfies WorkerRequest)
    pool.push(w)
  }
  state.pool = pool
  els.nestBtn.disabled = true
  els.cancelBtn.hidden = false
  els.busy.hidden = false
  els.progress.hidden = false
  els.progress.value = 0
  void orchestrateNest(ctx, stage1, pool, performance.now())
}

/**
 * Fan the passes out over the worker pool: run stage 1, fold the winner in
 * spec order (deterministic — identical to the sequential nest() driver), plan
 * the balanced stage-2 passes from it, run those, finalize.
 */
async function orchestrateNest(ctx: NestContext, stage1: PassSpec[], pool: Worker[], t0: number): Promise<void> {
  const fractions: number[] = []
  let totalPasses = stage1.length
  const showProgress = () => {
    els.progress.value = fractions.reduce((s, f) => s + (f || 0), 0) / totalPasses
  }
  try {
    const r1 = await runSpecsOnPool(pool, stage1, 0, fractions, showProgress)
    if (state.pool !== pool) return // cancelled
    let best = r1[0]
    for (const pass of r1.slice(1)) if (betterPass(pass, best)) best = pass
    const stage2 = planBalanced(ctx, best)
    if (stage2.length > 0) {
      totalPasses += stage2.length
      const r2 = await runSpecsOnPool(pool, stage2, stage1.length, fractions, showProgress)
      if (state.pool !== pool) return
      for (const pass of r2) if (betterPass(pass, best)) best = pass
    }
    finishNest(finalizeNest(ctx, best), performance.now() - t0)
  } catch (err) {
    if (state.pool !== pool) return
    message(`Nesting failed: ${err instanceof Error ? err.message : String(err)}`, 'error')
    stopPool()
  }
}

/** Dispatch specs across the pool, feeding each worker a new spec as it finishes. */
function runSpecsOnPool(
  pool: Worker[],
  specs: PassSpec[],
  seqBase: number,
  fractions: number[],
  onProgress: () => void
): Promise<PassResult[]> {
  return new Promise((resolve, reject) => {
    const results = new Array<PassResult>(specs.length)
    let nextIdx = 0
    let doneCount = 0
    const feed = (w: Worker): void => {
      if (nextIdx >= specs.length) return
      const idx = nextIdx++
      w.postMessage({ kind: 'pass', seq: seqBase + idx, spec: specs[idx] } satisfies WorkerRequest)
    }
    for (const w of pool) {
      w.onmessage = (ev: MessageEvent<WorkerResponse>) => {
        const msg = ev.data
        if (msg.type === 'pass-progress') {
          fractions[msg.seq] = msg.total ? msg.done / msg.total : 0
          onProgress()
        } else if (msg.type === 'pass-done') {
          fractions[msg.seq] = 1
          onProgress()
          results[msg.seq - seqBase] = msg.pass
          doneCount++
          if (doneCount === specs.length) resolve(results)
          else feed(w)
        } else if (msg.type === 'error') {
          reject(new Error(msg.message))
        }
      }
      w.onerror = (e) => reject(new Error(e.message || 'worker crashed'))
      feed(w)
    }
  })
}

function stopPool(): void {
  if (state.pool) for (const w of state.pool) w.terminate()
  state.pool = null
  els.cancelBtn.hidden = true
  els.busy.hidden = true
  els.progress.hidden = true
  els.nestBtn.disabled = state.parts.length === 0
}

function finishNest(result: NestResult, elapsedMs: number): void {
  stopPool()
  state.result = result
  syncUi()
  showStats(result, elapsedMs)
  if (result.failures.length) {
    const names = result.failures
      .map((id) => state.parts.find((p) => p.id === id)?.name ?? `#${id}`)
      .slice(0, 4)
    message(`Could not fit: ${names.join(', ')}${result.failures.length > 4 ? '…' : ''}. Increase the sheet size or allow rotation.`, 'error')
  }
  setTab('nested')
  fitNestedView()
}

function showStats(r: NestResult, elapsedMs: number): void {
  const rows: [string, string][] = []
  const placed = r.placements.length
  const total = state.parts.reduce((s, p) => s + p.count, 0)
  rows.push(['Placed', `${placed} / ${total} parts`])
  if (r.sheetH != null) {
    rows.push(['Sheets used', `${r.sheets.length} × ${fmt(r.sheetW)} × ${fmt(r.sheetH)} u`])
  } else if (r.sheets.length === 1) {
    rows.push(['Nest size', `${fmt(r.sheets[0].usedW)} × ${fmt(r.sheets[0].usedH)} u`])
  }
  rows.push(['Material used', `${(r.utilization * 100).toFixed(1)} %`])
  rows.push(['Resolution', `${r.resolution.toFixed(3)} u/px`])
  rows.push(['Nest time', elapsedMs < 9500 ? `${(elapsedMs / 1000).toFixed(2)} s` : `${(elapsedMs / 1000).toFixed(1)} s`])
  els.stats.innerHTML = ''
  for (const [k, v] of rows) {
    const key = document.createElement('span')
    key.textContent = k
    const val = document.createElement('b')
    val.textContent = v
    els.stats.append(key, val)
  }
}

// ---------- export ----------

function download(): void {
  const result = state.result
  if (!result) return
  const layout = layoutSheets(result)
  const partById = new Map(state.parts.map((p) => [p.id, p]))
  const groups: PlacedGroup[] = []
  for (const pl of result.placements) {
    const part = partById.get(pl.partId)
    if (!part) continue
    groups.push({
      entities: part.entities,
      origin: part.origin,
      theta: pl.theta,
      mirror: pl.mirror,
      t: { x: pl.tx + (layout.offsets[pl.sheet] ?? 0), y: pl.ty },
    })
  }
  const dxf = writeDxf(groups, {
    mergeLines: els.merge.checked,
    mergeTol: Math.max(num(els.mergeTol, 0.05), 1e-6),
    curveTol: Math.max(num(els.curveTol, 0.05), 1e-4),
  })
  const blob = new Blob([dxf], { type: 'application/dxf' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = 'nested.dxf'
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 5000)
}

// ---------- events ----------

els.drop.addEventListener('click', (e) => {
  if ((e.target as HTMLElement).id !== 'demo-link') els.fileInput.click()
})
els.drop.addEventListener('dragover', (e) => {
  e.preventDefault()
  els.drop.classList.add('dragover')
})
els.drop.addEventListener('dragleave', () => els.drop.classList.remove('dragover'))
els.drop.addEventListener('drop', (e) => {
  e.preventDefault()
  els.drop.classList.remove('dragover')
  if (e.dataTransfer?.files.length) void addFiles(e.dataTransfer.files)
})
els.fileInput.addEventListener('change', () => {
  if (els.fileInput.files?.length) void addFiles(els.fileInput.files)
  els.fileInput.value = ''
})
els.demoLink.addEventListener('click', (e) => {
  e.preventDefault()
  loadDemo()
})
els.clearParts.addEventListener('click', () => {
  state.files = []
  state.parts = []
  state.result = null
  clearMessages()
  setTab('parts')
  syncUi()
  canvasView.request()
})

for (const el of [els.grouping, els.joinTol, els.curveTol]) {
  el.addEventListener('change', () => {
    if (state.files.length) rebuildParts()
  })
}

els.sheetMode.addEventListener('change', () => {
  const mode = els.sheetMode.value
  els.sheetDims.style.display = mode === 'auto' ? 'none' : ''
  els.marginRow.style.display = mode === 'auto' ? 'none' : ''
  ;(els.sheetH.parentElement!.parentElement as HTMLElement).style.visibility = mode === 'wh' ? 'visible' : 'hidden'
})
els.sheetMode.dispatchEvent(new Event('change'))

els.nestBtn.addEventListener('click', startNest)
els.cancelBtn.addEventListener('click', () => {
  stopPool()
  message('Nesting cancelled.', 'warn')
})
els.downloadBtn.addEventListener('click', download)
els.tabParts.addEventListener('click', () => {
  setTab('parts')
  fitPartsView()
})
els.tabNested.addEventListener('click', () => {
  if (state.result) {
    setTab('nested')
    fitNestedView()
  }
})

syncUi()
