# Course Provider Plugin:

__Signal K server plugin that acts as a Course data provider__.

_Note: This plugin should ONLY be installed on a Signal K server that implements `v2 Course API`!_

---

This plugin populates the following course data paths found under `navigation.course.calcValues` as well as providing an API endpoint at `/signalk/v2/api/vessels/self/navigation/course/calcValues`:

- `calcMethod`
- `bearingTrackTrue`
- `bearingTrackMagnetic`
- `crossTrackError`
- `previousPoint.distance`
- `distance`
- `bearingTrue`
- `bearingMagnetic`
- `velocityMadeGood`
- `timeToGo`
- `estinmatedTimeOfArrival`

and optionally (as per settings):
- `steering.autopilot.target.headingTrue`
- `steering.autopilot.target.bearingMagnetic`

---

Additionally it will raise notifications when the value of `distance` falls below the value of `navigation.course.nextPoint.arrivalCircle` via the Signal K path __`notifications.navigation.arrivalCircleEntered`__.




