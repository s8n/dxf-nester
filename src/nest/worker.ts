import { nest } from './nester'
import type { NestOptions, NestPart } from './nester'

export interface WorkerRequest {
  parts: NestPart[]
  opts: NestOptions
}

self.onmessage = (ev: MessageEvent<WorkerRequest>) => {
  const { parts, opts } = ev.data
  let lastPost = 0
  try {
    const result = nest(parts, opts, (done, total) => {
      const now = Date.now()
      if (now - lastPost > 60 || done === total) {
        lastPost = now
        self.postMessage({ type: 'progress', done, total })
      }
    })
    self.postMessage({ type: 'done', result })
  } catch (err) {
    self.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) })
  }
}
