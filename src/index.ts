import { Plugin, PluginServerApp } from '@signalk/server-api'
import { Application, Request, Response } from 'express'
import { Notification, Watcher, WatchEvent } from './lib/alarms'
import {
  CourseData,
  SKPaths,
  ALARM_METHOD,
  ALARM_STATE,
  DeltaNotification,
  DeltaUpdate
} from './types'

import path from 'path'
import { Worker } from 'worker_threads'
import { Subscription } from 'rxjs'

interface CourseComputerApp extends Application, PluginServerApp {
  error: (msg: string) => void
  debug: (msg: string) => void
  setPluginStatus: (pluginId: string, status?: string) => void
  setPluginError: (pluginId: string, status?: string) => void
  getSelfPath: (path: string) => any
  handleMessage: (
    id: string | null,
    msg: DeltaUpdate | DeltaNotification
  ) => void
  streambundle: {
    getSelfBus: (path: string | void) => any
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
  'navigation.speedOverGround',
  'navigation.datetime',
  'navigation.course.arrivalCircle',
  'navigation.course.startTime',
  'navigation.course.targetArrivalTime',
  'navigation.course.nextPoint',
  'navigation.course.previousPoint'
]

module.exports = (server: CourseComputerApp): Plugin => {
  const watchArrival: Watcher = new Watcher() // watch distance from arrivalCircle
  const watchPassedDest: Watcher = new Watcher() // watch passedPerpendicular
  watchPassedDest.rangeMin = 1
  watchPassedDest.rangeMax = 2
  let baconSub: any[] = [] // stream subscriptions
  let obs: any[] = [] // Observables subscription
  let worker: Worker

  const SIGNALK_API_PATH = `/signalk/v2/api`
  const COURSE_CALCS_PATH = `${SIGNALK_API_PATH}/vessels/self/navigation/course/calcValues`

  const srcPaths: SKPaths = {}
  let courseCalcs: CourseData

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
    baconSub.forEach((b) => b())
    baconSub = []
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

  // register STREAM UPDATE message handler
  const initSubscriptions = (skPaths: string[]) => {
    getPaths(skPaths)

    skPaths.forEach((path: string) => {
      baconSub.push(
        server.streambundle.getSelfBus(path).onValue((v: any) => {
          srcPaths[path] = v.value
          if (path === 'navigation.position') {
            calc()
          }
        })
      )
    })

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
  const getPaths = (paths: string[]) => {
    paths.forEach((path) => {
      const v = server.getSelfPath(path)
      srcPaths[path] = v?.value ?? null
    })
    server.debug(`[srcPaths]: ${JSON.stringify(srcPaths)}`)
  }

  // trigger course calculations
  const calc = () => {
    if (srcPaths['navigation.position']) {
      server.debug(`*** do course calculation ***`)
      worker?.postMessage(srcPaths)
    }
  }

  // send calculation results delta
  const calcResult = async (result: CourseData) => {
    server.debug(`*** calculation result ***`)
    watchArrival.rangeMax =
      srcPaths['navigation.course.arrivalCircle'] ?? -1
    watchArrival.value = result.gc?.distance ?? -1
    watchPassedDest.value = result.passedPerpendicular ? 1 : 0
    courseCalcs = result
    server.handleMessage(plugin.id, buildDeltaMsg(courseCalcs as CourseData))
    server.debug(`*** course data delta sent***`)
    if (!metaSent) {
      server.handleMessage(
        plugin.id,
        buildMetaDeltaMsg()
      )
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
      value: source.calcMethod
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
        typeof source?.velocityMadeGood === 'undefined'
          ? null
          : source?.velocityMadeGood
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
          "Time in seconds to reach nextPoint's perpendicular) with current speed & direction.",
        units: 's'
      }
    })
    metas.push({
      path: `${calcPath}.estimatedTimeOfArrival`,
      value: {
        description: 'The estimated time of arrival at nextPoint position.',
        units: 's'
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
            watchPassedDest.value.toString(),
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

  // ******************************************
  return plugin
}
