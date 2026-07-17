import type { Pt } from '../geom'

/** Row-major bitmap with 32 pixels per word, used as occupancy grid and part masks. */
export class BitGrid {
  readonly w: number
  readonly words: number
  h: number
  data: Uint32Array

  constructor(w: number, h: number) {
    this.w = Math.max(1, w)
    this.words = (this.w + 31) >> 5
    this.h = Math.max(1, h)
    this.data = new Uint32Array(this.words * this.h)
  }

  ensureRows(h: number): void {
    if (h <= this.h) return
    const nh = Math.max(h, this.h * 2, 64)
    const nd = new Uint32Array(this.words * nh)
    nd.set(this.data)
    this.data = nd
    this.h = nh
  }

  set(x: number, y: number): void {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return
    this.data[y * this.words + (x >> 5)] |= 1 << (x & 31)
  }

  get(x: number, y: number): number {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return 0
    return (this.data[y * this.words + (x >> 5)] >>> (x & 31)) & 1
  }

  fillSpan(y: number, x0: number, x1: number): void {
    if (y < 0 || y >= this.h) return
    x0 = Math.max(0, x0)
    x1 = Math.min(this.w - 1, x1)
    if (x0 > x1) return
    const row = y * this.words
    const w0 = x0 >> 5
    const w1 = x1 >> 5
    const first = 0xffffffff << (x0 & 31)
    const lastBits = x1 & 31
    const last = lastBits === 31 ? 0xffffffff : (1 << (lastBits + 1)) - 1
    if (w0 === w1) {
      this.data[row + w0] |= first & last
      return
    }
    this.data[row + w0] |= first
    for (let i = w0 + 1; i < w1; i++) this.data[row + i] = 0xffffffff
    this.data[row + w1] |= last
  }

  popcount(): number {
    let n = 0
    for (let i = 0; i < this.data.length; i++) {
      let v = this.data[i]
      v -= (v >>> 1) & 0x55555555
      v = (v & 0x33333333) + ((v >>> 2) & 0x33333333)
      n += (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24
    }
    return n
  }
}

/**
 * Rasterize a part: closed rings filled with the even-odd rule (holes stay empty so
 * other parts can nest inside them), plus a 1px conservative stroke along every
 * ring and open chain so sub-pixel features never disappear.
 * Points are expected in local units with bbox min at (0,0); scale = pixels per unit.
 */
export function rasterize(rings: Pt[][], opens: Pt[][], scale: number, w: number, h: number): BitGrid {
  const grid = new BitGrid(w, h)
  // Even-odd scanline fill across all rings.
  const xs: number[] = []
  for (let y = 0; y < h; y++) {
    const sy = (y + 0.5) / scale
    xs.length = 0
    for (const ring of rings) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const a = ring[j]
        const b = ring[i]
        if (a.y > sy !== b.y > sy) {
          xs.push(a.x + ((sy - a.y) * (b.x - a.x)) / (b.y - a.y))
        }
      }
    }
    if (xs.length < 2) continue
    xs.sort((p, q) => p - q)
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const x0 = Math.ceil(xs[k] * scale - 0.5)
      const x1 = Math.floor(xs[k + 1] * scale - 0.5)
      grid.fillSpan(y, x0, x1)
    }
  }
  // Conservative outline strokes.
  const px = (v: number) => Math.round(v * scale - 0.5)
  const stroke = (pts: Pt[], closed: boolean) => {
    const n = pts.length
    const segs = closed ? n : n - 1
    for (let i = 0; i < segs; i++) {
      const a = pts[i]
      const b = pts[(i + 1) % n]
      line(grid, px(a.x), px(a.y), px(b.x), px(b.y))
    }
  }
  for (const r of rings) stroke(r, true)
  for (const o of opens) stroke(o, false)
  return grid
}

function line(grid: BitGrid, x0: number, y0: number, x1: number, y1: number): void {
  const clamp = (v: number, hi: number) => (v < 0 ? 0 : v > hi ? hi : v)
  x0 = clamp(x0, grid.w - 1)
  x1 = clamp(x1, grid.w - 1)
  y0 = clamp(y0, grid.h - 1)
  y1 = clamp(y1, grid.h - 1)
  let dx = Math.abs(x1 - x0)
  let dy = -Math.abs(y1 - y0)
  const sx = x0 < x1 ? 1 : -1
  const sy = y0 < y1 ? 1 : -1
  let err = dx + dy
  for (;;) {
    grid.set(x0, y0)
    if (x0 === x1 && y0 === y1) break
    const e2 = 2 * err
    if (e2 >= dy) {
      err += dy
      x0 += sx
    }
    if (e2 <= dx) {
      err += dx
      y0 += sy
    }
  }
}

/** Morphological dilation by a (2g+1)² square kernel; result is padded by g on all sides. */
export function dilate(src: BitGrid, g: number): BitGrid {
  const out = new BitGrid(src.w + 2 * g, src.h + 2 * g)
  orInto(out, src, g, g)
  if (g <= 0) return out
  const words = out.words
  // Horizontal: g passes of row |= row<<1 | row>>1.
  for (let pass = 0; pass < g; pass++) {
    for (let y = 0; y < out.h; y++) {
      const base = y * words
      let carryL = 0 // for <<1, carries the top bit of the previous (lower) word
      let prevTop = 0
      // <<1 pass (left to right)
      for (let i = 0; i < words; i++) {
        const v = out.data[base + i]
        prevTop = v >>> 31
        out.data[base + i] = v | ((v << 1) | carryL)
        carryL = prevTop
      }
      // >>1 pass (right to left)
      let carryR = 0
      for (let i = words - 1; i >= 0; i--) {
        const v = out.data[base + i]
        const bottom = v & 1
        out.data[base + i] = v | ((v >>> 1) | (carryR << 31))
        carryR = bottom
      }
    }
  }
  // Vertical: g passes of row |= rowAbove | rowBelow (using the previous pass snapshot).
  let prev = out.data
  for (let pass = 0; pass < g; pass++) {
    const cur = prev.slice()
    for (let y = 0; y < out.h; y++) {
      const base = y * words
      if (y > 0) {
        const up = (y - 1) * words
        for (let i = 0; i < words; i++) cur[base + i] |= prev[up + i]
      }
      if (y + 1 < out.h) {
        const dn = (y + 1) * words
        for (let i = 0; i < words; i++) cur[base + i] |= prev[dn + i]
      }
    }
    prev = cur
  }
  out.data = prev
  return out
}

/**
 * Test whether `mask` placed with its origin at (ox, oy) overlaps set bits of `occ`.
 * Requires 0 <= ox, ox + mask.w <= occ.w, and occ.h >= oy + mask.h.
 */
export function collide(occ: BitGrid, mask: BitGrid, ox: number, oy: number): boolean {
  const s = ox & 31
  const wi = ox >> 5
  const mw = mask.words
  const ow = occ.words
  const mdata = mask.data
  const odata = occ.data
  for (let my = 0; my < mask.h; my++) {
    const mbase = my * mw
    const obase = (oy + my) * ow + wi
    let carry = 0
    for (let i = 0; i < mw; i++) {
      const m = mdata[mbase + i]
      if (s === 0) {
        if (m & odata[obase + i]) return true
      } else {
        const bits = (m << s) | carry
        if (bits & odata[obase + i]) return true
        carry = m >>> (32 - s)
      }
    }
    if (carry && carry & odata[obase + mw]) return true
  }
  return false
}

/**
 * Count set bits of `mask` (placed at ox, oy) that coincide with set bits of `occ`.
 * Same bounds requirements as collide().
 */
export function overlapCount(occ: BitGrid, mask: BitGrid, ox: number, oy: number): number {
  const s = ox & 31
  const wi = ox >> 5
  const mw = mask.words
  const ow = occ.words
  const mdata = mask.data
  const odata = occ.data
  let n = 0
  for (let my = 0; my < mask.h; my++) {
    const mbase = my * mw
    const obase = (oy + my) * ow + wi
    let carry = 0
    for (let i = 0; i < mw; i++) {
      const m = mdata[mbase + i]
      let v: number
      if (s === 0) {
        v = m & odata[obase + i]
      } else {
        v = ((m << s) | carry) & odata[obase + i]
        carry = m >>> (32 - s)
      }
      if (v) {
        v -= (v >>> 1) & 0x55555555
        v = (v & 0x33333333) + ((v >>> 2) & 0x33333333)
        n += (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24
      }
    }
    if (carry) {
      let v = carry & odata[obase + mw]
      if (v) {
        v -= (v >>> 1) & 0x55555555
        v = (v & 0x33333333) + ((v >>> 2) & 0x33333333)
        n += (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24
      }
    }
  }
  return n
}

/** OR `src` into `dst` at (ox, oy). Same bounds requirements as collide(). */
export function orInto(dst: BitGrid, src: BitGrid, ox: number, oy: number): void {
  const s = ox & 31
  const wi = ox >> 5
  const sw = src.words
  const dw = dst.words
  dst.ensureRows(oy + src.h)
  for (let sy = 0; sy < src.h; sy++) {
    const sbase = sy * sw
    const dbase = (oy + sy) * dw + wi
    let carry = 0
    for (let i = 0; i < sw; i++) {
      const m = src.data[sbase + i]
      if (s === 0) {
        dst.data[dbase + i] |= m
      } else {
        dst.data[dbase + i] |= (m << s) | carry
        carry = m >>> (32 - s)
      }
    }
    if (carry) dst.data[dbase + sw] |= carry
  }
}
