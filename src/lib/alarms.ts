import { Subject, Observable } from 'rxjs'

import { ALARM_METHOD, ALARM_STATE, DeltaNotification } from '../types'

export class Notification {
  private _message: DeltaNotification

  constructor(
    path: string,
    msg: string | null,
    state: ALARM_STATE = ALARM_STATE.alert,
    method: ALARM_METHOD[] = [ALARM_METHOD.sound, ALARM_METHOD.visual]
  ) {
    this._message = {
      path: `notifications.${path}`,
      value:
        typeof msg === 'string'
          ? {
              state: state,
              method: method,
              message: msg
            }
          : null
    }
  }

  get message(): DeltaNotification {
    return this._message
  }
}

// fromBelow: true - previous value was below range, false - previous value was above range
// isBelow: true - current value is below range, false - current value is above range
export interface WatchEvent {
  type: 'enter' | 'in' | 'exit'
  value: number
  fromBelow?: boolean
  isBelow?: boolean
}

// ** watch a value within a range (min-max)
export class Watcher {
  private changeSource: Subject<WatchEvent> = new Subject()
  public change$: Observable<WatchEvent> = this.changeSource.asObservable()

  private _rangeMin = 0
  private _rangeMax = 100
  private _sampleCount = 0 // number of values sampled
  private _sampleSize = 1 // number of values to sample before range test
  private _val: number = -1
  private _inRange: boolean = false

  constructor() {}

  set value(val: number) {
    if (typeof val !== 'number') {
      return
    }
    let hasChanged = this._val !== val
    this._val = val
    if (hasChanged) {
      this._sampleCount++
      this._setValue(val)
    }
  }
  get value(): number {
    return this._val
  }

  set rangeMax(value: number) {
    if (typeof value !== 'number') {
      return
    }
    let hasChanged = this._rangeMax !== value
    this._rangeMax = value
    if (hasChanged) {
      this._setRange()
    }
  }
  get rangeMax(): number {
    return this._rangeMax
  }

  set rangeMin(value: number) {
    if (typeof value !== 'number') {
      return
    }
    let hasChanged = this._rangeMin !== value
    this._rangeMin = value
    if (hasChanged) {
      this._setRange()
    }
  }
  get rangeMin(): number {
    return this._rangeMin
  }

  set sampleSize(value: number) {
    this._sampleSize =
      typeof value === 'number' && value > 0 ? value : this._sampleSize
    this._sampleCount = 0
  }
  get sampleSize(): number {
    return this._sampleSize
  }

  isInRange(value: number = this._val): boolean {
    return typeof value == 'number' &&
      value <= this.rangeMax &&
      value >= this.rangeMin
      ? true
      : false
  }

  private _setValue(val: number) {
    if (this._sampleCount < this._sampleSize) {
      return
    }
    if (typeof val !== 'number') {
      this.changeSource.next({ type: 'exit', value: val })
      return
    }
    let testInRange: boolean = this.isInRange(val)

    if (testInRange) {
      //console.log(`** new value is in range`)
      if (this._inRange) {
        //console.log(`** and was already in range`)
        this.changeSource.next({ type: 'in', value: val })
      } else {
        //console.log(`** and was previously outside range`)
        this.changeSource.next({
          type: 'enter',
          value: val,
          fromBelow: this._val < this.rangeMin ? true : false
        })
      }
    } else {
      // console.log(`** new value is out of  range`)
      if (this._inRange) {
        //console.log(`** and was previously in range`)
        this.changeSource.next({
          type: 'exit',
          value: val,
          isBelow: val < this.rangeMin ? true : false
        })
      }
    }
    this._inRange = testInRange
    this._val = val
    this._sampleCount = 0
  }

  private _setRange() {
    let testInRange: boolean = this.isInRange()
    if (testInRange) {
      //console.log(`** value is in new range`)
      if (this._inRange) {
        //console.log(`** and was already in range`)
        this.changeSource.next({ type: 'in', value: this._val })
      } else {
        //console.log(`** and was previously outside range`)e)
        this.changeSource.next({
          type: 'enter',
          value: this._val,
          fromBelow: this._val < this.rangeMin ? true : false
        })
      }
    } else {
      //console.log(`** value is out of new range`)
      if (this._inRange) {
        //console.log(`** and was previously in range`)
        this.changeSource.next({
          type: 'exit',
          value: this._val,
          isBelow: this._val < this.rangeMin ? true : false
        })
      } else {
        //console.log(`** and was previously out of range`)
      }
    }
    this._inRange = testInRange
  }
}
