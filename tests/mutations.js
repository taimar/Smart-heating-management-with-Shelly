// Targeted behavioral mutations; never edits the working production script.
// Run: node tests/mutations.js [path-to-script]
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const sourcePath = path.resolve(process.argv[2] || path.join(__dirname, '..', 'SmartHeatingWithShelly.js'));
const source = fs.readFileSync(sourcePath, 'utf8');
const suite = path.join(__dirname, 'spec.js');
const mutations = [
    ['watchdog-restarted-each-cycle', 'S13',
        'if (status && status.running) {\n            _.isLp = false;\n            return;',
        'if (false) {\n            _.isLp = false;\n            return;'],
    ['incomplete-quarter-day', 'S14', '!valid || qCnt !== qExp', '!valid'],
    ['unbounded-fallback-hours', 'S10', 'const fbTim = c.hTim > c.tPer ? c.tPer : c.hTim;', 'const fbTim = c.hTim;'],
    ['firmware-minimum-exclusive', 'S40', 'return true; //equal versions meet the minimum requirement', 'return false; //reject equal firmware'],
    ['older-pro-firmware-accepted', 'S40', "verC('1.4.3',", "verC('1.4.2',"],
    ['forecast-user-minimum-ignored', 'S6', '_.hTim = c.hTim;', '_.hTim = 0;'],
    ['forecast-minimum-without-demand', 'S6', 'fcTm > 0 && _.hTim < c.hTim', '_.hTim < c.hTim'],
    ['repeated-hour-prices-averaged', 'S27', 'if (count < 4) { sum += row[1]; count++; }', 'sum += row[1]; count++;'],
    ['schedule-id-lost-on-read-error', 'S26',
        'if (err !== 0 || !res) { print(_.pId, "SystemData read failed:", err, msg); return; }',
        'if (err !== 0 || !res) { s.exSc = 0; print(_.pId, "SystemData read failed:", err, msg); return; }'],
    ['cron-minute', 'S48', 'timespec: "0 0 " + hrs', 'timespec: "0 30 " + hrs'],
    ['disabled-schedule', 'S48', 'enable: true,\n        timespec:', 'enable: false,\n        timespec:'],
    ['wrong-relay', 'S48', '                id: c.rId,', '                id: 0,'],
    ['wrong-polarity', 'S48', '                on: !c.Inv', '                on: c.Inv'],
    ['forecast-coefficient', 'S49', 'pFac: 0.5,', 'pFac: 0.6,'],
    ['forecast-reference', 'S49', 'const maxT = 16;', 'const maxT = 17;'],
    ['forecast-temperature-rounding', 'S49', 'Math.ceil(sumT / nTmp)', 'Math.floor(sumT / nTmp)'],
    ['forecast-hour-rounding', 'S49', 'Math.floor(fcTm / _.cPer)', 'Math.ceil(fcTm / _.cPer)'],
    ['forecast-curve', 'S49', 'c.hCur * 2 - 2', 'c.hCur - 2'],
    ['forecast-offset', 'S49', 'c.hCur * 2 - 2', 'c.hCur * 2 - 1'],
    ['forecast-period', 'S49', 'Math.floor(fcTm / _.cPer)', 'Math.floor(fcTm)'],
    ['forecast-warm-clamp', 'S49', 'fcTm < 0 || tFcs > maxT ? 0 : fcTm', 'fcTm < 0 ? 0 : fcTm'],
    ['threshold-only-on-exclusive', 'S50', 'mPric <= c.lowR', 'mPric < c.lowR', 2, 0],
    ['timed-on-exclusive', 'S50', 'mPric <= c.lowR', 'mPric < c.lowR', 2, 1],
    ['threshold-only-off-exclusive', 'S50', 'mPric >= c.higR', 'mPric > c.higR', 2, 0],
    ['timed-off-exclusive', 'S50', 'mPric >= c.higR', 'mPric > c.higR', 2, 1],
    ['timed-no-forced-on', 'S50', '(a < hHrs || forceOn)', '(a < hHrs)'],
    ['timed-no-forced-off', 'S50', '!forceOff && (a < hHrs || forceOn)', '(a < hHrs || forceOn)'],
    ['no-ranking-fees', 'S51', ' + fFee(first, p)', '', 2, 'all'],
    ['threshold-only-fee-not-subtracted', 'S52', '(pric - fee)', '(pric)', 2, 0],
    ['timed-fee-not-subtracted', 'S52', '(pric - fee)', '(pric)', 2, 1],
    ['no-startup-timer', 'S53', 't_hd = Timer.set(1000, true, fcTm);', ''],
    ['no-periodic-timer', 'S53', 'Timer.set(_.freq * 1000, true, loop);', ''],
    ['early-periodic-timer', 'S53', 'Timer.set(_.freq * 1000, true, loop);', 'Timer.set(60000, true, loop);'],
    ['late-periodic-timer', 'S53', 'Timer.set(_.freq * 1000, true, loop);', 'Timer.set(600000, true, loop);'],
    ['one-shot-periodic-timer', 'S53', 'Timer.set(_.freq * 1000, true, loop);', 'Timer.set(_.freq * 1000, false, loop);'],
    ['one-shot-time-check', 'S53', 'Timer.set(1000, true, fcTm)', 'Timer.set(1000, false, fcTm)'],
    ['ignore-update-minute', 'S53', 'updD: Math.floor(Math.random() * 46)', 'updD: 0'],
    ['wrong-price-country', 'S54', 'url += c.cnty + "&start="', 'url += "ee" + "&start="'],
    ['wrong-forecast-horizon', 'S54', 'url = url + c.tPer + "&latitude="', 'url = url + 1 + "&latitude="'],
    ['swapped-forecast-coordinates', 'S54', 'loc.lat + "&longitude=" + loc.lon', 'loc.lon + "&longitude=" + loc.lat'],
    ['heating-autostart-disabled', 'S55', 'id: _.sId, config: { enable: true }', 'id: _.sId, config: { enable: false }'],
    ['watchdog-autostart-disabled', 'S55', 'id: sId, config: { enable: true }', 'id: sId, config: { enable: false }'],
    ['watchdog-autostart-wrong-script', 'S55', 'id: sId, config: { enable: true }', 'id: 1, config: { enable: true }'],
    ['no-winter-peaks', 'S51', 'mnth >= 10 || mnth <= 2', 'false', 2, 'all'],
    ['exclude-march-peaks', 'S51', 'mnth >= 10 || mnth <= 2', 'mnth >= 10 || mnth < 2', 2, 'all'],
    ['exclude-november-peaks', 'S51', 'mnth >= 10 || mnth <= 2', 'mnth > 10 || mnth <= 2', 2, 'all'],
    ['early-imatra-summer-day', 'S51', 'hour < 8 || day === 6', 'hour < 7 || day === 6'],
    ['late-imatra-winter-night', 'S51', 'hour >= 23 || day === 6', 'hour >= 24 || day === 6'],
];
// Each variable package needs its own decisive detector. Uniform packages
// cannot be distinguished by rankings alone and are intentionally absent.
for (const [pack, rates] of [
    ['VORK2', '60.7, nRt: 35.1, dMRt: 60.7, hMRt: 35.1'],
    ['VORK4', '36.9, nRt: 21, dMRt: 36.9, hMRt: 21'],
    ['VORK5', '52.9, nRt: 30.3, dMRt: 81.8, hMRt: 47.4'],
    ['PARTN12', '72.4, nRt: 42, dMRt: 72.4, hMRt: 42'],
    ['PARTN12PL', '46.4, nRt: 27.1, dMRt: 46.4, hMRt: 27.1'],
]) mutations.push([pack + '-zero-fees', 'S51', '{ dRt: ' + rates + ' }',
    '{ dRt: 0, nRt: 0, dMRt: 0, hMRt: 0 }']);

function run(file) {
    return spawnSync(process.execPath, [suite, file], {
        env: { ...process.env, TZ: 'Europe/Tallinn' }, encoding: 'utf8', timeout: 20000,
        maxBuffer: 4 * 1024 * 1024,
    });
}
class StalePatternError extends Error {}

function mutate([name, , from, to, count = 1, occurrence = 0]) {
    const parts = source.split(from);
    if (parts.length - 1 !== count) {
        throw new StalePatternError('expected=' + count + ' actual=' + (parts.length - 1) +
            ' pattern=' + JSON.stringify(from));
    }
    let result = parts[0];
    for (let i = 0; i < count; i++) result += (occurrence === 'all' || occurrence === i ? to : from) + parts[i + 1];
    if (result === source) throw new Error(name + ': mutation did not change the source');
    return result;
}

const baseline = run(sourcePath);
if (baseline.status !== 0 || baseline.error) {
    console.error('BASELINE FAILED', baseline.error?.message || baseline.stderr ||
        baseline.stdout.split('\n').filter(line => /^(FAIL |.*SPEC FAILURES)/.test(line)).join('\n') || baseline.stdout.slice(-1000));
    process.exit(1);
}
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smart-heating-mutations-'));
let unresolved = 0;
try {
    for (const mutation of mutations) {
        const [name, intended] = mutation;
        try {
            const file = path.join(dir, name + '.js');
            fs.writeFileSync(file, mutate(mutation));
            const result = run(file);
            const failures = result.stdout.split('\n').filter(line => line.startsWith('FAIL '));
            const detectors = [...new Set(failures.map(line => line.split(' ')[1]))];
            const intendedAssertion = failures.some(line => line.startsWith('FAIL ' + intended + ' ') &&
                line.includes('"kind":"AssertionError"'));
            let status;
            if (result.error || result.signal || result.stderr || (!/SPEC FAILURES\s*$/.test(result.stdout) && result.status !== 0)) {
                status = 'ERROR';
            } else if (result.status === 0) {
                status = 'SURVIVED';
            } else if (intendedAssertion) {
                status = 'KILLED';
            } else {
                status = 'REVIEW';
            }
            if (status !== 'KILLED') unresolved++;
            console.log(status + ' ' + name + ' intended=' + intended + ' detected=' + (detectors.join(',') || 'none'));
            if (status === 'ERROR') console.log(result.error?.message || result.stderr || result.stdout.slice(-1000));
        } catch (error) {
            unresolved++;
            console.log((error instanceof StalePatternError ? 'STALE' : 'ERROR') + ' ' + name +
                ' intended=' + intended + ' -- ' + error.message);
        }
    }
} finally {
    fs.rmSync(dir, { recursive: true, force: true });
}
console.log(mutations.length - unresolved + '/' + mutations.length + ' mutants rejected by their intended behavioral scenarios');
process.exitCode = unresolved ? 1 : 0;
