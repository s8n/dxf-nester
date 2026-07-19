import { createNestContext, runPassSpec } from './nester'
import type { NestContext, NestOptions, NestPart, PassResult, PassSpec } from './nester'

export type WorkerRequest =
  | { kind: 'init'; parts: NestPart[]; opts: NestOptions }
  | { kind: 'pass'; seq: number; spec: PassSpec }

export type WorkerResponse =
  | { type: 'ready' }
  | { type: 'pass-progress'; seq: number; done: number; total: number }
  | { type: 'pass-done'; seq: number; pass: PassResult }
  | { type: 'error'; message: string }

const post = (msg: WorkerResponse): void => self.postMessage(msg)

// Built once per worker on 'init'; identical on every thread (and to the main
// thread's planning context) since it is a pure function of (parts, opts).
// Keeping it across passes lets the rasterized mask cache warm up once.
let ctx: NestContext | null = null

self.onmessage = (ev: MessageEvent<WorkerRequest>) => {
  const msg = ev.data
  try {
    if (msg.kind === 'init') {
      ctx = createNestContext(msg.parts, msg.opts)
      post({ type: 'ready' })
      return
    }
    if (!ctx) throw new Error('nest worker received a pass before init')
    let lastPost = 0
    const pass = runPassSpec(ctx, msg.spec, (done, total) => {
      const now = Date.now()
      if (now - lastPost > 60 || done === total) {
        lastPost = now
        post({ type: 'pass-progress', seq: msg.seq, done, total })
      }
    })
    post({ type: 'pass-done', seq: msg.seq, pass })
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) })
  }
}
