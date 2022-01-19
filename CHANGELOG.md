# CHANGELOG: @signalk/course-provider

### v1.0.0

- Populates the following course data paths found under both `navigation.courseGreatCircle` and `navigation.courseRhumbline`:

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

- Raises / clears `notifications.navigation.arrivalCircleEntered` notification when arrival circle is entered / exited.


