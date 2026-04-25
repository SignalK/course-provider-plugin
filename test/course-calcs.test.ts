import { describe, expect, it, beforeEach, vi } from 'vitest'

// LatLon stub. Methods return deterministic values derived from the points'
// coordinates so tests can predict output and assert on call counts.
//
// distance(a, b)        = hypot(dLat, dLon) * 1000   (m)
// rhumbDistance(a, b)   = distance(a, b) + 0.5       (so gc and rl are
//                                                     distinguishable but
//                                                     close in magnitude)
// initialBearing(a, b)  = ((b.lon - a.lon) * 90 + 360) mod 360  (deg)
// rhumbBearing(a, b)    = initialBearing(a, b) + 1   (deg)
class StubLatLon {
  constructor(public lat: number, public lon: number) {}
  distanceTo(other: StubLatLon): number {
    const dLat = other.lat - this.lat
    const dLon = other.lon - this.lon
    return Math.hypot(dLat, dLon) * 1000
  }
  rhumbDistanceTo(other: StubLatLon): number {
    return this.distanceTo(other) + 0.5
  }
  initialBearingTo(other: StubLatLon): number {
    return ((other.lon - this.lon) * 90 + 360) % 360
  }
  rhumbBearingTo(other: StubLatLon): number {
    return (this.initialBearingTo(other) + 1) % 360
  }
  crossTrackDistanceTo(_a: StubLatLon, _b: StubLatLon): number {
    return 0
  }
}

vi.mock('../src/lib/geodesy/latlon-spherical.js', () => ({
  LatLonSpherical: StubLatLon
}))

beforeEach(() => {
  // Reset the module registry between tests so state introduced by the
  // module under test starts clean and prototype spies are torn down.
  vi.restoreAllMocks()
  vi.resetModules()
})

function srcWithFix(opts?: {
  magVar?: number
  next?: { latitude: number; longitude: number }
}): Record<string, any> {
  return {
    'navigation.position': { latitude: 0, longitude: 0 },
    'navigation.course.previousPoint': {
      position: { latitude: 0, longitude: 0 }
    },
    'navigation.course.nextPoint': {
      position: opts?.next ?? { latitude: 0, longitude: 1 }
    },
    'navigation.magneticVariation': opts?.magVar ?? 0,
    'navigation.courseOverGroundTrue': Math.PI / 2,
    'navigation.speedOverGround': 5,
    'environment.wind.angleTrueGround': 0
  }
}

describe('calcs computes only the configured method (task 3)', () => {
  it('populates only `gc` for GreatCircle and leaves `rl` empty', async () => {
    const { calcs } = (await import('../src/worker/course')) as any
    const result = calcs(srcWithFix(), 'GreatCircle')

    expect(result.gc.calcMethod).toBe('GreatCircle')
    expect(typeof result.gc.distance).toBe('number')
    expect(result.rl).toEqual({})
  })

  it('populates only `rl` for Rhumbline and leaves `gc` empty', async () => {
    const { calcs } = (await import('../src/worker/course')) as any
    const result = calcs(srcWithFix(), 'Rhumbline')

    expect(result.rl.calcMethod).toBe('Rhumbline')
    expect(typeof result.rl.distance).toBe('number')
    // The stubbed rhumb distance differs from the great-circle distance by 0.5
    // so we can be certain the rhumb branch was taken.
    expect(result.rl.distance).toBeCloseTo(1000.5, 5)
    expect(result.gc).toEqual({})
  })

  // The guard at the top of calcs() is `!vesselPosition || !destination ||
  // !startPoint`. Each missing input must independently short-circuit to the
  // empty-result shape; a refactor that drops one branch should be caught here.
  it('returns empty branches when navigation.position is missing', async () => {
    const { calcs } = (await import('../src/worker/course')) as any
    const src = srcWithFix()
    delete src['navigation.position']
    expect(calcs(src, 'GreatCircle')).toEqual({
      gc: {},
      rl: {},
      passedPerpendicular: false
    })
  })

  it('returns empty branches when nextPoint is missing', async () => {
    const { calcs } = (await import('../src/worker/course')) as any
    const src = srcWithFix()
    delete src['navigation.course.nextPoint']
    expect(calcs(src, 'GreatCircle')).toEqual({
      gc: {},
      rl: {},
      passedPerpendicular: false
    })
  })

  it('returns empty branches when previousPoint position is missing', async () => {
    const { calcs } = (await import('../src/worker/course')) as any
    const src = srcWithFix()
    src['navigation.course.previousPoint'] = {} // present but no .position
    expect(calcs(src, 'GreatCircle')).toEqual({
      gc: {},
      rl: {},
      passedPerpendicular: false
    })
  })
})

describe('track bearing cache (task 4)', () => {
  it('skips the prev->next bearing call on a cached tick', async () => {
    const { LatLonSpherical } = (await import(
      '../src/lib/geodesy/latlon-spherical.js'
    )) as any
    const { calcs } = (await import('../src/worker/course')) as any

    calcs(srcWithFix(), 'GreatCircle')

    const spy = vi.spyOn(LatLonSpherical.prototype, 'initialBearingTo')
    calcs(srcWithFix(), 'GreatCircle')

    // Cache warm: bearingTrue (1) + passedPerpendicular (2) = 3.
    // The track bearing (previousPoint -> nextPoint) is served from cache.
    expect(spy).toHaveBeenCalledTimes(3)
  })

  it('recomputes the track bearing when nextPoint changes', async () => {
    const { LatLonSpherical } = (await import(
      '../src/lib/geodesy/latlon-spherical.js'
    )) as any
    const { calcs } = (await import('../src/worker/course')) as any

    calcs(srcWithFix(), 'GreatCircle')

    const spy = vi.spyOn(LatLonSpherical.prototype, 'initialBearingTo')
    // Change latitude only — keeps stub bearings (lon-driven) unchanged so
    // the downstream timeCalcs math stays well-defined, while the cache key
    // (nextLat) still differs and forces a recompute.
    calcs(srcWithFix({ next: { latitude: 0.5, longitude: 1 } }), 'GreatCircle')

    // Cache miss: track (1) + bearingTrue (1) + passedPerpendicular (2) = 4.
    expect(spy).toHaveBeenCalledTimes(4)
  })

  it('recomputes the track bearing when previousPoint changes', async () => {
    const { LatLonSpherical } = (await import(
      '../src/lib/geodesy/latlon-spherical.js'
    )) as any
    const { calcs } = (await import('../src/worker/course')) as any

    calcs(srcWithFix(), 'GreatCircle')

    const spy = vi.spyOn(LatLonSpherical.prototype, 'initialBearingTo')
    // Shift previousPoint latitude. The cache key (prevLat) differs so the
    // track bearing must be recomputed even though nextPoint is unchanged.
    const moved = srcWithFix()
    moved['navigation.course.previousPoint'].position.latitude = 0.5
    calcs(moved, 'GreatCircle')

    expect(spy).toHaveBeenCalledTimes(4)
  })

  it('recomputes the magnetic track bearing when magneticVariation changes', async () => {
    const { calcs } = (await import('../src/worker/course')) as any

    const a = calcs(srcWithFix({ magVar: 0 }), 'GreatCircle')
    const b = calcs(srcWithFix({ magVar: 0.1 }), 'GreatCircle')

    expect(b.gc.bearingTrackTrue).toBe(a.gc.bearingTrackTrue)
    expect(b.gc.bearingTrackMagnetic).not.toBe(a.gc.bearingTrackMagnetic)
  })

  it('recomputes when switching method (gc <-> rl)', async () => {
    const { LatLonSpherical } = (await import(
      '../src/lib/geodesy/latlon-spherical.js'
    )) as any
    const { calcs } = (await import('../src/worker/course')) as any

    calcs(srcWithFix(), 'GreatCircle')

    const rhumbSpy = vi.spyOn(LatLonSpherical.prototype, 'rhumbBearingTo')
    const result = calcs(srcWithFix(), 'Rhumbline')

    // Switching method invalidates the track bearing cache so the rhumb
    // bearing has to be computed: rhumbBearingTo for both track and bearing.
    expect(rhumbSpy).toHaveBeenCalledTimes(2)
    expect(result.gc).toEqual({})
  })
})

describe('routeRemaining cache and cursor reuse (tasks 5, 6)', () => {
  // A 4-waypoint route along the equator: 1deg + 1deg + 1deg = 3deg, which
  // the stub maps to 3 * 1000 = 3000 m.
  //
  // `waypointsVersion` is the cache key that survives the structured clone
  // performed by worker.postMessage. The main thread bumps it whenever
  // activeRoute.waypoints is reassigned; tests pass it explicitly to model
  // that behaviour.
  function routeSrc(waypointsVersion: number = 1): Record<string, any> {
    return {
      activeRoute: {
        waypoints: [
          [0, 0],
          [1, 0],
          [2, 0],
          [3, 0]
        ] as Array<[number, number]>,
        pointIndex: 0,
        reverse: false,
        waypointsVersion
      }
    }
  }

  it('returns the great-circle total of remaining segments', async () => {
    const { routeRemaining } = (await import('../src/worker/course')) as any
    expect(routeRemaining(routeSrc(), false)).toBe(3000)
  })

  it('returns the rhumb-line total of remaining segments', async () => {
    const { routeRemaining } = (await import('../src/worker/course')) as any
    // Stub adds 0.5 per segment to differentiate from gc; 3 segments -> +1.5.
    expect(routeRemaining(routeSrc(), true)).toBe(3001.5)
  })

  it('serves repeated calls from cache without re-summing segments', async () => {
    const { LatLonSpherical } = (await import(
      '../src/lib/geodesy/latlon-spherical.js'
    )) as any
    const { routeRemaining } = (await import('../src/worker/course')) as any

    const src = routeSrc()
    const first = routeRemaining(src, false)

    const spy = vi.spyOn(LatLonSpherical.prototype, 'distanceTo')
    const second = routeRemaining(src, false)
    expect(second).toBe(first)
    expect(spy).not.toHaveBeenCalled()
  })

  it('runs exactly one distance call per segment (no double allocation)', async () => {
    const { LatLonSpherical } = (await import(
      '../src/lib/geodesy/latlon-spherical.js'
    )) as any
    const { routeRemaining } = (await import('../src/worker/course')) as any

    const distSpy = vi.spyOn(LatLonSpherical.prototype, 'distanceTo')
    routeRemaining(routeSrc(), false)
    // 4 waypoints, fromIndex 0, toIndex 3 -> 3 segments -> 3 distance calls.
    // Cursor reuse keeps this at one call per segment instead of paying for
    // two LatLon constructions per iteration.
    expect(distSpy).toHaveBeenCalledTimes(3)
  })

  it('invalidates when waypointsVersion bumps (route content changed)', async () => {
    const { LatLonSpherical } = (await import(
      '../src/lib/geodesy/latlon-spherical.js'
    )) as any
    const { routeRemaining } = (await import('../src/worker/course')) as any

    routeRemaining(routeSrc(1), false)

    const replaced = routeSrc(2) // version bumped: route content has changed
    replaced.activeRoute.waypoints[3] = [4, 0] // total now 4 segments worth
    const spy = vi.spyOn(LatLonSpherical.prototype, 'distanceTo')
    const total = routeRemaining(replaced, false)

    expect(spy).toHaveBeenCalled()
    expect(total).toBe(4000)
  })

  it('hits cache after structuredClone (across worker postMessage)', async () => {
    const { LatLonSpherical } = (await import(
      '../src/lib/geodesy/latlon-spherical.js'
    )) as any
    const { routeRemaining } = (await import('../src/worker/course')) as any

    // Models the production flow: main thread builds srcPaths once, posts to
    // the worker every tick, Node structured-clones the envelope. The cache
    // must hit on the cloned object as long as waypointsVersion is unchanged.
    const tick1 = routeSrc(7)
    const first = routeRemaining(tick1, false)

    const tick2 = structuredClone(tick1)
    const spy = vi.spyOn(LatLonSpherical.prototype, 'distanceTo')
    const second = routeRemaining(tick2, false)

    expect(second).toBe(first)
    expect(spy).not.toHaveBeenCalled()
  })

  it('invalidates when pointIndex advances', async () => {
    const { routeRemaining } = (await import('../src/worker/course')) as any

    const src = routeSrc()
    const fromStart = routeRemaining(src, false)

    src.activeRoute.pointIndex = 2
    const fromMid = routeRemaining(src, false)

    expect(fromStart).toBe(3000)
    // Only the last segment remains: 1 * 1000 = 1000 m.
    expect(fromMid).toBe(1000)
  })

  it('invalidates when reverse flag changes', async () => {
    const { LatLonSpherical } = (await import(
      '../src/lib/geodesy/latlon-spherical.js'
    )) as any
    const { routeRemaining } = (await import('../src/worker/course')) as any

    const src = routeSrc()
    src.activeRoute.pointIndex = 1
    routeRemaining(src, false)

    // Spy after the cache is warm; flipping `reverse` must force a recompute
    // even though waypointsVersion / pointIndex / rhumbLine are unchanged.
    const spy = vi.spyOn(LatLonSpherical.prototype, 'distanceTo')
    src.activeRoute.reverse = true
    routeRemaining(src, false)

    expect(spy).toHaveBeenCalled()
  })

  it('returns 0 in reverse when pointIndex equals lastIndex', async () => {
    const { routeRemaining } = (await import('../src/worker/course')) as any
    const src = routeSrc()
    src.activeRoute.pointIndex = 3 // = lastIndex
    src.activeRoute.reverse = true
    // Reverse early-return: fromIndex 0, toIndex = lastIndex - lastIndex = 0.
    expect(routeRemaining(src, false)).toBe(0)
  })

  it('invalidates when geodesy flavour changes', async () => {
    const { LatLonSpherical } = (await import(
      '../src/lib/geodesy/latlon-spherical.js'
    )) as any
    const { routeRemaining } = (await import('../src/worker/course')) as any

    routeRemaining(routeSrc(), false)

    const spy = vi.spyOn(LatLonSpherical.prototype, 'rhumbDistanceTo')
    const rhumbTotal = routeRemaining(routeSrc(), true)
    expect(spy).toHaveBeenCalled()
    expect(rhumbTotal).toBe(3001.5)
  })

  it('returns 0 when fewer than two waypoints remain', async () => {
    const { routeRemaining } = (await import('../src/worker/course')) as any
    const src = {
      activeRoute: {
        waypoints: [
          [0, 0],
          [1, 0]
        ],
        pointIndex: 1,
        reverse: false
      }
    }
    expect(routeRemaining(src, false)).toBe(0)
  })

  it('returns 0 when pointIndex is null', async () => {
    const { routeRemaining } = (await import('../src/worker/course')) as any
    const src = {
      activeRoute: {
        waypoints: [
          [0, 0],
          [1, 0]
        ],
        pointIndex: null,
        reverse: false
      }
    }
    expect(routeRemaining(src, false)).toBe(0)
  })
})
