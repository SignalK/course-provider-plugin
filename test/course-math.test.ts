import { expect } from 'chai'
import { computeCourseGeometry } from '../src/lib/geodesy/course-math'
// eslint-disable-next-line @typescript-eslint/no-require-imports
const {
  LatLonSpherical: LatLon
} = require('../src/lib/geodesy/latlon-spherical.js')

const TO_RAD = Math.PI / 180

interface Pt {
  lat: number
  lon: number
}
interface Scenario {
  name: string
  vessel: Pt
  destination: Pt
  start: Pt
}

// Representative inputs covering the realistic envelope: short coastal,
// long ocean leg, high-latitude leg, equator, southern hemisphere, and
// antimeridian crossing.
const scenarios: Scenario[] = [
  {
    name: 'coastal cruise (NW Europe)',
    vessel: { lat: 50.0, lon: 8.0 },
    destination: { lat: 50.5, lon: 8.5 },
    start: { lat: 49.9, lon: 7.9 }
  },
  {
    name: 'long ocean leg (transatlantic)',
    vessel: { lat: 40.0, lon: -50.0 },
    destination: { lat: 50.0, lon: -10.0 },
    start: { lat: 40.5, lon: -55.0 }
  },
  {
    name: 'high latitude (Norwegian Sea)',
    vessel: { lat: 70.0, lon: 20.0 },
    destination: { lat: 71.5, lon: 25.0 },
    start: { lat: 69.5, lon: 18.0 }
  },
  {
    name: 'equator',
    vessel: { lat: 0.0, lon: 10.0 },
    destination: { lat: 0.0, lon: 30.0 },
    start: { lat: 0.0, lon: 5.0 }
  },
  {
    name: 'southern hemisphere',
    vessel: { lat: -33.5, lon: 151.0 },
    destination: { lat: -34.0, lon: 152.0 },
    start: { lat: -33.0, lon: 150.5 }
  },
  {
    name: 'antimeridian crossing',
    vessel: { lat: 1.0, lon: 179.5 },
    destination: { lat: 1.0, lon: -179.5 },
    start: { lat: 1.0, lon: 179.0 }
  }
]

// Floating-point tolerances. course-math computes Δψ via a different
// arrangement of logs/tans than LatLonSpherical, so trailing-bit
// differences are expected.
const ABS_DIST_TOL_M = 1e-3 // 1 mm
const ABS_BEARING_TOL_RAD = 1e-9
const ABS_XTE_TOL_M = 1e-3

// LatLon expects degrees-stored fields and `.toRadians()` conversions
// internally. Wrap360 returns degrees in [0, 360); we convert to radians
// for parity comparison.
function gcDistance(a: Pt, b: Pt): number {
  return new LatLon(a.lat, a.lon).distanceTo(new LatLon(b.lat, b.lon))
}
function rlDistance(a: Pt, b: Pt): number {
  return new LatLon(a.lat, a.lon).rhumbDistanceTo(new LatLon(b.lat, b.lon))
}
function gcBearingRad(a: Pt, b: Pt): number {
  const deg = new LatLon(a.lat, a.lon).initialBearingTo(
    new LatLon(b.lat, b.lon)
  )
  return deg * TO_RAD
}
function rlBearingRad(a: Pt, b: Pt): number {
  const deg = new LatLon(a.lat, a.lon).rhumbBearingTo(new LatLon(b.lat, b.lon))
  return deg * TO_RAD
}
function gcXte(vessel: Pt, start: Pt, dest: Pt): number {
  return new LatLon(vessel.lat, vessel.lon).crossTrackDistanceTo(
    new LatLon(start.lat, start.lon),
    new LatLon(dest.lat, dest.lon)
  )
}

// Reference passedPerpendicular using the same `Angle.difference`
// formulation the plugin used to live with.
function passedPerpendicularRef(vessel: Pt, dest: Pt, start: Pt): boolean {
  const dsDeg = new LatLon(dest.lat, dest.lon).initialBearingTo(
    new LatLon(start.lat, start.lon)
  )
  const dvDeg = new LatLon(dest.lat, dest.lon).initialBearingTo(
    new LatLon(vessel.lat, vessel.lon)
  )
  const ds = dsDeg * TO_RAD
  const dv = dvDeg * TO_RAD
  // Mirror `Angle.difference` from src/worker/course.ts pre-refactor.
  const d = Math.PI * 2 - dv
  let a = ds + d
  const pi2 = Math.PI * 2
  if (a < 0) a += pi2
  else if (a >= pi2) a -= pi2
  const diffRad = a < Math.PI ? -a : pi2 - a
  return Math.abs(diffRad) > Math.PI / 2
}

function describeScenario(s: Scenario) {
  describe(s.name, () => {
    const v = s.vessel
    const d = s.destination
    const st = s.start
    const out = computeCourseGeometry(
      v.lat * TO_RAD,
      v.lon * TO_RAD,
      d.lat * TO_RAD,
      d.lon * TO_RAD,
      st.lat * TO_RAD,
      st.lon * TO_RAD
    )

    it('matches LatLonSpherical great-circle distance vessel→destination', () => {
      expect(out.distanceGc).to.be.closeTo(gcDistance(v, d), ABS_DIST_TOL_M)
    })

    it('matches LatLonSpherical rhumb distance vessel→destination', () => {
      expect(out.distanceRl).to.be.closeTo(rlDistance(v, d), ABS_DIST_TOL_M)
    })

    it('matches LatLonSpherical great-circle distance vessel→start', () => {
      expect(out.prevDistanceGc).to.be.closeTo(
        gcDistance(v, st),
        ABS_DIST_TOL_M
      )
    })

    it('matches LatLonSpherical rhumb distance vessel→start', () => {
      expect(out.prevDistanceRl).to.be.closeTo(
        rlDistance(v, st),
        ABS_DIST_TOL_M
      )
    })

    it('matches LatLonSpherical great-circle bearing vessel→destination', () => {
      expect(out.bearingGcRad).to.be.closeTo(
        gcBearingRad(v, d),
        ABS_BEARING_TOL_RAD
      )
    })

    it('matches LatLonSpherical rhumb bearing vessel→destination', () => {
      expect(out.bearingRlRad).to.be.closeTo(
        rlBearingRad(v, d),
        ABS_BEARING_TOL_RAD
      )
    })

    it('matches LatLonSpherical track bearing start→destination (gc)', () => {
      expect(out.trackBearingGcRad).to.be.closeTo(
        gcBearingRad(st, d),
        ABS_BEARING_TOL_RAD
      )
    })

    it('matches LatLonSpherical track bearing start→destination (rl)', () => {
      expect(out.trackBearingRlRad).to.be.closeTo(
        rlBearingRad(st, d),
        ABS_BEARING_TOL_RAD
      )
    })

    it('matches LatLonSpherical cross-track distance', () => {
      expect(out.xte).to.be.closeTo(gcXte(v, st, d), ABS_XTE_TOL_M)
    })

    it('matches reference passedPerpendicular flag', () => {
      expect(out.passedPerpendicular).to.equal(passedPerpendicularRef(v, d, st))
    })
  })
}

describe('computeCourseGeometry — parity with LatLonSpherical', () => {
  for (const s of scenarios) {
    describeScenario(s)
  }
})

describe('computeCourseGeometry — passedPerpendicular regression cases', () => {
  // Specific geometry: vessel is past the perpendicular if it lies on the
  // far side of the destination relative to the planned track.
  it('detects when vessel has crossed the destination line', () => {
    const out = computeCourseGeometry(
      50.6 * TO_RAD,
      8.5 * TO_RAD, // vessel slightly past destination latitude on same lon
      50.5 * TO_RAD,
      8.5 * TO_RAD, // destination
      50.0 * TO_RAD,
      8.5 * TO_RAD // start
    )
    expect(out.passedPerpendicular).to.equal(true)
  })

  it('does not flag perpendicular before vessel reaches it', () => {
    const out = computeCourseGeometry(
      50.4 * TO_RAD,
      8.5 * TO_RAD, // vessel short of destination on same lon
      50.5 * TO_RAD,
      8.5 * TO_RAD,
      50.0 * TO_RAD,
      8.5 * TO_RAD
    )
    expect(out.passedPerpendicular).to.equal(false)
  })
})
