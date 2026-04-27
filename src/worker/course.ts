import { parentPort } from 'worker_threads'
import { CourseData, SKPaths } from '../types'
import { LatLonSpherical as LatLon } from '../lib/geodesy/latlon-spherical.js'

let activeDest = false

// process message from main thread
parentPort?.on('message', (message: SKPaths) => {
  if (parseSKPaths(message)) {
    parentPort?.postMessage(calcs(message))
    activeDest = true
  } else {
    if (activeDest) {
      parentPort?.postMessage({ gc: {}, rl: {} })
      activeDest = false
    }
  }
})

export function parseSKPaths(src: SKPaths): boolean {
  return src['navigation.position'] &&
    src['navigation.course.nextPoint']?.position &&
    src['navigation.course.previousPoint']?.position
    ? true
    : false
}

const toRadians = (degrees: number) => (degrees * Math.PI) / 180

const toDegrees = (radians: number) => (180 / Math.PI) * radians

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

// Track bearing cache. The bearing from previousPoint to nextPoint depends
// only on the route endpoints and magneticVariation, never on vessel
// position, so it can be reused across ticks until any of those change.
// Both great-circle and rhumb-line flavours are computed and stored together
// because they share the same key inputs.
//
// trackBearings returns the cache record directly to avoid allocating a
// fresh result object on every tick. Callers must treat the returned value
// as read-only (the Readonly<> type enforces this at compile time).
interface TrackBearingCache {
  prevLat: number
  prevLon: number
  nextLat: number
  nextLon: number
  magVar: number
  gcTrue: number
  gcMagnetic: number
  rlTrue: number
  rlMagnetic: number
}
let trackBearingCache: TrackBearingCache | null = null

function trackBearings(
  startPoint: LatLon,
  destination: LatLon,
  magVar: number
): Readonly<TrackBearingCache> {
  const c = trackBearingCache
  if (
    c &&
    c.magVar === magVar &&
    c.prevLat === startPoint.lat &&
    c.prevLon === startPoint.lon &&
    c.nextLat === destination.lat &&
    c.nextLon === destination.lon
  ) {
    return c
  }
  const gcTrue = toRadians(startPoint.initialBearingTo(destination))
  const gcMagnetic = compassAngle(gcTrue + magVar)
  const rlTrue = toRadians(startPoint.rhumbBearingTo(destination))
  const rlMagnetic = compassAngle(rlTrue + magVar)
  const fresh: TrackBearingCache = {
    prevLat: startPoint.lat,
    prevLon: startPoint.lon,
    nextLat: destination.lat,
    nextLon: destination.lon,
    magVar,
    gcTrue,
    gcMagnetic,
    rlTrue,
    rlMagnetic
  }
  trackBearingCache = fresh
  return fresh
}

// course calculations
export function calcs(src: SKPaths): CourseData {
  const vesselPosition = src['navigation.position']
    ? new LatLon(
        src['navigation.position'].latitude,
        src['navigation.position'].longitude
      )
    : null
  const destination = src['navigation.course.nextPoint']
    ? new LatLon(
        src['navigation.course.nextPoint'].position.latitude,
        src['navigation.course.nextPoint'].position.longitude
      )
    : null
  const startPoint = src['navigation.course.previousPoint'].position
    ? new LatLon(
        src['navigation.course.previousPoint'].position.latitude,
        src['navigation.course.previousPoint'].position.longitude
      )
    : null

  const res: CourseData = { gc: {}, rl: {}, passedPerpendicular: false }
  if (!vesselPosition || !destination || !startPoint) {
    return res
  }

  const xte = vesselPosition?.crossTrackDistanceTo(startPoint, destination)
  const magVar = src['navigation.magneticVariation'] ?? 0.0
  const vmgValue = vmg(src)
  const tb = trackBearings(startPoint, destination, magVar)

  // GreatCircle
  const bearingTrackTrue = tb.gcTrue
  const bearingTrue = toRadians(vesselPosition?.initialBearingTo(destination))
  const bearingTrackMagnetic = tb.gcMagnetic
  const bearingMagnetic = compassAngle(bearingTrue + magVar)
  const gcDistance = vesselPosition?.distanceTo(destination)
  const gcVmg = vmgValue
  const gcVmc = vmc(src, bearingTrue, 'true') // for ETA, TTG - prefer 'true' values
  const gcTime = timeCalcs(src, gcDistance, gcVmc as number, false)

  res.gc = {
    calcMethod: 'GreatCircle',
    bearingTrackTrue: bearingTrackTrue,
    bearingTrackMagnetic: bearingTrackMagnetic,
    crossTrackError: xte,
    distance: gcDistance,
    bearingTrue: bearingTrue,
    bearingMagnetic: bearingMagnetic,
    velocityMadeGood: gcVmg,
    velocityMadeGoodToCourse: gcVmc,
    timeToGo: gcTime.nextPoint.ttg,
    estimatedTimeOfArrival: gcTime.nextPoint.eta,
    previousPoint: {
      distance: vesselPosition?.distanceTo(startPoint)
    },
    route: {
      timeToGo: gcTime.route.ttg,
      estimatedTimeOfArrival: gcTime.route.eta,
      distance: gcTime.route.dtg
    },
    targetSpeed: targetSpeed(src, gcDistance)
  }

  // Rhumbline
  const rlBearingTrackTrue = tb.rlTrue
  const rlBearingTrue = toRadians(vesselPosition?.rhumbBearingTo(destination))
  const rlBearingTrackMagnetic = tb.rlMagnetic
  const rlBearingMagnetic = compassAngle(rlBearingTrue + magVar)
  const rlDistance = vesselPosition?.rhumbDistanceTo(destination)
  const rlVmg = vmgValue
  const rlVmc = vmc(src, rlBearingTrue, 'true') // for ETA, TTG - prefer 'true' values
  const rlTime = timeCalcs(src, rlDistance, rlVmc as number, true)

  res.rl = {
    calcMethod: 'Rhumbline',
    bearingTrackTrue: rlBearingTrackTrue,
    bearingTrackMagnetic: rlBearingTrackMagnetic,
    crossTrackError: xte,
    distance: rlDistance,
    bearingTrue: rlBearingTrue,
    bearingMagnetic: rlBearingMagnetic,
    velocityMadeGood: rlVmg,
    velocityMadeGoodToCourse: rlVmc,
    timeToGo: rlTime.nextPoint.ttg,
    estimatedTimeOfArrival: rlTime.nextPoint.eta,
    previousPoint: {
      distance: vesselPosition?.rhumbDistanceTo(startPoint)
    },
    route: {
      timeToGo: rlTime.route.ttg,
      estimatedTimeOfArrival: rlTime.route.eta,
      distance: rlTime.route.dtg
    },
    targetSpeed: targetSpeed(src, rlDistance, true)
  }

  // passed destination perpendicular
  res.passedPerpendicular = passedPerpendicular(
    vesselPosition,
    destination,
    startPoint
  )

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
// The cache is keyed on `waypointsVersion`, a primitive bumped by the main
// thread whenever it (re)assigns activeRoute.waypoints. We can't use the
// array reference itself because worker.postMessage structured-clones the
// envelope, so the worker sees a fresh array reference every tick even when
// the route is unchanged.
interface RouteRemainingCache {
  waypointsVersion: number
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

  // The main thread bumps `waypointsVersion` on every (re)assignment of
  // activeRoute.waypoints. We need a primitive cache key here because the
  // worker receives a freshly-cloned waypoints array on every postMessage,
  // so reference equality would never hold across ticks.
  const waypointsVersion = src['activeRoute'].waypointsVersion
  const canCache = typeof waypointsVersion === 'number'

  if (canCache) {
    const cache = routeRemainingCache
    if (
      cache &&
      cache.waypointsVersion === waypointsVersion &&
      cache.pointIndex === ptIndex &&
      cache.reverse === reverse
    ) {
      return useRhumbLine ? cache.totalRl : cache.totalGc
    }
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

  if (canCache) {
    routeRemainingCache = {
      waypointsVersion,
      pointIndex: ptIndex,
      reverse,
      totalGc,
      totalRl
    }
  }
  return useRhumbLine ? totalRl : totalGc
}

// return true if vessel is past perpendicular of destination
export function passedPerpendicular(
  vesselPosition: LatLon,
  destination: LatLon,
  startPoint: LatLon
): boolean {
  const ds = destination.initialBearingTo(startPoint)
  const dv = destination.initialBearingTo(vesselPosition)
  const diff = toDegrees(Angle.difference(toRadians(ds), toRadians(dv)))
  return Math.abs(diff) > 90
}

class Angle {
  /** difference between two angles (in radians)
   * @param h: angle 1
   * @param b: angle 2
   * @returns angle (-ive = port)
   */
  static difference(h: number, b: number): number {
    const d = Math.PI * 2 - b
    const hd = h + d
    const a = Angle.normalise(hd)
    return a < Math.PI ? 0 - a : Math.PI * 2 - a
  }

  /** Add two angles (in radians)
   * @param h: angle 1
   * @param b: angle 2
   * @returns sum angle
   */
  static add(h: number, b: number): number {
    return Angle.normalise(h + b)
  }

  /** Normalises angle to a value between 0 & 2Pi radians
   * @param a: angle
   * @returns value between 0-2Pi
   */
  static normalise(a: number): number {
    const pi2 = Math.PI * 2
    return a < 0 ? a + pi2 : a >= pi2 ? a - pi2 : a
  }
}
