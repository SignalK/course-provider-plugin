# CHANGELOG: @signalk/course-provider

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
    - `estinmatedTimeOfArrival`

- Raises / clears the following notifications:
    - `notifications.navigation.arrivalCircleEntered`
    - `notifications.navigation.perpendicularPassed`

- Optionally (as per configuration) populate the following steering / autopilot path(s):
    - `steering.autopilot.target.headingTrue`


