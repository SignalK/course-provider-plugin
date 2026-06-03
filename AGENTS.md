# Course Provider Plugin

The course-provider plugin computes course values (distance, bearing, ETA, route remaining, XTE, etc.) and publishes them on `navigation.course.calcValues.*`. It runs as a Signal K server plugin on Raspberry Pi 3-5 hardware, often on battery power.

Key components:

- **Plugin entrypoint**: `src/index.ts` — wires Signal K delta subscriptions, spawns the calculation worker, publishes deltas back to the server
- **Worker**: `src/worker/course.ts` — runs in a Node `worker_threads.Worker`; on every position tick computes both `gc` (great-circle) and `rl` (rhumb-line) branches plus `passedPerpendicular`
- **Geodesy**: `src/lib/geodesy/latlon-spherical.js` — Chris Veness' library, vendored
- **Delta builder**: `src/lib/delta-msg.ts` — fixed-shape values array for the `calcValues.*` delta
- **Benchmarks**: `bench/` — tinybench-based dispatch benchmark for A/B-ing perf changes (see `bench/README.md`)

## Code Quality Principles

### Scope and Complexity

Follow YAGNI, SOLID, DRY, and KISS. Only make changes that are directly requested or clearly necessary. A bug fix does not need surrounding code cleaned up. A simple feature does not need extra configurability.

Do not add error handling, fallbacks, or validation for scenarios that cannot happen. Trust internal code and framework guarantees. Only validate at system boundaries (delta values from the Signal K server, resource API responses, plugin config).

### General Standards

- Write self-documenting code; comments explain "why", not "what" — no echo comments restating what the code already says
- Keep functions small and focused on a single responsibility
- No magic numbers; use named constants
- Documentation describes current state, not development history — avoid changelog-style language that will become stale

### Type Safety

- **All new code must be written in TypeScript**
- Reuse types from `@signalk/server-api` where possible; do not redeclare them locally
- Use strict type checking; avoid `any`
- Validate external inputs at system boundaries (delta values, resource API responses, plugin config)

### Testing

- All new code requires tests
- Test behavior, not implementation details
- Mocha + chai; helpers in `test/helpers.ts`
- Aim for meaningful coverage, not arbitrary percentages

## Performance

The plugin runs at 1-2 Hz on every `navigation.position` delta on Raspberry Pi 3-5. CPU cycles cost watts. Treat the per-tick path as allocation-sensitive.

### Hot path

Per `navigation.position` delta:

`src/index.ts` `calc()` → `worker.postMessage(srcPaths)` (structured-cloned) → `src/worker/course.ts` `calcs(src)` → main thread `calcResult(result)` → `src/lib/delta-msg.ts` `buildDeltaMsg(...)` → `server.handleMessage(...)`.

Files in scope:

- `src/index.ts` `calc`, `calcResult`, the subscribe callback — per delta
- `src/worker/course.ts` `calcs`, `routeRemaining`, `trackBearings`, `passedPerpendicular`, `vmc`, `vmg` — per worker tick
- `src/lib/delta-msg.ts` `buildDeltaMsg` — per worker tick

### Rules

- **Guard `debug()` arguments.** `debug('x=' + JSON.stringify(obj))` evaluates the argument eagerly even when debug is off. Wrap with `debug.enabled &&` for anything that allocates (string concatenation, `JSON.stringify`).
- **Build objects in their final shape.** On hot paths, write all properties in a single object literal with consistent key order so V8 keeps a stable hidden class. Do not build up objects incrementally via spread or `Object.assign`. See `buildDeltaMsg` for the fixed-shape pattern.
- **Minimize per-tick allocations.** Hoist constants to module scope. Reuse cursors instead of allocating two `LatLon` objects per loop iteration (see `routeRemaining`).
- **Cache values that don't change every tick.** Track bearings (prev → next) depend only on endpoints and `magVar`, not on vessel position. Route-remaining distance depends on waypoints, `pointIndex`, and `reverse`, not on vessel position. See `trackBearingCache` and `routeRemainingCache` in `src/worker/course.ts`.
- **`worker.postMessage` structured-clones the envelope every tick.** Anything you put on `srcPaths` is cloned per tick — avoid stuffing large arrays in there casually. Caches keyed on array references do not survive the clone; use a primitive version counter bumped by the main thread (see `waypointsVersion`).
- **Use `Date.now()` for arithmetic, `new Date(ms).toISOString()` only for the final ETA string.** Avoid `Date` allocations in the math.
- **Use `structuredClone`** for deep cloning, not `JSON.parse(JSON.stringify(...))`.
- **Avoid lodash on hot paths.**

### Benchmarking

Run the dispatch benchmark with `npm run bench`. See `bench/README.md` for what each column means and what is and isn't covered (the dispatcher and delta-builder are; the geodesy maths in the worker is not, by default). Treat any `Δmean (%)` smaller than `rme(baseline) + rme(candidate)` as noise. Verify on Pi 3-5 hardware before claiming a Pi-relevant speedup.

## Git Commit Conventions

Conventional format: `<type>(<scope>)?: <subject>` where type = `feat|fix|docs|style|refactor|test|chore|perf`. Subject: 50 chars max, imperative mood ("add" not "added"), no period.

Keep commits small and atomic — one logical change per commit. Split unrelated changes into separate commits.

**MANDATORY:** Rebase and clean up commit history before opening or updating a PR. Amend fixes to the relevant existing commit; do not chain "fix typo" / "oops" commits.

## Pull Request Guidelines

Before opening a PR:

- Branch from latest `master`
- Run `npm run prettier:check`, `npm run typecheck`, and `npm test` — all must pass
- Rebase and clean up commit history
- Self-review your changes
- **NEVER change version numbers** — the maintainer updates versions on release

PR titles are used to generate release notes; make them descriptive ("If someone only read the title, would they understand what this PR does?").

PR descriptions: motivation (why) and approach (how), not mechanics (what — the diff shows that). Mention breaking changes explicitly. If the description has a test-plan checklist, every item must be checked before review.

Reference issues with `closes`, `fixes`, or `resolves`.

**MANDATORY:** One logical change per PR. Refactoring and behavior changes belong in separate PRs.

When updating a branch with upstream:

```sh
git fetch origin
git rebase origin/master
```

Use `git push --force-with-lease`, never bare `--force`.
