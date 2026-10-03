# Requirement tests for SmartHeatingWithShelly.js

Run from the repository root with Node 26 and `TZ=Europe/Tallinn`; the date and DST fixtures require that timezone. The major version is pinned in [`.nvmrc`](../.nvmrc), which CI also reads. With nvm, run `nvm install` and `nvm use` from the repository root. No test dependency installation is needed.

```bash
TZ=Europe/Tallinn node tests/spec.js SmartHeatingWithShelly.js
```

The [Tests workflow](../.github/workflows/tests.yml) runs the suite and mutation checks on pushes, pull requests, and manual dispatch, with a ten-minute job timeout.

The production installation and recovery contract is documented under [Virtual Component installation and recovery](../README.md#virtual-component-installation-and-recovery), also available in [Estonian](../README-ET.md#virtuaalkomponentide-paigaldamine-ja-taastamine).

## Finding scenarios

```bash
TZ=Europe/Tallinn node tests/spec.js SmartHeatingWithShelly.js --list
TZ=Europe/Tallinn node tests/spec.js SmartHeatingWithShelly.js --filter=S40
TZ=Europe/Tallinn node tests/spec.js SmartHeatingWithShelly.js --reverse
```

`--list` prints registered scenario names without running them and can be combined with `--filter` and `--reverse`. It is a navigation index: a registered scenario may contain parameter loops or aggregate multiple inputs into one reported check.

Filters match name prefixes, so `--filter=S4` also selects S40 through S49. An unmatched filter prints one error line and exits with status 1, including when listing. A normal run prints PASS/FAIL check results and exits with status 1 if any check fails.

## Harness semantics

Every scenario starts with a fresh world, clock, logs, and runtime list. Errors from all boots within a scenario remain recorded, including abandoned boots in restart cases. Test-side exceptions fail the scenario and allow subsequent scenarios to run. Each driven VM call has a three-second timeout.

RPC device effects and callback delivery are separate queued events, alongside one-shot timers. `stop()` discards the stopped runtime’s callbacks and timers while preserving device schedules, KVS and relay configuration. `boot(true, { scriptId: 2 })` starts another instance against the same device world. KVS reads return content-derived etags and conditional writes reject stale values. Use these entry points when writing scenarios:

- `boot()` automatically drains queued work after explicit `fcTm()` and `loop()` calls. `boot(true)` leaves execution to the scenario.
- `step()` and `flush()` process queued RPC callbacks and one-shot timers without firing recurring timers.
- `advanceBy(milliseconds)` and `advanceTo(epochMilliseconds)` process RPC callbacks and all due timers, including recurring timers, in chronological order. Each advance is limited to 10,000 events.
- Clock advancement moves script time and device `unixtime` together. A device reporting `unixtime=0` remains unsynchronized until the scenario sets its time.
- `jumpToNextDay()` simulates a wall-clock correction before an explicit tick, expiring prices through the production update predicate.

Randomness defaults to zero; use `boot(true, { random: 0.5 })` to exercise another value. The price fixture follows the requested date window. For independent expectations and literal anchors, see the S49 and S56 comments in [spec.js](spec.js).

## Mutation checks

```bash
node tests/mutations.js
# Or test a candidate script:
node tests/mutations.js /path/to/SmartHeatingWithShelly.js
```

The runner first requires a passing baseline, then mutates temporary copies of the production script and runs the suite in `Europe/Tallinn`. It checks exact replacement-match counts, imposes a 20-second timeout per run, and removes its temporary directory. The working production script is never edited. Node CLI flags are forwarded to child runs. Standard checks use Node 26 with default V8 optimization. A runtime crash is an error, never a successful mutation check.

| Outcome | Meaning |
| --- | --- |
| `KILLED` | A behavioral assertion failed in the mutation's intended detecting scenario. |
| `SURVIVED` | The suite passed with the mutation. |
| `REVIEW` | The suite failed without an assertion failure in the intended scenario. |
| `ERROR` | Execution failed, timed out, or encountered an unexpected runner error. |
| `STALE` | The source pattern no longer has the expected number of matches. The output includes expected/actual counts and the pattern. |

Every outcome except `KILLED` makes the final exit status nonzero. A stale pattern or per-mutation error does not stop the remaining mutants. VM exceptions are labeled separately and do not count as behavioral kills: a crash does not establish that the intended assertion detected the fault. Additional detecting scenarios are printed for inspection.

Run these checks after changing the suite. Update obsolete replacement strings when production code is refactored and review the intended detectors. This is targeted evidence of fault detection, not an exhaustive mutation score.

## Diagnostic assertions

Preserve the sentinel phrases `Schedule updates are paused`, `Missing controls`, and `Group setup incomplete`. Check the relevant field, control, record, or schedule identifiers and available RPC error reasons; allow surrounding wording to vary.

## Hardware limits

Installation and concurrency scenarios assert at most five pending RPCs and five active timers. Node does not establish Shelly engine compatibility, actual cron execution, or device memory usage. Measure `mem_used` and `mem_peak` on hardware before release.


### Device qualification checklist (outstanding)

No hardware results are available for these changes. For each run, record the device model, firmware, script commit, and observed result:

- Verify disabled creation → ID persistence → activation, including failed persistence and activation.
- Interrupt stop/start and reboot after each device effect, including in-place update; inspect IDs, enabled state, and timers.
- Exercise malformed watchdog records, overlapping stopped scripts, and stale-etag cleanup writes.
- Record schedule ID allocation after deletion and reboot; if IDs are reused, retain the documented manual stale-ID reconciliation boundary.
- Measure `mem_used` and `mem_peak` at the pre-change baseline, after lifecycle changes, and after pricing cleanup. Include two supported instances, failures and retries. Do not infer memory savings from Node results.

New tests S61–S68 cover these recovery boundaries in the queued Node harness; they do not establish device qualification.
