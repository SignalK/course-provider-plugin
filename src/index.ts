import { Plugin, ServerAPI, SKVersion, CourseInfo } from '@signalk/server-api'
import { Application, Request, Response } from 'express'
import { Notification, Watcher, WatchEvent } from './lib/alarms'
import {
  CourseData,
  SKPaths,
  ALARM_METHOD,
  ALARM_STATE,
  DeltaUpdate,
  DeltaValue
} from './types'

import path from 'path'
import { Worker } from 'worker_threads'
import { Subscription } from 'rxjs'

interface SKDeltaSubscription {
  context: string
  subscribe: Array<{ path: string; period: number }>
}

interface CourseComputerApp extends Application, ServerAPI {
  subscriptionmanager: {
    subscribe: (
      subscribe: SKDeltaSubscription,
      unsubscribes: Array<any>,
      errorCallback: (error: any) => void,
      deltaCallback: (delta: DeltaUpdate) => void
    ) => void
  }
  resourcesApi: {
    getResource: (resType: string, id: string) => Promise<any>
  }
}

const CONFIG_SCHEMA = {
  properties: {
    notifications: {
      type: 'object',
      title: 'Notifications',
      description: 'Configure the options for generated notifications.',
      properties: {
        sound: {
          type: 'boolean',
          title: 'Enable sound'
        }
      }
    },
    calculations: {
      type: 'object',
      title: 'Calculations',
      description: 'Configure course calculations options.',
      properties: {
        method: {
          type: 'string',
          default: 'GreatCircle',
          enum: ['GreatCircle', 'Rhumbline']
        }
      }
    }
  }
}

const CONFIG_UISCHEMA = {
  notifications: {
    sound: {
      'ui:widget': 'checkbox',
      'ui:title': ' ',
      'ui:help': ''
    }
  },
  calculations: {
    method: {
      'ui:widget': 'radio',
      'ui:title': 'Course calculation method',
      'ui:help': ' '
    }
  }
}

const SRC_PATHS = [
  'navigation.position',
  'navigation.magneticVariation',
  'navigation.headingTrue',
  'navigation.courseOverGroundTrue',
  'navigation.speedOverGround',
  'environment.wind.angleTrueGround',
  'navigation.datetime',
  'navigation.course.arrivalCircle',
  'navigation.course.startTime',
  'navigation.course.targetArrivalTime',
  'navigation.course.nextPoint',
  'navigation.course.previousPoint',
  'navigation.course.activeRoute',
  'resources.routes.*'
]

module.exports = (server: CourseComputerApp): Plugin => {
  const watchArrival: Watcher = new Watcher() // watch distance from arrivalCircle
  const watchPassedDest: Watcher = new Watcher() // watch passedPerpendicular
  watchPassedDest.rangeMin = 1
  watchPassedDest.rangeMax = 2
  let unsubscribes: any[] = [] // delta stream subscriptions
  let obs: any[] = [] // Observables subscription
  let worker: Worker

  const SIGNALK_API_PATH = `/signalk/v2/api`
  const COURSE_CALCS_PATH = `${SIGNALK_API_PATH}/vessels/self/navigation/course/calcValues`

  const srcPaths: SKPaths = {}
  let courseCalcs: CourseData
  let activeRouteId: string | undefined

  let metaSent = false

  // ******** REQUIRED PLUGIN DEFINITION *******
  const plugin: Plugin = {
    id: 'course-provider',
    name: 'Course Data provider',
    schema: () => CONFIG_SCHEMA,
    uiSchema: () => CONFIG_UISCHEMA,
    start: (options: { [key: string]: any }) => {
      doStartup(options)
    },
    stop: () => {
      doShutdown()
    }
  }
  // ************************************

  let config: any = {
    notifications: {
      sound: false
    },
    calculations: {
      method: 'GreatCircle'
    }
  }

  const doStartup = (options: any) => {
    try {
      server.debug(`${plugin.name} starting.......`)
      if (
        typeof options.notifications?.sound !== 'undefined' &&
        typeof options.calculations?.method !== 'undefined'
      ) {
        config = options
      }

      server.debug(`Applied config: ${JSON.stringify(config)}`)

      // setup subscriptions
      initSubscriptions(SRC_PATHS)
      // setup worker(s)
      initWorkers()
      // setup routes
      initEndpoints()

      const msg = 'Started'
      server.setPluginStatus(msg)
    } catch (error) {
      const msg = 'Started with errors!'
      server.setPluginError(msg)
      server.error('** EXCEPTION: **')
      server.error((error as any).stack)
      return error
    }
  }

  const doShutdown = () => {
    server.debug('** shutting down **')
    server.debug('** Un-subscribing from events **')
    unsubscribes.forEach((s) => s())
    unsubscribes = []
    obs.forEach((o: Subscription) => o.unsubscribe())
    obs = []
    if (worker) {
      server.debug('** Stopping Worker(s) **')
      worker.unref()
    }
    const msg = 'Stopped'
    server.setPluginStatus(msg)
  }

  // *****************************************

  // register DELTA stream message handler
  const initSubscriptions = (skPaths: string[]) => {
    server.debug('Initialising Stream Subscriptions....')
    getPaths(skPaths)

    const subscription: SKDeltaSubscription = {
      context: 'vessels.self',
      subscribe: skPaths.map((p) => ({
        path: p,
        period: 500
      }))
    }

    server.subscriptionmanager.subscribe(
      subscription,
      unsubscribes,
      (error) => {
        server.error(`${plugin.id} Error: ${error}`)
      },
      (delta: DeltaUpdate) => {
        if (!delta.updates) {
          return
        }
        delta.updates.forEach((u: { values: DeltaValue[] }) => {
          if (!u.values) {
            return
          }
          u.values.forEach((v: DeltaValue) => {
            if (v.path === 'navigation.position') {
              server.debug(
                `navigation.position ${JSON.stringify(v.value)} => calc()`
              )
              srcPaths[v.path] = v.value
              calc()
            } else if (v.path === 'navigation.course.activeRoute') {
              handleActiveRoute(v.value ? { ...v.value } : null)
            } else if (v.path.startsWith('resources.route')) {
              handleRouteUpdate(v)
            } else {
              srcPaths[v.path] = v.value
            }
          })
        })
      }
    )

    obs.push(
      watchArrival.change$.subscribe((event: WatchEvent) => {
        onArrivalCircleEvent(event)
      })
    )
    obs.push(
      watchPassedDest.change$.subscribe((event: WatchEvent) => {
        onPassedDestEvent(event)
      })
    )
  }

  // initialise calculation worker(s)
  const initWorkers = () => {
    server.debug('Initialising worker thread....')
    worker = new Worker(path.resolve(__dirname, './worker/course.js'))
    worker.on('message', (msg) => {
      calcResult(msg)
    })
    worker.on('error', (error) => console.error('** worker.error:', error))
    worker.on('exit', (code) => {
      if (code !== 0) {
        console.error('** worker.exit:', `Stopped with exit code ${code}`)
      }
    })
  }

  // initialise api endpoints
  const initEndpoints = () => {
    server.debug('Initialising API endpoint(s)....')
    server.get(`${COURSE_CALCS_PATH}`, async (req: Request, res: Response) => {
      server.debug(`** GET ${COURSE_CALCS_PATH}`)
      const calcs =
        config.calculations.method === 'Rhumbline'
          ? courseCalcs?.rl
          : courseCalcs?.gc

      if (!calcs) {
        res.status(400).json({
          state: 'FAILED',
          statusCode: 400,
          message: `No active destination!`
        })
        return
      }

      return res.status(200).json(calcs)
    })
  }

  // ********* Course Calculations *******************

  // retrieve initial values of target paths
  const getPaths = async (paths: string[]) => {
    paths.forEach((path) => {
      const v = server.getSelfPath(path)
      srcPaths[path] = v?.value ?? null
    })
    const ci = await server.getCourse()
    server.debug(`*** getPaths() ${JSON.stringify(ci)}`)
    if (ci) {
      srcPaths['navigation.course.nextPoint'] = ci.nextPoint
      srcPaths['navigation.course.previousPoint'] = ci.previousPoint
      srcPaths['activeRoute'] = ci.activeRoute
      if (ci.activeRoute) {
        activeRouteId = ci.activeRoute.href.split('/').slice(-1)[0]
        const waypoints = await getWaypoints(activeRouteId)
        srcPaths['activeRoute'].waypoints = waypoints
      }
    }
    server.debug(`[srcPaths]: ${JSON.stringify(srcPaths)}`)
  }

  // retrieve waypoints for supplied route id
  const getWaypoints = async (id: string): Promise<Array<[number, number]>> => {
    const rte = await server.resourcesApi.getResource('routes', id)
    const waypoints = rte ? rte.feature.geometry.coordinates : []
    server.debug(`*** activeRoute waypoints *** ${waypoints}`)
    return waypoints
  }

  // resources.routes delta handler
  const handleRouteUpdate = async (msg: DeltaValue) => {
    server.debug(`*** handleRouteUpdate *** ${JSON.stringify(msg)}`)
    if (msg.path.endsWith(activeRouteId as string)) {
      server.debug(`*** matched activeRouteId *** ${activeRouteId}`)
      const waypoints = await getWaypoints(activeRouteId as string)
      srcPaths['activeRoute'].waypoints = waypoints
    }
  }

  // 'navigation.course.activeRoute' delta handler
  const handleActiveRoute = async (value: any) => {
    server.debug(`*** handleActiveRoute *** ${JSON.stringify(value)}`)

    if (!value) {
      srcPaths['activeRoute'] = null
      activeRouteId = undefined
      return
    }
    if (!activeRouteId) {
      activeRouteId = value.href.split('/').slice(-1)[0]
    }

    if (value.href.includes(activeRouteId)) {
      const waypoints = await getWaypoints(activeRouteId as string)
      srcPaths['activeRoute'] = Object.assign({}, value, {
        waypoints: waypoints
      })
    }
    server.debug(
      `*** activeRoute *** ${JSON.stringify(srcPaths['activeRoute'])}`
    )
  }

  // trigger course calculations
  const calc = () => {
    server.debug(
      `*** navigation.position *** ${JSON.stringify(
        srcPaths['navigation.position']
      )}`
    )
    if (srcPaths['navigation.position']) {
      server.debug(JSON.stringify(srcPaths))
      worker?.postMessage(srcPaths)
    } else {
      server.debug('No vessel position.....Skipping calc()')
    }
  }

  // send calculation results delta
  const calcResult = async (result: CourseData) => {
    server.debug(`*** calculation result ***`)
    server.debug(JSON.stringify(result))
    watchArrival.rangeMax = srcPaths['navigation.course.arrivalCircle'] ?? -1
    watchArrival.value = result.gc?.distance ?? -1
    watchPassedDest.value = result.passedPerpendicular ? 1 : 0
    courseCalcs = result
    server.handleMessage(
      plugin.id,
      buildDeltaMsg(courseCalcs as CourseData),
      SKVersion.v2
    )
    server.debug(`*** course data delta sent***`)
    if (!metaSent) {
      server.handleMessage(plugin.id, buildMetaDeltaMsg(), SKVersion.v2)
      server.debug(`*** meta delta sent***`)
      metaSent = true
    }
  }

  const buildDeltaMsg = (course: CourseData): any => {
    const values: Array<{ path: string; value: any }> = []
    const calcPath = 'navigation.course.calcValues'
    const source =
      config.calculations.method === 'Rhumbline' ? course.rl : course.gc

    server.debug(`*** building course data delta ***`)
    values.push({
      path: `${calcPath}.calcMethod`,
      value: config.calculations.method
    })
    values.push({
      path: `${calcPath}.bearingTrackTrue`,
      value:
        typeof source.bearingTrackTrue === 'undefined'
          ? null
          : source.bearingTrackTrue
    })
    values.push({
      path: `${calcPath}.bearingTrackMagnetic`,
      value:
        typeof source.bearingTrackMagnetic === 'undefined'
          ? null
          : source.bearingTrackMagnetic
    })
    values.push({
      path: `${calcPath}.crossTrackError`,
      value:
        typeof source.crossTrackError === 'undefined'
          ? null
          : source.crossTrackError
    })

    values.push({
      path: `${calcPath}.previousPoint.distance`,
      value:
        typeof source.previousPoint?.distance === 'undefined'
          ? null
          : source.previousPoint?.distance
    })

    values.push({
      path: `${calcPath}.distance`,
      value: typeof source?.distance === 'undefined' ? null : source?.distance
    })
    values.push({
      path: `${calcPath}.bearingTrue`,
      value:
        typeof source?.bearingTrue === 'undefined' ? null : source?.bearingTrue
    })
    values.push({
      path: `${calcPath}.bearingMagnetic`,
      value:
        typeof source?.bearingMagnetic === 'undefined'
          ? null
          : source?.bearingMagnetic
    })

    values.push({
      path: `${calcPath}.velocityMadeGood`,
      value:
        typeof source?.velocityMadeGoodToCourse === 'undefined'
          ? null
          : source?.velocityMadeGoodToCourse
    })
    values.push({
      path: `performance.velocityMadeGoodToWaypoint`,
      value:
        typeof source?.velocityMadeGoodToCourse === 'undefined'
          ? null
          : source?.velocityMadeGoodToCourse
    })
    values.push({
      path: `${calcPath}.timeToGo`,
      value: typeof source?.timeToGo === 'undefined' ? null : source?.timeToGo
    })
    values.push({
      path: `${calcPath}.estimatedTimeOfArrival`,
      value:
        typeof source?.estimatedTimeOfArrival === 'undefined'
          ? null
          : source?.estimatedTimeOfArrival
    })

    values.push({
      path: `${calcPath}.route.timeToGo`,
      value:
        typeof source?.route?.timeToGo === 'undefined'
          ? null
          : source?.route?.timeToGo
    })
    values.push({
      path: `${calcPath}.route.estimatedTimeOfArrival`,
      value:
        typeof source?.route?.estimatedTimeOfArrival === 'undefined'
          ? null
          : source?.route?.estimatedTimeOfArrival
    })
    values.push({
      path: `${calcPath}.route.distance`,
      value:
        typeof source?.route?.distance === 'undefined'
          ? null
          : source?.route?.distance
    })

    values.push({
      path: `${calcPath}.targetSpeed`,
      value:
        typeof source?.targetSpeed === 'undefined' ? null : source?.targetSpeed
    })

    return {
      updates: [
        {
          values: values
        }
      ]
    }
  }

  const buildMetaDeltaMsg = (): any => {
    const metas: Array<{ path: string; value: any }> = []
    const calcPath = 'navigation.course.calcValues'
    server.debug(`*** building meta delta ***`)
    metas.push({
      path: `${calcPath}.calcMethod`,
      value: {
        description: 'Calculation type used (GreatCircle or Rhumbline).'
      }
    })
    metas.push({
      path: `${calcPath}.bearingTrackTrue`,
      value: {
        description:
          'The bearing of a line between previousPoint and nextPoint, relative to true north.',
        units: 'rad'
      }
    })
    metas.push({
      path: `${calcPath}.bearingTrackMagnetic`,
      value: {
        description:
          'The bearing of a line between previousPoint and nextPoint, relative to magnetic north.',
        units: 'rad'
      }
    })
    metas.push({
      path: `${calcPath}.crossTrackError`,
      value: {
        description:
          "The distance from the vessel's present position to the closest point on a line (track) between previousPoint and nextPoint. A negative number indicates that the vessel is currently to the left of this line (and thus must steer right to compensate), a positive number means the vessel is to the right of the line (steer left to compensate).",
        units: 'm'
      }
    })

    metas.push({
      path: `${calcPath}.previousPoint.distance`,
      value: {
        description:
          "The distance in meters between the vessel's present position and the previousPoint.",
        units: 'm'
      }
    })

    metas.push({
      path: `${calcPath}.distance`,
      value: {
        description:
          "The distance in meters between the vessel's present position and the nextPoint.",
        units: 'm'
      }
    })
    metas.push({
      path: `${calcPath}.bearingTrue`,
      value: {
        description:
          "The bearing of a line between the vessel's current position and nextPoint, relative to true north.",
        units: 'rad'
      }
    })
    metas.push({
      path: `${calcPath}.bearingMagnetic`,
      value: {
        description:
          "The bearing of a line between the vessel's current position and nextPoint, relative to magnetic north.",
        units: 'rad'
      }
    })
    metas.push({
      path: `${calcPath}.velocityMadeGood`,
      value: {
        description:
          'The velocity component of the vessel towards the nextPoint.',
        units: 'm/s'
      }
    })
    metas.push({
      path: `${calcPath}.timeToGo`,
      value: {
        description:
          "Time in seconds to reach nextPoint's perpendicular with current speed & direction.",
        units: 's'
      }
    })
    metas.push({
      path: `${calcPath}.estimatedTimeOfArrival`,
      value: {
        description: 'The estimated time of arrival at nextPoint position.'
      }
    })
    metas.push({
      path: `${calcPath}.route.timeToGo`,
      value: {
        description:
          'Time in seconds to reach final destination with current speed & direction.',
        units: 's'
      }
    })
    metas.push({
      path: `${calcPath}.route.estimatedTimeOfArrival`,
      value: {
        description: 'The estimated time of arrival at final destination.'
      }
    })
    metas.push({
      path: `${calcPath}.route.distance`,
      value: {
        description:
          'The remaining distance along the route to reach the final destination.',
        units: 'm'
      }
    })
    metas.push({
      path: `${calcPath}.targetSpeed`,
      value: {
        description:
          'The average speed required to arrive at the destination at the targetArrivalTime.',
        units: 'm/s'
      }
    })

    return {
      updates: [
        {
          meta: metas
        }
      ]
    }
  }

  // ********* Arrival circle events *****************

  const onArrivalCircleEvent = (event: WatchEvent) => {
    server.debug(JSON.stringify(event))
    const alarmMethod = config.notifications.sound
      ? [ALARM_METHOD.sound, ALARM_METHOD.visual]
      : [ALARM_METHOD.visual]

    if (event.type === 'enter') {
      if (srcPaths['navigation.position']) {
        emitNotification(
          new Notification(
            'navigation.course.arrivalCircleEntered',
            `Entered arrival zone: ${event.value.toFixed(
              0
            )}m < ${watchArrival.rangeMax.toFixed(0)}`,
            ALARM_STATE.alert,
            alarmMethod
          )
        )
      }
    }
    if (event.type === 'exit') {
      emitNotification(
        new Notification('navigation.course.arrivalCircleEntered', null)
      )
    }
  }

  // ********* Passed Destination events *****************
  const onPassedDestEvent = (event: WatchEvent) => {
    server.debug(JSON.stringify(event))
    if (event.type === 'enter') {
      if (srcPaths['navigation.position']) {
        emitNotification(
          new Notification(
            'navigation.course.perpendicularPassed',
            watchPassedDest.value === 1
              ? 'Next Point perpendicular has been passed.'
              : '',
            ALARM_STATE.alert,
            []
          )
        )
      }
    }
    if (event.type === 'exit') {
      emitNotification(
        new Notification('navigation.course.perpendicularPassed', null)
      )
    }
  }

  // send notification delta message
  const emitNotification = (notification: Notification) => {
    server.debug(JSON.stringify(notification?.message))
    server.handleMessage(plugin.id, {
      updates: [{ values: [notification.message] }]
    })
  }

  return plugin
}
