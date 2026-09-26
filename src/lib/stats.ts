/* The small amount of statistics the forecast needs, kept separate so it can be
 * unit-tested without touching React or the data layer. */

/**
 * Standard normal CDF via Abramowitz & Stegun 26.2.17 — accurate to ~7.5e-8,
 * which is far beyond what a risk percentage rendered to one decimal needs.
 */
export function normalCdf(x: number): number {
  const sign = x < 0 ? -1 : 1
  const z = Math.abs(x) / Math.SQRT2

  const t = 1 / (1 + 0.3275911 * z)
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) *
      t +
      0.254829592) *
      t *
      Math.exp(-z * z)

  return 0.5 * (1 + sign * y)
}

export interface Trend {
  slope: number
  intercept: number
  /** Standard deviation of the residuals, the basis of the forecast band. */
  residualStd: number
}

/** Ordinary least squares of y against its index. */
export function linearTrend(values: number[]): Trend {
  const n = values.length
  if (n < 2) return { slope: 0, intercept: values[0] ?? 0, residualStd: 1 }

  let sumX = 0
  let sumY = 0
  let sumXY = 0
  let sumXX = 0

  for (let i = 0; i < n; i++) {
    sumX += i
    sumY += values[i]
    sumXY += i * values[i]
    sumXX += i * i
  }

  const denominator = n * sumXX - sumX * sumX
  const slope = denominator === 0 ? 0 : (n * sumXY - sumX * sumY) / denominator
  const intercept = (sumY - slope * sumX) / n

  let sse = 0
  for (let i = 0; i < n; i++) {
    const residual = values[i] - (intercept + slope * i)
    sse += residual * residual
  }

  return {
    slope,
    intercept,
    residualStd: Math.sqrt(sse / Math.max(1, n - 2)),
  }
}

export const clamp = (v: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, v))

export function mean(values: number[]): number {
  if (values.length === 0) return 0
  return values.reduce((a, b) => a + b, 0) / values.length
}
