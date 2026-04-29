/*
 * Mitata-based dispatcher benchmark.
 *
 * Pretty CLI table by default:
 *   npm run bench
 *
 * JSON capture for cross-branch comparison:
 *   npm run bench -- --json bench/results/<label>.json
 *
 * Why mitata
 * ----------
 * - Built-in allocations-per-op measurement when run with `--expose-gc`
 *   (the npm script sets the flag). Equivalent to BenchmarkDotNet's
 *   `MemoryDiagnoser` Allocated column. No hand-rolled `perf_hooks`
 *   GC observer needed.
 * - Multiple measurement rounds with cross-round statistics (p50/p99
 *   over rounds rather than over samples), more robust than a single
 *   long sample window.
 * - Smaller-noise timing on sub-microsecond ops via log-normal stats
 *   instead of a flat mean.
 *
 * Why not vitest bench
 * --------------------
 * Vitest 4.x's bench summary is empty when stdout is piped (verified)
 * and its `json` reporter alias was removed.
 */

import { bench, run, do_not_optimize } from 'mitata'
import {
  createHarness,
  multiValueDelta,
  positionDelta,
  type DeltaCallback
} from './harness'
import * as fs from 'node:fs'
import * as path from 'node:path'

interface ScenarioBuilder {
  name: string
  build: () => Promise<{ run: () => void; teardown: () => void }>
}

const scenarios: ScenarioBuilder[] = [
  {
    name: 'position update (debug off, prod default)',
    build: async () => {
      const h = await createHarness({ debugEnabled: false })
      const cb: DeltaCallback = h.deltaCallback
      let i = 0
      return {
        run: () => {
          i = (i + 1) & 0xffff
          do_not_optimize(cb(positionDelta(50 + i * 1e-6, 8 + i * 1e-6)))
        },
        teardown: () => h.stop()
      }
    }
  },
  {
    name: 'position update (debug ENABLED)',
    build: async () => {
      const h = await createHarness({ debugEnabled: true })
      const cb: DeltaCallback = h.deltaCallback
      let i = 0
      return {
        run: () => {
          i = (i + 1) & 0xffff
          do_not_optimize(cb(positionDelta(50 + i * 1e-6, 8 + i * 1e-6)))
        },
        teardown: () => h.stop()
      }
    }
  },
  {
    name: 'mixed delta (4 values, debug off)',
    build: async () => {
      const h = await createHarness({ debugEnabled: false })
      const cb: DeltaCallback = h.deltaCallback
      let i = 0
      return {
        run: () => {
          i = (i + 1) & 0xffff
          do_not_optimize(cb(multiValueDelta(50 + i * 1e-6, 8 + i * 1e-6)))
        },
        teardown: () => h.stop()
      }
    }
  },
  {
    name: 'mixed delta (4 values, debug ENABLED)',
    build: async () => {
      const h = await createHarness({ debugEnabled: true })
      const cb: DeltaCallback = h.deltaCallback
      let i = 0
      return {
        run: () => {
          i = (i + 1) & 0xffff
          do_not_optimize(cb(multiValueDelta(50 + i * 1e-6, 8 + i * 1e-6)))
        },
        teardown: () => h.stop()
      }
    }
  },
  {
    name: '10-update burst in single callback',
    build: async () => {
      const h = await createHarness({ debugEnabled: false })
      const cb: DeltaCallback = h.deltaCallback
      // Pre-build the burst object once; mutate lat/lon per iteration
      // so the plugin can't trivially short-circuit on identical input.
      const burst = {
        updates: Array.from({ length: 10 }, () => ({
          values: [
            {
              path: 'navigation.position',
              value: { latitude: 50, longitude: 8 }
            }
          ]
        }))
      }
      let i = 0
      return {
        run: () => {
          i = (i + 1) & 0xffff
          const lat = 50 + i * 1e-6
          const lon = 8 + i * 1e-6
          for (let k = 0; k < burst.updates.length; k++) {
            const v = (burst.updates[k] as any).values[0].value
            v.latitude = lat
            v.longitude = lon
          }
          do_not_optimize(cb(burst))
        },
        teardown: () => h.stop()
      }
    }
  }
]

async function main() {
  const args = process.argv.slice(2)
  const jsonIdx = args.indexOf('--json')
  const jsonPath = jsonIdx >= 0 ? args[jsonIdx + 1] : undefined

  // Build every scenario up front so the bench-registration order
  // matches what mitata reports.
  const teardowns: Array<() => void> = []
  for (const sc of scenarios) {
    const built = await sc.build()
    teardowns.push(built.teardown)
    // gc('once') runs GC once before measurement starts; mitata still
    // tracks per-iteration heap deltas via the `heap`/`gc` columns in
    // its output. `inner` GCs every iteration which gets pathological
    // on the BEFORE-perf-PRs source (lots of JSON.stringify calls
    // allocate enough that per-iteration GC never lets the loop reach
    // its sample target).
    bench(sc.name, built.run).gc('once')
  }

  if (jsonPath) {
    // Mitata's `format: 'json'` builds a JSON string and feeds it to
    // `print()`. Capture rather than emit so we can wrap it in our
    // metadata envelope before writing.
    let captured = ''
    await run({
      // mitata accepts a per-format options object via the format key.
      // `samples: false` strips the per-sample arrays which would otherwise
      // bloat the JSON to ~60 MB per run; the summary stats (avg/p99/etc)
      // and per-iter heap/gc are kept either way.
      format: { json: { samples: false, debug: false } } as any,
      colors: false,
      print: (chunk: string) => {
        captured += chunk
      }
    })
    const payload = {
      meta: {
        nodeVersion: process.version,
        platform: `${process.platform}-${process.arch}`,
        gcExposed: typeof globalThis.gc === 'function',
        recordedAt: new Date().toISOString()
      },
      mitata: JSON.parse(captured)
    }
    fs.mkdirSync(path.dirname(jsonPath), { recursive: true })
    fs.writeFileSync(jsonPath, JSON.stringify(payload, null, 2))
    console.log(`\nWrote JSON to ${jsonPath}`)
  } else {
    await run()
  }

  for (const td of teardowns) td()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
