/**
 * Course calculation worker.
 *
 * Runs in a Node worker thread. Each tick it receives the latest SignalK
 * path snapshot plus the configured calculation method (GreatCircle or
 * Rhumbline) and emits the corresponding `CourseData` slice the main thread
 * needs to publish. Only the configured branch is computed; the unused
 * branch is returned empty so existing callers can still index by `gc`/`rl`
 * without conditional access.
 *
 * The track bearing (previousPoint -> nextPoint) is cached across ticks
 * because it depends only on the route endpoints and magneticVariation, not
 * on vessel position. The cache is invalidated whenever any of those keys
 * change.
 */

import { parentPort } from 'worker_threads'
import {
  CalcMethod,
  CalcRequest,
  CourseData,
  CourseResult,
  SKPaths
} from '../types'
import { LatLonSpherical as LatLon } from '../lib/geodesy/latlon-spherical.js'

// Empty-result template factory. Used both for the no-active-destination
// transition message and the early-exit path inside calcs(); centralising
// the shape avoids drift if CourseData ever gets a new required field.
function emptyCourseData(): CourseData {
  return { gc: {}, rl: {}, passedPerpendicular: false }
}

let activeDest = false

// process message from main thread
parentPort?.on('message', (message: CalcRequest) => {
  if (parseSKPaths(message.paths)) {
    parentPort?.postMessage(calcs(message.paths, message.method))
    activeDest = true
  } else {
    if (activeDest) {
      parentPort?.postMessage(emptyCourseData())
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

// Track bearing (previousPoint -> nextPoint) cache. The bearing depends only
// on the route endpoints and magneticVariation, never on vessel position, so
// it can be reused across ticks until any of those change.
interface TrackBearingCache {
  prevLat: number
  prevLon: number
  nextLat: number
  nextLon: number
  magVar: number
  rhumbLine: boolean
  bearingTrackTrue: number
  bearingTrackMagnetic: number
}
let trackBearingCache: TrackBearingCache | null = null

function trackBearings(
  startPoint: LatLon,
  destination: LatLon,
  magVar: number,
  rhumbLine: boolean
): { bearingTrackTrue: number; bearingTrackMagnetic: number } {
  const c = trackBearingCache
  if (
    c &&
    c.rhumbLine === rhumbLine &&
    c.magVar === magVar &&
    c.prevLat === startPoint.lat &&
    c.prevLon === startPoint.lon &&
    c.nextLat === destination.lat &&
    c.nextLon === destination.lon
  ) {
    return {
      bearingTrackTrue: c.bearingTrackTrue,
      bearingTrackMagnetic: c.bearingTrackMagnetic
    }
  }
  const bearingTrackTrue = toRadians(
    rhumbLine
      ? startPoint.rhumbBearingTo(destination)
      : startPoint.initialBearingTo(destination)
  )
  const bearingTrackMagnetic = compassAngle(bearingTrackTrue + magVar)
  trackBearingCache = {
    prevLat: startPoint.lat,
    prevLon: startPoint.lon,
    nextLat: destination.lat,
    nextLon: destination.lon,
    magVar,
    rhumbLine,
    bearingTrackTrue,
    bearingTrackMagnetic
  }
  return { bearingTrackTrue, bearingTrackMagnetic }
}

// course calculations.
//
// `method` selects the branch (`gc` for GreatCircle, `rl` for Rhumbline) to
// compute. The unused branch is returned empty so existing callers can still
// index by `gc`/`rl` without conditional access.
export function calcs(src: SKPaths, method: CalcMethod): CourseData {
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

  const res = emptyCourseData()
  if (!vesselPosition || !destination || !startPoint) {
    return res
  }

  const xte = vesselPosition.crossTrackDistanceTo(startPoint, destination)
  const magVar = src['navigation.magneticVariation'] ?? 0.0
  const vmgValue = vmg(src)
  const rhumbLine = method === 'Rhumbline'

  const { bearingTrackTrue, bearingTrackMagnetic } = trackBearings(
    startPoint,
    destination,
    magVar,
    rhumbLine
  )
  const bearingTrue = toRadians(
    rhumbLine
      ? vesselPosition.rhumbBearingTo(destination)
      : vesselPosition.initialBearingTo(destination)
  )
  const bearingMagnetic = compassAngle(bearingTrue + magVar)
  const distance = rhumbLine
    ? vesselPosition.rhumbDistanceTo(destination)
    : vesselPosition.distanceTo(destination)
  const vmcValue = vmc(src, bearingTrue, 'true') // for ETA, TTG - prefer 'true' values
  const time = timeCalcs(src, distance, vmcValue as number, rhumbLine)
  const previousPointDistance = rhumbLine
    ? vesselPosition.rhumbDistanceTo(startPoint)
    : vesselPosition.distanceTo(startPoint)

  const methodResult: CourseResult = {
    calcMethod: rhumbLine ? 'Rhumbline' : 'GreatCircle',
    bearingTrackTrue,
    bearingTrackMagnetic,
    crossTrackError: xte,
    distance,
    bearingTrue,
    bearingMagnetic,
    velocityMadeGood: vmgValue,
    velocityMadeGoodToCourse: vmcValue,
    timeToGo: time.nextPoint.ttg,
    estimatedTimeOfArrival: time.nextPoint.eta,
    previousPoint: { distance: previousPointDistance },
    route: {
      timeToGo: time.route.ttg,
      estimatedTimeOfArrival: time.route.eta,
      distance: time.route.dtg
    },
    targetSpeed: targetSpeed(src, distance, rhumbLine)
  }

  if (rhumbLine) {
    res.rl = methodResult
  } else {
    res.gc = methodResult
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

// total distance in meters of remaining route segments
function routeRemaining(src: SKPaths, rhumbLine?: boolean): number {
  if (
    src['activeRoute']?.pointIndex === null ||
    !Array.isArray(src['activeRoute']?.waypoints)
  ) {
    return 0
  }
  if (src['activeRoute']?.waypoints.length < 2) {
    return 0
  }

  let reverse = src['activeRoute']?.reverse
  let ptIndex = src['activeRoute']?.pointIndex
  let lastIndex = src['activeRoute']?.waypoints.length - 1

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

  // sum segment lengths
  let wpts = src['activeRoute'].waypoints
  let rteLen = 0
  for (let idx = fromIndex; idx < toIndex; idx++) {
    let pt = new LatLon(wpts[idx][1], wpts[idx][0])
    if (rhumbLine) {
      rteLen += pt.rhumbDistanceTo(
        new LatLon(wpts[idx + 1][1], wpts[idx + 1][0])
      )
    } else {
      rteLen += pt.distanceTo(new LatLon(wpts[idx + 1][1], wpts[idx + 1][0]))
    }
  }
  return rteLen
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
