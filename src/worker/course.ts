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
    src['navigation.course.nextPoint.position'] &&
    src['navigation.course.previousPoint.position']
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
  const destination = src['navigation.course.nextPoint.position']
    ? new LatLon(
        src['navigation.course.nextPoint.position'].latitude,
        src['navigation.course.nextPoint.position'].longitude
      )
    : null
  const startPoint = src['navigation.course.previousPoint.position']
    ? new LatLon(
        src['navigation.course.previousPoint.position'].latitude,
        src['navigation.course.previousPoint.position'].longitude
      )
    : null

  const res: CourseData = { gc: {}, rl: {} }
  if (!vesselPosition || !destination || !startPoint) {
    return res
  }

  let xte = vesselPosition?.crossTrackDistanceTo(startPoint, destination)

  // Great Circle
  let bearingTrackTrue = toRadians(startPoint?.initialBearingTo(destination))
  let bearingTrue = toRadians(vesselPosition?.initialBearingTo(destination))
  let bearingTrackMagnetic: number | null = null
  let bearingMagnetic: number | null = null

  if (typeof src['navigation.magneticVariation'] === 'number') {
    bearingTrackMagnetic =
      (bearingTrackTrue as number) - src['navigation.magneticVariation']
    bearingMagnetic =
      (bearingTrue as number) - src['navigation.magneticVariation']
  }

  let gcDistance = vesselPosition?.distanceTo(destination)
  let gcVmg = vmg(src, bearingTrue)
  let gcTime = timeCalcs(src, gcDistance, gcVmg as number)

  res.gc = {
    calcMethod: 'Great Circle',
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
    }
  }

  // Rhumbline
  let rlBearingTrackTrue = toRadians(startPoint?.rhumbBearingTo(destination))
  let rlBearingTrue = toRadians(vesselPosition?.rhumbBearingTo(destination))
  let rlBearingTrackMagnetic: number | null = null
  let rlBearingMagnetic: number | null = null

  if (typeof src['navigation.magneticVariation'] === 'number') {
    rlBearingTrackMagnetic =
      (rlBearingTrackTrue as number) - src['navigation.magneticVariation']
    rlBearingMagnetic =
      (rlBearingTrue as number) - src['navigation.magneticVariation']
  }

  let rlDistance = vesselPosition?.rhumbDistanceTo(destination)
  let rlVmg = vmg(src, rlBearingTrue)
  let rlTime = timeCalcs(src, rlDistance, rlVmg as number)

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
    }
  }
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

  let date: Date = src['navigation.datetime']
    ? new Date(src['navigation.datetime'])
    : new Date()

  let dateMsec = date.getTime()
  let ttgMsec = Math.floor((distance / (vmg * 0.514444)) * 1000)
  let etaMsec = dateMsec + ttgMsec

  return {
    ttg: ttgMsec / 1000,
    eta: new Date(etaMsec).toISOString()
  }
}
