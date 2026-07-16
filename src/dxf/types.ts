import type { Pt } from '../geom'

export interface PolyVertex {
  x: number
  y: number
  /** Arc bulge to the NEXT vertex (tan of quarter sweep, CCW positive). */
  bulge: number
}

export type Entity =
  | { type: 'LINE'; layer: string; a: Pt; b: Pt }
  | { type: 'CIRCLE'; layer: string; center: Pt; r: number }
  | { type: 'ARC'; layer: string; center: Pt; r: number; start: number; end: number } // radians, CCW
  | { type: 'POLYLINE'; layer: string; closed: boolean; verts: PolyVertex[] }
  | { type: 'ELLIPSE'; layer: string; center: Pt; major: Pt; ratio: number; start: number; end: number }
  | {
      type: 'SPLINE'
      layer: string
      degree: number
      closed: boolean
      ctrl: Pt[]
      knots: number[]
      weights?: number[]
    }

export interface SampledEntity {
  entity: Entity
  pts: Pt[]
  closed: boolean
}
