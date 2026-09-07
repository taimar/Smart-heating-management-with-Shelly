# Requirement tests for SmartHeatingWithShelly.js

`spec.js` is the merge gate for the heating script. It runs the real script in a stubbed Shelly environment and specifies externally observable requirements rather than a particular implementation. Each candidate runs in a Node VM with a three-second limit per driven call, so an infinite parser or control loop is reported without stopping the remaining scenarios.

Run it from the repository root:

```bash
TZ=Europe/Tallinn node tests/spec.js SmartHeatingWithShelly.js
```

The suite covers:

- complete Elering responses, every mid-row truncation offset, malformed prices and discontinuous timestamps;
- CRLF and missing final newlines, with the quarter-hour requirement retained;
- 23-, 24-, and 25-hour local days, including unequal repeated-hour prices, validation of the second occurrence, and exactly 23 spring candidates;
- tariff windows and forecast heating limits;
- offline fallback and recovery from RPC failures, including periodic ticks while fallback RPCs are pending; threshold-only outages preserve existing schedules/relay settings while explicit zero-hour timed settings still remove heating;
- safe schedule replacement, verified relay timers after an update failure, and disabling incompatible schedules before changing polarity;
- bounded SystemData write retries before further calculations, including pending schedule ID zero; failed reads, malformed JSON and invalid schedule IDs preserve known state; recovery must schedule newly requested hours;
- invalid settings and failed reads preserve stored configuration and existing heating, then recover after correction; valid virtual controls can supersede invalid inactive KVS heating values when mode and relay are known;
- supported numeric/string periods, explicit zero, and wider KVS numeric ranges;
- Virtual Component names and values, complete foreign sets, single conflicting controls, filtered and unfiltered pagination;
- incomplete Virtual Component reads preserve schedules and relay settings when repair cannot be verified;
- backup writes for changed values or missing/corrupt records, cache reuse after transient read failures, missing-control repair, version-independent reinstall, and recovery from failed additions across retries and restarts;
- repair attempts are bounded per calculation even when a successful add does not produce a visible control; decorative group failures do not block heating, and existing group names/membership survive repair;
- other same-relay schedules are diagnosed on the first calculation even before an ID is recorded, without repeated notices, blocked calculations or modified jobs; short/missing firmware versions are handled;
- unreadable/invalid backups cannot reset settings, including with every control absent, and log messages identify failed keys and RPC reasons;
- pending group work causes zero idle-tick RPCs; both retry states share a three-failure cap without preventing required heating updates;
- occupied-slot races, deletion between creation and population, and the documented cosmetic restart gap; restart resets the budget for a legitimate repair but leaves a complete ungrouped installation alone; early mode/relay rejection is checked before component reads or backup writes;
- embedded watchdog deletion, concurrency, flash-write behavior, and cached-ID name checks before accepting or restarting a script.

The price server adapts to either supported request convention: an exclusive next-midnight `end`, or an inclusive final-quarter `end`. Expected schedule hours are calculated by an independent oracle.

## Known limits

- Node.js does not model Shelly's memory ceiling or every scripting-engine restriction.
- Most RPC timing is synchronous; additional queued scenarios cover installation, repair, RPC/timer limits, and concurrent watchdog script-stop events.
- Hardware validation is still required before release, particularly for peak memory and live API behavior.

## Virtual Component recovery

`SmartHeatingVC<ScriptId>` stores only the nine control values from the last complete valid read (42 bytes of JSON with the defaults). Fresh installation saves its intended values before adding any controls, so interrupted installation can resume. Repair restores missing controls from this backup and leaves surviving values untouched. Only one repair batch is attempted per calculation. Existing decorative groups keep their names and membership. The group is created during installation or repair of the controls, only after all nine controls are valid. A three-state in-memory flag (idle, creation pending, population pending) permits one retry per already-required heating calculation. Pending group work never causes a calculation on an otherwise idle tick. Creation and population share a per-boot budget of three retryable failures; successes and terminal occupied/deleted outcomes do not consume it. Exhaustion returns the state to idle and logs manual-grouping advice once, while heating updates continue normally. Restart resets the budget, but a complete ungrouped installation remains ungrouped. A missing required control alongside the absent group permits a repair and a fresh creation attempt after restart. Only a successful create response authorizes population. An occupied slot after failed creation stops retries; a not-found response during population also stops retries without recreating a deleted group. Group failures do not prevent heating. There is no persisted group marker. After restart, an existing empty group or an absent group alongside nine complete controls is left alone; manual grouping may be needed if restart interrupted installation. Normal reads also require the expected control names and valid values before applying or backing up any settings. The backup is refreshed when a complete read detects changes.

An incomplete installation without a valid backup, or with a conflicting control name on a reserved ID, is left untouched. Only a confirmed NOT FOUND (-105) response permits initialization from defaults and explicit reinstall advice. A failed backup read or invalid record logs the SmartHeatingVC key. Without a backup validated during this boot, initialization/repair pauses without changing the backup. With a validated cache, only missing controls use cached values; present controls supply their live values. The merged set is validated and saved before adding controls. A failed write leaves the validated cache unchanged. Complete valid live controls can still supply settings and refresh the backup. One outcome value distinguishes succeeded, missing, invalid and failed reads. A matching cache can suppress an unchanged write after a transient failure; missing and invalid records must be refreshed even when the cache matches. Restore missing controls manually; remove all reserved controls to reinstall only after confirming the backup is absent and intentionally choosing defaults. Reinstallation uses the backup when available and initial defaults otherwise, regardless of the stored script version.

The backup adds a small resident value array and transient serialization/repair allocations. Its serialized size is not a measurement of Shelly RAM usage; measure `mem_used` and `mem_peak` on the target device during both normal scheduling and repair.

## Configuration validation

Supported heating periods remain 0, 6, 12 and 24 hours, including their enum string forms. Null, blank and unsupported settings are reported and left unchanged. Numeric fields require JSON numbers; boolean fields require true or false. KVS price thresholds and heating-curve values retain their wider numeric ranges instead of inheriting UI slider limits.

The script initializes `SmartHeatingConf<ScriptId>` only after a confirmed missing-key response. A failed read or invalid JSON cannot trigger initialization, change relay settings, or replace an existing schedule. Successfully read settings are used without rewriting the configuration key. Fix the reported setting and the normal retry resumes scheduling. Invalid active settings log “Schedule updates are paused”; no automatic period migration or setting reset is performed. In Virtual Component mode, valid controls supply the nine heating values regardless of inactive KVS heating values, but mode and relay must still be read and validated.

Virtual controls are recognized by their reserved keys, expected names and valid values. Keep the installed control names; if a control is renamed, the error identifies the expected name to restore. This catches conflicting controls, including one conflicting control in an otherwise complete set. It is a collision check, not proof of ownership against another script deliberately using identical keys and names.

## Schedule persistence and polarity changes

A failed SystemData write leaves the new schedule ID pending in memory. Each five-minute tick retries the same record once, before reading KVS or calculating another schedule. Once the write succeeds, normal scheduling resumes. This also applies to ID zero when no heating is scheduled. No additional KVS backup or recovery journal is created.

A power cut or script restart before the pending record is saved can still leave a schedule unrecorded. This implementation does not recover orphan schedules across restarts; the in-memory retry fixes temporary write failures during normal operation. The first successful schedule-list read reports matching jobs once per boot without claiming ownership, changing them, or blocking scheduling; an empty list also completes this scan. Failed reads do not complete it. Jobs added later are not tracked. After the first successful scan, Schedule.List is skipped if no schedule ID is recorded. A failed diagnostic list read can be ignored only when no existing schedule ID is recorded.

Before updating a timer, the script reads the recorded schedule's relay command. A schedule using a different polarity or relay is disabled first. Failure to read or disable it leaves the timer unchanged. If a later step fails, the old schedule remains disabled (or already deleted) until a normal retry installs its replacement; scheduled heating may pause during that interval. Same-polarity schedules remain enabled during ordinary recalculation.

The watchdog fast path rechecks the cached script's name before accepting it as running or restarting it. A renamed or reused ID is left alone, and the script searches for the named watchdog again. This name check does not detect someone replacing code while retaining the watchdog name.

Group membership retries intentionally have no cross-restart ownership recovery. A successful `Virtual.Add` response is the only transition to population pending. Creation errors trigger a read of `Group.GetConfig` to distinguish an occupied slot without relying on an undocumented already-exists error code.

Group tests verify the exact nine member keys and default name, both terminal log explanations, and strict numeric ID 200 in the create response. Missing IDs, wrong numeric IDs, and string "200" never authorize population. Unverified successful responses are reported as uncertain ownership and do not suppress a later group-rename notice. Mode selection logs once and explains whether ManualKVS forced it or the device lacks Virtual Component support; capability checks remain quiet and tolerate non-string firmware and app values.

Threshold-only mode (`TimePeriod: 0`) has no historical-hour fallback: a price error pauses updates without changing relay settings or deleting a recorded schedule. The next valid price response resumes scheduling, including clearing heating when no hours meet the thresholds. The offline fallback for a timed period with zero requested heating hours remains empty. Invalid backups name corrective actions separately from transient failed reads; intentional deletion of a corrupt key permits default reinstallation only when the controls are absent.

Deleting the SystemData key mid-run preserves the schedule ID already in memory: the next calculation deletes the old job, installs the changed hours, and persists the replacement ID. The regression catches resetting that ID on a NOT FOUND (-105) response.

Cache-repair tests cover every missing control after failed reads, invalid JSON, and invalid backup values. They assert the first backup write already includes changed surviving values, all surviving controls remain untouched, and heating updates resume. Cold-boot cases still pause without a validated cache. A failed-write regression checks that attempted merging cannot mutate the cache. S7c checks the missing-backup explanation, every missing control name, and a recovery action separately. Existing groups remain untouched, with a manual-grouping note during repair.

Mode rollback is tested by rejecting invalid forced-KVS settings, removing that record, and confirming VC installation without persisting the rejected mode. A complete-read regression deletes both the group and one control during the same run: only the control returns. Saved configurations require `RelayId`, including VC mode; a minimal VC configuration selecting relay 1 is checked against timer and schedule RPCs. Null control-add responses must not interrupt the subsequent complete-read verification. Empty or failed fallback attempts must not be logged as active historical-hour schedules.
