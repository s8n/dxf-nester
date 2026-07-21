import { createNestContext, runPassSpec } from './nester'
import type { NestContext, NestOptions, NestPart, PassResult, PassSpec } from './nester'
import initWasm, { NestSession } from '../../nest-core/pkg/nest_core'
import wasmUrl from '../../nest-core/pkg/nest_core_bg.wasm?url'

export type WorkerRequest =
  | { kind: 'init'; parts: NestPart[]; opts: NestOptions }
  | { kind: 'pass'; seq: number; spec: PassSpec }

export type WorkerResponse =
  | { type: 'ready'; engine: 'wasm' | 'ts' }
  | { type: 'pass-progress'; seq: number; done: number; total: number }
  | { type: 'pass-done'; seq: number; pass: PassResult }
  | { type: 'error'; message: string }

const post = (msg: WorkerResponse): void => self.postMessage(msg)

// The Rust/WASM engine is the fast path; the TypeScript engine below is the
// fallback if the wasm module fails to load or instantiate. Either way the
// session state (context + rasterized mask cache) lives for the worker's
// lifetime and is shared across passes. Both engines produce identical results
// (see tests/wasm.test.ts), so the choice is invisible to the caller.
let session: NestSession | null = null
let ctx: NestContext | null = null

// Message handling is chained so a 'pass' never starts while the async wasm
// init from a preceding 'init' message is still in flight.
let queue: Promise<void> = Promise.resolve()
self.onmessage = (ev: MessageEvent<WorkerRequest>) => {
  queue = queue.then(() => handle(ev.data))
}

async function handle(msg: WorkerRequest): Promise<void> {
  try {
    if (msg.kind === 'init') {
      let engine: 'wasm' | 'ts' = 'ts'
      try {
        await initWasm({ module_or_path: wasmUrl })
        session = new NestSession(JSON.stringify(msg.parts), JSON.stringify(msg.opts))
        engine = 'wasm'
      } catch (err) {
        console.warn('nest-core wasm unavailable, falling back to the TS engine:', err)
        session = null
        ctx = createNestContext(msg.parts, msg.opts)
      }
      post({ type: 'ready', engine })
      return
    }
    let lastPost = 0
    const onProgress = (done: number, total: number): void => {
      const now = Date.now()
      if (now - lastPost > 60 || done === total) {
        lastPost = now
        post({ type: 'pass-progress', seq: msg.seq, done, total })
      }
    }
    let pass: PassResult
    if (session) {
      pass = JSON.parse(session.runPass(JSON.stringify(msg.spec), onProgress)) as PassResult
    } else {
      if (!ctx) throw new Error('nest worker received a pass before init')
      pass = runPassSpec(ctx, msg.spec, onProgress)
    }
    post({ type: 'pass-done', seq: msg.seq, pass })
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) })
  }
}
