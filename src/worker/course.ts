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

function parseSKPaths(src: SKPaths): boolean {
  return src['navigation.position'] &&
    src['navigation.course.nextPoint']?.position &&
    src['navigation.course.previousPoint']?.position
    ? true
    : false
}

function toRadians(value: number) {
  return (value * Math.PI) / 180
}

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

// course calculations
function calcs(src: SKPaths): CourseData {
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

  // GreatCircle
  const bearingTrackTrue = toRadians(startPoint?.initialBearingTo(destination))
  const bearingTrue = toRadians(vesselPosition?.initialBearingTo(destination))
  const bearingTrackMagnetic = compassAngle(bearingTrackTrue + magVar)
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
  const rlBearingTrackTrue = toRadians(startPoint?.rhumbBearingTo(destination))
  const rlBearingTrue = toRadians(vesselPosition?.rhumbBearingTo(destination))
  const rlBearingTrackMagnetic = compassAngle(rlBearingTrackTrue + magVar)
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
function vmg(src: SKPaths): number | null {
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
function vmc(
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
  return Math.cos(Math.abs(Angle.difference(bearing, cog))) * src['navigation.speedOverGround']
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

// Time to Go & Estimated time of arrival at the nextPoint / route destination
function timeCalcs(
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

  if (typeof distance !== 'number' || !vmc) {
    return result
  }

  const date: Date = src['navigation.datetime']
    ? new Date(src['navigation.datetime'])
    : new Date()

  const dateMsec = date.getTime()

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
function targetSpeed(
  src: SKPaths,
  distance: number,
  rhumbLine?: boolean
): number | null {
  if (
    typeof distance !== 'number' ||
    !src['navigation.course.targetArrivalTime']
  ) {
    return null
  }

  // if route totalDistance = distance plus + length of remaining route segments
  if (src['activeRoute']?.waypoints) {
    distance += routeRemaining(src, rhumbLine)
  }

  const date: Date = src['navigation.datetime']
    ? new Date(src['navigation.datetime'])
    : new Date()
  const dateMsec = date.getTime()
  const tat = new Date(src['navigation.course.targetArrivalTime'])
  const tatMsec = tat.getTime()
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
  for (let idx = fromIndex; idx < lastIndex; idx++) {
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
function passedPerpendicular(
  vesselPosition: LatLon,
  destination: LatLon,
  startPoint: LatLon
): boolean {
  const va = toVector(destination, vesselPosition)
  const vb = toVector(destination, startPoint)
  const rad = Math.acos((va.x * vb.x + va.y * vb.y) / (va.length * vb.length))
  const deg = (180 / Math.PI) * rad
  return deg > 90 ? true : false
}

interface Vector {
  x: number
  y: number
  length: number
}

function toVector(origin: LatLon, end: LatLon): Vector {
  // calc longitudinal difference (inc dateline transition)
  function xDiff(a: number, b: number): number {
    let bx: number
    if (a > 170 && b < 0) {
      // E->W transition
      bx = a + (180 - a) + (180 + b)
    } else if (a < -170 && b > 0) {
      // W->E transition
      bx = a - (180 + a) - (180 - b)
    } else {
      bx = b
    }
    return bx - a
  }

  const x = xDiff(origin.longitude, end.longitude)
  const y = end.latitude - origin.latitude
  const v: Vector = {
    x: x,
    y: y,
    length: Math.sqrt(Math.pow(x, 2) + Math.pow(y, 2))
  }
  return v
}

class Angle {
  /** difference between two angles (in radians)
   * @param h: angle 1
   * @param b: angle 2
   * @returns angle (-ive = port)
   */
  static difference(h: number, b: number): number {
    const d = (Math.PI*2) - b;
    const hd = h + d;
    const a = Angle.normalise(hd);
    return a < Math.PI ? 0 - a : (Math.PI*2) - a;
  }

  /** Add two angles (in radians)
   * @param h: angle 1
   * @param b: angle 2 
   * @returns sum angle
   */
  static add(h: number, b: number): number {
    return Angle.normalise(h + b);
  }

  /** Normalises angle to a value between 0 & 2Pi radians
   * @param a: angle
   * @returns value between 0-2Pi
   */
  static normalise(a: number): number {
    const pi2 = (Math.PI*2)
    return a < 0 ? a + pi2 : a >= pi2 ? a - pi2 : a;
  }
}
