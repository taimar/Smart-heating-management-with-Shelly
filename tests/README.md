# Requirement tests for SmartHeatingWidthShelly.js

`spec.js` is the merge gate for the heating script. It runs the real script in a stubbed Shelly environment and specifies externally observable requirements rather than a particular implementation. Each candidate runs in a Node VM with a three-second limit per driven call, so an infinite parser or control loop is reported without stopping the remaining scenarios.

Run it from the repository root:

```bash
TZ=Europe/Tallinn node tests/spec.js SmartHeatingWidthShelly.js
```

The suite covers:

- complete Elering responses, every mid-row truncation offset, malformed prices and discontinuous timestamps;
- CRLF and missing final newlines, with the quarter-hour requirement retained;
- 23-, 24-, and 25-hour local days;
- tariff windows and forecast heating limits;
- offline fallback and recovery from RPC failures;
- safe schedule replacement, verified relay timers after an update failure, and disabling incompatible schedules before changing polarity;
- bounded SystemData write retries before further calculations, including pending schedule ID zero;
- invalid settings and failed reads preserve stored configuration and existing heating, then recover after correction;
- supported numeric/string periods, explicit zero, and wider KVS numeric ranges;
- Virtual Component names and values, complete foreign sets, single conflicting controls, filtered and unfiltered pagination;
- incomplete Virtual Component reads preserve schedules and relay settings when repair cannot be verified;
- compact backup writes only when control values change, missing-control repair, version-independent reinstall, and recovery from failed additions across retries and restarts;
- embedded watchdog deletion, concurrency, flash-write behavior, and cached-ID name checks before accepting or restarting a script.

The price server adapts to either supported request convention: an exclusive next-midnight `end`, or an inclusive final-quarter `end`. Expected schedule hours are calculated by an independent oracle.

## Known limits

- Node.js does not model Shelly's memory ceiling or every scripting-engine restriction.
- Most RPC timing is synchronous; additional queued scenarios cover installation, repair, RPC/timer limits, and concurrent watchdog script-stop events.
- Hardware validation is still required before release, particularly for peak memory and live API behavior.

## Virtual Component recovery

`SmartHeatingVC<ScriptId>` stores only the nine control values from the last complete valid read (42 bytes of JSON with the defaults). Fresh installation saves its intended values before adding any controls, so interrupted installation can resume. Repair restores missing controls from this backup and leaves surviving values untouched. Normal reads also require the expected control names and valid values before applying or backing up any settings. The backup is refreshed when a complete read detects changes.

An incomplete installation without a valid backup, or with a conflicting component name on a reserved ID, is left untouched. Restore the missing controls manually, or remove all reserved controls and restart to reinstall. Reinstallation uses the backup when available and initial defaults otherwise, regardless of the stored script version.

The backup adds a small resident value array and transient serialization/repair allocations. Its serialized size is not a measurement of Shelly RAM usage; measure `mem_used` and `mem_peak` on the target device during both normal scheduling and repair.

## Configuration validation

Supported heating periods remain 0, 6, 12 and 24 hours, including their enum string forms. Null, blank and unsupported settings are reported and left unchanged. Numeric fields require JSON numbers; boolean fields require true or false. KVS price thresholds and heating-curve values retain their wider numeric ranges instead of inheriting UI slider limits.

The script initializes `SmartHeatingConf<ScriptId>` only after a confirmed missing-key response. A failed read or invalid JSON cannot trigger initialization, change relay settings, or replace an existing schedule. Successfully read settings are used without rewriting the configuration key. Fix the reported setting and the normal retry resumes scheduling.

Virtual controls are recognized by their reserved keys, expected names and valid values. Keep the installed control names; if a control is renamed, the error identifies the expected name to restore. This catches conflicting controls, including one conflicting control in an otherwise complete set. It is a collision check, not proof of ownership against another script deliberately using identical keys and names.

## Schedule persistence and polarity changes

A failed SystemData write leaves the new schedule ID pending in memory. Each five-minute tick retries the same record once, before reading KVS or calculating another schedule. Once the write succeeds, normal scheduling resumes. This also applies to ID zero when no heating is scheduled. No additional KVS backup or recovery journal is created.

A power cut or script restart before the pending record is saved can still leave a schedule unrecorded. This implementation does not discover orphan schedules across restarts; the in-memory retry fixes temporary write failures during normal operation.

Before updating a timer, the script reads the recorded schedule's relay command. A schedule using a different polarity or relay is disabled first. Failure to read or disable it leaves the timer unchanged. If a later step fails, the old schedule remains disabled (or already deleted) until a normal retry installs its replacement; scheduled heating may pause during that interval. Same-polarity schedules remain enabled during ordinary recalculation.

The watchdog fast path rechecks the cached script's name before accepting it as running or restarting it. A renamed or reused ID is left alone, and the script searches for the named watchdog again. This name check does not detect someone replacing code while retaining the watchdog name.
