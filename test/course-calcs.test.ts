import { expect } from 'chai'
import { mockModule, resetModuleCache } from './helpers'

// LatLon stub. Methods return deterministic values derived from the points'
// coordinates so tests can predict output and assert on call counts.
//
// distance(a, b)        = hypot(dLat, dLon) * 1000   (m)
// rhumbDistance(a, b)   = distance(a, b) + 0.5
// initialBearing(a, b)  = ((b.lon - a.lon) * 90 + 360) mod 360  (deg)
// rhumbBearing(a, b)    = initialBearing(a, b) + 1   (deg)
//
// `callCounts` is reset between tests to assert how often each bearing
// method gets called per tick (for cache-hit / cache-miss assertions).
const callCounts = {
  initialBearingTo: 0,
  rhumbBearingTo: 0
}

class StubLatLon {
  constructor(
    public lat: number,
    public lon: number
  ) {}
  distanceTo(other: StubLatLon): number {
    const dLat = other.lat - this.lat
    const dLon = other.lon - this.lon
    return Math.hypot(dLat, dLon) * 1000
  }
  rhumbDistanceTo(other: StubLatLon): number {
    return this.distanceTo(other) + 0.5
  }
  initialBearingTo(other: StubLatLon): number {
    callCounts.initialBearingTo++
    return ((other.lon - this.lon) * 90 + 360) % 360
  }
  rhumbBearingTo(other: StubLatLon): number {
    callCounts.rhumbBearingTo++
    // Inlined rather than calling this.initialBearingTo so the count for
    // the latter does not include internal calls.
    return ((((other.lon - this.lon) * 90 + 360) % 360) + 1) % 360
  }
  crossTrackDistanceTo(_a: StubLatLon, _b: StubLatLon): number {
    return 0
  }
}

// Install the stub at suite start; restore on suite end so sibling test
// files (passedPerpendicular, course-defensive) can still see the real
// LatLonSpherical when the require cache hits later.
let restoreLatLon: () => void = () => {}

function loadCalcs(): (src: any) => any {
  // Reset module registry so the per-tick caches start clean.
  resetModuleCache('../src/worker/course')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require('../src/worker/course') as any
  return mod.calcs
}

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

describe('track bearing cache', () => {
  let calcs: (src: any) => any

  before(() => {
    restoreLatLon = mockModule('../src/lib/geodesy/latlon-spherical.js', {
      LatLonSpherical: StubLatLon
    })
  })

  after(() => {
    restoreLatLon()
    resetModuleCache('../src/worker/course')
  })

  beforeEach(() => {
    calcs = loadCalcs()
    callCounts.initialBearingTo = 0
    callCounts.rhumbBearingTo = 0
  })

  it('skips the prev->next bearing calls on a cached tick', () => {
    calcs(srcWithFix())

    callCounts.initialBearingTo = 0
    callCounts.rhumbBearingTo = 0
    calcs(srcWithFix())

    // Cache warm: track bearings (gc + rl) are served from cache. Vessel-
    // position-dependent bearings still recompute, plus passedPerpendicular.
    //   initialBearingTo: vesselPosition->destination (1) + passedPerpendicular (2) = 3
    //   rhumbBearingTo:   vesselPosition->destination (1) = 1
    expect(callCounts.initialBearingTo).to.equal(3)
    expect(callCounts.rhumbBearingTo).to.equal(1)
  })

  it('recomputes both flavours when nextPoint changes', () => {
    calcs(srcWithFix())

    callCounts.initialBearingTo = 0
    callCounts.rhumbBearingTo = 0
    // Change latitude only — keeps stub bearings stable so timeCalcs math
    // stays well-defined while invalidating the cache key (nextLat).
    calcs(srcWithFix({ next: { latitude: 0.5, longitude: 1 } }))

    // Cache miss: track bearings recompute (gc + rl) plus the per-tick calls.
    //   initialBearingTo: track (1) + bearingTrue (1) + passedPerpendicular (2) = 4
    //   rhumbBearingTo:   track (1) + bearingTrue (1) = 2
    expect(callCounts.initialBearingTo).to.equal(4)
    expect(callCounts.rhumbBearingTo).to.equal(2)
  })

  it('recomputes both flavours when previousPoint changes', () => {
    calcs(srcWithFix())

    callCounts.initialBearingTo = 0
    callCounts.rhumbBearingTo = 0
    // Shift previousPoint latitude. The cache key (prevLat) differs so the
    // track bearings must recompute even though nextPoint is unchanged.
    const moved = srcWithFix()
    moved['navigation.course.previousPoint'].position.latitude = 0.5
    calcs(moved)

    expect(callCounts.initialBearingTo).to.equal(4)
    expect(callCounts.rhumbBearingTo).to.equal(2)
  })

  it('recomputes the magnetic track bearing when magneticVariation changes', () => {
    const a = calcs(srcWithFix({ magVar: 0 }))
    const b = calcs(srcWithFix({ magVar: 0.1 }))

    // True bearings depend on geometry only, so they stay equal across magVar.
    expect(b.gc.bearingTrackTrue).to.equal(a.gc.bearingTrackTrue)
    expect(b.rl.bearingTrackTrue).to.equal(a.rl.bearingTrackTrue)
    // Magnetic bearings shift with magVar.
    expect(b.gc.bearingTrackMagnetic).to.not.equal(a.gc.bearingTrackMagnetic)
    expect(b.rl.bearingTrackMagnetic).to.not.equal(a.rl.bearingTrackMagnetic)
  })

  it('cached values match a freshly-computed result', () => {
    const fresh = calcs(srcWithFix())
    const cached = calcs(srcWithFix())

    // Assert both flavours match across the cache hit so the cache cannot
    // silently return stale or wrong values.
    expect(cached.gc.bearingTrackTrue).to.equal(fresh.gc.bearingTrackTrue)
    expect(cached.gc.bearingTrackMagnetic).to.equal(
      fresh.gc.bearingTrackMagnetic
    )
    expect(cached.rl.bearingTrackTrue).to.equal(fresh.rl.bearingTrackTrue)
    expect(cached.rl.bearingTrackMagnetic).to.equal(
      fresh.rl.bearingTrackMagnetic
    )
  })
})
