import { setWorkerUrl } from 'maplibre-gl'

/* See scripts/sync-map-worker.ts for why the worker is served from a fixed
 * public path rather than bundled: its own relative import of
 * "./maplibre-gl-shared.mjs" has to keep resolving. */
setWorkerUrl('/maplibre/maplibre-gl-worker.mjs')
