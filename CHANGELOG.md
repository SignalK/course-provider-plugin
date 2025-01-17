# CHANGELOG: @signalk/course-provider

## v1.1.1

- **Fixed**: - Issue where magnetic bearing values fell outside of the 0-360 degree range.

## v1.1.0

- **Added**: - `performance.velocityMadeGoodToWaypoint`.
- **Update**: - Use a value of _0_ when `navigation.magneticVariation` is undefined to ensure `bearingTrackMagnetic` & `bearingMagnetic` have a value.

## v1.0.3

- **Fixed**: - Value of `navigation.course.calcValues.calcMethod` being set to `undefined` when course is cleared.

## v1.0.2

- **Fixed**: - Remove erroneous unit conversion in TTG calculation.

## v1.0.1

- **Update**: - Change plugin catagory keyword to `signalk-category-utility`.

## v1.0.0

- Populates the following course data paths under `navigation.course.calcValues`:

    - `bearingTrackTrue`
    - `bearingTrackMagnetic`
    - `crossTrackError`
    - `distance`
    - `distance`
    - `bearingTrue`
    - `bearingMagnetic`
    - `velocityMadeGood`
    - `timeToGo`
    - `estimatedTimeOfArrival`
    - `targetSpeed`

- Raises / clears the following notifications:
    - `notifications.navigation.arrivalCircleEntered`
    - `notifications.navigation.perpendicularPassed`

