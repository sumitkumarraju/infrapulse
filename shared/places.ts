export interface PlaceBox {
  south: number
  west: number
  north: number
  east: number
}

export interface CuratedPlace {
  name: string
  box: PlaceBox
}

export const CURATED_PLACES: CuratedPlace[] = [
  {
    name: 'Ludhiana, Punjab, India',
    box: { south: 30.82, north: 30.98, west: 75.76, east: 75.94 },
  },
  {
    name: 'Mohali, SAS Nagar, Punjab, India',
    box: { south: 30.65, north: 30.76, west: 76.66, east: 76.76 },
  },
  {
    name: 'Chandigarh, India',
    box: { south: 30.68, north: 30.79, west: 76.72, east: 76.84 },
  },
  {
    name: 'Sector 17, Chandigarh, India',
    box: { south: 30.735, north: 30.748, west: 76.772, east: 76.788 },
  },
  {
    name: 'New Delhi, Delhi, India',
    box: { south: 28.52, north: 28.68, west: 77.14, east: 77.30 },
  },
  {
    name: 'South Delhi, Delhi, India',
    box: { south: 28.48, north: 28.58, west: 77.16, east: 77.26 },
  },
  {
    name: 'Mumbai, Maharashtra, India',
    box: { south: 18.92, north: 19.18, west: 72.80, east: 72.96 },
  },
  {
    name: 'Bengaluru, Karnataka, India',
    box: { south: 12.88, north: 13.06, west: 77.52, east: 77.68 },
  },
  {
    name: 'Pune, Maharashtra, India',
    box: { south: 18.46, north: 18.60, west: 73.78, east: 73.94 },
  },
  {
    name: 'Amritsar, Punjab, India',
    box: { south: 31.58, north: 31.68, west: 74.82, east: 74.94 },
  },
  {
    name: 'Jalandhar, Punjab, India',
    box: { south: 31.28, north: 31.38, west: 75.52, east: 75.64 },
  },
  {
    name: 'Patiala, Punjab, India',
    box: { south: 30.30, north: 30.38, west: 76.35, east: 76.45 },
  },
  {
    name: 'Jaipur, Rajasthan, India',
    box: { south: 26.84, north: 26.96, west: 75.74, east: 75.88 },
  },
  {
    name: 'Hyderabad, Telangana, India',
    box: { south: 17.34, north: 17.48, west: 78.40, east: 78.56 },
  },
  {
    name: 'Kolkata, West Bengal, India',
    box: { south: 22.48, north: 22.62, west: 88.30, east: 88.42 },
  },
  {
    name: 'Chennai, Tamil Nadu, India',
    box: { south: 12.98, north: 13.12, west: 80.20, east: 80.30 },
  },
]

/**
 * Clamps bounding boxes that exceed Overpass limits (0.25 sq deg) around their center.
 * Guarantees that any place selected can be safely imported without rejection.
 */
export function clampPlaceBox(box: PlaceBox, maxSideDeg = 0.40): PlaceBox {
  const height = box.north - box.south
  const width = box.east - box.west
  const area = height * width

  if (area <= 0.22 && height <= maxSideDeg && width <= maxSideDeg) {
    return box
  }

  const centerLat = (box.south + box.north) / 2
  const centerLon = (box.west + box.east) / 2
  const halfLat = Math.min(height / 2, maxSideDeg / 2)
  const halfLon = Math.min(width / 2, maxSideDeg / 2)

  return {
    south: Number((centerLat - halfLat).toFixed(6)),
    north: Number((centerLat + halfLat).toFixed(6)),
    west: Number((centerLon - halfLon).toFixed(6)),
    east: Number((centerLon + halfLon).toFixed(6)),
  }
}

/**
 * Matches place queries against curated cities and landmarks when offline or as fallback.
 */
export function findCuratedPlaces(query: string): CuratedPlace[] {
  const q = query.toLowerCase().trim()
  if (!q) return []
  return CURATED_PLACES.filter(
    (p) =>
      p.name.toLowerCase().includes(q) ||
      q.includes(p.name.split(',')[0].toLowerCase()),
  )
}
