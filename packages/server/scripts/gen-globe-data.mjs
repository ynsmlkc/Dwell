/**
 * `public/globe-data.js` ve `src/leaderboard/countries.ts`'i uretir.
 *
 * Bagimliliklari projeye EKLENMIYOR — yilda bir calisacak bir betik icin
 * uc paket tasimaya degmez. Gecici bir klasorde calistir:
 *
 *   mkdir /tmp/globe && cd /tmp/globe
 *   npm i d3-geo topojson-client world-atlas
 *   curl -o centroids.csv https://raw.githubusercontent.com/google/dspl/master/samples/google/canonical/countries.csv
 *   node <repo>/packages/server/scripts/gen-globe-data.mjs <repo>/packages/server
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const out = process.argv[2]
if (!out) throw new Error('kullanim: node gen-globe-data.mjs <packages/server yolu>')

// Paketler betigin yanindan degil, CALISTIRILDIGI klasorden cozuluyor.
const require = createRequire(join(process.cwd(), 'x.js'))
const load = (name) => import(pathToFileURL(require.resolve(name)).href)
const { geoContains } = await load('d3-geo')
const { feature } = await load('topojson-client')
const topo = JSON.parse(readFileSync(require.resolve('world-atlas/land-110m.json'), 'utf8'))
const land = feature(topo, topo.objects.land)

// Fibonacci kuresi: esit alanli dagilim, kutuplarda yigilma yok.
const N = 16000, dots = []
const golden = Math.PI * (3 - Math.sqrt(5))
for (let i = 0; i < N; i++) {
  const lat = Math.asin(1 - (i / (N - 1)) * 2) * 180 / Math.PI
  const lon = ((i * golden * 180 / Math.PI) % 360 + 540) % 360 - 180
  if (lat < -60) continue
  if (geoContains(land, [lon, lat])) dots.push(Math.round(lat * 10), Math.round(lon * 10))
}

const countries = {}
for (const r of readFileSync('centroids.csv', 'utf8').trim().split('\n').slice(1)) {
  const m = r.match(/^([A-Z]{2}),(-?[\d.]+),(-?[\d.]+),"?([^"]*)"?$/)
  if (m) countries[m[1]] = [Math.round(+m[2] * 10) / 10, Math.round(+m[3] * 10) / 10, m[4]]
}

const header = readFileSync(join(out, 'public/globe-data.js'), 'utf8').split('export const')[0]
writeFileSync(join(out, 'public/globe-data.js'),
  `${header}export const LAND = ${JSON.stringify(dots)};\nexport const COUNTRIES = ${JSON.stringify(countries)};\n`)

const codes = Object.keys(countries).sort()
const lines = []
for (let i = 0; i < codes.length; i += 16) lines.push('  ' + codes.slice(i, i + 16).map((c) => `'${c}'`).join(', ') + ',')
const ts = join(out, '../protocol/src/countries.ts')
writeFileSync(ts, readFileSync(ts, 'utf8').replace(/new Set\(\[[\s\S]*\]\)/, `new Set([\n${lines.join('\n')}\n])`))

console.log(`${dots.length / 2} kara noktasi, ${codes.length} ulke`)
