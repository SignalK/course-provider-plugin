import { describe, expect, it, vi, beforeEach } from 'vitest'

// Tests the main-thread side of the worker -> main round trip: when the
// worker fires a `message` event with a CourseData result, calcResult must
// drive the arrival watcher and the published delta from the configured
// method's branch — not unconditionally from `gc`.

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

  postMessage(_msg: unknown) {}

  unref() {}

  // Test-only: invokes registered listeners synchronously, simulating the
  // worker firing back into the main thread.
  fire(event: string, arg: unknown) {
    const handlers = this.listeners[event] ?? []
    for (const h of handlers) h(arg)
  }
}

vi.mock('worker_threads', () => ({ Worker: MockWorker }))
vi.mock('express', () => ({}))

beforeEach(() => {
  workerInstances.length = 0
  vi.resetModules()
})

async function startPlugin(method: 'GreatCircle' | 'Rhumbline') {
  const pluginModule = (await import('../src/index.ts')) as any
  const factory = (pluginModule.default ?? pluginModule) as (server: any) => {
    start: (options: any) => void
    stop: () => void
  }

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
      subscribe: vi.fn((_sub: unknown, unsubscribes: Array<() => void>) => {
        unsubscribes.push(() => {})
      })
    },
    resourcesApi: { getResource: vi.fn(() => Promise.resolve(null)) }
  }

  const plugin = factory(server)
  plugin.start({ notifications: { sound: false }, calculations: { method } })
  return {
    server,
    worker: workerInstances[workerInstances.length - 1],
    stop: () => plugin.stop()
  }
}

function distanceFromDelta(handleMessageMock: any): number | null {
  // The plugin emits a v2 delta whose `values` array is the fixed-shape
  // output of buildDeltaMsg. The distance entry is at index 5.
  for (const call of handleMessageMock.mock.calls) {
    const msg = call[1]
    const values = msg?.updates?.[0]?.values
    if (!Array.isArray(values)) continue
    for (const v of values) {
      if (v.path === 'navigation.course.calcValues.distance') {
        return v.value
      }
    }
  }
  return null
}

describe('calcResult selects the configured method branch', () => {
  it('publishes Rhumbline distance when configured for Rhumbline', async () => {
    const { server, worker, stop } = await startPlugin('Rhumbline')

    worker.fire('message', {
      gc: {},
      rl: { distance: 1234, calcMethod: 'Rhumbline' },
      passedPerpendicular: false
    })

    expect(distanceFromDelta(server.handleMessage)).toBe(1234)
    stop()
  })

  it('publishes GreatCircle distance when configured for GreatCircle', async () => {
    const { server, worker, stop } = await startPlugin('GreatCircle')

    worker.fire('message', {
      gc: { distance: 5678, calcMethod: 'GreatCircle' },
      rl: {},
      passedPerpendicular: false
    })

    expect(distanceFromDelta(server.handleMessage)).toBe(5678)
    stop()
  })
})
