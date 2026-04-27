/*
 * Reusable mock-SignalK harness for bench/run.ts.
 *
 * Mocks the `Worker` class on `worker_threads` BEFORE the plugin is
 * loaded so the plugin's `new Worker(...)` call constructs the mock
 * instead. The dispatcher and helpers (lib/delta-msg, lib/alarms) all
 * run for real; we just don't want the actual worker thread spinning
 * up because (a) it does the geodesy maths off-thread and isn't what
 * the perf PRs target and (b) it makes results noisier.
 *
 * `createHarness()` returns a fresh plugin instance + delta callback +
 * mock worker. Multiple calls in the same process share the singleton
 * mock — that's fine because the plugin re-instantiates the Worker on
 * every start().
 */

import workerThreads from 'node:worker_threads'

export type DeltaCallback = (delta: unknown) => void

export class MockWorker {
  public postedMessages: unknown[] = []
  private listeners: Record<string, Array<(arg: unknown) => void>> = {}

  constructor(public filename: string) {}
  on(event: string, handler: (arg: unknown) => void) {
    this.listeners[event] = this.listeners[event] || []
    this.listeners[event].push(handler)
    return this
  }
  removeAllListeners() {
    this.listeners = {}
    return this
  }
  terminate() {
    return Promise.resolve(0)
  }
  postMessage(msg: unknown) {
    this.postedMessages.push(msg)
  }
  unref() {}
}

// Replace `Worker` on the singleton worker_threads module so any later
// `import { Worker } from 'worker_threads'` sees the mock. Runs once at
// import time; safe to call again.
;(workerThreads as any).Worker = MockWorker

export interface Harness {
  deltaCallback: DeltaCallback
  worker: MockWorker
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

let lastWorker: MockWorker | undefined
const origCtor = MockWorker
class TrackingWorker extends origCtor {
  constructor(filename: string) {
    super(filename)
    lastWorker = this
  }
}
;(workerThreads as any).Worker = TrackingWorker

export async function createHarness(
  opts: HarnessOptions = {}
): Promise<Harness> {
  const debugEnabled = opts.debugEnabled ?? false
  lastWorker = undefined

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
  if (!lastWorker) {
    throw new Error('plugin did not construct a Worker')
  }

  return {
    deltaCallback: deltaCallback as DeltaCallback,
    worker: lastWorker,
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
