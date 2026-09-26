import { z } from 'zod'

/* Request validation.
 *
 * The ingest endpoint is the one an untrusted device posts to, so it is the
 * one worth bounding carefully: coordinates must be real coordinates, a
 * timestamp must parse, and a single request cannot carry a million points.
 */

/** A trip is minutes long at a bump every second or two; 500 is generous. */
export const MAX_BUMPS_PER_REQUEST = 500

const isoDate = z
  .string()
  .refine((value) => !Number.isNaN(Date.parse(value)), 'Not a valid timestamp')

export const bumpSchema = z.object({
  at: isoDate,
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  // A pothole is a spike, not a rocket launch: anything past 10g is a dropped
  // phone or a bad sensor, and should not be allowed to tank a road's score.
  magnitude: z.number().min(0).max(100),
  speedMs: z.number().min(0).max(120),
})

export const ingestSchema = z.object({
  // No deviceId here on purpose: it comes from the signed token, not the body.
  // A body field would let any caller claim to be any device.
  tripId: z.string().min(1).max(128),
  bumps: z.array(bumpSchema).min(1).max(MAX_BUMPS_PER_REQUEST),
})

export const photoReportSchema = z.object({
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  imageUrl: z.string().min(1).max(2048),
  label: z.string().min(1).max(64),
  confidence: z.number().min(0).max(1),
  severity: z.enum(['minor', 'moderate', 'severe']),
  box: z.object({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    w: z.number().min(0).max(1),
    h: z.number().min(0).max(1),
  }),
  reporter: z.string().min(1).max(64).default('Anonymous'),
})

export const photoStatusSchema = z.object({
  status: z.enum(['pending', 'approved', 'rejected']),
})

export const createWorkOrdersSchema = z.object({
  segmentIds: z.array(z.number().int().nonnegative()).min(1).max(2000),
})

export const updateWorkOrderSchema = z
  .object({
    status: z
      .enum(['open', 'in-progress', 'repaired', 'verified', 'reopened'])
      .optional(),
    assignee: z.string().min(1).max(64).optional(),
  })
  .refine(
    (value) => value.status !== undefined || value.assignee !== undefined,
    'Nothing to update',
  )

export const reviewEscalationSchema = z.object({
  action: z.enum(['approve', 'send', 'dismiss']),
  reason: z.string().max(500).optional(),
})

export const projectedQuerySchema = z.object({
  days: z.coerce.number().int().min(0).max(90).default(0),
})
