# Requirement tests for SmartHeatingWithShelly.js

Run the script in the stubbed Shelly environment:

```bash
TZ=Europe/Tallinn node tests/spec.js SmartHeatingWithShelly.js
```

Each driven VM call has a three-second timeout. Queued scenarios exercise asynchronous RPCs, timers, interrupted installation, and concurrent watchdog events. N1 checks fresh installation with and without SystemData and asserts RPC and timer peaks stay at or below five. S17 also checks those limits during interrupted installation, manual reset, and a later pause: peaks must each stay at or below five. The price fixture follows the requested date window; expected schedule hours come from an independent oracle.

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

Keep the sentinel phrases `Schedule updates are paused`, `Missing controls`, and `Group setup incomplete`. Missing-control messages include component IDs and names; configuration and persistence errors identify the relevant field, record, or schedule and the available RPC reason. If an entry is omitted or a returned control has no status/value, the message advises waiting for the next read when the control exists, and manual restoration only when it is actually missing. Other prose is not a compatibility interface. The group failure message appears once per installation attempt, with no repeated messages during normal calculations. Successful responses that do not confirm numeric ID 200 are reported as unverified creation, without an error code; actual RPC failures include their code and reason.

## Limits

Node does not establish Shelly engine compatibility, actual cron execution, or device memory usage. Measure `mem_used` and `mem_peak` on hardware before release. Most scenarios use synchronous callbacks; queued cases cover the critical asynchronous paths and RPC/timer limits.

Schedule persistence remains an in-memory retry, not a transaction journal. A restart before a successful SystemData write may leave an unrecorded schedule. The script does not discover or recover orphan schedules, and it skips schedule listing when no ID is recorded. After a failed polarity transition, the previous schedule may remain disabled until a successful retry.
