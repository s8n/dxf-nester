//! The nesting pass runner: a direct port of src/nest/nester.ts's
//! createNestContext + runPassSpec. Pass planning (which orders/policies to
//! try, balanced sheet distribution) stays in TypeScript — this crate receives
//! PassSpecs whose `order` indexes into the instance list, so the context here
//! must derive the exact same deterministic instance ordering as the TS side.

use crate::grid::{collide, dilate, or_into, overlap_count, rasterize, BitGrid, Pt as GPt};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::f64::consts::PI;

#[derive(Deserialize, Clone, Copy)]
pub struct Pt {
    pub x: f64,
    pub y: f64,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct NestPart {
    pub id: i32,
    pub rings: Vec<Vec<Pt>>,
    pub opens: Vec<Vec<Pt>>,
    pub width: f64,
    pub height: f64,
    pub area: f64,
    pub count: u32,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct NestOptions {
    pub gap: f64,
    pub margin: f64,
    pub resolution: Option<f64>,
    pub sheet_width: Option<f64>,
    pub sheet_height: Option<f64>,
    pub rotation_step: f64,
    pub mirror: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PassSpec {
    pub order: Vec<usize>,
    pub policy: Policy,
    #[serde(default)]
    pub assign: Option<Vec<usize>>,
}

#[derive(Deserialize, Clone, Copy, PartialEq)]
pub enum Policy {
    #[serde(rename = "bl")]
    Bl,
    #[serde(rename = "contact")]
    Contact,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Placement {
    pub part_id: i32,
    pub sheet: usize,
    pub theta: f64,
    pub mirror: bool,
    pub tx: f64,
    pub ty: f64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SheetInfo {
    pub used_w: f64,
    pub used_h: f64,
    pub placed: u32,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PassResult {
    pub placements: Vec<Placement>,
    pub sheets: Vec<SheetInfo>,
    pub placed_area: f64,
    pub stock_area: f64,
    pub used_area: f64,
    pub failures: Vec<i32>,
}

struct Mask {
    grid: BitGrid,
    w: usize,
    h: usize,
    off_x: f64,
    off_y: f64,
    w_u: f64,
    h_u: f64,
    theta: f64,
    mirror: bool,
    dilated: Option<BitGrid>,
    /// Mask dilated by gap+1 px: the "contact zone" stamped into Sheet.occ_c.
    dilated_c: Option<BitGrid>,
}

struct Sheet {
    occ: BitGrid,
    occ_c: BitGrid,
    contact_rows: usize,
    /// First empty nest-space row (px): all rows >= top_nest are guaranteed free.
    top_nest: usize,
    used_w_u: f64,
    used_h_u: f64,
    placed: u32,
}

pub struct NestContext {
    opts: NestOptions,
    rotations: Vec<f64>,
    mirrors: Vec<bool>,
    margin: f64,
    sheet_w: f64,
    sheet_h: Option<f64>,
    res: f64,
    scale: f64,
    inner_w: usize,
    inner_h: Option<usize>,
    gap_px: usize,
    pad: usize,
    pad_c: usize,
    /// Placement instances (one entry per copy, referencing `parts`), biggest first.
    instances: Vec<usize>,
    parts: Vec<NestPart>,
    mask_cache: HashMap<(i32, u64, bool), Option<usize>>,
    masks: Vec<Mask>,
}

impl NestContext {
    /// Build the shared per-nest context; None when there is nothing to place.
    /// Must mirror createNestContext() in nester.ts exactly.
    pub fn new(parts: Vec<NestPart>, opts: NestOptions) -> Option<NestContext> {
        let usable: Vec<NestPart> = parts
            .into_iter()
            .filter(|p| p.count > 0 && (!p.rings.is_empty() || !p.opens.is_empty()))
            .collect();
        if usable.is_empty() {
            return None;
        }
        let mut rotations = vec![0.0f64];
        if opts.rotation_step > 0.0 {
            // Same f64 accumulation loop as the TS code.
            let mut a = opts.rotation_step;
            while a < 360.0 - 1e-9 {
                rotations.push(a);
                a += opts.rotation_step;
            }
        }
        let mirrors: Vec<bool> = if opts.mirror { vec![false, true] } else { vec![false] };

        let mut max_part_min_w = 0.0f64;
        let mut min_part_dim = f64::INFINITY;
        let mut total_area = 0.0f64;
        for p in &usable {
            let mut best = f64::INFINITY;
            for &rot in &rotations {
                let (w, _h) = oriented_bbox(p, rot * PI / 180.0);
                if w < best {
                    best = w;
                }
            }
            max_part_min_w = max_part_min_w.max(best);
            min_part_dim = min_part_dim.min(p.width.min(p.height));
            total_area += p.area * p.count as f64;
        }

        let margin = opts.margin.max(0.0);
        let sheet_w = match opts.sheet_width {
            Some(w) => w,
            None => (total_area * 1.8).sqrt().max(max_part_min_w * 1.02 + 2.0 * opts.gap) + 2.0 * margin,
        };
        let sheet_h = if opts.sheet_width.is_some() { opts.sheet_height } else { None };
        let inner_w_u = (sheet_w - 2.0 * margin).max(1e-6);
        let inner_h_u = sheet_h.map(|h| (h - 2.0 * margin).max(1e-6));

        let mut res = opts.resolution.unwrap_or_else(|| auto_resolution(inner_w_u, min_part_dim));
        res = res.max(1e-4);
        let scale = 1.0 / res;

        let inner_w = crate::grid::js_round(inner_w_u * scale).max(1.0) as usize;
        let inner_h = inner_h_u.map(|h| (h * scale).floor().max(1.0) as usize);
        let gap_px = crate::grid::js_round(opts.gap * scale).max(0.0) as usize;
        let pad = gap_px;
        let pad_c = pad + 1;

        // Instance list, biggest first — the same stable sort as the TS side, so
        // PassSpec order indices line up.
        let mut instances: Vec<usize> = Vec::new();
        for (pi, p) in usable.iter().enumerate() {
            for _ in 0..p.count {
                instances.push(pi);
            }
        }
        instances.sort_by(|&ai, &bi| {
            let a = &usable[ai];
            let b = &usable[bi];
            b.area
                .partial_cmp(&a.area)
                .unwrap()
                .then(b.width.max(b.height).partial_cmp(&a.width.max(a.height)).unwrap())
        });

        Some(NestContext {
            opts,
            rotations,
            mirrors,
            margin,
            sheet_w,
            sheet_h,
            res,
            scale,
            inner_w,
            inner_h,
            gap_px,
            pad,
            pad_c,
            instances,
            parts: usable,
            mask_cache: HashMap::new(),
            masks: Vec::new(),
        })
    }

    pub fn instance_count(&self) -> usize {
        self.instances.len()
    }

    fn get_mask(&mut self, pi: usize, rot: f64, mir: bool) -> Option<usize> {
        let key = (self.parts[pi].id, rot.to_bits(), mir);
        if let Some(m) = self.mask_cache.get(&key) {
            return *m;
        }
        let mut built = build_mask(&self.parts[pi], rot * PI / 180.0, mir, self.scale);
        if let Some(m) = &built {
            if m.w > self.inner_w || self.inner_h.map_or(false, |ih| m.h > ih) {
                built = None;
            }
        }
        let idx = built.map(|m| {
            self.masks.push(m);
            self.masks.len() - 1
        });
        self.mask_cache.insert(key, idx);
        idx
    }
}

fn auto_resolution(inner_w_u: f64, min_part_dim: f64) -> f64 {
    let base = inner_w_u / 900.0;
    let floor = inner_w_u / 4000.0;
    let fine = if min_part_dim.is_finite() && min_part_dim > 0.0 { min_part_dim / 6.0 } else { base };
    floor.max(base.min(fine))
}

fn oriented_bbox(p: &NestPart, theta: f64) -> (f64, f64) {
    let c = theta.cos();
    let s = theta.sin();
    let mut min_x = f64::INFINITY;
    let mut min_y = f64::INFINITY;
    let mut max_x = f64::NEG_INFINITY;
    let mut max_y = f64::NEG_INFINITY;
    let mut visit = |pt: &Pt| {
        let x = pt.x * c - pt.y * s;
        let y = pt.x * s + pt.y * c;
        if x < min_x {
            min_x = x;
        }
        if y < min_y {
            min_y = y;
        }
        if x > max_x {
            max_x = x;
        }
        if y > max_y {
            max_y = y;
        }
    };
    for r in &p.rings {
        for pt in r {
            visit(pt);
        }
    }
    for o in &p.opens {
        for pt in o {
            visit(pt);
        }
    }
    if !min_x.is_finite() {
        return (0.0, 0.0);
    }
    (max_x - min_x, max_y - min_y)
}

fn build_mask(p: &NestPart, theta: f64, mirror: bool, scale: f64) -> Option<Mask> {
    let c = theta.cos();
    let s = theta.sin();
    let xf = |pt: &Pt| -> GPt {
        let px = if mirror { -pt.x } else { pt.x };
        GPt { x: px * c - pt.y * s, y: px * s + pt.y * c }
    };
    let mut min_x = f64::INFINITY;
    let mut min_y = f64::INFINITY;
    let mut max_x = f64::NEG_INFINITY;
    let mut max_y = f64::NEG_INFINITY;
    let mut rings: Vec<Vec<GPt>> = p.rings.iter().map(|r| r.iter().map(&xf).collect()).collect();
    let mut opens: Vec<Vec<GPt>> = p.opens.iter().map(|o| o.iter().map(&xf).collect()).collect();
    for poly in rings.iter().chain(opens.iter()) {
        for pt in poly {
            if pt.x < min_x {
                min_x = pt.x;
            }
            if pt.y < min_y {
                min_y = pt.y;
            }
            if pt.x > max_x {
                max_x = pt.x;
            }
            if pt.y > max_y {
                max_y = pt.y;
            }
        }
    }
    if !min_x.is_finite() {
        return None;
    }
    for poly in rings.iter_mut().chain(opens.iter_mut()) {
        for pt in poly.iter_mut() {
            pt.x -= min_x;
            pt.y -= min_y;
        }
    }
    let w_u = max_x - min_x;
    let h_u = max_y - min_y;
    let w = ((w_u * scale).ceil() + 1.0).max(1.0) as usize;
    let h = ((h_u * scale).ceil() + 1.0).max(1.0) as usize;
    if w * h > 64_000_000 {
        return None; // pathological resolution/part combination
    }
    let grid = rasterize(&rings, &opens, scale, w, h);
    Some(Mask {
        grid,
        w,
        h,
        off_x: min_x,
        off_y: min_y,
        w_u,
        h_u,
        theta,
        mirror,
        dilated: None,
        dilated_c: None,
    })
}

/// Bottom-left first fit: scan upward with a coarse row stride, then refine the
/// band. collide()'s skip distances only jump over positions proven to collide,
/// so narrow slots are never skipped over.
fn find_fit(sheet: &mut Sheet, mask: &Mask, inner_w: usize, inner_h: Option<usize>, pad: usize) -> Option<(usize, usize)> {
    if mask.w > inner_w {
        return None;
    }
    let max_x = inner_w - mask.w;
    let y_limit: Option<usize> = match inner_h {
        Some(ih) => {
            if mask.h > ih {
                return None;
            }
            Some(ih - mask.h)
        }
        None => None,
    };
    let scan_top = match y_limit {
        Some(yl) => sheet.top_nest.min(yl),
        None => sheet.top_nest,
    };
    let st = (mask.w.min(mask.h) / 6).clamp(1, 8);
    let mut y = 0usize;
    while y <= scan_top {
        sheet.occ.ensure_rows(y + pad + mask.h);
        let mut x = 0usize;
        while x <= max_x {
            let d = collide(&sheet.occ, &mask.grid, x + pad, y + pad);
            if d == 0 {
                // Found room in this band — refine to the lowest-left position inside it.
                let mut fy = y.saturating_sub(st - 1);
                while fy < y {
                    let mut fx = 0usize;
                    while fx <= max_x {
                        let fd = collide(&sheet.occ, &mask.grid, fx + pad, fy + pad);
                        if fd == 0 {
                            return Some((fx, fy));
                        }
                        fx += fd;
                    }
                    fy += 1;
                }
                return Some((x, y));
            }
            x += d;
        }
        y += st;
    }
    // Nothing inside the used region — place on top if the height limit allows.
    if y_limit.map_or(true, |yl| sheet.top_nest <= yl) {
        sheet.occ.ensure_rows(sheet.top_nest + pad + mask.h);
        return Some((0, sheet.top_nest));
    }
    None
}

fn new_sheet(ctx: &NestContext) -> Sheet {
    let mut occ_c = BitGrid::new(ctx.inner_w + 2 * ctx.pad_c, 128);
    // Sheet floor counts as contact.
    for y in 0..=ctx.pad_c {
        let w = occ_c.w;
        occ_c.fill_span(y, 0, w as i64 - 1);
    }
    Sheet {
        occ: BitGrid::new(ctx.inner_w + 2 * ctx.pad, 128),
        occ_c,
        contact_rows: 0,
        top_nest: 0,
        used_w_u: 0.0,
        used_h_u: 0.0,
        placed: 0,
    }
}

/// Keep occ_c's left/right sheet-edge columns marked as rows grow.
fn ensure_contact(sheet: &mut Sheet, rows: usize, pad_c: usize, inner_w: usize) {
    sheet.occ_c.ensure_rows(rows);
    if sheet.contact_rows < sheet.occ_c.h {
        for y in sheet.contact_rows..sheet.occ_c.h {
            let w = sheet.occ_c.w;
            sheet.occ_c.fill_span(y, 0, pad_c as i64);
            sheet.occ_c.fill_span(y, (pad_c + inner_w - 1) as i64, w as i64 - 1);
        }
        sheet.contact_rows = sheet.occ_c.h;
    }
}

/// Run one greedy placement pass. Pure w.r.t. (ctx's parts+opts, spec).
pub fn run_pass<F: FnMut(usize, usize)>(ctx: &mut NestContext, spec: &PassSpec, mut on_progress: F) -> PassResult {
    let order = spec.order.clone();
    let total = order.len();
    let policy = spec.policy;

    struct PlacedItem {
        pi: usize,
        mask: usize,
        x: usize,
        y: usize,
        sheet: usize,
    }

    let mut sheets: Vec<Sheet> = Vec::new();
    if let Some(assign) = &spec.assign {
        let mut pool = 0usize;
        for &si in assign {
            pool = pool.max(si + 1);
        }
        while sheets.len() < pool {
            sheets.push(new_sheet(ctx));
        }
    }
    let mut items: Vec<PlacedItem> = Vec::new();
    let mut failures: Vec<i32> = Vec::new();
    let mut placed_area = 0.0f64;
    let mut done = 0usize;

    // Best position for any allowed orientation of the part on one sheet.
    // (Free function to appease the borrow checker: needs &mut ctx for masks.)
    fn best_on_sheet(
        ctx: &mut NestContext,
        pi: usize,
        sheet: &mut Sheet,
        policy: Policy,
    ) -> Option<(usize, usize, usize)> {
        let mut sheet_best: Option<(usize, usize, usize)> = None; // (mask, x, y)
        let mut best_contact: i64 = -1;
        for mir_i in 0..ctx.mirrors.len() {
            let mir = ctx.mirrors[mir_i];
            for rot_i in 0..ctx.rotations.len() {
                let rot = ctx.rotations[rot_i];
                let Some(mi) = ctx.get_mask(pi, rot, mir) else { continue };
                let (inner_w, inner_h, pad, pad_c) = (ctx.inner_w, ctx.inner_h, ctx.pad, ctx.pad_c);
                let mask = &ctx.masks[mi];
                let Some((x, y)) = find_fit(sheet, mask, inner_w, inner_h, pad) else { continue };
                if policy == Policy::Contact {
                    ensure_contact(sheet, y + pad_c + mask.h, pad_c, inner_w);
                    let c = overlap_count(&sheet.occ_c, &mask.grid, x + pad_c, y + pad_c) as i64;
                    let better = match sheet_best {
                        None => true,
                        Some((_, bx, by)) => c > best_contact || (c == best_contact && (y < by || (y == by && x < bx))),
                    };
                    if better {
                        sheet_best = Some((mi, x, y));
                        best_contact = c;
                    }
                } else {
                    let better = match sheet_best {
                        None => true,
                        Some((_, bx, by)) => y < by || (y == by && x < bx),
                    };
                    if better {
                        sheet_best = Some((mi, x, y));
                    }
                }
            }
        }
        sheet_best
    }

    for (oi, &ii) in order.iter().enumerate() {
        let pi = ctx.instances[ii];
        let mut best: Option<(usize, usize, usize, usize)> = None; // (sheet, mask, x, y)
        let target = spec.assign.as_ref().map(|a| a[oi]);
        if let Some(t) = target {
            if t < sheets.len() {
                if let Some((mi, x, y)) = best_on_sheet(ctx, pi, &mut sheets[t], policy) {
                    best = Some((t, mi, x, y));
                }
            }
        }
        let mut si = 0usize;
        while si < sheets.len() && best.is_none() {
            if Some(si) != target {
                if let Some((mi, x, y)) = best_on_sheet(ctx, pi, &mut sheets[si], policy) {
                    best = Some((si, mi, x, y));
                }
            }
            si += 1;
        }
        if best.is_none() {
            let mut fits_empty = false;
            for mir_i in 0..ctx.mirrors.len() {
                for rot_i in 0..ctx.rotations.len() {
                    let (mir, rot) = (ctx.mirrors[mir_i], ctx.rotations[rot_i]);
                    if ctx.get_mask(pi, rot, mir).is_some() {
                        fits_empty = true;
                    }
                }
            }
            if fits_empty {
                sheets.push(new_sheet(ctx));
                let si = sheets.len() - 1;
                if let Some((mi, x, y)) = best_on_sheet(ctx, pi, &mut sheets[si], policy) {
                    best = Some((si, mi, x, y));
                }
            }
            if best.is_none() {
                let id = ctx.parts[pi].id;
                if !failures.contains(&id) {
                    failures.push(id);
                }
                done += 1;
                on_progress(done, total);
                continue;
            }
        }

        let (bsheet, bmask, bx, by) = best.unwrap();
        // stamp()
        {
            let gap_px = ctx.gap_px;
            let (pad_c, inner_w) = (ctx.pad_c, ctx.inner_w);
            if ctx.masks[bmask].dilated.is_none() {
                ctx.masks[bmask].dilated = Some(dilate(&ctx.masks[bmask].grid, gap_px));
            }
            let sheet = &mut sheets[bsheet];
            or_into(&mut sheet.occ, ctx.masks[bmask].dilated.as_ref().unwrap(), bx, by);
            sheet.top_nest = sheet.top_nest.max(by + ctx.masks[bmask].h + gap_px);
            if policy == Policy::Contact {
                if ctx.masks[bmask].dilated_c.is_none() {
                    ctx.masks[bmask].dilated_c = Some(dilate(&ctx.masks[bmask].grid, gap_px + 1));
                }
                let dc_h = ctx.masks[bmask].dilated_c.as_ref().unwrap().h;
                ensure_contact(sheet, by + dc_h, pad_c, inner_w);
                or_into(&mut sheet.occ_c, ctx.masks[bmask].dilated_c.as_ref().unwrap(), bx, by);
            }
        }
        items.push(PlacedItem { pi, mask: bmask, x: bx, y: by, sheet: bsheet });
        placed_area += ctx.parts[pi].area;
        done += 1;
        on_progress(done, total);
    }

    // Derive per-sheet stats and placements from the final item list.
    for it in &items {
        let sheet = &mut sheets[it.sheet];
        let mask = &ctx.masks[it.mask];
        sheet.used_w_u = sheet.used_w_u.max(ctx.margin + it.x as f64 * ctx.res + mask.w_u);
        sheet.used_h_u = sheet.used_h_u.max(ctx.margin + it.y as f64 * ctx.res + mask.h_u);
        sheet.placed += 1;
    }
    // Drop sheets that ended up empty (possible with `assign`) and renumber.
    let mut remap: HashMap<usize, usize> = HashMap::new();
    let mut live: Vec<&Sheet> = Vec::new();
    for (i, s) in sheets.iter().enumerate() {
        if s.placed > 0 {
            remap.insert(i, live.len());
            live.push(s);
        }
    }
    let placements: Vec<Placement> = items
        .iter()
        .map(|it| {
            let mask = &ctx.masks[it.mask];
            Placement {
                part_id: ctx.parts[it.pi].id,
                sheet: remap[&it.sheet],
                theta: mask.theta,
                mirror: mask.mirror,
                tx: ctx.margin + it.x as f64 * ctx.res - mask.off_x,
                ty: ctx.margin + it.y as f64 * ctx.res - mask.off_y,
            }
        })
        .collect();

    let sheet_infos: Vec<SheetInfo> = live
        .iter()
        .map(|s| SheetInfo { used_w: s.used_w_u + ctx.margin, used_h: s.used_h_u + ctx.margin, placed: s.placed })
        .collect();
    let mut stock_area = 0.0f64;
    let mut used_area = 0.0f64;
    for s in &sheet_infos {
        stock_area += match ctx.sheet_h {
            Some(sh) => ctx.sheet_w * sh,
            None => (if ctx.opts.sheet_width.is_some() { ctx.sheet_w } else { s.used_w }) * s.used_h,
        };
        used_area += s.used_w * s.used_h;
    }
    PassResult { placements, sheets: sheet_infos, placed_area, stock_area, used_area, failures }
}
