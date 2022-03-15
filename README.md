# Course Provider Plugin:

__Signal K server plugin that acts as a Course data provider__.

_Note: This plugin should ONLY be installed on a Signal K server that implements `v2 Course API`!_

---

This plugin populates the following course data paths found under `navigation.course.calculations`:

- `calcMethod`
- `bearingTrackTrue`
- `bearingTrackMagnetic`
- `crossTrackError`
- `previousPoint.distance`
- `nextPoint.distance`
- `nextPoint.bearingTrue`
- `nextPoint.bearingMagnetic`
- `nextPoint.velocityMadeGood`
- `nextPoint.timeToGo`
- `nextPoint.estinmatedTimeOfArrival`

---

Additionally it will raise notifications when the value of `nextPoint.distance` falls below the value of `nextPoint.arrivalCircle` via the Signal K path __`notifications.navigation.arrivalCircleEntered`__.




