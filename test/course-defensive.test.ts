import { describe, expect, it, vi } from 'vitest'

vi.mock('../src/lib/geodesy/latlon-spherical.js', () => ({
  LatLonSpherical: class {}
}))

describe('course calculations defensive guards', () => {
  it('parseSKPaths returns false when required positions are missing', async () => {
    const { parseSKPaths } = await import('../src/worker/course')
    const src = {
      'navigation.course.nextPoint': { position: { latitude: 1, longitude: 2 } },
      'navigation.course.previousPoint': {
        position: { latitude: 1, longitude: 2 }
      }
    }

    expect(parseSKPaths(src)).toBe(false)
  })

  it('vmg returns null when wind or speed is missing', async () => {
    const { vmg } = await import('../src/worker/course')
    const srcMissingWind = { 'navigation.speedOverGround': 3 }
    const srcMissingSpeed = { 'environment.wind.angleTrueGround': 0.5 }

    expect(vmg(srcMissingWind)).toBeNull()
    expect(vmg(srcMissingSpeed)).toBeNull()
  })

  it('vmc returns null when course or speed is missing', async () => {
    const { vmc } = await import('../src/worker/course')
    const srcMissingCog = { 'navigation.speedOverGround': 3 }
    const srcMissingSpeed = { 'navigation.courseOverGroundTrue': 1.2 }

    expect(vmc(srcMissingCog, 1.5)).toBeNull()
    expect(vmc(srcMissingSpeed, 1.5)).toBeNull()
  })

  it('timeCalcs returns empty results when vmc is non-positive', async () => {
    const { timeCalcs } = await import('../src/worker/course')
    const src = {
      'navigation.datetime': '2020-01-01T00:00:00.000Z'
    }
    const result = timeCalcs(src, 100, -1, false)

    expect(result.nextPoint.ttg).toBeNull()
    expect(result.nextPoint.eta).toBeNull()
  })

  it('targetSpeed returns null for invalid targetArrivalTime', async () => {
    const { targetSpeed } = await import('../src/worker/course')
    const src = {
      'navigation.datetime': '2020-01-01T00:00:00.000Z',
      'navigation.course.targetArrivalTime': 'invalid'
    }

    expect(targetSpeed(src, 100)).toBeNull()
  })
})
