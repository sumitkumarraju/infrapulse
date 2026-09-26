/* Cutting a road into addressable pieces.
 *
 * A works department repairs a stretch, not a whole road: "the Ludhiana
 * highway is bad" is not actionable, "this 50 metres of it" is. Everything in
 * the system — scores, towers, work orders, complaints — is keyed to one of
 * these pieces, so this is where the unit of the entire product is decided.
 *
 * Lives in shared/ without a Turf dependency because the server imports
 * regions at runtime and should not carry a geospatial toolkit to cut a line
 * into equal parts.
 */

const METRES_PER_DEGREE_LAT = 110_540

function metresPerDegreeLon(lat: number): number {
  return 111_320 * Math.cos((lat * Math.PI) / 180)
}

/** Distance in metres between two [lon, lat] points. */
export function metresBetween(
  a: [number, number],
  b: [number, number],
): number {
  const midLat = (a[1] + b[1]) / 2
  const dx = (b[0] - a[0]) * metresPerDegreeLon(midLat)
  const dy = (b[1] - a[1]) * METRES_PER_DEGREE_LAT
  return Math.hypot(dx, dy)
}

/** Total length of a polyline, in metres. */
export function lengthOf(path: [number, number][]): number {
  let total = 0
  for (let i = 1; i < path.length; i++) {
    total += metresBetween(path[i - 1], path[i])
  }
  return total
}

/**
 * Splits a polyline into pieces of about `targetM` metres.
 *
 * Vertices are preserved and cuts are interpolated between them, so a curve
 * stays a curve rather than becoming a chord. The final piece takes whatever
 * is left; a remainder shorter than a quarter of the target is merged back
 * into the previous piece instead of becoming a stub nobody can repair.
 */
export function chunkLine(
  path: [number, number][],
  targetM = 50,
): [number, number][][] {
  if (path.length < 2) return path.length === 1 ? [path] : []

  const chunks: [number, number][][] = []
  let current: [number, number][] = [path[0]]
  let accumulated = 0

  for (let i = 1; i < path.length; i++) {
    let from = path[i - 1]
    const to = path[i]
    let spanRemaining = metresBetween(from, to)

    // A single span can be longer than several chunks, so keep cutting it.
    while (accumulated + spanRemaining >= targetM) {
      const needed = targetM - accumulated
      const t = spanRemaining === 0 ? 0 : needed / spanRemaining
      const cut: [number, number] = [
        from[0] + (to[0] - from[0]) * t,
        from[1] + (to[1] - from[1]) * t,
      ]

      current.push(cut)
      chunks.push(current)

      current = [cut]
      from = cut
      spanRemaining -= needed
      accumulated = 0
    }

    accumulated += spanRemaining
    current.push(to)
  }

  if (current.length >= 2) {
    const tail = lengthOf(current)
    // A 3-metre stub is not something a crew can be sent to.
    if (tail < targetM / 4 && chunks.length > 0) {
      chunks[chunks.length - 1].push(...current.slice(1))
    } else {
      chunks.push(current)
    }
  }

  return chunks
}
