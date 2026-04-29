/*
 * Reusable mock-SignalK harness for bench/run.ts.
 *
 * Wires up a stub server so the plugin can be `start()`ed in-process,
 * and returns the captured delta callback so each scenario can drive
 * deltas through the dispatcher. The plugin runs `calcs()` inline on
 * the same thread now (no worker thread), so the bench measures the
 * full per-tick cost: dispatch + parseSKPaths + calcs + buildDeltaMsg.
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
}

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
    resourcesApi: { getResource: () => Promise.resolve(null) }
  }

  const plugin = factory(server)
  plugin.start({
    notifications: { sound: false },
    calculations: { method: 'GreatCircle' }
  })

  if (!deltaCallback) {
    throw new Error('subscribe was not called during plugin.start')
  }

  return {
    deltaCallback: deltaCallback as DeltaCallback,
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
