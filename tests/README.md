# Requirement tests for SmartHeatingWidthShelly.js

`spec.js` is the merge gate for the heating script. It runs the real script in a stubbed Shelly environment and specifies externally observable requirements rather than a particular implementation. Each candidate runs in a Node VM with a three-second limit per driven call, so an infinite parser or control loop is reported without stopping the remaining scenarios.

Run it from the repository root:

```bash
TZ=Europe/Tallinn node tests/spec.js SmartHeatingWidthShelly.js
```

The suite covers:

- complete and truncated Elering price responses;
- 23-, 24-, and 25-hour local days;
- tariff windows and forecast heating limits;
- offline fallback and recovery from RPC failures;
- safe schedule replacement;
- corrupted and string-valued configuration;
- Virtual Component ownership, filtered and unfiltered pagination;
- incomplete Virtual Component reads preserve schedules, relay settings, and KVS data, then recover on the normal retry;
- embedded watchdog deletion, concurrency, and flash-write behavior.

The price server adapts to either supported request convention: an exclusive next-midnight `end`, or an inclusive final-quarter `end`. Expected schedule hours are calculated by an independent oracle.

## Known limits

- Node.js does not model Shelly's memory ceiling or every scripting-engine restriction.
- RPC timing is deterministic except for the embedded watchdog sandbox, which deliberately queues callbacks to test concurrent script-stop events.
- Hardware validation is still required before release, particularly for peak memory and live API behavior.
