/* Prints the health-band mix produced by the generator. Used to tune the
 * constants in src/data/mock/generate.ts against the target in CLAUDE.md 4.3:
 * about 15% critical, about 5% watch-and-falling-fast, the rest mostly good. */
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  segmentsFromGeoJson,
  simulateSegment,
  statusFor,
} from '../src/data/mock/generate'

const HERE = dirname(fileURLToPath(import.meta.url))
const geo = JSON.parse(
  readFileSync(resolve(HERE, '../public/data/segments.geojson'), 'utf-8'),
)

const segments = segmentsFromGeoJson(geo)
const statuses = segments.map((s) => statusFor(s, simulateSegment(s), 0))

const n = statuses.length
const pct = (c: number) => ((c / n) * 100).toFixed(1) + '%'
const critical = statuses.filter((s) => s.band === 'critical')
const watch = statuses.filter((s) => s.band === 'watch')
const good = statuses.filter((s) => s.band === 'good')
const aboutToFail = watch.filter((s) => s.trend30 < -0.08 && s.risk30 > 0.4)

console.log('segments      ', n)
console.log(
  'critical <40  ',
  critical.length,
  pct(critical.length),
  '(target ~15%)',
)
console.log('watch 40-69   ', watch.length, pct(watch.length))
console.log('good >=70     ', good.length, pct(good.length))
console.log(
  'about to fail ',
  aboutToFail.length,
  pct(aboutToFail.length),
  '(target ~5%)',
)
console.log(
  'mean score    ',
  (statuses.reduce((a, s) => a + s.score, 0) / n).toFixed(1),
)
console.log(
  'mean risk30   ',
  (statuses.reduce((a, s) => a + s.risk30, 0) / n).toFixed(3),
)
