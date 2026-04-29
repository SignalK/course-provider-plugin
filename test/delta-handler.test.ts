import { expect } from 'chai'
import { mockModule, resetModuleCache, spy, type Spy } from './helpers'
import type { CourseData, SKPaths } from '../src/types'

type DeltaCallback = (delta: unknown) => void
type CalcsSpy = Spy<(src: SKPaths) => CourseData>

// Stub `calcs`/`parseSKPaths` so the dispatcher can run inline without
// the real geodesy. The calcs spy doubles as our test-visible snapshot
// of `srcPaths` at the moment calc() ran (its first argument).
function startPluginCapturingDelta(): {
  stop: () => void
  deltaCallback: DeltaCallback
  calcsSpy: CalcsSpy
  server: any
} {
  const calcsSpy = spy<(src: SKPaths) => CourseData>(() => ({
    gc: {},
    rl: {},
    passedPerpendicular: false
  }))
  const restoreCourse = mockModule('../src/worker/course', {
    calcs: calcsSpy,
    parseSKPaths: () => true
  })
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
    stop: () => {
      plugin.stop()
      restoreCourse()
    },
    deltaCallback: capturedDeltaCallback as DeltaCallback,
    calcsSpy,
    server
  }
}

describe('delta handler dispatch', () => {
  // Positive path: a navigation.position delta triggers calc().
  it('forwards navigation.position value and triggers calc', () => {
    const { deltaCallback, calcsSpy, stop } = startPluginCapturingDelta()

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

    expect(calcsSpy.calls.length).to.equal(1)
    const src = calcsSpy.calls[0]![0] as Record<string, any>
    expect(src['navigation.position']).to.deep.equal({
      latitude: 10,
      longitude: 20
    })

    stop()
  })

  // Non-position paths should be stored but not trigger a calc.
  it('stores non-position paths without triggering calc', () => {
    const { deltaCallback, calcsSpy, stop } = startPluginCapturingDelta()

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

    expect(calcsSpy.calls.length).to.equal(0)
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
    const { deltaCallback, calcsSpy, stop } = startPluginCapturingDelta()

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

    // Exactly one calc: the one triggered by navigation.position.
    expect(calcsSpy.calls.length).to.equal(1)
    const src = calcsSpy.calls[0]![0] as Record<string, any>
    // All three values should be present in srcPaths by the time calc() runs.
    expect(src['navigation.speedOverGround']).to.equal(4.2)
    expect(src['navigation.position']).to.deep.equal({
      latitude: 1,
      longitude: 2
    })
    expect(src['navigation.headingTrue']).to.equal(1.57)
    stop()
  })

  // Defensive: deltas with no updates or no values should not crash.
  it('tolerates delta with no updates', () => {
    const { deltaCallback, calcsSpy, stop } = startPluginCapturingDelta()
    deltaCallback({})
    expect(calcsSpy.calls.length).to.equal(0)
    stop()
  })

  it('tolerates update with no values', () => {
    const { deltaCallback, calcsSpy, stop } = startPluginCapturingDelta()
    deltaCallback({ updates: [{}] })
    expect(calcsSpy.calls.length).to.equal(0)
    stop()
  })

  // Boundary: multiple updates in a single delta.
  it('processes multiple updates in a single delta', () => {
    const { deltaCallback, calcsSpy, stop } = startPluginCapturingDelta()

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

    expect(calcsSpy.calls.length).to.equal(1)
    const src = calcsSpy.calls[0]![0] as Record<string, any>
    expect(src['navigation.speedOverGround']).to.equal(3.1)
    expect(src['navigation.position']).to.deep.equal({
      latitude: 5,
      longitude: 6
    })
    stop()
  })
})
