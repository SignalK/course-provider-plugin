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

- Populates the following steering / autopilot paths:
    - `steering.autopilot.target.headingTrue`

- Raises / clears the following notifications:
    - `notifications.navigation.arrivalCircleEntered`


### Configuration
---
**Notifications:** provides configuration for generated notifications.

- **Enable sound:** Checking this option sets the `sound` flag for any notifications generated.

**Calculation method:** Select the course calculation method to use and the paths to populate.

- Great Circle (default): populates values using `GreatCircle` calculations.
- Rhumbline: populates values using `Rhumbline` calculations.

**Autopilot:**
- Emit target heading delta: Check to send `steering.autopilot.target.headingTrue` delta messages.
