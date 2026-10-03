# Review findings: `master...HEAD`

Branch `claude/actionable-bugs-8a5c69`, reviewed 2026-10-01 at high effort and revised after a second developer's review. The requirement suite (`node tests/spec.js SmartHeatingWithShelly.js`) passes. The second reviewer reproduced #1–4 with temporary Node probes. No finding was tested on Shelly hardware.

## Implementation status

Stage 1 addresses #1, #2 and #4: JSON-era empty IDs (4.2 <= Version < 5), retries across midnight, validated watchdog records and conditional cleanup writes. Regression scenarios S57–S60 pass under Node 24. Watchdog behavior is checked on readable/minified copies, with parity against installed code. Shelly hardware qualification remains outstanding.

## Priority

| # | Finding | Priority |
|---|---------|----------|
| 1 | Legacy `ExistingSchedule: ""` blocks all scheduling | Blocking |
| 2 | Offline fallback can persist a full day (exists on `master` too) | Blocking |
| 3 | Unsaved schedule ID is orphaned, then duplicated on restart | Blocking |
| 4 | Watchdog throws on malformed or `null` SystemData | Watchdog robustness |
| 5 | Stale network provider label after switching to `NONE` | Diagnostic cleanup |
| 6–8 | Duplication and redundant work | Optional cleanup |
| 9 | Two forecast mutations pin constants | Conventions |

## Correctness

### 1. Legacy SystemData `ExistingSchedule: ""` blocks all scheduling

[SmartHeatingWithShelly.js:367](SmartHeatingWithShelly.js:367)

`rSys` rejects any `ExistingSchedule` that is not a non-negative integer. v4.9 saved `"ExistingSchedule":""` when the first calculation after boot found no heating hours. Upgraded devices then stop scheduling until the user edits KVS by hand.

**Scenario:** In v4.9, `_.scId` starts as `''`. When `fScd` gets an empty `eler` (threshold-only mode with no cheap hours, or `AlwaysOffPrice` set too low), it returns before `_.scId = 0` runs, and `fKvs` saves `ExistingSchedule: ""`. After the upgrade, `idOk("")` is false and `sdOk` stays false. `inst()` then calls `rErr` every 5 minutes, and no schedule is ever created.

**Fix:** Accept `""` as "no schedule", preferably only for legacy records. Do not treat `null` or a missing field as `0`. Neither value is known v4.9 output, and treating them as `0` could throw away a schedule ID that is real.

### 2. Offline fallback can persist a full day after connectivity returns

[SmartHeatingWithShelly.js:1057](SmartHeatingWithShelly.js:1057)

This bug also exists on `master`: the old `hErr` did not reset the timestamps either. It is in scope because this branch rewrote `hErr`.

`hErr` installs the fallback schedule but never clears `_.tsPr` or `_.tsFc`. Retries stop once the old timestamp counts as "yesterday".

**Scenario:** The script restarts at 15:00 on day D and fetches prices, so `tsPr` is D 15:00. Elering is unreachable for the whole of 23:xx, and `fMan` installs the fallback hours. At 00:05 on D+1, `updt` sees `tsPr` dated yesterday and `isTm` false, so it returns false. No retry happens until 23:xx on D+1, and the whole day heats on fixed fallback hours even though prices are available.

**Fix:** Reset the timestamps in `hErr` as `rErr` does, or keep retrying while `_.manu` is true.

### 3. Unsaved new schedule ID is orphaned, then duplicated on restart

[SmartHeatingWithShelly.js:993](SmartHeatingWithShelly.js:993)

While `sysPending` is true, the new schedule ID exists only in memory. KVS still holds the old ID, which is already deleted. The save retry in `loop` works only while the script keeps running.

**Scenario:** `fdSc` deletes schedule 5 and `fScd` creates schedule 6. `KVS.set` then fails, so KVS still says 5. The user stops or edits the script:

1. The watchdog reads ID 5, gets a delete error, and keeps 5. Schedule 6 stays enabled.
2. On restart, `rSys` loads 5. `fTmr` does not find it in `Schedule.List`, so it sets `exSc = 0` and creates schedule 7.
3. Schedules 6 and 7 both switch the relay, and no script knows about 6.

### 4. Watchdog throws on malformed or `null` SystemData

[files/watchdog.js:6](files/watchdog.js:6) (also in `files/watchdog-min.js` and the code embedded in `putC`)

All three watchdog copies call `JSON.parse(res.value)` without `try`/`catch` and then read `.ExistingSchedule` from the result. Malformed JSON throws in `JSON.parse`. Valid JSON `null` throws when `.ExistingSchedule` is read.

**Scenario:** `SmartHeatingSys<id>` holds corrupted or hand-edited JSON (the heating script itself handles this case in `rSys`). When the heating script stops, the watchdog handler throws inside the `KVS.Get` callback. The exception was reproduced in Node. Whether Shelly then stops the whole watchdog script was not tested on hardware. If it does, the watchdog stays down until the heating script's next successful `pSys` restarts it, and any heating script stopped in that gap keeps its schedule.

**Fix:** Catch the parse error and validate the parsed object. This keeps the shared watchdog running. It cannot recover the schedule ID that the bad record has lost.

## Cleanup

### 5. Network provider label is stale after switching to `NONE` (diagnostic)

[SmartHeatingWithShelly.js:584](SmartHeatingWithShelly.js:584)

`main()` sets `_.prov` only for the VORK, PART, PAMA and SPECIAL packages. After a change from VORK2 to NONE, the log prints `Network provider: Elektlevi NONE`. Fees stay correct because every NONE rate is 0.

**Fix:** Add an `else` branch that sets `_.prov = "None"`.

### 6. The package list is duplicated (reuse)

[SmartHeatingWithShelly.js:20](SmartHeatingWithShelly.js:20)

`pack(key, true)` repeats the eleven package keys that the rate table below already defines, and `dtVc` repeats them a third time. Adding a package means editing three lists.

`pack(key) !== null` would remove one copy, but it creates a rate object every time validation runs. A shared list of keys removes the duplication without that allocation.

### 7. Timer delay is computed twice in `sTmr` (simplification)

[SmartHeatingWithShelly.js:902](SmartHeatingWithShelly.js:902)

`c.tmr * 60 + 10` is computed as `timr` and again as `delay` in the error branch. If one changes and the other does not, the check compares against a different delay than the one requested.

### 8. The transfer fee is added, then computed again to subtract it (simplification)

[SmartHeatingWithShelly.js:745](SmartHeatingWithShelly.js:745)

`gEle` adds `fFee` to each hourly price when it builds `raw`. It then calls `fFee` again for each hour to recover the market price, and needs an extra `Math.round` to undo floating-point drift.

On a normal full-day calculation, the second pass creates about 24 extra `Date` objects for Elektrilevi and about 48 for Imatra, because Imatra's `fFee` also calls `gTz`. Forecast periods create fewer. Storing market prices in `raw` keeps more array data in memory, so any memory saving must be measured.

## Conventions

### 9. Two forecast mutations pin constants

[tests/mutations.js:35](tests/mutations.js:35) (also line 36)

The mutations `forecast-coefficient` (`pFac` 0.5 → 0.6) and `forecast-reference` (`maxT` 16 → 17) change a constant and nothing else. `~/.claude/CLAUDE.md` says: "If the mistake is 'someone changed this value', write no test." and "Constants get at most one snapshot test."

**Fix:** Remove only these two mutations. Keep the rest of S49's checks, which cover rounding, period division and clamping.

**Not in scope:** S53's timing assertions and the `early-periodic-timer` and `late-periodic-timer` mutations (lines 54–55) stay. [README.md:292](README.md:292) promises that failed requests are retried at five-minute intervals, so S53 checks a documented behaviour. The two mutations check that the suite catches a wrong retry interval. They do not prove that the timer uses `_.freq`, because a hardcoded `300000` would also pass. To change the interval on purpose, update the README and S53 together.
