
const { LatLonSpherical } = require('../src/lib/geodesy/latlon-spherical')
const { passedPerpendicular } = require('../plugin/worker/course')

// ** +ive angle diff

let startPosition = new LatLonSpherical(57.58684, 11.106578)
let destPosition = new LatLonSpherical(57.61672, 11.10488)

console.log('pastPerpendicular (+ive diff) should return FALSE')
let vesselPosition = new LatLonSpherical(57.61657, 11.10054)
console.log(passedPerpendicular(vesselPosition, destPosition, startPosition))

console.log('pastPerpendicular (+ive diff) should return TRUE')
vesselPosition = new LatLonSpherical(57.61905, 11.10306)
console.log(passedPerpendicular(vesselPosition, destPosition, startPosition))

// ** -ive angle diff

startPosition = new LatLonSpherical(57.58684, 11.13768)

console.log('pastPerpendicular (-ive diff) should return FALSE')
vesselPosition = new LatLonSpherical(57.61505, 11.10054)
console.log(passedPerpendicular(vesselPosition, destPosition, startPosition))

console.log('pastPerpendicular (-ive diff) should return TRUE')
vesselPosition = new LatLonSpherical(57.61905, 11.10306)
console.log(passedPerpendicular(vesselPosition, destPosition, startPosition))


// ** Dateline crossing E to W **

startPosition = new LatLonSpherical(-35.97490, 179.89971)
destPosition = new LatLonSpherical(-35.95874, -179.22151)

console.log('pastPerpendicular EW dateline crossing should return FALSE')
vesselPosition = new LatLonSpherical(-35.93179, 179.93300)
console.log(passedPerpendicular(vesselPosition, destPosition, startPosition))

console.log('pastPerpendicular EW dateline crossing should return TRUE')
vesselPosition = new LatLonSpherical(-35.90753, -179.21486)
console.log(passedPerpendicular(vesselPosition, destPosition, startPosition))


// ** Dateline crossing W to E **

startPosition = new LatLonSpherical(-35.95874, -179.22151)
destPosition = new LatLonSpherical(-35.97490, 179.89971)

console.log('pastPerpendicular WE dateline crossing should return FALSE')
vesselPosition = new LatLonSpherical(-35.93179, -179.95716)
console.log(passedPerpendicular(vesselPosition, destPosition, startPosition))

console.log('pastPerpendicular WE dateline crossing should return TRUE')
vesselPosition = new LatLonSpherical(-35.90753, 179.87308)
console.log(passedPerpendicular(vesselPosition, destPosition, startPosition))

