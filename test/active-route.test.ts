import { expect } from 'chai'
import { resetModuleCache, spy } from './helpers'

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

type DeltaCallback = (delta: unknown) => void

function startPlugin(getResourceImpl: (id: string) => Promise<any>) {
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

  let deltaCallback: DeltaCallback | null = null

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
          cb: DeltaCallback
        ) => {
          deltaCallback = cb
          unsubscribes.push(() => {})
        }
      )
    },
    resourcesApi: { getResource: spy(getResourceImpl) }
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
    worker: workerInstances[workerInstances.length - 1]!,
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
  expect(after).to.be.greaterThan(before)
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
    const { deltaCallback, worker, server, stop } = startPlugin(async () => ({
      feature: { geometry: { coordinates: waypoints } }
    }))

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

    expect(server.resourcesApi.getResource.calledWith('routes', 'abc123')).to.be
      .true
    expect(snapshot.activeRoute).to.exist
    expect(snapshot.activeRoute.href).to.equal('/resources/routes/abc123')
    expect(snapshot.activeRoute.waypoints).to.deep.equal(waypoints)
    // Important: stored object is a fresh copy, not the original delta value,
    // so the plugin owns its own state and cannot bleed back into upstream.
    expect(snapshot.activeRoute).to.not.equal(routeValue)

    stop()
  })

  it('clears activeRoute when delta value is null', async () => {
    const { deltaCallback, worker, stop } = startPlugin(async () => null)

    deltaCallback({
      updates: [
        {
          values: [{ path: 'navigation.course.activeRoute', value: null }]
        }
      ]
    })
    await new Promise((r) => setTimeout(r, 0))

    const snapshot = await snapshotSrcPaths(deltaCallback, worker)
    expect(snapshot.activeRoute).to.be.null
    stop()
  })
})
