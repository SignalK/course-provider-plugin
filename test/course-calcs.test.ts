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
