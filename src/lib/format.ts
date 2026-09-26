/** Indian digit grouping — 1,42,80,000 rather than 14,280,000. */
export function formatInr(value: number): string {
  const rounded = Math.round(value)
  if (rounded >= 1_00_00_000) return `₹${(rounded / 1_00_00_000).toFixed(2)} cr`
  if (rounded >= 1_00_000) return `₹${(rounded / 1_00_000).toFixed(1)} L`
  return `₹${rounded.toLocaleString('en-IN')}`
}

export function formatInrExact(value: number): string {
  return `₹${Math.round(value).toLocaleString('en-IN')}`
}
