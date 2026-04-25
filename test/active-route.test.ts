import { describe, expect, it, vi, beforeEach } from 'vitest'

// Mock the worker so the plugin can start; we don't care about calc results here.
const workerInstances: MockWorker[] = []

class MockWorker {
  public postedMessages: unknown[] = []
  private listeners: Record<string, Array<(arg: unknown) => void>> = {}

  constructor(public filename: string) {
    workerInstances.push(this)
  }
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

vi.mock('worker_threads', () => ({ Worker: MockWorker }))
vi.mock('express', () => ({}))

type DeltaCallback = (delta: unknown) => void

// Start the plugin, capture the delta callback, and expose a way to read
// `srcPaths['activeRoute']` via the `message` handler we attach on the
// worker mock (calc() pushes the full srcPaths snapshot into the worker
// and that is the only test-visible read-out of the internal state).
async function startPlugin(getResourceImpl: (id: string) => Promise<any>) {
  const pluginModule = (await import('../src/index.ts')) as {
    default?: unknown
    [key: string]: unknown
  }
  const factory = ((pluginModule as any).default ?? (pluginModule as any)) as (
    server: any
  ) => { start: (options: any) => void; stop: () => void }

  let deltaCallback: DeltaCallback | null = null

  const server = {
    debug: vi.fn(),
    error: vi.fn(),
    setPluginStatus: vi.fn(),
    setPluginError: vi.fn(),
    handleMessage: vi.fn(),
    getSelfPath: vi.fn(() => null),
    getCourse: vi.fn(() => Promise.resolve(null)),
    get: vi.fn(),
    subscriptionmanager: {
      subscribe: vi.fn(
        (
          _sub: unknown,
          unsubscribes: Array<() => void>,
          _err: unknown,
          cb: DeltaCallback
        ) => {
          deltaCallback = cb
          unsubscribes.push(() => {})
        }
      )
    },
    resourcesApi: { getResource: vi.fn(getResourceImpl) }
  }

  const plugin = factory(server)
  plugin.start({
    notifications: { sound: false },
    calculations: { method: 'GreatCircle' }
  })

  if (!deltaCallback) throw new Error('subscribe was not called')

  return {
    stop: () => plugin.stop(),
    deltaCallback: deltaCallback as DeltaCallback,
    worker: workerInstances[workerInstances.length - 1],
    server
  }
}

// Drive a navigation.position through the dispatcher so the worker mock
// receives the current srcPaths snapshot. Returns that snapshot object.
async function snapshotSrcPaths(
  deltaCallback: DeltaCallback,
  worker: MockWorker
): Promise<Record<string, any>> {
  const before = worker.postedMessages.length
  deltaCallback({
    updates: [
      {
        values: [
          {
            path: 'navigation.position',
            value: { latitude: 0, longitude: 0 }
          }
        ]
      }
    ]
  })
  // Give any pending microtasks (from handleActiveRoute awaits) a chance to settle.
  await new Promise((r) => setTimeout(r, 0))
  const after = worker.postedMessages.length
  expect(after).toBeGreaterThan(before)
  return worker.postedMessages[after - 1] as Record<string, any>
}

describe('navigation.course.activeRoute dispatch', () => {
  beforeEach(() => {
    workerInstances.length = 0
  })

  // Pins the post-handleActiveRoute storage shape so a refactor that drops
  // the `{ ...v.value }` spread still produces an entry containing href and
  // waypoints fetched from resourcesApi.
  it('stores activeRoute with waypoints fetched from resourcesApi', async () => {
    const waypoints = [
      [10, 20],
      [11, 21],
      [12, 22]
    ]
    const { deltaCallback, worker, server, stop } = await startPlugin(
      async () => ({ feature: { geometry: { coordinates: waypoints } } })
    )

    const routeValue = {
      href: '/resources/routes/abc123',
      name: 'Test Route'
    }

    deltaCallback({
      updates: [
        {
          values: [{ path: 'navigation.course.activeRoute', value: routeValue }]
        }
      ]
    })

    // Wait for the async getResource in handleActiveRoute to settle.
    await new Promise((r) => setTimeout(r, 0))

    // Now drive a position update so the worker mock receives srcPaths
    // containing the stored activeRoute.
    const snapshot = await snapshotSrcPaths(deltaCallback, worker)

    expect(server.resourcesApi.getResource).toHaveBeenCalledWith(
      'routes',
      'abc123'
    )
    expect(snapshot.activeRoute).toBeTruthy()
    expect(snapshot.activeRoute.href).toBe('/resources/routes/abc123')
    expect(snapshot.activeRoute.waypoints).toEqual(waypoints)
    // Important: stored object is a fresh copy, not the original delta value,
    // so the plugin owns its own state and cannot bleed back into upstream.
    expect(snapshot.activeRoute).not.toBe(routeValue)

    stop()
  })

  it('clears activeRoute when delta value is null', async () => {
    const { deltaCallback, worker, stop } = await startPlugin(async () => null)

    deltaCallback({
      updates: [
        {
          values: [{ path: 'navigation.course.activeRoute', value: null }]
        }
      ]
    })
    await new Promise((r) => setTimeout(r, 0))

    const snapshot = await snapshotSrcPaths(deltaCallback, worker)
    expect(snapshot.activeRoute).toBeNull()
    stop()
  })
})
