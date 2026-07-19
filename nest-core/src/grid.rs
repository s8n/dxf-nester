//! Bit-grid primitives: a row-major 32-bit-word bitmap used as occupancy grid
//! and part masks, plus rasterization, dilation and the skip-reporting
//! collision test. Direct port of src/nest/raster.ts — every operation mirrors
//! the JS semantics exactly (u32 bit ops, Math.round = round-half-up) so the
//! WASM engine reproduces the TS engine's results bit for bit.

#[derive(Clone, Copy)]
pub struct Pt {
    pub x: f64,
    pub y: f64,
}

/// JS Math.round: round half toward +Infinity (Rust's f64::round differs on -0.5).
#[inline]
pub fn js_round(v: f64) -> f64 {
    (v + 0.5).floor()
}

pub struct BitGrid {
    pub w: usize,
    pub words: usize,
    pub h: usize,
    pub data: Vec<u32>,
}

impl BitGrid {
    pub fn new(w: usize, h: usize) -> BitGrid {
        let w = w.max(1);
        let words = (w + 31) >> 5;
        let h = h.max(1);
        BitGrid { w, words, h, data: vec![0; words * h] }
    }

    pub fn ensure_rows(&mut self, h: usize) {
        if h <= self.h {
            return;
        }
        let nh = h.max(self.h * 2).max(64);
        self.data.resize(self.words * nh, 0);
        self.h = nh;
    }

    pub fn set(&mut self, x: i64, y: i64) {
        if x < 0 || y < 0 || x as usize >= self.w || y as usize >= self.h {
            return;
        }
        let (x, y) = (x as usize, y as usize);
        self.data[y * self.words + (x >> 5)] |= 1u32 << (x & 31);
    }

    pub fn get(&self, x: i64, y: i64) -> u32 {
        if x < 0 || y < 0 || x as usize >= self.w || y as usize >= self.h {
            return 0;
        }
        let (x, y) = (x as usize, y as usize);
        (self.data[y * self.words + (x >> 5)] >> (x & 31)) & 1
    }

    pub fn fill_span(&mut self, y: usize, x0: i64, x1: i64) {
        if y >= self.h {
            return;
        }
        let x0 = x0.max(0) as usize;
        let x1i = x1.min(self.w as i64 - 1);
        if x1i < 0 || x0 as i64 > x1i {
            return;
        }
        let x1 = x1i as usize;
        let row = y * self.words;
        let w0 = x0 >> 5;
        let w1 = x1 >> 5;
        let first = 0xffff_ffffu32 << (x0 & 31);
        let last_bits = x1 & 31;
        let last = if last_bits == 31 { 0xffff_ffffu32 } else { (1u32 << (last_bits + 1)) - 1 };
        if w0 == w1 {
            self.data[row + w0] |= first & last;
            return;
        }
        self.data[row + w0] |= first;
        for i in (w0 + 1)..w1 {
            self.data[row + i] = 0xffff_ffff;
        }
        self.data[row + w1] |= last;
    }
}

/// Rasterize a part: closed rings filled with the even-odd rule (holes stay
/// empty so other parts can nest inside them), plus a 1px conservative stroke
/// along every ring and open chain so sub-pixel features never disappear.
pub fn rasterize(rings: &[Vec<Pt>], opens: &[Vec<Pt>], scale: f64, w: usize, h: usize) -> BitGrid {
    let mut grid = BitGrid::new(w, h);
    let mut xs: Vec<f64> = Vec::new();
    for y in 0..h {
        let sy = (y as f64 + 0.5) / scale;
        xs.clear();
        for ring in rings {
            let n = ring.len();
            if n == 0 {
                continue;
            }
            let mut j = n - 1;
            for i in 0..n {
                let a = ring[j];
                let b = ring[i];
                if (a.y > sy) != (b.y > sy) {
                    xs.push(a.x + ((sy - a.y) * (b.x - a.x)) / (b.y - a.y));
                }
                j = i;
            }
        }
        if xs.len() < 2 {
            continue;
        }
        xs.sort_by(|p, q| p.partial_cmp(q).unwrap());
        let mut k = 0;
        while k + 1 < xs.len() {
            let x0 = (xs[k] * scale - 0.5).ceil() as i64;
            let x1 = (xs[k + 1] * scale - 0.5).floor() as i64;
            grid.fill_span(y, x0, x1);
            k += 2;
        }
    }
    // Conservative outline strokes.
    let px = |v: f64| js_round(v * scale - 0.5) as i64;
    let mut stroke = |pts: &[Pt], closed: bool| {
        let n = pts.len();
        if n == 0 {
            return;
        }
        let segs = if closed { n } else { n - 1 };
        for i in 0..segs {
            let a = pts[i];
            let b = pts[(i + 1) % n];
            line(&mut grid, px(a.x), px(a.y), px(b.x), px(b.y));
        }
    };
    for r in rings {
        stroke(r, true);
    }
    for o in opens {
        stroke(o, false);
    }
    grid
}

fn line(grid: &mut BitGrid, x0: i64, y0: i64, x1: i64, y1: i64) {
    let clamp = |v: i64, hi: i64| if v < 0 { 0 } else if v > hi { hi } else { v };
    let mut x0 = clamp(x0, grid.w as i64 - 1);
    let x1 = clamp(x1, grid.w as i64 - 1);
    let mut y0 = clamp(y0, grid.h as i64 - 1);
    let y1 = clamp(y1, grid.h as i64 - 1);
    let dx = (x1 - x0).abs();
    let dy = -(y1 - y0).abs();
    let sx = if x0 < x1 { 1 } else { -1 };
    let sy = if y0 < y1 { 1 } else { -1 };
    let mut err = dx + dy;
    loop {
        grid.set(x0, y0);
        if x0 == x1 && y0 == y1 {
            break;
        }
        let e2 = 2 * err;
        if e2 >= dy {
            err += dy;
            x0 += sx;
        }
        if e2 <= dx {
            err += dx;
            y0 += sy;
        }
    }
}

/// Morphological dilation by a (2g+1)² square kernel; result is padded by g on all sides.
pub fn dilate(src: &BitGrid, g: usize) -> BitGrid {
    let mut out = BitGrid::new(src.w + 2 * g, src.h + 2 * g);
    or_into(&mut out, src, g, g);
    if g == 0 {
        return out;
    }
    let words = out.words;
    // Horizontal: g passes of row |= row<<1 | row>>1.
    for _ in 0..g {
        for y in 0..out.h {
            let base = y * words;
            let mut carry_l = 0u32;
            // <<1 pass (left to right)
            for i in 0..words {
                let v = out.data[base + i];
                let prev_top = v >> 31;
                out.data[base + i] = v | ((v << 1) | carry_l);
                carry_l = prev_top;
            }
            // >>1 pass (right to left)
            let mut carry_r = 0u32;
            for i in (0..words).rev() {
                let v = out.data[base + i];
                let bottom = v & 1;
                out.data[base + i] = v | ((v >> 1) | (carry_r << 31));
                carry_r = bottom;
            }
        }
    }
    // Vertical: g passes of row |= rowAbove | rowBelow (using the previous pass snapshot).
    let mut prev = std::mem::take(&mut out.data);
    for _ in 0..g {
        let mut cur = prev.clone();
        for y in 0..out.h {
            let base = y * words;
            if y > 0 {
                let up = (y - 1) * words;
                for i in 0..words {
                    cur[base + i] |= prev[up + i];
                }
            }
            if y + 1 < out.h {
                let dn = (y + 1) * words;
                for i in 0..words {
                    cur[base + i] |= prev[dn + i];
                }
            }
        }
        prev = cur;
    }
    out.data = prev;
    out
}

/// Test whether `mask` placed with its origin at (ox, oy) overlaps set bits of `occ`.
/// Returns 0 when free; on collision returns a skip distance d >= 1 such that
/// placements at ox+1 .. ox+d-1 all collide too (see raster.ts for the proof).
pub fn collide(occ: &BitGrid, mask: &BitGrid, ox: usize, oy: usize) -> usize {
    let s = ox & 31;
    let wi = ox >> 5;
    let mw = mask.words;
    let ow = occ.words;
    let mdata = &mask.data;
    let odata = &occ.data;
    for my in 0..mask.h {
        let mbase = my * mw;
        let obase = (oy + my) * ow + wi;
        let mut carry = 0u32;
        let mut conf_at: isize = -1;
        let mut conf_bits = 0u32;
        for i in 0..mw {
            let m = mdata[mbase + i];
            let bits: u32;
            if s == 0 {
                bits = m;
            } else {
                bits = (m << s) | carry;
                carry = m >> (32 - s);
            }
            let conf = bits & odata[obase + i];
            if conf != 0 {
                conf_at = i as isize;
                conf_bits = conf;
            }
        }
        if carry != 0 {
            let conf = carry & odata[obase + mw];
            if conf != 0 {
                conf_at = mw as isize;
                conf_bits = conf;
            }
        }
        if conf_at < 0 {
            continue;
        }
        // Rightmost conflicting occupancy column (absolute) and the mask column on it.
        let c = (((wi as isize + conf_at) as i64) << 5) + (31 - conf_bits.leading_zeros() as i64);
        let mcol = c - ox as i64;
        // Find the highest clear mask bit m0 below mcol in this row: every position
        // ox' in (ox, c - m0) still has a set mask bit landing on cell c.
        let mut m0: i64 = -1;
        if mcol > 0 {
            let mut w2 = ((mcol - 1) >> 5) as isize;
            let top = ((mcol - 1) & 31) as u32;
            let top_mask = if top == 31 { 0xffff_ffffu32 } else { (1u32 << (top + 1)) - 1 };
            let mut inv = !mdata[mbase + w2 as usize] & top_mask;
            loop {
                if inv != 0 {
                    m0 = ((w2 as i64) << 5) + (31 - inv.leading_zeros() as i64);
                    break;
                }
                w2 -= 1;
                if w2 < 0 {
                    break;
                }
                inv = !mdata[mbase + w2 as usize];
            }
        }
        return (c - m0 - ox as i64) as usize;
    }
    0
}

/// Count set bits of `mask` (placed at ox, oy) that coincide with set bits of `occ`.
pub fn overlap_count(occ: &BitGrid, mask: &BitGrid, ox: usize, oy: usize) -> u32 {
    let s = ox & 31;
    let wi = ox >> 5;
    let mw = mask.words;
    let ow = occ.words;
    let mdata = &mask.data;
    let odata = &occ.data;
    let mut n = 0u32;
    for my in 0..mask.h {
        let mbase = my * mw;
        let obase = (oy + my) * ow + wi;
        let mut carry = 0u32;
        for i in 0..mw {
            let m = mdata[mbase + i];
            let v: u32;
            if s == 0 {
                v = m & odata[obase + i];
            } else {
                v = ((m << s) | carry) & odata[obase + i];
                carry = m >> (32 - s);
            }
            n += v.count_ones();
        }
        if carry != 0 {
            n += (carry & odata[obase + mw]).count_ones();
        }
    }
    n
}

/// OR `src` into `dst` at (ox, oy).
pub fn or_into(dst: &mut BitGrid, src: &BitGrid, ox: usize, oy: usize) {
    let s = ox & 31;
    let wi = ox >> 5;
    let sw = src.words;
    let dw = dst.words;
    dst.ensure_rows(oy + src.h);
    for sy in 0..src.h {
        let sbase = sy * sw;
        let dbase = (oy + sy) * dw + wi;
        let mut carry = 0u32;
        for i in 0..sw {
            let m = src.data[sbase + i];
            if s == 0 {
                dst.data[dbase + i] |= m;
            } else {
                dst.data[dbase + i] |= (m << s) | carry;
                carry = m >> (32 - s);
            }
        }
        if carry != 0 {
            dst.data[dbase + sw] |= carry;
        }
    }
}
