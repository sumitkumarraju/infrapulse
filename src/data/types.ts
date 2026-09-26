/* The shape of everything the UI knows about. A real backend must produce
 * exactly these types; nothing in the app depends on where they came from. */

export type RoadClass = 'arterial' | 'collector' | 'local'
export type HealthBand = 'good' | 'watch' | 'critical'

export interface Segment {
  id: number
  name: string
  highway: string
  roadClass: RoadClass
  lengthM: number
  /** Within 300m of a school or hospital. */
  nearSensitive: boolean
  busRoute: boolean
  /** [lon, lat] pairs, as deck.gl and MapLibre both expect. */
  path: [number, number][]
  /** Midpoint, for towers, pulses and camera fly-to. */
  center: [number, number]
}

/** Why a segment scores what it does — the drawer's waterfall chart. */
export interface ScoreBreakdown {
  /** Everything starts at a perfect road. */
  base: number
  bumpPenalty: number
  roughnessPenalty: number
  photoPenalty: number
}

export interface SegmentStatus {
  id: number
  score: number
  band: HealthBand
  /** Probability the score drops below 30 within N days, 0-1. */
  risk30: number
  risk60: number
  risk90: number
  /** risk30 x impact x decay urgency. Higher means fix sooner. */
  priority: number
  /** Points per day, negative when deteriorating. */
  trend30: number
  estimatedCostInr: number
  repairType: 'patching' | 'resurfacing'
  breakdown: ScoreBreakdown
  bumpsLast7Days: number
  photoReportCount: number
}

export interface DailyScore {
  /** ISO date, YYYY-MM-DD. */
  day: string
  score: number
}

export interface ForecastPoint {
  day: string
  /** Days from today, 0-90. */
  offset: number
  value: number
  lower: number
  upper: number
}

export type PhotoSeverity = 'minor' | 'moderate' | 'severe'
export type PhotoStatus = 'pending' | 'approved' | 'rejected'

export interface PhotoReport {
  id: string
  segmentId: number
  segmentName: string
  imageUrl: string
  /** What the (fake) detector saw. */
  label: string
  confidence: number
  /** Normalised 0-1 box over the image. */
  box: { x: number; y: number; w: number; h: number }
  severity: PhotoSeverity
  status: PhotoStatus
  createdAt: string
  reporter: string
}

export type WorkOrderStatus =
  | 'open'
  | 'in-progress'
  | 'repaired'
  | 'verified'
  | 'reopened'

export interface WorkOrder {
  id: string
  segmentId: number
  segmentName: string
  status: WorkOrderStatus
  assignee: string
  costInr: number
  repairType: 'patching' | 'resurfacing'
  createdAt: string
  updatedAt: string
  /** Bumps per 100 passes before the repair, and after it was verified. */
  bumpRateBefore: number
  bumpRateAfter?: number
}

export interface Kpis {
  cityHealthIndex: number
  criticalCount: number
  watchCount: number
  goodCount: number
  bumpsToday: number
  costExposureInr: number
  openWorkOrders: number
  /** 30 points, for the sparkline in the KPI bar. */
  healthTrend: number[]
}

export type LiveEvent =
  | {
      type: 'bump'
      segmentId: number
      at: string
      /** Vertical acceleration spike, m/s². */
      magnitude: number
      position: [number, number]
      /** True when it came from a real phone over BroadcastChannel. */
      real?: boolean
    }
  | {
      type: 'photo'
      segmentId: number
      at: string
      report: PhotoReport
    }
  | {
      type: 'alert'
      segmentId: number
      at: string
      message: string
      band: HealthBand
    }
