use nest_core::grid::BitGrid;
use nest_core::nest::{run_pass, NestContext, NestOptions, NestPart, PassSpec, Policy, Pt};

fn rect_part(id: i32, w: f64, h: f64, count: u32) -> NestPart {
    NestPart {
        id,
        rings: vec![vec![
            Pt { x: 0.0, y: 0.0 },
            Pt { x: w, y: 0.0 },
            Pt { x: w, y: h },
            Pt { x: 0.0, y: h },
        ]],
        opens: vec![],
        width: w,
        height: h,
        area: w * h,
        count,
    }
}

fn opts() -> NestOptions {
    NestOptions {
        gap: 2.0,
        margin: 0.0,
        resolution: Some(0.5),
        sheet_width: Some(50.0),
        sheet_height: None,
        rotation_step: 90.0,
        mirror: false,
    }
}

#[test]
fn collide_skip_is_sound() {
    let mut occ = BitGrid::new(160, 12);
    occ.fill_span(3, 40, 55);
    occ.fill_span(4, 90, 92);
    occ.fill_span(5, 10, 12);
    occ.fill_span(6, 120, 141);
    occ.set(63, 7);
    let mut mask = BitGrid::new(34, 5);
    mask.fill_span(0, 0, 33);
    for y in 1..5 {
        mask.fill_span(y, 0, 5);
        mask.fill_span(y, 28, 33);
    }
    let brute = |occ: &BitGrid, mask: &BitGrid, ox: usize, oy: usize| -> bool {
        for y in 0..mask.h {
            for x in 0..mask.w {
                if mask.get(x as i64, y as i64) != 0 && occ.get((ox + x) as i64, (oy + y) as i64) != 0 {
                    return true;
                }
            }
        }
        false
    };
    for oy in 0..=7usize {
        let mut ox = 0usize;
        while ox + mask.w <= occ.w {
            let d = nest_core::grid::collide(&occ, &mask, ox, oy);
            assert_eq!(d == 0, !brute(&occ, &mask, ox, oy), "at ox={ox} oy={oy}");
            if d == 0 {
                ox += 1;
            } else {
                for k in 1..d {
                    if ox + k + mask.w <= occ.w {
                        assert!(brute(&occ, &mask, ox + k, oy), "skipped free pos at ox={} oy={}", ox + k, oy);
                    }
                }
                ox += d;
            }
        }
    }
}

#[test]
fn places_all_rects_without_failures() {
    let parts = vec![rect_part(1, 20.0, 10.0, 4), rect_part(2, 15.0, 15.0, 2)];
    let mut ctx = NestContext::new(parts, opts()).unwrap();
    let n = ctx.instance_count();
    assert_eq!(n, 6);
    let spec = PassSpec { order: (0..n).collect(), policy: Policy::Contact, assign: None };
    let result = run_pass(&mut ctx, &spec, |_, _| {});
    assert!(result.failures.is_empty());
    assert_eq!(result.placements.len(), 6);
    assert_eq!(result.sheets.len(), 1);
}
