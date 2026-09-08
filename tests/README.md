# Requirement tests for SmartHeatingWithShelly.js

Run the script in the stubbed Shelly environment:

```bash
TZ=Europe/Tallinn node tests/spec.js SmartHeatingWithShelly.js
```

Each driven VM call has a three-second timeout. Queued scenarios exercise asynchronous RPCs, timers, interrupted installation, and concurrent watchdog events. N1 checks fresh installation with and without SystemData and asserts RPC and timer peaks stay at or below five. S17 also checks those limits during interrupted installation, manual reset, and a later pause: peaks must each stay at or below five. The price fixture follows the requested date window; expected schedule hours come from an independent oracle.

The [Tests workflow](../.github/workflows/tests.yml) runs the spec followed by the mutation script on pushes, pull requests, and manual dispatch. It uses Node 24, sets `TZ=Europe/Tallinn` for the job, and has a ten-minute timeout. No dependency installation is needed.

## Behavior and timing coverage

| Scenario | Required behavior |
| --- | --- |
| S48 | Complete daily cron expression, enabled schedule, selected relay ID, and polarity, online and during fallback. The same schedule assertion is used throughout S49–S56. |
| S49 | Forecast demand between the clamps, with hand-computed expected hours for fractional means, positive/negative curve adjustments, and 24/12/6-hour periods. Cases distinguish both rounding steps, reference temperature, coefficient, offset, and period division. A mean of 17°C with curve +4 must produce no schedule despite positive formula demand, exercising the warm-weather clamp above the 16°C reference. |
| S50 | Inclusive on/off price boundaries in both modes, off taking precedence when thresholds overlap, and timed overrides inside/outside the cheapest-hour count. |
| S51 | Each variable tariff changes the winner across a one-cent boundary. VORK5 cases cover weekday/weekend peak windows and March/April and October/November boundaries; Imatra cases cover summer/winter and weekend windows. S5 retains its original weekend regression. |
| S52 | Flat packages compare the market price against thresholds after fee subtraction, in both modes. A uniform fee cannot change hour rankings, so these cases do not claim to validate absolute flat tariff amounts. |
| S53 | Registered timers start heating, respect startup jitter and five-minute retries, refresh on successive days after the selected update minute, and recover after waiting for device time. Checks assert both no early work and work when due. |
| S54 | Outgoing price requests select each configured country. Forecast requests use the device's latitude/longitude and the configured 6/12/24-hour period. Service origins, paths, and the temperature measure are asserted without changing response fixtures. |
| S55 | Initially disabled heating and watchdog scripts each receive an autostart enable command for the correct ID. The already enabled script is not rewritten. The stub records enabled state per script. |
| S56 | Hand-written unequal-price tables anchor both production ranking and the oracle to literal hour lists: two hours in each six-hour period, and three hours on the autumn DST day. The DST comment identifies repeated 03:00 and explains why its second occurrence's lower price is ignored. |

S48–S56 use a small synchronous scenario wrapper with a fresh world, clock, and logs. Test-side exceptions are reported as failures and the next scenario still runs; older top-level cases have not all been migrated to this wrapper. VM errors remain recorded for that boot instead of being cleared by the next driven call.

The queued harness supports `advanceBy(milliseconds)` and `advanceTo(epochMilliseconds)`. These process one-shot timers, repeating timers, and RPC callbacks in chronological order up to the bound, moving the script clock and device `unixtime` together. A device with `unixtime=0` remains unsynchronized until the scenario sets its time. Each advance is limited to 10,000 events. Randomness defaults to zero and can be set with `boot(true, { random: 0.5 })`.

Existing `step()`/`flush()` cases still drive callbacks explicitly: they drain queued RPC and one-shot work without firing recurring timers. `jumpToNextDay()` simulates a device wall-clock correction before an explicit tick, expiring prices through the production update predicate. It replaces the old private timestamp mutation; S53 uses only boot and bounded time advancement.

## Targeted mutation checks

```bash
node tests/mutations.js
# Or test a candidate script:
node tests/mutations.js /path/to/SmartHeatingWithShelly.js
```

The mutation runner first requires a passing baseline, then changes temporary copies of the script and runs the suite in `Europe/Tallinn`. It checks exact source-match counts, imposes a 20-second timeout per run, and removes its temporary directory. The working script is never edited.

Each mutation names its intended detecting scenario. `KILLED` requires a behavioral assertion failure there. `SURVIVED` means the suite passed; `REVIEW` means failures occurred without the intended assertion; `ERROR` means execution failed, timed out, or an unexpected runner error occurred. `STALE` specifically means the replacement pattern no longer has the expected number of matches; it reports the mutation name, expected/actual counts, and pattern. All outcomes except `KILLED` produce a nonzero final exit status. A stale pattern or per-mutation error does not stop the remaining mutants. VM exceptions are labeled separately and do not count as intended behavioral detections. Additional detecting scenarios are printed for inspection; an unexpected detector can be legitimate, such as S47 detecting a missing tariff fee.

Run this set after changes to the suite. It covers selected schedule, forecast, threshold, tariff, and timer defects; it is not an exhaustive mutation score. When production code is refactored, update obsolete replacement strings and review the intended detectors.

## Installation contract and TDD coverage

The installation policy was tested by changing the expected behavior first and confirming failures before modifying the runtime.

| Scenario | Required behavior |
| --- | --- |
| All nine controls present and valid (S7c, S29) | Use their values for heating after validating configuration and SystemData reads. |
| Invalid/conflicting controls or failed/incomplete reads (S19–S21, S36, S36b, N6) | Pause without changing controls, relay settings, or schedules. |
| N1: all nine slots empty, SystemData present or absent | Install defaults and schedule heating; replace any recorded schedule without orphaning it. Preserve foreign controls with pagination and ignored server-side key filters; assert RPC and timer peaks stay at or below five. |
| N2: partial controls, SystemData absent | Pause without changing controls or heating. Parameterized over all nine missing controls with pagination and ignored server-side key filters. |
| N3: partial controls, SystemData present or absent | Pause without changing controls, KVS, relay settings, or schedules, even with an old backup present. Name every missing control; preserve state across retries and restarts. |
| N4: fresh group creation or population fails | Log once, continue heating, and issue no group RPC on later normal calculations or restart. A restart between control creation and grouping leaves a cosmetic gap. |
| N5: obsolete backup absent, corrupt, or valid | Make zero calls touching `SmartHeatingVC1` across installation, normal calculations, and a partial-controls pause. Leave any existing record unchanged. |
| N6: SystemData read fails or contains invalid JSON/ID | Block installation with either empty slots or partial controls. The empty-slot cases detect a bypassed SystemData read guard; partial controls alone cannot establish that protection. |

Every inventory page must include a numeric `total`, including a single page containing all nine valid controls. This unreleased version tightens normal reads: earlier code could accept a complete single page without this field. Missing or nonnumeric totals now pause both normal reads and installation; S36b checks preserved state and recovery after a valid response.

Partial controls always pause, regardless of SystemData. Its absence cannot establish whether deleted controls had customized values. Keep SystemData because it holds the schedule ID.

Failed control additions stop the current batch. If some controls were created, later calculations and restarts pause until the user restores the missing controls or deliberately removes all nine and restarts for defaults. All-empty slots still permit installation. A post-install verification read that finds a partial set cannot start another batch in the same calculation, and the next calculation pauses too. S15 checks failed additions and manual recovery; S28 checks an add that reports success without producing a visible control. All-empty reinstallation retains the old schedule ID until replacement.

Existing group names and membership remain untouched, including installation into nine empty control slots alongside an existing group; new controls then need manual grouping. Group population requires a successful create response with numeric ID 200. Creation and population occur once in the install chain, after control additions and before a complete verification read. An absent or empty group alongside complete controls requires manual grouping. No recovery backup, group retry state, or group ownership marker is persisted.

## Retained heating regressions

- Correct schedules for normal days, 23/25-hour DST days, tariff windows, forecast limits, and supported numeric/string periods.
- Full quarter-hour price validation, malformed/truncated rows, CRLF, missing final newlines, and outage recovery. Every quarter in the repeated hour is validated.
- Threshold-only outages preserve heating state; explicit zero-hour timed fallback still clears the old schedule.
- Invalid settings, conflicting control names, missing values, and failed reads preserve existing settings and heating. Valid controls override inactive KVS heating values only after mode and relay validation.
- Timer failures require a verified equivalent timer. Incompatible schedules are disabled before a polarity change; local RPC failures retry without guessing state.
- Failed SystemData writes retain the pending schedule ID, including zero, and retry before another calculation. A deleted key does not erase an ID already known in memory.
- S45 checks queued configuration → SystemData reads before either mode starts, including missing/failed configuration and SystemData-first pause diagnostics when both reads fail. S46 checks persistence after schedule creation succeeds, fails, or is unnecessary, including version 5 and next-tick retry after creation failure. S23, S25, and S26 retain pending-write and overlapping-tick coverage.
- Watchdog deletion, concurrent events, cached-ID name checks, and avoidance of unnecessary code writes.
- SystemData write-failure diagnostics retain the paused-updates sentinel, schedule ID, and RPC reason (S34). A missing Gen2 Pro firmware version selects KVS without attempting virtual controls (S40).

## Diagnostic contract

Keep the sentinel phrases `Schedule updates are paused`, `Missing controls`, and `Group setup incomplete`. Missing-control messages include component IDs and names; configuration and persistence errors identify the relevant field, record, or schedule and the available RPC reason. If an entry is omitted or a returned control has no status/value, the message advises waiting for the next read when the control exists, and manual restoration only when it is actually missing. Other prose is not a compatibility interface. S16 checks the preserved schedule ID, paused-updates sentinel, and RPC reason while accepting equivalent preservation wording. The group failure message appears once per installation attempt, with no repeated messages during normal calculations. Successful responses that do not confirm numeric ID 200 are reported as unverified creation, without an error code; actual RPC failures include their code and reason.

## Limits

Node does not establish Shelly engine compatibility, actual cron execution, or device memory usage. Measure `mem_used` and `mem_peak` on hardware before release. Most scenarios use synchronous callbacks; queued cases cover the critical asynchronous paths and RPC/timer limits.

Schedule persistence remains an in-memory retry, not a transaction journal. A restart before a successful SystemData write may leave an unrecorded schedule. The script does not discover or recover orphan schedules, and it skips schedule listing when no ID is recorded. After a failed polarity transition, the previous schedule may remain disabled until a successful retry.
