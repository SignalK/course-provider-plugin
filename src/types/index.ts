export interface SKPaths {
  [key: string]: any
}

export type CalcMethod = 'GreatCircle' | 'Rhumbline'

// Worker invocation envelope. The worker only ever needs the current path
// snapshot plus the calculation method that buildDeltaMsg will publish, so
// we send those together to avoid keeping the worker stateful or mixing the
// method tag into the SignalK path map.
export interface CalcRequest {
  paths: SKPaths
  method: CalcMethod
}

export interface CourseData {
  gc: CourseResult
  rl: CourseResult
  passedPerpendicular: boolean
}

export interface CourseResult {
  calcMethod?: string
  distance?: number | null
  bearingTrue?: number | null
  bearingMagnetic?: number | null
  velocityMadeGood?: number | null
  velocityMadeGoodToCourse?: number | null
  timeToGo?: number | null
  estimatedTimeOfArrival?: string | null
  previousPoint?: {
    distance?: number | null
  }
  route?: {
    timeToGo?: number | null
    estimatedTimeOfArrival?: string | null
    distance?: number | null
  }
  bearingTrackTrue?: number | null
  bearingTrackMagnetic?: number | null
  crossTrackError?: number | null
  targetSpeed?: number | null
}

// ** Delta Message content**
export interface DeltaValue {
  path: string
  value: any
}

// ** Delta Update Message **
export interface DeltaUpdate {
  updates: [
    {
      values: DeltaValue[]
    }
  ]
}

interface AlarmValue {
  state: ALARM_STATE
  method: ALARM_METHOD[]
  message: string
}

// ** Notification Message **
export interface DeltaNotification extends DeltaValue {
  value: AlarmValue | null
}

export enum ALARM_STATE {
  nominal = 'nominal',
  normal = 'normal',
  alert = 'alert',
  warn = 'warn',
  alarm = 'alarm',
  emergency = 'emergency'
}

export enum ALARM_METHOD {
  visual = 'visual',
  sound = 'sound'
}
