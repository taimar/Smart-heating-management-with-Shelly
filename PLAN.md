# Smart heating: bounded recovery fixes and staged cleanup

## Summary

Address findings #1–9 on `claude/actionable-bugs-8a5c69` through three separately reviewable PRs.

The recovery guarantee is bounded: **prevent newly enabled orphan schedules caused by interrupted creation or failed persistence**. Reuse recorded IDs, retain disabled schedules on zero-heating days, and enable new schedules only after their IDs are saved.

Automatic orphan discovery and protection against stale IDs reassigned to unrelated schedules are excluded. Document these limitations without claiming complete ownership protection.

## Task 1 — PR 1: Legacy compatibility, retries and watchdog hardening

### Legacy SystemData — #1

- Accept `ExistingSchedule: ""` only in a parsed, non-array object with a finite numeric version satisfying **`4.2 <= Version < 5`**.
- Interpret this legacy value as zero and normalize it through the next normal successful SystemData write.
- Keep the upper boundary fixed at 5; do not tie it to future values of `_.newV`.
- Continue rejecting missing/null IDs, numeric strings, negative/fractional IDs and empty strings outside that version range.
- Remove the migration-specific rule about preserving an unsaved in-memory ID. Preserve existing handling of failed reads and missing keys.
- Apply this migration only to the existing `SmartHeatingSys<ScriptId>` record. Do not introduce discovery or migration of historical key names.

### Offline retries — #2

- Before entering fallback, invalidate `tsPr` and, when forecasting is enabled, `tsFc`.
- Preserve `_.manu`’s suppression of repeated fallback installation.
- Release the loop lock after each completed attempt and retry through the existing five-minute timer.
- Successful fetching resumes calculated heating and clears fallback mode.
- Preserve threshold-only behavior: unavailable prices pause updates without installing historical fallback hours.

### Watchdog — #4 and conditional writes

Deliver all watchdog changes together:

- Catch malformed JSON and require a non-array object with a finite, non-negative integer schedule ID.
- Zero requires no action. Invalid records produce a script-specific diagnostic without modifying schedules or storage.
- Keep asynchronous callback state local to each stopped script.
- Before dispatching delayed deletion, skip cleanup if the target script is already running.
- Delete only the recorded ID. Preserve the record when deletion fails.
- After successful deletion, clear the ID using the `etag` from the original KVS read. On conflict, preserve the newer record; never retry unconditionally.
- If no usable `etag` is returned, skip clearing the record and log the limitation.
- Preserve `LastCalculation` when clearing the ID.

KVS provides conditional writes through `etag`; no additional storage key is needed. [Shelly KVS API](https://shelly-api-docs.shelly.cloud/gen2/ComponentsAndServices/KVS/)

Run behavioral tests against the readable and minified watchdogs. Add one parity assertion comparing the installed embedded code with the minified file, excluding only surrounding whitespace.

## Task 2 — PR 2: Schedule lifecycle and interruption recovery

Implement these transitions in `SmartHeatingWithShelly.js`:

| State | Required behavior |
|---|---|
| Recorded schedule exists; heating required | Verify timer compatibility, then update the schedule in place |
| Recorded schedule has incompatible relay or polarity | Disable it before configuring the target timer, then update and enable the same ID |
| No recorded schedule exists; heating required | Configure timer → create disabled → validate returned ID → persist ID → enable |
| Recorded schedule is disabled after restart | Recalculate using current configuration and reuse its ID |
| Recorded schedule exists; no heating required | Disable it, retain its ID and record the calculation |
| No schedule exists; no heating required | Persist zero without creating a placeholder |

Additional requirements:

- A failed or malformed `Schedule.List` response must pause work; it does not establish absence.
- Create a replacement only after absence of the recorded schedule is confirmed.
- Track pending persistence and activation separately in memory. Persistence failures retry the same record before accepting another calculation.
- Activation failures retain the ID, invalidate fetch timestamps and reconcile on the next five-minute tick.
- An invalid create response leaves the newly created job disabled and produces an actionable diagnostic.
- Restart discards pending runtime state and reconciles persisted identity against device schedules.
- Never discover, adopt or delete jobs by matching hours, relay commands or polarity.
- The watchdog still deletes the recorded schedule on stop; retaining disabled schedules applies to zero-heating calculations.
- Preserve the calculation-attempt timestamp across retries. Saving an ID must not be logged as successful activation.

No persistent fields or configuration options are added. `ExistingSchedule` may identify an active or disabled job. `LastCalculation` remains the recorded attempt time, not proof of successful activation.

### Failure harness and acceptance criteria

Extend the queued harness to separate an RPC’s device-side effect from callback delivery. Restart retains device schedules, KVS and relay configuration while discarding stopped-runtime callbacks, timers and memory.

Cover:

- Interruption after disabled creation, persistence, activation and in-place update—including after effects occur but before callbacks arrive.
- Failed persistence never enabling a new schedule.
- Restart after activation producing no duplicate enabled schedule.
- Activation failures, confirmed missing schedules and polarity transitions retaining recoverable identity.
- Heating → zero hours → heating reusing one ID, including restart during the disabled period.
- Initial zero-hour calculation creating no schedule.
- Two instances with identical relay commands remaining independent while their recorded identities are valid.
- Delayed watchdog writes preserving newer SystemData.

Revise S23–S26, S42 and S46 where assertions require deletion, replacement IDs or zero IDs for disabled heating. Preserve outcome, timer-compatibility and resource-limit checks.

### ID-reuse boundary

The documented Schedule API assigns IDs but does not promise they are never reused. Treat the recorded ID as the existing system’s authority, not proof against reassignment. [Shelly Schedule API](https://shelly-api-docs.shelly.cloud/gen2/ComponentsAndServices/Schedule/)

- Add hardware checks for allocation after deletion and reboot.
- If reuse is observed, record it explicitly and retain the bounded release scope.
- Document that a stale/reassigned ID requires manual reconciliation of SystemData and actual schedules before restarting.
- Do not add heuristic ownership matching or silently broaden this PR into ownership redesign.
- Existing unrecorded enabled schedules are not repaired by this change. Interrupted new creation may leave disabled orphans consuming slots.

## Task 3 — PR 3: Optional cleanup and mutation maintenance

- **#5:** Reset the provider label to `"None"` for packages without a matching provider prefix.
- **#6:** Use one shared constant package-key array for validation and virtual-component options. Preserve ordering, labels and rates; do not use `Object.freeze` or allocate rate objects during validation.
- **#7:** Reuse the calculated `timr` value for timer configuration and verification.
- **#8:** Store hourly rows as `[timestamp, totalPrice, marketPrice]`. Round market averages once, calculate fees once, rank by total price and apply thresholds directly to market price. Preserve tie-breaking and DST behavior.
- **#9:** Remove only the two forecast constant mutations. Preserve S49’s behavioral coverage, S53’s five-minute assertions and its interval mutations. Update other mutation patterns only where refactoring requires it.

Use existing pricing and scheduling scenarios to verify cleanup. Make no unmeasured memory or performance claim.

## Verification and delivery

For each PR:

- Run the requirement suite and mutation runner with Node 24 and `TZ=Europe/Tallinn`.
- Before committing each new test batch, apply a representative one-line behavioral mutation to a temporary source copy and count failures. Require one or two named detectors; investigate zero failures or broad overlap.
- Keep production changes and their regression tests together. Add no tests solely for cosmetic cleanup or duplicated arithmetic.
- Update both language READMEs and the findings document with that PR’s actual behavior.

Required hardware checks:

- Disabled creation and save-before-enable ordering.
- Stop/start and reboot interruptions.
- Watchdog malformed-record handling and conditional KVS writes.
- Schedule-ID allocation after deletion and reboot.
- Memory baseline, memory after PR 2, and memory after PR 3, including supported two-instance operation and failure/retry paths.

Hardware results must identify the device and firmware tested. If hardware is unavailable, report Node verification separately and leave hardware qualification outstanding; do not claim device validation.

Document retained disabled schedules, unchanged timestamp meaning, disabled-orphan cleanup, stale-ID limitations and coordinated upgrade of heating instances sharing the watchdog. Three PRs provide independent review and rollback boundaries; they do not imply compatibility with older instances that reinstall an older watchdog.
