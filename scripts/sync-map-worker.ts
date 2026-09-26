/* Copies MapLibre's tile worker (and the shared chunk it imports) into
 * public/maplibre/.
 *
 * MapLibre 6 loads its worker from a sibling file resolved against its own
 * module URL, and that worker in turn imports "./maplibre-gl-shared.mjs".
 * Neither Vite's dev server nor the bundler keeps those two next to each other,
 * so the worker 404s, the request falls through to index.html, and the browser
 * rejects HTML as a module script — the map then renders nothing at all.
 * Serving both files from one fixed public path makes the relative import
 * resolve in dev and in the production build alike.
 *
 * Runs automatically before `dev` and `build`, so it cannot go stale when
 * maplibre-gl is upgraded. */

import { copyFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const FROM = resolve(HERE, '../node_modules/maplibre-gl/dist')
const TO = resolve(HERE, '../public/maplibre')

mkdirSync(TO, { recursive: true })
for (const file of ['maplibre-gl-worker.mjs', 'maplibre-gl-shared.mjs']) {
  copyFileSync(resolve(FROM, file), resolve(TO, file))
}
console.log(`Synced MapLibre worker files to ${TO}`)
