import { describe, expect, it } from 'vitest'
import { buildDeltaMsg } from '../src/lib/delta-msg'
import { CourseData } from '../src/types'

function fullCourseData(): CourseData {
  const gc = {
    calcMethod: 'GreatCircle',
    bearingTrackTrue: 1.1,
    bearingTrackMagnetic: 1.2,
    crossTrackError: -3.4,
    distance: 5000,
    bearingTrue: 2.1,
    bearingMagnetic: 2.2,
    velocityMadeGood: 4.5,
    velocityMadeGoodToCourse: 4.2,
    timeToGo: 1200,
    estimatedTimeOfArrival: '2020-01-01T00:20:00.000Z',
    previousPoint: { distance: 100 },
    route: {
      timeToGo: 3600,
      estimatedTimeOfArrival: '2020-01-01T01:00:00.000Z',
      distance: 15000
    },
    targetSpeed: 4.17
  }
  const rl = {
    ...gc,
    calcMethod: 'Rhumbline',
    bearingTrackTrue: 9.9,
    distance: 6000
  }
  return { gc, rl, passedPerpendicular: false }
}

describe('buildDeltaMsg', () => {
  it('emits all 16 paths in stable order', () => {
    const msg = buildDeltaMsg(fullCourseData(), 'GreatCircle')
    const values = msg.updates[0].values

    expect(values).toHaveLength(16)
    const paths = values.map((v) => v.path)
    expect(paths).toEqual([
      'navigation.course.calcValues.calcMethod',
      'navigation.course.calcValues.bearingTrackTrue',
      'navigation.course.calcValues.bearingTrackMagnetic',
      'navigation.course.calcValues.crossTrackError',
      'navigation.course.calcValues.previousPoint.distance',
      'navigation.course.calcValues.distance',
      'navigation.course.calcValues.bearingTrue',
      'navigation.course.calcValues.bearingMagnetic',
      'navigation.course.calcValues.velocityMadeGood',
      'performance.velocityMadeGoodToWaypoint',
      'navigation.course.calcValues.timeToGo',
      'navigation.course.calcValues.estimatedTimeOfArrival',
      'navigation.course.calcValues.route.timeToGo',
      'navigation.course.calcValues.route.estimatedTimeOfArrival',
      'navigation.course.calcValues.route.distance',
      'navigation.course.calcValues.targetSpeed'
    ])
  })

  it('maps GreatCircle source fields and echoes method in calcMethod', () => {
    const course = fullCourseData()
    const msg = buildDeltaMsg(course, 'GreatCircle')
    const byPath = Object.fromEntries(
      msg.updates[0].values.map((v) => [v.path, v.value])
    )

    expect(byPath['navigation.course.calcValues.calcMethod']).toBe(
      'GreatCircle'
    )
    expect(byPath['navigation.course.calcValues.bearingTrackTrue']).toBe(1.1)
    expect(byPath['navigation.course.calcValues.distance']).toBe(5000)
    expect(byPath['navigation.course.calcValues.previousPoint.distance']).toBe(
      100
    )
    expect(
      byPath['navigation.course.calcValues.route.estimatedTimeOfArrival']
    ).toBe('2020-01-01T01:00:00.000Z')
    expect(byPath['navigation.course.calcValues.targetSpeed']).toBe(4.17)
  })

  it('selects the Rhumbline branch when method is Rhumbline', () => {
    const course = fullCourseData()
    const msg = buildDeltaMsg(course, 'Rhumbline')
    const byPath = Object.fromEntries(
      msg.updates[0].values.map((v) => [v.path, v.value])
    )

    expect(byPath['navigation.course.calcValues.calcMethod']).toBe('Rhumbline')
    expect(byPath['navigation.course.calcValues.bearingTrackTrue']).toBe(9.9)
    expect(byPath['navigation.course.calcValues.distance']).toBe(6000)
  })

  it('publishes velocityMadeGoodToCourse under both VMG paths', () => {
    // Intentional quirk preserved from the original implementation: both
    // `velocityMadeGood` and `performance.velocityMadeGoodToWaypoint` expose
    // the VMC-to-course value, not the VMG-to-wind one.
    const course = fullCourseData()
    const msg = buildDeltaMsg(course, 'GreatCircle')
    const byPath = Object.fromEntries(
      msg.updates[0].values.map((v) => [v.path, v.value])
    )

    expect(byPath['navigation.course.calcValues.velocityMadeGood']).toBe(4.2)
    expect(byPath['performance.velocityMadeGoodToWaypoint']).toBe(4.2)
  })

  it('maps undefined fields to null', () => {
    const course: CourseData = {
      gc: {},
      rl: {},
      passedPerpendicular: false
    }
    const msg = buildDeltaMsg(course, 'GreatCircle')
    const byPath = Object.fromEntries(
      msg.updates[0].values.map((v) => [v.path, v.value])
    )

    expect(byPath['navigation.course.calcValues.calcMethod']).toBe(
      'GreatCircle'
    )
    expect(byPath['navigation.course.calcValues.bearingTrackTrue']).toBeNull()
    expect(byPath['navigation.course.calcValues.distance']).toBeNull()
    expect(
      byPath['navigation.course.calcValues.previousPoint.distance']
    ).toBeNull()
    expect(byPath['navigation.course.calcValues.route.timeToGo']).toBeNull()
    expect(byPath['navigation.course.calcValues.targetSpeed']).toBeNull()
  })

  it('maps explicit null fields to null', () => {
    const course: CourseData = {
      gc: {
        bearingTrackTrue: null,
        distance: null,
        previousPoint: { distance: null },
        route: { timeToGo: null, estimatedTimeOfArrival: null, distance: null },
        targetSpeed: null
      },
      rl: {},
      passedPerpendicular: false
    }
    const msg = buildDeltaMsg(course, 'GreatCircle')
    const byPath = Object.fromEntries(
      msg.updates[0].values.map((v) => [v.path, v.value])
    )

    expect(byPath['navigation.course.calcValues.bearingTrackTrue']).toBeNull()
    expect(byPath['navigation.course.calcValues.distance']).toBeNull()
    expect(byPath['navigation.course.calcValues.route.distance']).toBeNull()
  })

  it('preserves zero as a non-null value (distinguishes from undefined)', () => {
    const course: CourseData = {
      gc: { distance: 0, crossTrackError: 0, timeToGo: 0, targetSpeed: 0 },
      rl: {},
      passedPerpendicular: false
    }
    const msg = buildDeltaMsg(course, 'GreatCircle')
    const byPath = Object.fromEntries(
      msg.updates[0].values.map((v) => [v.path, v.value])
    )

    expect(byPath['navigation.course.calcValues.distance']).toBe(0)
    expect(byPath['navigation.course.calcValues.crossTrackError']).toBe(0)
    expect(byPath['navigation.course.calcValues.timeToGo']).toBe(0)
    expect(byPath['navigation.course.calcValues.targetSpeed']).toBe(0)
  })
})
