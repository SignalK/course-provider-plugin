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
    src['navigation.course.nextPoint'].position &&
    src['navigation.course.previousPoint'].position
    ? true
    : false
}

function toRadians(value: number) {
  return (value * Math.PI) / 180
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

  // GreatCircle
  const bearingTrackTrue = toRadians(startPoint?.initialBearingTo(destination))
  const bearingTrue = toRadians(vesselPosition?.initialBearingTo(destination))
  let bearingTrackMagnetic: number | null = null
  let bearingMagnetic: number | null = null

  if (typeof src['navigation.magneticVariation'] === 'number') {
    bearingTrackMagnetic =
      (bearingTrackTrue as number) - src['navigation.magneticVariation']
    bearingMagnetic =
      (bearingTrue as number) - src['navigation.magneticVariation']
  }

  const gcDistance = vesselPosition?.distanceTo(destination)
  const gcVmg = vmg(src, bearingTrue)
  const gcTime = timeCalcs(src, gcDistance, gcVmg as number)

  res.gc = {
    calcMethod: 'GreatCircle',
    bearingTrackTrue: bearingTrackTrue,
    bearingTrackMagnetic: bearingTrackMagnetic,
    crossTrackError: xte,
    distance: gcDistance,
    bearingTrue: bearingTrue,
    bearingMagnetic: bearingMagnetic,
    velocityMadeGood: gcVmg,
    timeToGo: gcTime.ttg,
    estimatedTimeOfArrival: gcTime.eta,
    previousPoint: {
      distance: vesselPosition?.distanceTo(startPoint)
    },
    targetSpeed: targetSpeed(src, gcDistance)
  }

  // Rhumbline
  const rlBearingTrackTrue = toRadians(startPoint?.rhumbBearingTo(destination))
  const rlBearingTrue = toRadians(vesselPosition?.rhumbBearingTo(destination))
  let rlBearingTrackMagnetic: number | null = null
  let rlBearingMagnetic: number | null = null

  if (typeof src['navigation.magneticVariation'] === 'number') {
    rlBearingTrackMagnetic =
      (rlBearingTrackTrue as number) - src['navigation.magneticVariation']
    rlBearingMagnetic =
      (rlBearingTrue as number) - src['navigation.magneticVariation']
  }

  const rlDistance = vesselPosition?.rhumbDistanceTo(destination)
  const rlVmg = vmg(src, rlBearingTrue)
  const rlTime = timeCalcs(src, rlDistance, rlVmg as number)

  res.rl = {
    calcMethod: 'Rhumbline',
    bearingTrackTrue: rlBearingTrackTrue,
    bearingTrackMagnetic: rlBearingTrackMagnetic,
    crossTrackError: xte,
    distance: rlDistance,
    bearingTrue: rlBearingTrue,
    bearingMagnetic: rlBearingMagnetic,
    velocityMadeGood: rlVmg,
    timeToGo: rlTime.ttg,
    estimatedTimeOfArrival: rlTime.eta,
    previousPoint: {
      distance: vesselPosition?.rhumbDistanceTo(startPoint)
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

// Velocity Made Good to Course
function vmg(src: SKPaths, bearingTrue: number): number | null {
  if (
    typeof src['navigation.headingTrue'] !== 'number' ||
    typeof src['navigation.speedOverGround'] !== 'number'
  ) {
    return null
  }

  return (
    Math.cos(bearingTrue - src['navigation.headingTrue']) *
    src['navigation.speedOverGround']
  )
}

// Time to Go & Estimated time of arrival at the nextPoint
function timeCalcs(
  src: SKPaths,
  distance: number,
  vmg: number
): { ttg: number | null; eta: string | null } {
  if (typeof distance !== 'number' || !vmg) {
    return { ttg: null, eta: null }
  }

  const date: Date = src['navigation.datetime']
    ? new Date(src['navigation.datetime'])
    : new Date()

  const dateMsec = date.getTime()
  const ttgMsec = Math.floor((distance / (vmg * 0.514444)) * 1000)
  const etaMsec = dateMsec + ttgMsec

  return {
    ttg: ttgMsec / 1000,
    eta: new Date(etaMsec).toISOString()
  }
}

// Avg speed required to arrive at destinationa at targetArrivalTime
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
  if (src['navigation.course.activeRoute.waypoints']) {
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
    src['navigation.course.activeRoute.pointIndex'] === null ||
    !src['navigation.course.activeRoute.waypoints'] ||
    !Array.isArray(src['navigation.course.activeRoute.waypoints'])
  ) {
    return 0
  }
  if (src['navigation.course.activeRoute.waypoints'].length < 2) {
    return 0
  }
  let reverse = src['navigation.course.activeRoute.reverse']
  let ptIndex = src['navigation.course.activeRoute.pointIndex']
  let lastIndex = src['navigation.course.activeRoute.waypoints'].length - 1

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
  let wpts = src['navigation.course.activeRoute.waypoints']
  let rteLen = 0
  for (let idx = fromIndex; idx < lastIndex; idx++) {
    let pt = new LatLon(
      wpts[idx].position.latitude,
      wpts[idx].position.longitude
    )
    if (rhumbLine) {
      rteLen += pt.rhumbDistanceTo(
        new LatLon(
          wpts[idx + 1].position.latitude,
          wpts[idx + 1].position.longitude
        )
      )
    } else {
      rteLen += pt.distanceTo(
        new LatLon(
          wpts[idx + 1].position.latitude,
          wpts[idx + 1].position.longitude
        )
      )
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
