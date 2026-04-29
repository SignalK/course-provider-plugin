import { CourseData, CourseResult, SKPaths } from '../types'
import { LatLonSpherical as LatLon } from '../lib/geodesy/latlon-spherical.js'
import { computeCourseGeometry } from '../lib/geodesy/course-math'

export function parseSKPaths(src: SKPaths): boolean {
  return src['navigation.position'] &&
    src['navigation.course.nextPoint']?.position &&
    src['navigation.course.previousPoint']?.position
    ? true
    : false
}

const TO_RAD = Math.PI / 180

/** Normalises angle to a value within the range of a compass
 * @param angle: angle (in radians)
 * @returns value between 0 - 2*PI
 */
function compassAngle(angle: number): number {
  const maxAngle = Math.PI * 2
  return angle < 0
    ? angle + maxAngle
    : angle >= maxAngle
      ? angle - maxAngle
      : angle
}

// course calculations.
//
// All per-tick geodesy now goes through `computeCourseGeometry` from
// `lib/geodesy/course-math.ts`: distance + bearing + xte + track bearing
// + passedPerpendicular in one pass over pre-converted radian scalars,
// no `LatLon` class allocations on the hot path. The vendored
// `latlon-spherical.js` library stays for cold-path route/resource code
// (see `routeRemaining` below).
export function calcs(src: SKPaths): CourseData {
  const pos = src['navigation.position']
  const next = src['navigation.course.nextPoint']
  const prev = src['navigation.course.previousPoint']

  const res: CourseData = { gc: {}, rl: {}, passedPerpendicular: false }
  if (!pos || !next?.position || !prev?.position) {
    return res
  }

  const g = computeCourseGeometry(
    pos.latitude * TO_RAD,
    pos.longitude * TO_RAD,
    next.position.latitude * TO_RAD,
    next.position.longitude * TO_RAD,
    prev.position.latitude * TO_RAD,
    prev.position.longitude * TO_RAD
  )

  const magVar = src['navigation.magneticVariation'] ?? 0.0
  const vmgValue = vmg(src)

  // GreatCircle
  const bearingTrackTrue = g.trackBearingGcRad
  const bearingTrue = g.bearingGcRad
  const bearingTrackMagnetic = compassAngle(bearingTrackTrue + magVar)
  const bearingMagnetic = compassAngle(bearingTrue + magVar)
  const gcDistance = g.distanceGc
  const gcVmc = vmc(src, bearingTrue, 'true') // for ETA, TTG - prefer 'true' values
  const gcTime = timeCalcs(src, gcDistance, gcVmc as number, false)

  const gcResult: CourseResult = {
    calcMethod: 'GreatCircle',
    bearingTrackTrue,
    bearingTrackMagnetic,
    crossTrackError: g.xte,
    distance: gcDistance,
    bearingTrue,
    bearingMagnetic,
    velocityMadeGood: vmgValue,
    velocityMadeGoodToCourse: gcVmc,
    timeToGo: gcTime.nextPoint.ttg,
    estimatedTimeOfArrival: gcTime.nextPoint.eta,
    previousPoint: { distance: g.prevDistanceGc },
    route: {
      timeToGo: gcTime.route.ttg,
      estimatedTimeOfArrival: gcTime.route.eta,
      distance: gcTime.route.dtg
    },
    targetSpeed: targetSpeed(src, gcDistance)
  }
  res.gc = gcResult

  // Rhumbline
  const rlBearingTrackTrue = g.trackBearingRlRad
  const rlBearingTrue = g.bearingRlRad
  const rlBearingTrackMagnetic = compassAngle(rlBearingTrackTrue + magVar)
  const rlBearingMagnetic = compassAngle(rlBearingTrue + magVar)
  const rlDistance = g.distanceRl
  const rlVmc = vmc(src, rlBearingTrue, 'true')
  const rlTime = timeCalcs(src, rlDistance, rlVmc as number, true)

  const rlResult: CourseResult = {
    calcMethod: 'Rhumbline',
    bearingTrackTrue: rlBearingTrackTrue,
    bearingTrackMagnetic: rlBearingTrackMagnetic,
    crossTrackError: g.xte,
    distance: rlDistance,
    bearingTrue: rlBearingTrue,
    bearingMagnetic: rlBearingMagnetic,
    velocityMadeGood: vmgValue,
    velocityMadeGoodToCourse: rlVmc,
    timeToGo: rlTime.nextPoint.ttg,
    estimatedTimeOfArrival: rlTime.nextPoint.eta,
    previousPoint: { distance: g.prevDistanceRl },
    route: {
      timeToGo: rlTime.route.ttg,
      estimatedTimeOfArrival: rlTime.route.eta,
      distance: rlTime.route.dtg
    },
    targetSpeed: targetSpeed(src, rlDistance, true)
  }
  res.rl = rlResult

  res.passedPerpendicular = g.passedPerpendicular

  return res
}

// Velocity Made Good to wind
export function vmg(src: SKPaths): number | null {
  if (
    typeof src['environment.wind.angleTrueGround'] !== 'number' ||
    typeof src['navigation.speedOverGround'] !== 'number'
  ) {
    return null
  }
  return (
    Math.cos(src['environment.wind.angleTrueGround']) *
    src['navigation.speedOverGround']
  )
}

// Velocity Made Good to Course (used for ETA / TTG calcs)
export function vmc(
  src: SKPaths,
  bearing: number,
  bearingType: 'true' | 'magnetic' = 'true'
): number | null {
  const cog =
    bearingType === 'true'
      ? src['navigation.courseOverGroundTrue']
      : src['navigation.courseOverGroundMagnetic']
  if (
    typeof cog !== 'number' ||
    typeof src['navigation.speedOverGround'] !== 'number'
  ) {
    return null
  }
  return (
    Math.cos(Math.abs(Angle.difference(bearing, cog))) *
    src['navigation.speedOverGround']
  )
}

interface CourseTimes {
  nextPoint: {
    ttg: number | null
    eta: string | null
  }
  route: {
    ttg: number | null
    eta: string | null
    dtg: number | null
  }
}

/**
 * Resolve the millisecond timestamp from a SignalK datetime-like field.
 * Accepts:
 *   - ISO 8601 string (per SignalK spec)
 *   - number (epoch-ms, legacy tolerance)
 *   - undefined / null -> current time
 * Returns NaN on an unparseable string; callers must check Number.isFinite.
 */
function resolveDateMsec(raw: unknown): number {
  if (raw === undefined || raw === null) return Date.now()
  if (typeof raw === 'number') return raw
  return Date.parse(raw as string)
}

// Time to Go & Estimated time of arrival at the nextPoint / route destination
export function timeCalcs(
  src: SKPaths,
  distance: number,
  vmc: number,
  rhumbLine: boolean
): CourseTimes {
  const isRoute =
    Array.isArray(src['activeRoute']?.waypoints) &&
    src['activeRoute']?.waypoints.length !== 0

  const result: CourseTimes = {
    nextPoint: { ttg: null, eta: null },
    route: { ttg: null, eta: null, dtg: null }
  }

  if (
    typeof distance !== 'number' ||
    !Number.isFinite(distance) ||
    typeof vmc !== 'number' ||
    !Number.isFinite(vmc) ||
    vmc <= 0
  ) {
    return result
  }

  const dateMsec = resolveDateMsec(src['navigation.datetime'])
  if (!Number.isFinite(dateMsec)) {
    return result
  }

  const nextTtgMsec = Math.floor((distance / vmc) * 1000)
  const nextEtaMsec = dateMsec + nextTtgMsec
  result.nextPoint.ttg = nextTtgMsec / 1000
  result.nextPoint.eta = new Date(nextEtaMsec).toISOString()

  if (isRoute) {
    const rteDistance = distance + routeRemaining(src, rhumbLine)
    const routeTtgMsec = Math.floor((rteDistance / vmc) * 1000)
    const routeEtaMsec = dateMsec + routeTtgMsec
    result.route.ttg = routeTtgMsec / 1000
    result.route.eta = new Date(routeEtaMsec).toISOString()
    result.route.dtg = rteDistance
  }
  return result
}

// Avg speed required to arrive at destination at targetArrivalTime
export function targetSpeed(
  src: SKPaths,
  distance: number,
  rhumbLine?: boolean
): number | null {
  if (
    typeof distance !== 'number' ||
    !Number.isFinite(distance) ||
    !src['navigation.course.targetArrivalTime']
  ) {
    return null
  }

  // if route totalDistance = distance plus + length of remaining route segments
  if (src['activeRoute']?.waypoints) {
    distance += routeRemaining(src, rhumbLine)
  }

  const dateMsec = resolveDateMsec(src['navigation.datetime'])
  if (!Number.isFinite(dateMsec)) {
    return null
  }

  const tatMsec = resolveDateMsec(src['navigation.course.targetArrivalTime'])
  if (!Number.isFinite(tatMsec)) {
    return null
  }
  if (tatMsec <= dateMsec) {
    // current time is after targetArrivalTime
    return null
  }
  const tDiffSec = (tatMsec - dateMsec) / 1000
  return distance / tDiffSec
}

// Route remaining distance cache. The total only changes when waypoints,
// pointIndex, or reverse flag change, but the function is called four times
// per tick (gc/rl × timeCalcs/targetSpeed). Both flavours share the same
// key inputs and are computed together in one cursor pass on miss.
//
// The cache keys on the waypoints array reference. The main thread
// reassigns `srcPaths['activeRoute'].waypoints` on every route change
// (`getPaths`, `handleRouteUpdate`, `handleActiveRoute`), and `calcs()`
// runs in-process now so reference identity survives.
interface RouteRemainingCache {
  waypoints: Array<[number, number]>
  pointIndex: number
  reverse: boolean
  totalGc: number
  totalRl: number
}
let routeRemainingCache: RouteRemainingCache | null = null

// total distance in meters of remaining route segments
export function routeRemaining(src: SKPaths, rhumbLine?: boolean): number {
  if (
    src['activeRoute']?.pointIndex === null ||
    !Array.isArray(src['activeRoute']?.waypoints)
  ) {
    return 0
  }
  const waypoints = src['activeRoute'].waypoints as Array<[number, number]>
  if (waypoints.length < 2) {
    return 0
  }

  const reverse = !!src['activeRoute'].reverse
  const ptIndex = src['activeRoute'].pointIndex
  const lastIndex = waypoints.length - 1
  const useRhumbLine = !!rhumbLine

  // determine segments to sum
  let fromIndex: number
  let toIndex: number
  if (reverse) {
    fromIndex = 0
    toIndex = lastIndex - ptIndex
    if (toIndex === fromIndex) {
      return 0
    }
  } else {
    if (ptIndex === lastIndex) {
      return 0
    }
    fromIndex = ptIndex
    toIndex = lastIndex
  }

  const cache = routeRemainingCache
  if (
    cache &&
    cache.waypoints === waypoints &&
    cache.pointIndex === ptIndex &&
    cache.reverse === reverse
  ) {
    return useRhumbLine ? cache.totalRl : cache.totalGc
  }

  // Sum segment lengths for both flavours in a single pass. Advance one
  // LatLon cursor instead of allocating two LatLon objects per iteration;
  // on a 50-waypoint route that is ~50 fewer allocations per cache miss.
  const fromWp = waypoints[fromIndex]!
  let pt = new LatLon(fromWp[1], fromWp[0])
  let totalGc = 0
  let totalRl = 0
  for (let idx = fromIndex; idx < toIndex; idx++) {
    const wp = waypoints[idx + 1]!
    const next = new LatLon(wp[1], wp[0])
    totalGc += pt.distanceTo(next)
    totalRl += pt.rhumbDistanceTo(next)
    pt = next
  }

  routeRemainingCache = {
    waypoints,
    pointIndex: ptIndex,
    reverse,
    totalGc,
    totalRl
  }
  return useRhumbLine ? totalRl : totalGc
}

// Helper used by `vmc` to fold the |bearing - cog| difference into [0, π].
class Angle {
  /** Signed angle difference (radians); negative result means port. */
  static difference(h: number, b: number): number {
    const d = Math.PI * 2 - b
    const hd = h + d
    const a = Angle.normalise(hd)
    return a < Math.PI ? 0 - a : Math.PI * 2 - a
  }

  /** Normalises an angle to [0, 2π). */
  static normalise(a: number): number {
    const pi2 = Math.PI * 2
    return a < 0 ? a + pi2 : a >= pi2 ? a - pi2 : a
  }
}
