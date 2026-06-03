/*
 * Reusable mock-SignalK harness for bench/run.ts.
 *
 * Wires up a stub server so the plugin can be `start()`ed directly, and
 * returns the captured delta callback so each scenario can drive deltas
 * through the dispatcher. calcs() runs synchronously in the dispatch, so
 * the bench measures the full per-tick cost: dispatch + parseSKPaths +
 * calcs + buildDeltaMsg.
 */

export type DeltaCallback = (delta: unknown) => void

export interface Harness {
  deltaCallback: DeltaCallback
  stop: () => void
}

interface HarnessOptions {
  /**
   * Set `false` to mirror production where the SignalK Admin UI keeps
   * `debug` disabled. Several perf PRs (debug-gate in particular)
   * only show a delta when debug is off, which is the default.
   */
  debugEnabled?: boolean
  /**
   * When true (default), drive a one-shot delta before returning that
   * populates `nextPoint`, `previousPoint`, COG, SOG, and datetime so
   * `parseSKPaths(srcPaths)` returns true on every subsequent tick and
   * `calcs()` runs the full geodesy path. Without this prime the
   * dispatcher short-circuits to a no-op and the bench measures only
   * the dispatcher loop overhead.
   */
  primeCourse?: boolean
  /**
   * When true, also prime an active route (a multi-waypoint resource and
   * an activeRoute delta with a pointIndex) so `calcs()` exercises
   * `routeRemaining` and its reference-keyed cache on every subsequent
   * tick. Default false.
   */
  primeRoute?: boolean
}

// A 25-waypoint route for the active-route bench scenario. Coordinates are
// [lon, lat] pairs, matching the shape the resources API returns.
const BENCH_ROUTE_WAYPOINTS: Array<[number, number]> = Array.from(
  { length: 25 },
  (_, k) => [8 + k * 0.01, 50 + k * 0.01]
)

export async function createHarness(
  opts: HarnessOptions = {}
): Promise<Harness> {
  const debugEnabled = opts.debugEnabled ?? false

  // Drop the cached plugin module so each createHarness() call gets a
  // fresh closure (per-instance state inside src/index.ts mutates
  // across start/stop cycles, and we don't want that bleeding between
  // bench scenarios).
  const pluginPath = require.resolve('../src/index')
  delete require.cache[pluginPath]

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const factory = require('../src/index') as (server: any) => {
    start: (options: any) => void
    stop: () => void
  }

  let deltaCallback: DeltaCallback | null = null

  const debug = Object.assign(function debug(_msg: any, ..._args: any[]) {}, {
    enabled: debugEnabled
  })

  const server = {
    debug,
    error: () => undefined,
    setPluginStatus: () => undefined,
    setPluginError: () => undefined,
    handleMessage: () => undefined,
    getSelfPath: () => null,
    getCourse: () => Promise.resolve(null),
    get: () => undefined,
    subscriptionmanager: {
      subscribe: (
        _sub: unknown,
        unsubscribes: Array<() => void>,
        _err: unknown,
        cb: DeltaCallback
      ) => {
        deltaCallback = cb
        unsubscribes.push(() => undefined)
      }
    },
    resourcesApi: {
      getResource: () =>
        Promise.resolve(
          opts.primeRoute
            ? { feature: { geometry: { coordinates: BENCH_ROUTE_WAYPOINTS } } }
            : null
        )
    }
  }

  const plugin = factory(server)
  plugin.start({
    notifications: { sound: false },
    calculations: { method: 'GreatCircle' }
  })

  if (!deltaCallback) {
    throw new Error('subscribe was not called during plugin.start')
  }
  const cb = deltaCallback as DeltaCallback

  if (opts.primeCourse !== false) {
    cb({
      updates: [
        {
          values: [
            {
              path: 'navigation.course.nextPoint',
              value: { position: { latitude: 50.5, longitude: 8.5 } }
            },
            {
              path: 'navigation.course.previousPoint',
              value: { position: { latitude: 50.0, longitude: 8.0 } }
            },
            { path: 'navigation.magneticVariation', value: 0.05 },
            { path: 'navigation.courseOverGroundTrue', value: 1.5 },
            { path: 'navigation.speedOverGround', value: 4.2 },
            { path: 'navigation.datetime', value: '2026-04-29T00:00:00.000Z' }
          ]
        }
      ]
    })
  }

  if (opts.primeRoute) {
    cb({
      updates: [
        {
          values: [
            {
              path: 'navigation.course.activeRoute',
              value: {
                href: '/resources/routes/bench-route',
                pointIndex: 0,
                reverse: false
              }
            }
          ]
        }
      ]
    })
    // handleActiveRoute fetches the waypoints asynchronously; let the
    // microtasks settle so the route is committed to srcPaths before the
    // first measured tick.
    await new Promise((resolve) => setTimeout(resolve, 0))
  }

  return {
    deltaCallback: cb,
    stop: () => plugin.stop()
  }
}

export function positionDelta(lat: number, lon: number) {
  return {
    updates: [
      {
        values: [
          {
            path: 'navigation.position',
            value: { latitude: lat, longitude: lon }
          }
        ]
      }
    ]
  }
}

export function multiValueDelta(lat: number, lon: number) {
  return {
    updates: [
      {
        values: [
          {
            path: 'navigation.position',
            value: { latitude: lat, longitude: lon }
          },
          { path: 'navigation.headingTrue', value: 1.5 },
          { path: 'navigation.speedOverGround', value: 4.2 },
          { path: 'navigation.courseOverGroundTrue', value: 1.6 }
        ]
      }
    ]
  }
}
