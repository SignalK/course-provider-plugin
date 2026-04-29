import { expect } from 'chai'
import { mockModule, resetModuleCache, spy, type Spy } from './helpers'
import type { CourseData, SKPaths } from '../src/types'

type DeltaCallback = (delta: unknown) => void
type CalcsSpy = Spy<(src: SKPaths) => CourseData>

// Per-test mock-restore latch. Set by startPluginCapturingDelta(),
// torn down in afterEach so a failed assertion cannot leak the
// `src/worker/course` stub into a later test file.
let restoreCourse: (() => void) | null = null

afterEach(() => {
  if (restoreCourse) {
    restoreCourse()
    restoreCourse = null
  }
})

interface StartOptions {
  /**
   * Custom parseSKPaths implementation (defaults to always-true so calc()
   * always reaches the calcs branch). Tests of the activeDest flip pass
   * a programmable returner.
   */
  parseSKPaths?: (src: SKPaths) => boolean
  /**
   * Custom calcs return value. Defaults to an empty CourseData; tests
   * that assert on the published delta payload pass a non-trivial
   * fixture.
   */
  calcsReturn?: CourseData
}

// Stub `calcs`/`parseSKPaths` so the dispatcher can run inline without
// the real geodesy. The calcs spy doubles as our test-visible snapshot
// of `srcPaths` at the moment calc() ran (its first argument).
function startPluginCapturingDelta(opts: StartOptions = {}): {
  stop: () => void
  deltaCallback: DeltaCallback
  calcsSpy: CalcsSpy
  server: any
} {
  const fixed: CourseData = opts.calcsReturn ?? {
    gc: {},
    rl: {},
    passedPerpendicular: false
  }
  const calcsSpy = spy<(src: SKPaths) => CourseData>(() => fixed)
  restoreCourse = mockModule('../src/worker/course', {
    calcs: calcsSpy,
    parseSKPaths: opts.parseSKPaths ?? (() => true)
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
    stop: () => plugin.stop(),
    deltaCallback: capturedDeltaCallback as DeltaCallback,
    calcsSpy,
    server
  }
}

function positionDelta(lat: number, lon: number) {
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

  // Skip the calc entirely when navigation.position is missing — the
  // dispatcher's first guard. Without this, parseSKPaths would receive
  // a srcPaths with no position and cascade into the wrong branch.
  it('skips calc when navigation.position is missing', () => {
    const { deltaCallback, calcsSpy, server, stop } =
      startPluginCapturingDelta()

    deltaCallback({
      updates: [
        {
          values: [{ path: 'navigation.speedOverGround', value: 5 }]
        }
      ]
    })

    expect(calcsSpy.calls.length).to.equal(0)
    expect(server.handleMessage.called).to.equal(false)
    stop()
  })
})

// Pins the activeDest flip — the cleared-state delta has to fire
// exactly once when the navigation context becomes incomplete after
// being complete, then stay silent until it becomes complete again.
// Pre-refactor this lived in the worker module; now it lives in the
// plugin closure.
describe('activeDest flip', () => {
  it('emits one calc, one cleared-state delta, then stays silent on idle ticks', () => {
    let parseResult = true
    const calcsReturn: CourseData = {
      gc: { calcMethod: 'GreatCircle', distance: 1234 },
      rl: { calcMethod: 'Rhumbline', distance: 1235 },
      passedPerpendicular: false
    }
    const { deltaCallback, calcsSpy, server, stop } = startPluginCapturingDelta(
      {
        parseSKPaths: () => parseResult,
        calcsReturn
      }
    )

    // Tick 1: complete context → calcs runs and a calcValues delta fires.
    deltaCallback(positionDelta(50, 8))
    expect(calcsSpy.calls.length).to.equal(1)
    // Two handleMessage calls expected on the very first complete tick:
    // the calcValues delta and the once-only meta delta.
    expect(server.handleMessage.calls.length).to.equal(2)

    // Tick 2: context becomes incomplete → exactly one cleared-state
    // calcValues delta is emitted from the activeDest=true path. No
    // further calcs() invocation.
    parseResult = false
    deltaCallback(positionDelta(50, 8))
    expect(calcsSpy.calls.length).to.equal(1)
    expect(server.handleMessage.calls.length).to.equal(3)

    // Tick 3: still incomplete and activeDest is now false → idle. No
    // new handleMessage call.
    deltaCallback(positionDelta(50, 8))
    expect(calcsSpy.calls.length).to.equal(1)
    expect(server.handleMessage.calls.length).to.equal(3)

    // Tick 4: context complete again → fresh calcs run and one more
    // calcValues delta. Meta delta is NOT re-emitted (latch).
    parseResult = true
    deltaCallback(positionDelta(50, 8))
    expect(calcsSpy.calls.length).to.equal(2)
    expect(server.handleMessage.calls.length).to.equal(4)

    stop()
  })

  it('publishes the buildDeltaMsg payload from the configured method on each calc', () => {
    const calcsReturn: CourseData = {
      gc: { calcMethod: 'GreatCircle', distance: 9999 },
      rl: {},
      passedPerpendicular: false
    }
    const { deltaCallback, server, stop } = startPluginCapturingDelta({
      calcsReturn
    })

    deltaCallback(positionDelta(50, 8))

    // The calcValues delta is the first handleMessage call; the meta
    // delta is the second. Both go through SKVersion.v2.
    const firstCall = server.handleMessage.calls[0]
    expect(firstCall).to.exist
    const [, payload, version] = firstCall!
    // SKVersion.v2 is exported as the string 'v2' from server-api.
    expect(version).to.equal('v2')
    const distanceEntry = (
      payload as {
        updates: Array<{ values: Array<{ path: string; value: any }> }>
      }
    ).updates[0]!.values.find(
      (v) => v.path === 'navigation.course.calcValues.distance'
    )
    expect(distanceEntry).to.exist
    expect(distanceEntry!.value).to.equal(9999)

    stop()
  })
})
