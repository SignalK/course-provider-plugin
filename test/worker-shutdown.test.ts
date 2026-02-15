import { describe, expect, it, vi, beforeEach } from 'vitest'

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

vi.mock('worker_threads', () => ({
  Worker: MockWorker
}))

vi.mock('express', () => ({}))

describe('worker shutdown', () => {
  beforeEach(() => {
    instances.length = 0
  })

  it('terminates the worker on plugin stop', async () => {
    const pluginModule = (await import('../src/index.ts')) as {
      default?: unknown
      [key: string]: unknown
    }
    const pluginFactory = (pluginModule as any).default ?? (pluginModule as any)
    const factory = pluginFactory as (server: any) => {
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
        subscribe: vi.fn((_: unknown, unsubscribes: Array<() => void>) => {
          unsubscribes.push(() => {})
        })
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

    plugin.stop()

    expect(instances.length).toBe(1)
    expect(instances[0].removeAllListenersCalled).toBe(true)
    expect(instances[0].terminateCalled).toBe(true)
  })
})
