import { expect } from 'chai'
import { mockModule, resetModuleCache } from './helpers'

// LatLon stub. Methods return deterministic values derived from the points'
// coordinates so tests can predict output and assert on call counts.
//
// distance(a, b)        = hypot(dLat, dLon) * 1000   (m)
// rhumbDistance(a, b)   = distance(a, b) + 0.5
//
// `callCounts` is reset between tests to assert how often distanceTo /
// rhumbDistanceTo are called per cache hit / miss.
const callCounts = {
  distanceTo: 0,
  rhumbDistanceTo: 0
}

class StubLatLon {
  constructor(
    public lat: number,
    public lon: number
  ) {}
  distanceTo(other: StubLatLon): number {
    callCounts.distanceTo++
    const dLat = other.lat - this.lat
    const dLon = other.lon - this.lon
    return Math.hypot(dLat, dLon) * 1000
  }
  rhumbDistanceTo(other: StubLatLon): number {
    callCounts.rhumbDistanceTo++
    // Inlined rather than calling distanceTo so the count for the latter
    // does not include internal calls.
    const dLat = other.lat - this.lat
    const dLon = other.lon - this.lon
    return Math.hypot(dLat, dLon) * 1000 + 0.5
  }
  initialBearingTo(other: StubLatLon): number {
    return ((other.lon - this.lon) * 90 + 360) % 360
  }
  rhumbBearingTo(other: StubLatLon): number {
    return ((((other.lon - this.lon) * 90 + 360) % 360) + 1) % 360
  }
  crossTrackDistanceTo(_a: StubLatLon, _b: StubLatLon): number {
    return 0
  }
}

let restoreLatLon: () => void = () => {}

function loadRouteRemaining(): (src: any, useRhumbLine: boolean) => number {
  resetModuleCache('../src/worker/course')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require('../src/worker/course') as any
  return mod.routeRemaining
}

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

describe('routeRemaining cache and cursor reuse', () => {
  let routeRemaining: (src: any, useRhumbLine: boolean) => number

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
    routeRemaining = loadRouteRemaining()
    callCounts.distanceTo = 0
    callCounts.rhumbDistanceTo = 0
  })

  it('returns the great-circle total of remaining segments', () => {
    expect(routeRemaining(routeSrc(), false)).to.equal(3000)
  })

  it('returns the rhumb-line total of remaining segments', () => {
    // Stub adds 0.5 per segment to differentiate from gc; 3 segments -> +1.5.
    expect(routeRemaining(routeSrc(), true)).to.equal(3001.5)
  })

  it('serves both flavours from cache after a single computation pass', () => {
    const src = routeSrc()
    const gcFirst = routeRemaining(src, false)

    // After the first call, both gc and rl totals are cached. Subsequent
    // calls in either flavour must not recompute.
    callCounts.distanceTo = 0
    callCounts.rhumbDistanceTo = 0
    const gcSecond = routeRemaining(src, false)
    const rlAfterGc = routeRemaining(src, true)

    expect(gcSecond).to.equal(gcFirst)
    expect(rlAfterGc).to.equal(3001.5)
    expect(callCounts.distanceTo).to.equal(0)
    expect(callCounts.rhumbDistanceTo).to.equal(0)
  })

  it('runs exactly one distance call per segment per flavour (no double allocation)', () => {
    routeRemaining(routeSrc(), false)
    // 4 waypoints, fromIndex 0, toIndex 3 -> 3 segments. With cursor reuse
    // and both-flavours-in-one-pass: 3 distanceTo + 3 rhumbDistanceTo.
    expect(callCounts.distanceTo).to.equal(3)
    expect(callCounts.rhumbDistanceTo).to.equal(3)
  })

  it('invalidates when waypointsVersion bumps (route content changed)', () => {
    routeRemaining(routeSrc(1), false)

    const replaced = routeSrc(2) // version bumped: route content has changed
    replaced.activeRoute.waypoints[3] = [4, 0] // total now 4 segments worth
    callCounts.distanceTo = 0
    const total = routeRemaining(replaced, false)

    expect(callCounts.distanceTo).to.be.greaterThan(0)
    expect(total).to.equal(4000)
  })

  it('hits cache after structuredClone (across worker postMessage)', () => {
    // Models the production flow: main thread builds srcPaths once, posts to
    // the worker every tick, Node structured-clones the envelope. The cache
    // must hit on the cloned object as long as waypointsVersion is unchanged.
    const tick1 = routeSrc(7)
    const first = routeRemaining(tick1, false)

    const tick2 = structuredClone(tick1)
    callCounts.distanceTo = 0
    const second = routeRemaining(tick2, false)

    expect(second).to.equal(first)
    expect(callCounts.distanceTo).to.equal(0)
  })

  it('invalidates when pointIndex advances', () => {
    const src = routeSrc()
    const fromStart = routeRemaining(src, false)

    src.activeRoute.pointIndex = 2
    const fromMid = routeRemaining(src, false)

    expect(fromStart).to.equal(3000)
    // Only the last segment remains: 1 * 1000 = 1000 m.
    expect(fromMid).to.equal(1000)
  })

  it('invalidates when reverse flag changes', () => {
    const src = routeSrc()
    src.activeRoute.pointIndex = 1
    routeRemaining(src, false)

    // Reset counter; flipping `reverse` must force a recompute even though
    // waypointsVersion / pointIndex are unchanged.
    callCounts.distanceTo = 0
    src.activeRoute.reverse = true
    routeRemaining(src, false)

    expect(callCounts.distanceTo).to.be.greaterThan(0)
  })

  it('returns 0 in reverse when pointIndex equals lastIndex', () => {
    const src = routeSrc()
    src.activeRoute.pointIndex = 3 // = lastIndex
    src.activeRoute.reverse = true
    // Reverse early-return: fromIndex 0, toIndex = lastIndex - lastIndex = 0.
    expect(routeRemaining(src, false)).to.equal(0)
  })

  it('returns 0 when fewer than two waypoints remain', () => {
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
    expect(routeRemaining(src, false)).to.equal(0)
  })

  it('returns 0 when pointIndex is null', () => {
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
    expect(routeRemaining(src, false)).to.equal(0)
  })
})
