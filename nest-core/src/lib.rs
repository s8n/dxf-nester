//! WASM bindings for the nesting core. A NestSession mirrors one worker's
//! NestContext on the TS side: built once from (parts, opts), then any number
//! of passes run against it so the rasterized mask cache warms up once.

pub mod grid;
pub mod nest;

use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub struct NestSession {
    ctx: nest::NestContext,
}

#[wasm_bindgen]
impl NestSession {
    /// parts_json: NestPart[]; opts_json: NestOptions — the exact TS shapes.
    #[wasm_bindgen(constructor)]
    pub fn new(parts_json: &str, opts_json: &str) -> Result<NestSession, JsError> {
        let parts: Vec<nest::NestPart> =
            serde_json::from_str(parts_json).map_err(|e| JsError::new(&format!("bad parts: {e}")))?;
        let opts: nest::NestOptions =
            serde_json::from_str(opts_json).map_err(|e| JsError::new(&format!("bad options: {e}")))?;
        let ctx = nest::NestContext::new(parts, opts).ok_or_else(|| JsError::new("nothing to nest"))?;
        Ok(NestSession { ctx })
    }

    #[wasm_bindgen(js_name = instanceCount)]
    pub fn instance_count(&self) -> usize {
        self.ctx.instance_count()
    }

    /// Run one pass; spec_json is a PassSpec. Returns a PassResult as JSON.
    /// `progress` (optional) is called with (done, total) after each instance.
    #[wasm_bindgen(js_name = runPass)]
    pub fn run_pass(&mut self, spec_json: &str, progress: Option<js_sys::Function>) -> Result<String, JsError> {
        let spec: nest::PassSpec =
            serde_json::from_str(spec_json).map_err(|e| JsError::new(&format!("bad spec: {e}")))?;
        let result = nest::run_pass(&mut self.ctx, &spec, |done, total| {
            if let Some(f) = &progress {
                let _ = f.call2(&JsValue::NULL, &JsValue::from_f64(done as f64), &JsValue::from_f64(total as f64));
            }
        });
        serde_json::to_string(&result).map_err(|e| JsError::new(&format!("serialize: {e}")))
    }
}
