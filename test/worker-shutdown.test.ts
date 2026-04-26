import { expect } from 'chai'
import { resetModuleCache, spy } from './helpers'

const instances: MockWorker[] = []

class MockWorker {
  public removeAllListenersCalled = false
  public terminateCalled = false
  public unrefCalled = false
  private listeners: Record<string, Array<(arg: unknown) => void>> = {}

  constructor(public filename: string) {
    instances.push(this)
  }

  on(event: string, handler: (arg: unknown) => void) {
    this.listeners[event] = this.listeners[event] || []
    this.listeners[event].push(handler)
    return this
  }

  removeAllListeners() {
    this.removeAllListenersCalled = true
    this.listeners = {}
    return this
  }

  terminate() {
    this.terminateCalled = true
    return Promise.resolve(0)
  }

  postMessage() {}

  unref() {
    this.unrefCalled = true
  }
}

describe('worker shutdown', () => {
  beforeEach(() => {
    instances.length = 0
  })

  it('terminates the worker on plugin stop', () => {
    // Re-applied here (not at top level) because sibling test files
    // mutate the same Worker slot.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('worker_threads').Worker = MockWorker
    resetModuleCache('../src/index')
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const factory = require('../src/index') as (server: any) => {
      start: (options: any) => void
      stop: () => void
    }

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
        subscribe: spy((_: unknown, unsubscribes: Array<() => void>) => {
          unsubscribes.push(() => {})
        })
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

    plugin.stop()

    expect(instances.length).to.equal(1)
    expect(instances[0].removeAllListenersCalled).to.equal(true)
    expect(instances[0].terminateCalled).to.equal(true)
  })
})
