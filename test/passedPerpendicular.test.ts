import { expect } from 'chai'
import { LatLonSpherical } from '../src/lib/geodesy/latlon-spherical'
import { passedPerpendicular } from '../src/worker/course'

describe('Passed Perpendicular', () => {
  it('(+ive diff) should return FALSE', () => {
    const startPosition = new LatLonSpherical(57.58684, 11.106578)
    const destPosition = new LatLonSpherical(57.61672, 11.10488)
    const vesselPosition = new LatLonSpherical(57.61657, 11.10054)
    expect(passedPerpendicular(vesselPosition, destPosition, startPosition)).to
      .be.false
  })

  it('(+ive diff) should return TRUE', () => {
    const startPosition = new LatLonSpherical(57.58684, 11.106578)
    const destPosition = new LatLonSpherical(57.61672, 11.10488)
    const vesselPosition = new LatLonSpherical(57.61905, 11.10306)
    expect(passedPerpendicular(vesselPosition, destPosition, startPosition)).to
      .be.true
  })

  it('(-ive diff) should return FALSE', () => {
    const startPosition = new LatLonSpherical(57.58684, 11.106578)
    const destPosition = new LatLonSpherical(57.61672, 11.10488)
    const vesselPosition = new LatLonSpherical(57.61505, 11.10054)
    expect(passedPerpendicular(vesselPosition, destPosition, startPosition)).to
      .be.false
  })

  it('(-ive diff) should return TRUE', () => {
    const startPosition = new LatLonSpherical(57.58684, 11.106578)
    const destPosition = new LatLonSpherical(57.61672, 11.10488)
    const vesselPosition = new LatLonSpherical(57.61905, 11.10306)
    expect(passedPerpendicular(vesselPosition, destPosition, startPosition)).to
      .be.true
  })
})

describe('Dateline crossing', () => {
  it('(E to W) should return FALSE', () => {
    const startPosition = new LatLonSpherical(-35.9749, 179.89971)
    const destPosition = new LatLonSpherical(-35.95874, -179.22151)
    const vesselPosition = new LatLonSpherical(-35.93179, 179.933)
    expect(passedPerpendicular(vesselPosition, destPosition, startPosition)).to
      .be.false
  })

  it('(E to W) should return TRUE', () => {
    const startPosition = new LatLonSpherical(-35.9749, 179.89971)
    const destPosition = new LatLonSpherical(-35.95874, -179.22151)
    const vesselPosition = new LatLonSpherical(-35.90753, -179.21486)
    expect(passedPerpendicular(vesselPosition, destPosition, startPosition)).to
      .be.true
  })

  it('(W to E) should return FALSE', () => {
    const startPosition = new LatLonSpherical(-35.95874, -179.22151)
    const destPosition = new LatLonSpherical(-35.9749, 179.89971)
    const vesselPosition = new LatLonSpherical(-35.93179, -179.95716)
    expect(passedPerpendicular(vesselPosition, destPosition, startPosition)).to
      .be.false
  })

  it('(W to E) should return TRUE', () => {
    const startPosition = new LatLonSpherical(-35.95874, -179.22151)
    const destPosition = new LatLonSpherical(-35.9749, 179.89971)
    const vesselPosition = new LatLonSpherical(-35.90753, 179.87308)
    expect(passedPerpendicular(vesselPosition, destPosition, startPosition)).to
      .be.true
  })
})
