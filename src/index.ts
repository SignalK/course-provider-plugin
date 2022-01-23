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
      description: '',
      properties: {
        sound: {
          type: 'boolean',
          title: 'Enable sound'
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

const CALC_INTERVAL = 1000

module.exports = (server: CourseComputerApp): Plugin => {
  
  const watcher: Watcher = new Watcher() // watch distance from arrivalCircle
  let baconSub: any[] = [] // stream subscriptions
  let obs: any[] = [] // Observables subscription
  let timer: ReturnType<typeof setTimeout>
  let worker: Worker

  const srcPaths: SKPaths = {}

  // ******** REQUIRED PLUGIN DEFINITION *******
  const plugin: Plugin = {
    id: 'course-data',
    name: 'Course Data provider',
    schema: () => CONFIG_SCHEMA,
    uiSchema: () => CONFIG_UISCHEMA,
    start: (options: any, restart: any) => {
      doStartup(options, restart)
    },
    stop: () => {
      doShutdown()
    }
  }
  // ************************************

  let config: any = {
    notifications: {
      sound: false
    }
  }

  const doStartup = (options: any, restart: any) => {
    try {
      server.debug(`${plugin.name} starting.......`)
      if (typeof options.notifications?.sound !== 'undefined') {
        config =  options
      }
      server.debug(`Applied config: ${JSON.stringify(config)}`)

      // setup subscriptions
      initSubscriptions(SRC_PATHS)
      // setup worker(s)
      initWorkers()

      const msg = 'Started'
      server.setPluginStatus(msg)
      afterStart()
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
    if (timer) {
      server.debug('** Stopping Timer(s) **')
      timer.unref()
    }
    if (worker) {
      server.debug('** Stopping Worker(s) **')
      worker.unref()
    }
    const msg = 'Stopped'
    server.setPluginStatus(msg)
  }

  // *****************************************

  // register STREAM UPDATE message handlers
  const initSubscriptions = (skPaths: string[]) => {
    skPaths.forEach( (path:string) => {
      baconSub.push(
        server.streambundle
          .getSelfBus(path)
          .onValue((v: any) => {
            srcPaths[path] = v.value
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

  // ** additional plugin start processing
  const afterStart = () => {
    // start calculation interval timer
    timer = setInterval(() => calc(), CALC_INTERVAL)
  }

  // ********* Course Calculations *******************

  // trigger course calculations
  const calc = () => {
    if (srcPaths['navigation.position']) {
      worker?.postMessage(srcPaths)
    }
  }

  // send calculation result delta
  const calcResult = async (result: CourseData) => {
    watcher.rangeMax = srcPaths['navigation.course']?.nextPoint?.arrivalCircle ?? -1
    watcher.value = result.gc.nextPoint?.distance ?? -1
    server.handleMessage(plugin.id, buildDeltaMsg(result))
  }

  const buildDeltaMsg = (course: CourseData): any => {
    const values: Array<{ path: string; value: any }> = []
    const courseType = [
      'navigation.courseGreatCircle',
      'navigation.courseRhumbline'
    ]

    // Great Circle
    values.push({
      path: `${courseType[0]}.bearingTrackTrue`,
      value: (typeof course.gc.bearingTrackTrue === 'undefined') ?
        null : course.gc.bearingTrackTrue
    })
    values.push({
      path: `${courseType[0]}.bearingTrackMagnetic`,
      value: (typeof course.gc.bearingTrackMagnetic === 'undefined') ?
        null : course.gc.bearingTrackMagnetic
    })
    values.push({
      path: `${courseType[0]}.crossTrackError`,
      value: (typeof course.gc.crossTrackError === 'undefined') ?
        null : course.gc.crossTrackError
    })

    values.push({
      path: `${courseType[0]}.previousPoint.distance`,
      value: (typeof course.gc.previousPoint?.distance === 'undefined') ?
        null : course.gc.previousPoint?.distance
    })

    values.push({
      path: `${courseType[0]}.nextPoint.distance`,
      value: (typeof course.gc.nextPoint?.distance === 'undefined') ?
        null : course.gc.nextPoint?.distance
    })
    values.push({
      path: `${courseType[0]}.nextPoint.bearingTrue`,
      value: (typeof course.gc.nextPoint?.bearingTrue === 'undefined') ?
        null : course.gc.nextPoint?.bearingTrue
    })
    values.push({
      path: `${courseType[0]}.nextPoint.bearingMagnetic`,
      value: (typeof course.gc.nextPoint?.bearingMagnetic === 'undefined') ?
        null : course.gc.nextPoint?.bearingMagnetic
    })
    values.push({
      path: `${courseType[0]}.nextPoint.velocityMadeGood`,
      value: (typeof course.gc.nextPoint?.velocityMadeGood === 'undefined') ?
        null : course.gc.nextPoint?.velocityMadeGood
    })
    values.push({
      path: `${courseType[0]}.nextPoint.timeToGo`,
      value: (typeof course.gc.nextPoint?.timeToGo === 'undefined') ?
        null : course.gc.nextPoint?.timeToGo
    })
    values.push({
      path: `${courseType[0]}.nextPoint.estimatedTimeOfArrival`,
      value: (typeof course.gc.nextPoint?.estimatedTimeOfArrival === 'undefined') ?
        null : course.gc.nextPoint?.estimatedTimeOfArrival
    })

    // Rhumbline
    values.push({
      path: `${courseType[1]}.bearingTrackTrue`,
      value: (typeof course.rl.bearingTrackTrue === 'undefined') ?
        null : course.rl.bearingTrackTrue
    })
    values.push({
      path: `${courseType[1]}.bearingTrackMagnetic`,
      value: (typeof course.rl.bearingTrackMagnetic === 'undefined') ?
        null : course.rl.bearingTrackMagnetic
    })
    values.push({
      path: `${courseType[1]}.crossTrackError`,
      value: (typeof course.rl.bearingTrackMagnetic === 'undefined') ?
        null : course.rl.bearingTrackMagnetic
    })

    values.push({
      path: `${courseType[1]}.previousPoint.distance`,
      value: (typeof course.rl.previousPoint?.distance === 'undefined') ?
        null : course.rl.previousPoint?.distance
    })

    values.push({
      path: `${courseType[1]}.nextPoint.distance`,
      value: (typeof course.rl.nextPoint?.distance === 'undefined') ?
        null : course.rl.nextPoint?.distance
    })
    values.push({
      path: `${courseType[1]}.nextPoint.bearingTrue`,
      value: (typeof course.rl.nextPoint?.bearingTrue === 'undefined') ?
        null : course.rl.nextPoint?.bearingTrue
    })
    values.push({
      path: `${courseType[1]}.nextPoint.bearingMagnetic`,
      value: (typeof course.rl.nextPoint?.bearingMagnetic === 'undefined') ?
        null : course.rl.nextPoint?.bearingMagnetic
    })
    values.push({
      path: `${courseType[1]}.nextPoint.velocityMadeGood`,
      value: (typeof course.rl.nextPoint?.velocityMadeGood === 'undefined') ?
        null : course.rl.nextPoint?.velocityMadeGood
    })
    values.push({
      path: `${courseType[1]}.nextPoint.timeToGo`,
      value: (typeof course.rl.nextPoint?.timeToGo === 'undefined') ?
        null : course.rl.nextPoint?.timeToGo
    })
    values.push({
      path: `${courseType[1]}.nextPoint.estimatedTimeOfArrival`,
      value: (typeof course.rl.nextPoint?.estimatedTimeOfArrival === 'undefined') ?
        null : course.rl.nextPoint?.estimatedTimeOfArrival
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
