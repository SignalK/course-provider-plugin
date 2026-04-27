import { expect } from 'chai'
import { resetModuleCache, spy } from './helpers'

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

type DeltaCallback = (delta: unknown) => void

function startPluginCapturingDelta(): {
  stop: () => void
  deltaCallback: DeltaCallback
  worker: MockWorker
  server: any
} {
  // Replace Worker on the singleton worker_threads module so the plugin's
  // `new Worker(...)` call constructs MockWorker instead. Re-applied per
  // start because sibling test files may have installed their own
  // MockWorker subclass into the same singleton.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('worker_threads').Worker = MockWorker
  resetModuleCache('../src/index')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const factory = require('../src/index') as (server: any) => {
    start: (options: any) => void
    stop: () => void
  }

  let capturedDeltaCallback: DeltaCallback | null = null

  const server = {
    debug: spy(),
    error: spy(),
    setPluginStatus: spy(),
    setPluginError: spy(),
    handleMessage: spy(),
    getSelfPath: spy(() => null),
    getCourse: spy(() => Promise.resolve(null)),
    get: spy(),
    subscriptionmanager: {
      subscribe: spy(
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
      getResource: spy(() => Promise.resolve(null))
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
    deltaCallback: capturedDeltaCallback as DeltaCallback,
    worker: workerInstances[workerInstances.length - 1]!,
    server
  }
}

describe('delta handler dispatch', () => {
  beforeEach(() => {
    workerInstances.length = 0
  })

  // Positive path: a navigation.position delta should trigger the worker calc.
  it('forwards navigation.position value and triggers worker calc', () => {
    const { deltaCallback, worker, stop } = startPluginCapturingDelta()

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

    expect(worker.postedMessages.length).to.equal(1)
    const msg = worker.postedMessages[0] as Record<string, any>
    expect(msg['navigation.position']).to.deep.equal({
      latitude: 10,
      longitude: 20
    })

    stop()
  })

  // Non-position paths should be stored but not trigger a calc.
  it('stores non-position paths without triggering calc', () => {
    const { deltaCallback, worker, stop } = startPluginCapturingDelta()

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

    expect(worker.postedMessages.length).to.equal(0)
    stop()
  })

  // resources.routes.<id> paths must dispatch to the route update handler,
  // not fall through to srcPaths.
  it('dispatches resources.routes.* paths to handleRouteUpdate', async () => {
    const { deltaCallback, server, stop } = startPluginCapturingDelta()

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
    expect(server.resourcesApi.getResource.called).to.equal(false)
    stop()
  })

  // Mixed batch: one update, multiple values of different kinds.
  it('handles a batch with multiple value kinds in one update', () => {
    const { deltaCallback, worker, stop } = startPluginCapturingDelta()

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
    expect(worker.postedMessages.length).to.equal(1)
    const msg = worker.postedMessages[0] as Record<string, any>
    // All three values should be present in srcPaths by the time calc() runs.
    expect(msg['navigation.speedOverGround']).to.equal(4.2)
    expect(msg['navigation.position']).to.deep.equal({
      latitude: 1,
      longitude: 2
    })
    expect(msg['navigation.headingTrue']).to.equal(1.57)
    stop()
  })

  // Defensive: deltas with no updates or no values should not crash.
  it('tolerates delta with no updates', () => {
    const { deltaCallback, worker, stop } = startPluginCapturingDelta()
    deltaCallback({})
    expect(worker.postedMessages.length).to.equal(0)
    stop()
  })

  it('tolerates update with no values', () => {
    const { deltaCallback, worker, stop } = startPluginCapturingDelta()
    deltaCallback({ updates: [{}] })
    expect(worker.postedMessages.length).to.equal(0)
    stop()
  })

  // Boundary: multiple updates in a single delta.
  it('processes multiple updates in a single delta', () => {
    const { deltaCallback, worker, stop } = startPluginCapturingDelta()

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

    expect(worker.postedMessages.length).to.equal(1)
    const msg = worker.postedMessages[0] as Record<string, any>
    expect(msg['navigation.speedOverGround']).to.equal(3.1)
    expect(msg['navigation.position']).to.deep.equal({
      latitude: 5,
      longitude: 6
    })
    stop()
  })
})
