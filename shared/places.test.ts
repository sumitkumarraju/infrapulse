import { describe, expect, it } from 'vitest'
import { clampPlaceBox, findCuratedPlaces, CURATED_PLACES } from './places'

describe('places', () => {
  it('has curated places available', () => {
    expect(CURATED_PLACES.length).toBeGreaterThan(10)
  })

  it('finds curated places by case-insensitive name', () => {
    const ludhiana = findCuratedPlaces('ludhiana')
    expect(ludhiana.length).toBeGreaterThan(0)
    expect(ludhiana[0].name).toContain('Ludhiana')

    const mohali = findCuratedPlaces('Mohali')
    expect(mohali.length).toBeGreaterThan(0)
    expect(mohali[0].name).toContain('Mohali')

    const sector17 = findCuratedPlaces('Sector 17')
    expect(sector17.length).toBeGreaterThan(0)
    expect(sector17[0].name).toContain('Sector 17')
  })

  it('leaves small boxes unchanged', () => {
    const smallBox = { south: 30.7, north: 30.8, west: 76.7, east: 76.8 }
    const clamped = clampPlaceBox(smallBox)
    expect(clamped).toEqual(smallBox)
  })

  it('clamps large boxes so area stays under 0.25 sq deg', () => {
    const hugeBox = { south: 20.0, north: 25.0, west: 70.0, east: 75.0 }
    const clamped = clampPlaceBox(hugeBox)
    const area = (clamped.north - clamped.south) * (clamped.east - clamped.west)
    expect(area).toBeLessThanOrEqual(0.25)
    expect(clamped.north - clamped.south).toBeLessThanOrEqual(0.400001)
    expect(clamped.east - clamped.west).toBeLessThanOrEqual(0.400001)
  })
})
