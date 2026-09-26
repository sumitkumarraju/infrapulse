import type { StyleSpecification } from 'maplibre-gl'

/* A dark basemap built directly on OpenFreeMap's vector tiles (free, no key).
 *
 * Restyling a published style at runtime means chasing layer ids that can change
 * under us; declaring the handful of layers we actually want is both smaller and
 * exactly the palette in UI_DESIGN section 4: buildings present but recessive,
 * water nearly black, labels quiet, and no basemap road colour competing with
 * the health ramp we draw on top. */

export const CENTER: [number, number] = [76.575, 30.768]

export const INITIAL_VIEW = {
  longitude: CENTER[0],
  latitude: CENTER[1],
  zoom: 14.6,
  pitch: 55,
  bearing: -20,
}

export const darkStyle: StyleSpecification = {
  version: 8,
  glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
  sources: {
    openfreemap: {
      type: 'vector',
      url: 'https://tiles.openfreemap.org/planet',
    },
  },
  layers: [
    {
      id: 'background',
      type: 'background',
      paint: { 'background-color': '#060B18' },
    },
    {
      id: 'landcover',
      type: 'fill',
      source: 'openfreemap',
      'source-layer': 'landcover',
      paint: { 'fill-color': '#0B1326', 'fill-opacity': 0.6 },
    },
    {
      id: 'landuse',
      type: 'fill',
      source: 'openfreemap',
      'source-layer': 'landuse',
      paint: { 'fill-color': '#0C1530', 'fill-opacity': 0.5 },
    },
    {
      id: 'water',
      type: 'fill',
      source: 'openfreemap',
      'source-layer': 'water',
      paint: { 'fill-color': '#0A1628' },
    },
    {
      // The basemap's own roads are structure, not data: dim and colourless,
      // so the health ramp drawn above them is the only thing carrying meaning.
      id: 'roads',
      type: 'line',
      source: 'openfreemap',
      'source-layer': 'transportation',
      paint: {
        'line-color': '#18223C',
        'line-width': [
          'interpolate',
          ['exponential', 1.4],
          ['zoom'],
          10,
          0.5,
          18,
          6,
        ],
      },
    },
    {
      id: 'buildings-3d',
      type: 'fill-extrusion',
      source: 'openfreemap',
      'source-layer': 'building',
      minzoom: 13,
      paint: {
        'fill-extrusion-color': '#111A30',
        'fill-extrusion-opacity': 0.55,
        'fill-extrusion-height': ['coalesce', ['get', 'render_height'], 8],
        'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0],
      },
    },
    {
      id: 'road-labels',
      type: 'symbol',
      source: 'openfreemap',
      'source-layer': 'transportation_name',
      minzoom: 15,
      layout: {
        'symbol-placement': 'line',
        'text-field': ['get', 'name'],
        'text-font': ['Noto Sans Regular'],
        'text-size': 11,
        'text-letter-spacing': 0.04,
      },
      paint: {
        'text-color': '#5F6E8C',
        'text-halo-color': '#060B18',
        'text-halo-width': 1.4,
      },
    },
    {
      id: 'place-labels',
      type: 'symbol',
      source: 'openfreemap',
      'source-layer': 'place',
      maxzoom: 15,
      layout: {
        'text-field': ['get', 'name'],
        'text-font': ['Noto Sans Regular'],
        'text-size': 12,
      },
      paint: {
        'text-color': '#97A3BD',
        'text-halo-color': '#060B18',
        'text-halo-width': 1.4,
      },
    },
  ],
}

/** Flat, cheap version used when the GPU cannot keep up (UI_DESIGN 4). */
export const liteStyle: StyleSpecification = {
  ...darkStyle,
  layers: darkStyle.layers.filter((l) => l.id !== 'buildings-3d'),
}
