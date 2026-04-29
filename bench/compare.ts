/*
 * Compare two bench/run.ts JSON outputs (mitata format wrapped in our
 * meta envelope) and print a side-by-side delta table.
 *
 * Usage:
 *   node --import tsx bench/compare.ts <baseline.json> <candidate.json>
 *
 * Negative `Δavg` means the candidate is faster.
 *
 * The `signal?` column flags whether the |Δavg| exceeds the per-run
 * spread (p99 − p25) of either input — i.e. whether the move is
 * larger than typical run-to-run jitter. This isn't a hypothesis test
 * but it's the closest single-row "is this real" signal the mitata
 * stats give us without re-aggregating samples ourselves.
 */

import * as fs from 'node:fs'

interface MitataStats {
  avg: number
  min: number
  max: number
  p25: number
  p75: number
  p99: number
  ticks: number
  heap: { avg: number; total: number; min: number; max: number; _: number }
  gc: { avg: number; total: number; min: number; max: number }
}

interface MitataBenchmark {
  alias: string
  runs: Array<{ stats: MitataStats }>
}

interface Payload {
  meta?: {
    nodeVersion?: string
    platform?: string
    gcExposed?: boolean
    recordedAt?: string
  }
  mitata: { benchmarks: MitataBenchmark[] }
}

const [, , baselinePath, candidatePath] = process.argv
if (!baselinePath || !candidatePath) {
  console.error(
    'usage: node --import tsx bench/compare.ts <baseline.json> <candidate.json>'
  )
  process.exit(2)
}

const baseline: Payload = JSON.parse(fs.readFileSync(baselinePath, 'utf8'))
const candidate: Payload = JSON.parse(fs.readFileSync(candidatePath, 'utf8'))

const baseByName = new Map(
  baseline.mitata.benchmarks.map((b) => [b.alias, b.runs[0]!.stats])
)

console.log()
console.log(`baseline:  ${baselinePath}`)
console.log(`           ${describe(baseline)}`)
console.log(`candidate: ${candidatePath}`)
console.log(`           ${describe(candidate)}`)
console.log()

const rows = candidate.mitata.benchmarks.map((c) => {
  const cs = c.runs[0]!.stats
  const bs = baseByName.get(c.alias)
  if (!bs) {
    return {
      name: c.alias,
      'base avg (ns)': '-',
      'cand avg (ns)': cs.avg.toFixed(0),
      'Δavg (%)': 'NEW',
      'signal?': '-',
      'Δheap b/op': '-',
      'Δgc total (ms)': '-'
    }
  }
  const dAvgPct = ((cs.avg - bs.avg) / bs.avg) * 100
  const baseSpread = bs.p99 - bs.p25
  const candSpread = cs.p99 - cs.p25
  const spread = Math.max(baseSpread, candSpread)
  const significant = Math.abs(cs.avg - bs.avg) > spread
  const dHeapPerOp = (cs.heap?.avg ?? 0) - (bs.heap?.avg ?? 0)
  // Mitata reports gc.total in nanoseconds.
  const dGcMs = ((cs.gc?.total ?? 0) - (bs.gc?.total ?? 0)) / 1_000_000
  return {
    name: c.alias,
    'base avg (ns)': bs.avg.toFixed(0),
    'cand avg (ns)': cs.avg.toFixed(0),
    'Δavg (%)': formatPct(dAvgPct),
    'signal?': significant ? 'YES' : `noise (spread ±${spread.toFixed(0)} ns)`,
    'Δheap b/op': dHeapPerOp.toFixed(0),
    'Δgc total (ms)': dGcMs.toFixed(1)
  }
})

console.table(rows)

function formatPct(p: number): string {
  const sign = p > 0 ? '+' : ''
  return `${sign}${p.toFixed(1)}`
}

function describe(p: Payload): string {
  if (!p.meta) return '(no meta)'
  const bits: string[] = []
  if (p.meta.nodeVersion) bits.push(`node ${p.meta.nodeVersion}`)
  if (p.meta.platform) bits.push(p.meta.platform)
  if (p.meta.gcExposed === false) bits.push('NO --expose-gc')
  if (p.meta.recordedAt) bits.push(p.meta.recordedAt)
  return bits.join(', ')
}
