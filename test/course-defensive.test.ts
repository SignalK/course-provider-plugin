import { describe, expect, it, vi } from 'vitest'

vi.mock('../src/lib/geodesy/latlon-spherical.js', () => ({
  LatLonSpherical: class {}
}))

describe('course calculations defensive guards', () => {
  it('parseSKPaths returns false when required positions are missing', async () => {
    const { parseSKPaths } = await import('../src/worker/course')
    const src = {
      'navigation.course.nextPoint': {
        position: { latitude: 1, longitude: 2 }
      },
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

  it('timeCalcs returns empty results when vmc is zero', async () => {
    const { timeCalcs } = await import('../src/worker/course')
    const src = {
      'navigation.datetime': '2020-01-01T00:00:00.000Z'
    }
    const result = timeCalcs(src, 100, 0, false)

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

describe('timeCalcs / targetSpeed positive paths', () => {
  // Pins the arithmetic so the Date-allocation refactor can't change
  // observable outputs (TTG seconds, ETA ISO string, targetSpeed).

  it('timeCalcs derives TTG and ETA from an ISO datetime', async () => {
    const { timeCalcs } = await import('../src/worker/course')
    // 1000 m at 10 m/s = 100 s -> ETA = base + 100 s
    const src = { 'navigation.datetime': '2020-01-01T00:00:00.000Z' }
    const result = timeCalcs(src, 1000, 10, false)

    expect(result.nextPoint.ttg).toBe(100)
    expect(result.nextPoint.eta).toBe('2020-01-01T00:01:40.000Z')
    expect(result.route.ttg).toBeNull()
    expect(result.route.eta).toBeNull()
  })

  it('timeCalcs accepts numeric epoch-ms datetime (legacy tolerance)', async () => {
    const { timeCalcs } = await import('../src/worker/course')
    // 2020-01-01T00:00:00.000Z = 1577836800000 ms
    const src = { 'navigation.datetime': 1577836800000 }
    const result = timeCalcs(src, 500, 5, false)

    expect(result.nextPoint.ttg).toBe(100)
    expect(result.nextPoint.eta).toBe('2020-01-01T00:01:40.000Z')
  })

  it('timeCalcs falls back to current time when datetime is missing', async () => {
    const { timeCalcs } = await import('../src/worker/course')
    const before = Date.now()
    const result = timeCalcs({}, 200, 10, false)
    const after = Date.now()

    expect(result.nextPoint.ttg).toBe(20)
    expect(result.nextPoint.eta).not.toBeNull()
    const etaMs = Date.parse(result.nextPoint.eta as string)
    // ETA should land in [before+20s, after+20s]
    expect(etaMs).toBeGreaterThanOrEqual(before + 20_000)
    expect(etaMs).toBeLessThanOrEqual(after + 20_000)
  })

  it('targetSpeed computes average speed from time-to-arrival window', async () => {
    const { targetSpeed } = await import('../src/worker/course')
    // 1000 m over 500 s -> 2 m/s
    const src = {
      'navigation.datetime': '2020-01-01T00:00:00.000Z',
      'navigation.course.targetArrivalTime': '2020-01-01T00:08:20.000Z'
    }
    expect(targetSpeed(src, 1000)).toBe(2)
  })

  it('targetSpeed accepts numeric epoch-ms datetime and TAT', async () => {
    const { targetSpeed } = await import('../src/worker/course')
    const base = 1577836800000
    const src = {
      'navigation.datetime': base,
      'navigation.course.targetArrivalTime': base + 500_000
    }
    expect(targetSpeed(src, 1000)).toBe(2)
  })

  it('targetSpeed returns null when current time is past targetArrivalTime', async () => {
    const { targetSpeed } = await import('../src/worker/course')
    const src = {
      'navigation.datetime': '2020-01-01T00:10:00.000Z',
      'navigation.course.targetArrivalTime': '2020-01-01T00:05:00.000Z'
    }
    expect(targetSpeed(src, 1000)).toBeNull()
  })
})
