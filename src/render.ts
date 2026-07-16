import type { Pt } from './geom'
import type { Part } from './parts'
import type { NestResult } from './nest/nester'

export function partColor(id: number, alpha = 0.55): string {
  const hue = (id * 137.508) % 360
  return `hsla(${hue.toFixed(1)}, 65%, 58%, ${alpha})`
}

export interface View {
  k: number
  x: number
  y: number
}

export class CanvasView {
  readonly canvas: HTMLCanvasElement
  view: View = { k: 1, x: 0, y: 0 }
  private draw: () => void

  constructor(canvas: HTMLCanvasElement, draw: (ctx: CanvasRenderingContext2D, view: View) => void) {
    this.canvas = canvas
    this.draw = () => {
      const ctx = canvas.getContext('2d')!
      const dpr = window.devicePixelRatio || 1
      const w = canvas.clientWidth
      const h = canvas.clientHeight
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr)
        canvas.height = Math.round(h * dpr)
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, w, h)
      draw(ctx, this.view)
    }
    let dragging = false
    let lx = 0
    let ly = 0
    canvas.addEventListener('pointerdown', (e) => {
      dragging = true
      lx = e.clientX
      ly = e.clientY
      canvas.setPointerCapture(e.pointerId)
    })
    canvas.addEventListener('pointermove', (e) => {
      if (!dragging) return
      this.view.x += e.clientX - lx
      this.view.y += e.clientY - ly
      lx = e.clientX
      ly = e.clientY
      this.request()
    })
    canvas.addEventListener('pointerup', () => (dragging = false))
    canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault()
        const rect = canvas.getBoundingClientRect()
        const mx = e.clientX - rect.left
        const my = e.clientY - rect.top
        const f = Math.exp(-e.deltaY * 0.0015)
        this.view.x = mx - (mx - this.view.x) * f
        this.view.y = my - (my - this.view.y) * f
        this.view.k *= f
        this.request()
      },
      { passive: false },
    )
    new ResizeObserver(() => this.request()).observe(canvas)
  }

  private raf = 0
  request(): void {
    if (this.raf) return
    this.raf = requestAnimationFrame(() => {
      this.raf = 0
      this.draw()
    })
  }

  /** Fit a world-space bbox (y up) into the canvas with padding. */
  fit(minX: number, minY: number, maxX: number, maxY: number): void {
    const w = this.canvas.clientWidth
    const h = this.canvas.clientHeight
    const bw = Math.max(maxX - minX, 1e-9)
    const bh = Math.max(maxY - minY, 1e-9)
    const k = Math.min((w * 0.9) / bw, (h * 0.9) / bh)
    this.view.k = k
    this.view.x = w / 2 - k * (minX + bw / 2)
    this.view.y = h / 2 + k * (minY + bh / 2)
    this.request()
  }

  /** Convert world (y up) to screen. */
  toScreen(p: Pt): Pt {
    return { x: this.view.x + this.view.k * p.x, y: this.view.y - this.view.k * p.y }
  }
}

function tracePoly(ctx: CanvasRenderingContext2D, view: View, pts: Pt[], close: boolean, map?: (p: Pt) => Pt): void {
  for (let i = 0; i < pts.length; i++) {
    const q = map ? map(pts[i]) : pts[i]
    const sx = view.x + view.k * q.x
    const sy = view.y - view.k * q.y
    if (i === 0) ctx.moveTo(sx, sy)
    else ctx.lineTo(sx, sy)
  }
  if (close) ctx.closePath()
}

export function drawPartShape(
  ctx: CanvasRenderingContext2D,
  view: View,
  part: Part,
  map: (p: Pt) => Pt,
  fill: string,
  stroke: string,
): void {
  if (part.rings.length) {
    ctx.beginPath()
    for (const ring of part.rings) tracePoly(ctx, view, ring, true, map)
    ctx.fillStyle = fill
    ctx.fill('evenodd')
    ctx.strokeStyle = stroke
    ctx.lineWidth = 1.2
    ctx.stroke()
  }
  if (part.opens.length) {
    ctx.beginPath()
    for (const open of part.opens) tracePoly(ctx, view, open, false, map)
    ctx.strokeStyle = stroke
    ctx.lineWidth = 1
    ctx.stroke()
  }
}

export interface SheetLayout {
  /** World-space x offset of each sheet (sheets are laid side by side). */
  offsets: number[]
  gapBetween: number
  totalW: number
  totalH: number
}

export function layoutSheets(result: NestResult): SheetLayout {
  const n = result.sheets.length
  const gapBetween = Math.max(result.sheetW * 0.06, 10 * result.resolution, 5)
  const offsets: number[] = []
  let x = 0
  let totalH = 0
  for (let i = 0; i < n; i++) {
    offsets.push(x)
    const w = result.sheetH != null ? result.sheetW : Math.max(result.sheets[i].usedW, result.sheetW * 0.05)
    x += w + gapBetween
    totalH = Math.max(totalH, result.sheetH ?? result.sheets[i].usedH)
  }
  return { offsets, gapBetween, totalW: Math.max(x - gapBetween, 1e-9), totalH }
}
