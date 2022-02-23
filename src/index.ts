import { Plugin, PluginServerApp } from '@signalk/server-api'
import { Notification, Watcher, WatchEvent } from './lib/alarms'
import { 
  CourseData, SKPaths,
  ALARM_METHOD, ALARM_STATE,
  DeltaNotification, DeltaUpdate
} from './types'

import path from 'path'
import { Worker } from 'worker_threads'
import { Subscription } from 'rxjs'

interface CourseComputerApp extends PluginServerApp {
  error: (msg: string) => void
  debug: (msg: string) => void
  setPluginStatus: (pluginId: string, status?: string) => void
  setPluginError: (pluginId: string, status?: string) => void
  handleMessage: (
    id: string | null,
    msg: DeltaUpdate | DeltaNotification
  ) => void
  config: { configPath: string }
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
          type: "string",
          default: 'Great Circle',
          enum: [
            'Great Circle',
            'Rhumbline'
          ]
        },
        autopilot: {
          type: 'boolean',
          title: 'Emit target heading delta'
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
    },
    autopilot: {
      'ui:widget': 'checkbox',
      'ui:title': ' Autopilot',
      'ui:help': ''
    }
  }
}

const SRC_PATHS = [
  'navigation.course',
  'navigation.position',
  'navigation.magneticVariation',
  'navigation.headingTrue',
  'navigation.speedOverGround',
  'navigation.datetime'
]

module.exports = (server: CourseComputerApp): Plugin => {
  
  const watcher: Watcher = new Watcher() // watch distance from arrivalCircle
  let baconSub: any[] = [] // stream subscriptions
  let obs: any[] = [] // Observables subscription
  let worker: Worker
  let useRhumbline: boolean;

  const srcPaths: SKPaths = {}

  // ******** REQUIRED PLUGIN DEFINITION *******
  const plugin: Plugin = {
    id: 'course-data',
    name: 'Course Data provider',
    schema: () => CONFIG_SCHEMA,
    uiSchema: () => CONFIG_UISCHEMA,
    start: (options: {[key: string]: any}) => {
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
      method: 'Great Circle',
      autopilot: false
    }
  }

  const doStartup = (options: any) => {
    try {
      server.debug(`${plugin.name} starting.......`)
      if (
        typeof options.notifications?.sound !== 'undefined' &&
        typeof options.calculations?.method !== 'undefined'
      ) {
        config =  options
      }
      
      useRhumbline = config.calculations.method === 'Rhumbline'
      server.debug(`Applied config: ${JSON.stringify(config)}\n\r useRhumbline= ${useRhumbline}`)

      // setup subscriptions
      initSubscriptions(SRC_PATHS)
      // setup worker(s)
      initWorkers()

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
    baconSub.forEach(b => b())
    baconSub = []
    obs.forEach( (o:Subscription) => o.unsubscribe() )
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
    skPaths.forEach( (path:string) => {
      baconSub.push(
        server.streambundle
          .getSelfBus(path)
          .onValue((v: any) => {
            srcPaths[path] = v.value
            if (path === 'navigation.position') {
              calc()
            }
          })
      )
    })

    obs.push(
      watcher.change$.subscribe( (event:WatchEvent) => {
        onChange(event)
      })
    )
  }

  // initialise calculation worker(s)
  const initWorkers = () => {
    worker = new Worker(path.resolve(__dirname, './worker/course.js'))
    worker.on('message', msg => {
      calcResult(msg)
    })
    worker.on('error', error => console.error('** worker.error:', error))
    worker.on('exit', code => {
      if (code !== 0) {
        console.error('** worker.exit:', `Stopped with exit code ${code}`)
      }
    })
  }

  // ********* Course Calculations *******************

  // trigger course calculations
  const calc = () => {
    if (srcPaths['navigation.position']) {
      worker?.postMessage(srcPaths)
    }
  }

  // send calculation results delta
  const calcResult = async (result: CourseData) => {
    watcher.rangeMax = srcPaths['navigation.course']?.nextPoint?.arrivalCircle ?? -1
    watcher.value = result.gc.nextPoint?.distance ?? -1
    server.handleMessage(plugin.id, buildDeltaMsg(result))
  }

  const buildDeltaMsg = (course: CourseData): any => {
    const values: Array<{ path: string; value: any }> = []

    const courseType = useRhumbline ? 
      'navigation.courseRhumbline' :
      'navigation.courseGreatCircle'

    const source = useRhumbline ? course.rl : course.gc

    values.push({
      path: `${courseType}.bearingTrackTrue`,
      value: (typeof source.bearingTrackTrue === 'undefined') ?
        null : source.bearingTrackTrue
    })
    values.push({
      path: `${courseType}.bearingTrackMagnetic`,
      value: (typeof source.bearingTrackMagnetic === 'undefined') ?
        null : source.bearingTrackMagnetic
    })
    values.push({
      path: `${courseType}.crossTrackError`,
      value: (typeof source.crossTrackError === 'undefined') ?
        null : source.crossTrackError
    })

    values.push({
      path: `${courseType}.previousPoint.distance`,
      value: (typeof source.previousPoint?.distance === 'undefined') ?
        null : source.previousPoint?.distance
    })

    values.push({
      path: `${courseType}.nextPoint.distance`,
      value: (typeof source.nextPoint?.distance === 'undefined') ?
        null : source.nextPoint?.distance
    })
    values.push({
      path: `${courseType}.nextPoint.bearingTrue`,
      value: (typeof source.nextPoint?.bearingTrue === 'undefined') ?
        null : source.nextPoint?.bearingTrue
    })
    if (config.calculations.autopilot) {
      values.push({
        path: `steering.autopilot.target.headingTrue`,
        value: (typeof source.nextPoint?.bearingTrue === 'undefined') ?
          null : source.nextPoint?.bearingTrue
      })
    }
    values.push({
      path: `${courseType}.nextPoint.bearingMagnetic`,
      value: (typeof source.nextPoint?.bearingMagnetic === 'undefined') ?
        null : source.nextPoint?.bearingMagnetic
    })
    values.push({
      path: `${courseType}.nextPoint.velocityMadeGood`,
      value: (typeof source.nextPoint?.velocityMadeGood === 'undefined') ?
        null : source.nextPoint?.velocityMadeGood
    })
    values.push({
      path: `${courseType}.nextPoint.timeToGo`,
      value: (typeof source.nextPoint?.timeToGo === 'undefined') ?
        null : source.nextPoint?.timeToGo
    })
    values.push({
      path: `${courseType}.nextPoint.estimatedTimeOfArrival`,
      value: (typeof source.nextPoint?.estimatedTimeOfArrival === 'undefined') ?
        null : source.nextPoint?.estimatedTimeOfArrival
    })

    return {
      updates: [
        {
          values: values
        }
      ]
    }
  }

  // ********* Arrival circle events *****************

  const onChange = (event: WatchEvent) => {
    const alarmMethod = config.notifications.sound ? 
      [ALARM_METHOD.sound, ALARM_METHOD.visual] :
      [ALARM_METHOD.visual]
    if (event.type === 'in') {
      if (srcPaths['navigation.position']) {
        emitNotification(
          new Notification(
            'arrivalCircleEntered',
            `Approaching Destination: ${event.value.toFixed(0)}m`,
            ALARM_STATE.warn,
            alarmMethod
          )
        )
      }
    }
    if (event.type === 'enter') {
      if (srcPaths['navigation.position']) {
        emitNotification(
          new Notification(
            'arrivalCircleEntered',
            `Entered arrival zone: ${event.value.toFixed(0)}m < ${watcher.rangeMax.toFixed(0)}`,
            ALARM_STATE.warn,
            alarmMethod
          )
        )

      }
    }
    if (event.type === 'exit') {
      emitNotification(
        new Notification(
          "arrivalCircleEntered",
          `Entered arrival zone: ${event.value.toFixed(0)}m > (${watcher.rangeMax.toFixed(0)})`,
          ALARM_STATE.normal,
          []
        )
      )
    }
  }

  // ** send notification delta message **
  const emitNotification = (notification: Notification) => {
    server.handleMessage(plugin.id, {
      updates: [{ values: [notification.message] }]
    })
  }

  // ******************************************
  return plugin
}
