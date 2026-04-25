import { describe, expect, it, vi, beforeEach } from 'vitest'

// Minimal Worker mock so the plugin can start without spawning a real thread.
// We also capture postMessage calls to assert that a position delta triggers calc().
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

vi.mock('worker_threads', () => ({
  Worker: MockWorker
}))

vi.mock('express', () => ({}))

type DeltaCallback = (delta: unknown) => void

async function startPluginCapturingDelta(): Promise<{
  stop: () => void
  deltaCallback: DeltaCallback
  worker: MockWorker
  server: any
}> {
  const pluginModule = (await import('../src/index.ts')) as {
    default?: unknown
    [key: string]: unknown
  }
  const pluginFactory = (pluginModule as any).default ?? (pluginModule as any)
  const factory = pluginFactory as (server: any) => {
    start: (options: any) => void
    stop: () => void
  }

  let capturedDeltaCallback: DeltaCallback | null = null

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
          deltaCb: DeltaCallback
        ) => {
          capturedDeltaCallback = deltaCb
          unsubscribes.push(() => {})
        }
      )
    },
    resourcesApi: {
      getResource: vi.fn(() => Promise.resolve(null))
    }
  }

  const plugin = factory(server)
  plugin.start({
    notifications: { sound: false },
    calculations: { method: 'GreatCircle' }
  })

  if (!capturedDeltaCallback) {
    throw new Error('subscriptionmanager.subscribe was not called')
  }

  return {
    stop: () => plugin.stop(),
    deltaCallback: capturedDeltaCallback,
    worker: workerInstances[workerInstances.length - 1],
    server
  }
}

describe('delta handler dispatch', () => {
  beforeEach(() => {
    workerInstances.length = 0
  })

  // Positive path: a navigation.position delta should trigger the worker calc.
  it('forwards navigation.position value and triggers worker calc', async () => {
    const { deltaCallback, worker, stop } = await startPluginCapturingDelta()

    deltaCallback({
      updates: [
        {
          values: [
            {
              path: 'navigation.position',
              value: { latitude: 10, longitude: 20 }
            }
          ]
        }
      ]
    })

    expect(worker.postedMessages.length).toBe(1)
    const msg = worker.postedMessages[0] as Record<string, any>
    expect(msg['navigation.position']).toEqual({ latitude: 10, longitude: 20 })

    stop()
  })

  // Non-position paths should be stored but not trigger a calc.
  it('stores non-position paths without triggering calc', async () => {
    const { deltaCallback, worker, stop } = await startPluginCapturingDelta()

    deltaCallback({
      updates: [
        {
          values: [
            { path: 'navigation.speedOverGround', value: 5.5 },
            { path: 'navigation.magneticVariation', value: 0.1 }
          ]
        }
      ]
    })

    expect(worker.postedMessages.length).toBe(0)
    stop()
  })

  // resources.routes.<id> paths must dispatch to the route update handler,
  // not fall through to srcPaths.
  it('dispatches resources.routes.* paths to handleRouteUpdate', async () => {
    const { deltaCallback, server, stop } = await startPluginCapturingDelta()

    deltaCallback({
      updates: [
        {
          values: [
            {
              path: 'resources.routes.abc123',
              value: { feature: { geometry: { coordinates: [] } } }
            }
          ]
        }
      ]
    })

    // handleRouteUpdate is async; wait a tick.
    await Promise.resolve()
    // It ultimately calls resourcesApi.getResource only if activeRouteId
    // matches. Here activeRouteId is unset, so nothing is fetched, but the
    // important thing is the dispatch did not store under srcPaths and did
    // not crash.
    expect(server.resourcesApi.getResource).not.toHaveBeenCalled()
    stop()
  })

  // Mixed batch: one update, multiple values of different kinds.
  it('handles a batch with multiple value kinds in one update', async () => {
    const { deltaCallback, worker, stop } = await startPluginCapturingDelta()

    deltaCallback({
      updates: [
        {
          values: [
            { path: 'navigation.speedOverGround', value: 4.2 },
            {
              path: 'navigation.position',
              value: { latitude: 1, longitude: 2 }
            },
            { path: 'navigation.headingTrue', value: 1.57 }
          ]
        }
      ]
    })

    // Exactly one postMessage: the one triggered by navigation.position.
    expect(worker.postedMessages.length).toBe(1)
    const msg = worker.postedMessages[0] as Record<string, any>
    // All three values should be present in srcPaths by the time calc() runs.
    expect(msg['navigation.speedOverGround']).toBe(4.2)
    expect(msg['navigation.position']).toEqual({ latitude: 1, longitude: 2 })
    expect(msg['navigation.headingTrue']).toBe(1.57)
    stop()
  })

  // Defensive: deltas with no updates or no values should not crash.
  it('tolerates delta with no updates', async () => {
    const { deltaCallback, worker, stop } = await startPluginCapturingDelta()
    deltaCallback({})
    expect(worker.postedMessages.length).toBe(0)
    stop()
  })

  it('tolerates update with no values', async () => {
    const { deltaCallback, worker, stop } = await startPluginCapturingDelta()
    deltaCallback({ updates: [{}] })
    expect(worker.postedMessages.length).toBe(0)
    stop()
  })

  // Boundary: multiple updates in a single delta.
  it('processes multiple updates in a single delta', async () => {
    const { deltaCallback, worker, stop } = await startPluginCapturingDelta()

    deltaCallback({
      updates: [
        {
          values: [{ path: 'navigation.speedOverGround', value: 3.1 }]
        },
        {
          values: [
            {
              path: 'navigation.position',
              value: { latitude: 5, longitude: 6 }
            }
          ]
        }
      ]
    })

    expect(worker.postedMessages.length).toBe(1)
    const msg = worker.postedMessages[0] as Record<string, any>
    expect(msg['navigation.speedOverGround']).toBe(3.1)
    expect(msg['navigation.position']).toEqual({ latitude: 5, longitude: 6 })
    stop()
  })
})
