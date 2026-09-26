import type { StyleSpecification } from 'maplibre-gl'

/* A dark basemap built directly on OpenFreeMap's vector tiles (free, no key).
 *
 * Restyling a published style at runtime means chasing layer ids that can change
 * under us; declaring the layers we want is both smaller and exactly the palette
 * in UI_DESIGN section 4: buildings present but recessive, water nearly black,
 * labels quiet, and no basemap road colour competing with the health ramp drawn
 * on top.
 *
 * The detail here is deliberate. A map of coloured lines floating in black gives
 * an engineer nothing to locate themselves by — "the bad one near the college"
 * needs the college on the map. So this carries landuse, parks, water, building
 * footprints extruded and shaded by height, road casings, and four tiers of
 * labels that appear as you descend.
 */

export const CENTER: [number, number] = [76.575, 30.768]

export const INITIAL_VIEW = {
  longitude: CENTER[0],
  latitude: CENTER[1],
  zoom: 14.6,
  pitch: 55,
  bearing: -20,
}

const FONT = ['Noto Sans Regular']
const FONT_BOLD = ['Noto Sans Bold']

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

    /* --- Ground cover ---------------------------------------------------- */

    {
      id: 'landcover',
      type: 'fill',
      source: 'openfreemap',
      'source-layer': 'landcover',
      paint: {
        // Green space reads faintly green rather than as generic fill, which
        // is what makes a campus or a park recognisable from above.
        'fill-color': [
          'match',
          ['get', 'class'],
          'wood',
          '#0C1A22',
          'grass',
          '#0C1A20',
          'farmland',
          '#0E1626',
          '#0B1326',
        ],
        'fill-opacity': 0.65,
      },
    },
    {
      id: 'landuse',
      type: 'fill',
      source: 'openfreemap',
      'source-layer': 'landuse',
      paint: {
        'fill-color': [
          'match',
          ['get', 'class'],
          'residential',
          '#0C1530',
          'industrial',
          '#131A2E',
          'commercial',
          '#141B33',
          'school',
          '#10203A',
          'hospital',
          '#1A1330',
          '#0C1530',
        ],
        'fill-opacity': 0.55,
      },
    },
    {
      id: 'park',
      type: 'fill',
      source: 'openfreemap',
      'source-layer': 'park',
      paint: { 'fill-color': '#0C1C22', 'fill-opacity': 0.7 },
    },
    {
      id: 'water',
      type: 'fill',
      source: 'openfreemap',
      'source-layer': 'water',
      paint: { 'fill-color': '#0A1628' },
    },
    {
      id: 'waterway',
      type: 'line',
      source: 'openfreemap',
      'source-layer': 'waterway',
      paint: {
        'line-color': '#0F2036',
        'line-width': ['interpolate', ['linear'], ['zoom'], 10, 0.6, 18, 3],
      },
    },

    /* --- Roads: structure only, never meaning ---------------------------- */

    {
      // A casing under the road line gives the network edges to read against
      // the ground, the way a printed map does.
      id: 'road-casing',
      type: 'line',
      source: 'openfreemap',
      'source-layer': 'transportation',
      minzoom: 13,
      paint: {
        'line-color': '#0A0F1E',
        'line-width': [
          'interpolate',
          ['exponential', 1.4],
          ['zoom'],
          13,
          1.5,
          18,
          11,
        ],
      },
    },
    {
      id: 'roads',
      type: 'line',
      source: 'openfreemap',
      'source-layer': 'transportation',
      paint: {
        'line-color': [
          'match',
          ['get', 'class'],
          'motorway',
          '#222E4C',
          'trunk',
          '#1F2A46',
          'primary',
          '#1D2740',
          'secondary',
          '#1A2339',
          '#161E33',
        ],
        'line-width': [
          'interpolate',
          ['exponential', 1.4],
          ['zoom'],
          10,
          0.5,
          18,
          7,
        ],
      },
    },
    {
      id: 'rail',
      type: 'line',
      source: 'openfreemap',
      'source-layer': 'transportation',
      filter: ['==', ['get', 'class'], 'rail'],
      minzoom: 13,
      paint: {
        'line-color': '#26304A',
        'line-dasharray': [3, 2],
        'line-width': ['interpolate', ['linear'], ['zoom'], 13, 0.6, 18, 2.2],
      },
    },

    /* --- Buildings -------------------------------------------------------- */

    {
      id: 'buildings-3d',
      type: 'fill-extrusion',
      source: 'openfreemap',
      'source-layer': 'building',
      minzoom: 13,
      paint: {
        // Taller blocks catch slightly more light, which is enough to read the
        // skyline's shape without the buildings competing with the road data.
        'fill-extrusion-color': [
          'interpolate',
          ['linear'],
          ['coalesce', ['get', 'render_height'], 8],
          0,
          '#0F1729',
          12,
          '#131C33',
          40,
          '#1A2440',
          90,
          '#212C4E',
        ],
        'fill-extrusion-opacity': 0.72,
        'fill-extrusion-height': [
          'interpolate',
          ['linear'],
          ['zoom'],
          // Grow the extrusion in as you zoom, so the city does not pop.
          13,
          0,
          15.5,
          ['coalesce', ['get', 'render_height'], 8],
        ],
        'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0],
      },
    },

    /* --- Labels, appearing as you descend --------------------------------- */

    {
      id: 'water-labels',
      type: 'symbol',
      source: 'openfreemap',
      'source-layer': 'water_name',
      layout: {
        'text-field': ['get', 'name'],
        'text-font': FONT,
        'text-size': 11,
        'text-letter-spacing': 0.08,
      },
      paint: {
        'text-color': '#3C5A7A',
        'text-halo-color': '#060B18',
        'text-halo-width': 1.2,
      },
    },
    {
      id: 'place-labels',
      type: 'symbol',
      source: 'openfreemap',
      'source-layer': 'place',
      maxzoom: 16,
      layout: {
        'text-field': ['get', 'name'],
        'text-font': FONT_BOLD,
        'text-size': ['interpolate', ['linear'], ['zoom'], 10, 10, 15, 14],
        'text-letter-spacing': 0.06,
        'text-transform': 'uppercase',
      },
      paint: {
        'text-color': '#97A3BD',
        'text-halo-color': '#060B18',
        'text-halo-width': 1.6,
      },
    },
    {
      // Schools, hospitals and colleges: the landmarks that make a road
      // dangerous, and the ones an engineer navigates by.
      id: 'poi-labels',
      type: 'symbol',
      source: 'openfreemap',
      'source-layer': 'poi',
      minzoom: 14.5,
      filter: [
        'in',
        ['get', 'class'],
        [
          'literal',
          ['school', 'hospital', 'college', 'university', 'bus', 'railway'],
        ],
      ],
      layout: {
        'text-field': ['get', 'name'],
        'text-font': FONT,
        'text-size': 10.5,
        'text-anchor': 'top',
        'text-offset': [0, 0.6],
        'text-max-width': 9,
      },
      paint: {
        'text-color': '#67E8F9',
        'text-halo-color': '#060B18',
        'text-halo-width': 1.6,
      },
    },
    {
      id: 'road-labels',
      type: 'symbol',
      source: 'openfreemap',
      'source-layer': 'transportation_name',
      minzoom: 14.5,
      layout: {
        'symbol-placement': 'line',
        'text-field': ['get', 'name'],
        'text-font': FONT,
        'text-size': 11,
        'text-letter-spacing': 0.04,
      },
      paint: {
        'text-color': '#7E8CA8',
        'text-halo-color': '#060B18',
        'text-halo-width': 1.4,
      },
    },
  ],
}

/** Flat and cheap, for when the GPU cannot keep up (UI_DESIGN 4). */
export const liteStyle: StyleSpecification = {
  ...darkStyle,
  layers: darkStyle.layers.filter(
    (l) => l.id !== 'buildings-3d' && l.id !== 'road-casing',
  ),
}
