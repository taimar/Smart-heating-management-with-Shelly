// Requirement suite for SmartHeatingWithShelly.js using simulated device RPCs.
// Legacy cases drive callbacks explicitly; S53-S56 exercise registered timers.
// Run: TZ=Europe/Tallinn node tests/spec.js <path-to-script>
const fs = require("fs");
const vm = require("vm");
const assert = require("assert/strict");
const SRC = fs.readFileSync(process.argv[2], "utf8");

const RealDate = global.Date;
const EVE = { // fetch instants: the evening before the target day, 23:30 local
    normal: "2026-01-13T23:30:00+02:00", // target Wed Jan 14 (24h)
    spring: "2026-03-28T23:30:00+02:00", // target Sun Mar 29 (23h)
    autumn: "2026-10-24T23:30:00+03:00", // target Sun Oct 25 (25h)
};
let FIXED_MS = new RealDate(EVE.normal).getTime();
class Date extends RealDate {
    constructor(...a) { a.length === 0 ? super(W ? W.now : FIXED_MS) : super(...a); }
    static now() { return W ? W.now : FIXED_MS; }
    setHours(...a) {
        if (W && W.noDateMutation) throw new Error("Date.setHours unavailable");
        return super.setHours(...a);
    }
    setDate(...a) {
        if (W && W.noDateMutation) throw new Error("Date.setDate unavailable");
        return super.setDate(...a);
    }
}

// ---- world ----
let W;
function freshWorld() {
    return {
        kvs: {}, schedules: [], deleted: [], nextId: 5, nextScriptId: 9, calls: [],
        scripts: [{ id: 3, name: "watchdog" }], running: { 3: true }, scriptEnabled: {},
        vcs: [], vDeleted: [], http: null, fail: {}, lastUrl: null,
        putCode: 0, ignoreKeys: false, relayConfigs: [], kvsWrites: [], addAttempts: [],
        device: { gen: 2, app: "Plus1PM", ver: "1.4.4" },
        sysConfig: { location: { lat: 59.44, lon: 24.75 } },
        now: FIXED_MS, unixtime: FIXED_MS / 1000,
    };
}
const prints = [];
function print(...a) { prints.push(a.join(" ")); }
function atob(b) { return Buffer.from(b, "base64").toString("latin1"); }
const Shelly = {
    getCurrentScriptId: () => 1,
    getDeviceInfo: () => W.device,
    getComponentConfig: (n, id) => {
        if (n === "sys") return W.sysConfig;
        if (n === "switch") return W.relayConfig;
        if (n === "script" && id === 1) return { enable: W.scriptEnabled[id] ?? true };
        if (n === "script" && id !== 1) {
            const script = W.scripts.find(s => s.id === id);
            return script ? { name: script.name, enable: W.scriptEnabled[id] ?? true } : null;
        }
        return { enable: true };
    },
    getComponentStatus: (n, id) => {
        if (n === "sys") return { unixtime: W.unixtime };
        if (n === "script" && id !== undefined && id !== 1) {
            const ex = W.scripts.find(s => s.id === id);
            return ex ? { running: !!W.running[id], mem_used: 1, mem_peak: 2 } : null;
        }
        return { running: true, mem_used: 1, mem_peak: 2 };
    },
    call: (m, p, cb, ud) => {
        W.calls.push({ method: m, params: p });
        const done = (r, e, s) => { if (W.observe) W.observe(); if (cb) cb(r, e || 0, s || "", ud); };
        if (m === "Virtual.Add") W.addAttempts.push(p.type + ":" + p.id);
        if (W.fail[m] && (typeof W.fail[m] !== "function" || W.fail[m](p))) return done(null, -1, "forced failure");
        switch (m) {
            case "KVS.Get": return W.kvs[p.key] !== undefined ? done({ value: W.kvs[p.key], etag: kvTag(W.kvs[p.key]) }, 0) : done(null, -105, "not found");
            case "KVS.set": case "KVS.Set": {
                if (p.etag !== undefined && (W.kvs[p.key] === undefined || p.etag !== kvTag(W.kvs[p.key]))) return done(null, -1, "etag mismatch");
                W.kvsWrites.push(p.key); W.kvs[p.key] = p.value; return done({ etag: kvTag(p.value) }, 0);
            }
            case "HTTP.GET": { W.lastUrl = p.url; const r = W.http(p); return done(r[0], r[1], ""); }
            case "Switch.SetConfig": W.relayConfigs.push(p.config); W.relayConfig = Object.assign({}, p.config); return done({}, 0);
            case "Schedule.Delete": {
                const i = W.schedules.findIndex(s => s.id === p.id);
                if (i === -1) return done(null, -103, "no such schedule");
                W.deleted.push(p.id); W.schedules.splice(i, 1); return done({}, 0);
            }
            case "Schedule.Create": {
                const id = W.nextId++;
                W.schedules.push({ id, enable: p.enable, timespec: p.timespec, calls: p.calls });
                return done(W.createResponse === undefined ? { id } : W.createResponse, 0);
            }
            case "Schedule.List": return done(W.listResponse === undefined ? { jobs: W.schedules.map(s => Object.assign({}, s)) } : W.listResponse, 0);
            case "Schedule.Update": {
                const job = W.schedules.find(s => s.id === p.id);
                if (!job) return done(null, -105, "no such schedule");
                Object.assign(job, p);
                return done({ id: p.id }, 0);
            }
            case "Script.List": return done({ scripts: W.scripts.slice() }, 0);
            case "Script.Create": { const id = W.nextScriptId++; W.scripts.push({ id, name: p.name }); W.running[id] = false; return done({ id }, 0); }
            case "Script.Stop": W.running[p.id] = false; return done({}, 0);
            case "Script.Start": W.running[p.id] = true; return done({}, 0);
            case "Script.SetConfig": {
                if ("enable" in p.config) W.scriptEnabled[p.id] = p.config.enable;
                return done({ id: p.id }, 0);
            }
            case "Script.PutCode": W.wdCode = p.code; W.putCode++; return done({ id: p.id }, 0);
            case "Shelly.GetComponents": {
                // models a keys-capable, PAGINATED firmware: filters by p.keys, pages by p.offset
                let list = W.vcs.slice();
                if (W.hiddenStatusKey && p.include && p.include.includes("status")) list = list.filter(v => v.key !== W.hiddenStatusKey);
                if (p.keys && !W.ignoreKeys) list = list.filter(v => p.keys.indexOf(v.key) !== -1);
                const ps = W.pageSize || 1000;
                const off = p.offset || 0;
                const components = list.slice(off, off + ps).map(v => {
                    const entry = { key: v.key };
                    if (!p.include || p.include.includes("status")) entry.status = v.status;
                    if (!p.include || p.include.includes("config")) entry.config = v.config;
                    return entry;
                });
                const response = { components, total: list.length, offset: off };
                if ("componentTotal" in W) {
                    if (W.componentTotal === undefined) delete response.total;
                    else response.total = W.componentTotal;
                }
                return done(response, 0);
            }
            case "Virtual.Delete": {
                W.vDeleted.push(p.key);
                W.vcs = W.vcs.filter(v => v.key !== p.key);
                return done({}, 0);
            }
            case "Group.GetConfig": {
                const group = W.vcs.find(v => v.key === "group:" + p.id);
                return group ? done(group.config, 0) : done(null, -105, "Bad id=" + p.id);
            }
            case "Virtual.Add": {
                if (W.vcs.some(v => v.key === p.type + ":" + p.id)) return done(null, -103, "Component already exists");
                if (W.ghostAdd === p.type + ":" + p.id) return done({ id: p.id }, 0);
                W.vcs.push({ key: p.type + ":" + p.id, config: p.config, status: { value: p.config.default_value } });
                let response = { id: p.id };
                if (p.type === "group" && W.groupCreateResponse) response = W.groupCreateResponse;
                if (p.type !== "group" && W.controlCreateResponse !== undefined) response = W.controlCreateResponse;
                return done(response, 0);
            }
            case "Group.Set": {
                const group = W.vcs.find(v => v.key === "group:" + p.id);
                if (!group) return done(null, -105, "Bad id=" + p.id);
                group.status = { value: p.value.slice() };
                return done({}, 0);
            }
            default: throw new Error("unstubbed: " + m);
        }
    },
};
// Each candidate runs in its own VM context. A hung parser or loop becomes a
// scenario failure instead of stopping the rest of the suite.
// RPC callbacks and one-shot timers always run through the queue. Bare boot()
// drains it after fcTm()/loop(); explicitStepping leaves draining to the case.
function boot(explicitStepping, options = {}) {
    const autoDrain = !explicitStepping;
    const world = W, queue = [], timers = new Map();
    let now = 0, nextTimer = 0, rpcCount = 0, rpcPeak = 0, timerPeak = 0;
    const scriptId = options.scriptId ?? 1;
    let active = true;
    W.running[scriptId] = true;
    const asyncShelly = Object.assign({}, Shelly, {
        getCurrentScriptId: () => scriptId,
        getComponentConfig: (name, id) => name === "script" && id === scriptId
            ? { enable: W.scriptEnabled[id] ?? true } : Shelly.getComponentConfig(name, id),
        getComponentStatus: (name, id) => name === "script" && id === scriptId
            ? { running: active, mem_used: 1, mem_peak: 2 } : Shelly.getComponentStatus(name, id),
        call: (method, params, cb, data) => {
            rpcCount++; rpcPeak = Math.max(rpcPeak, rpcCount);
            queue.push({ method, params, at: now + 10, run: () => {
                Shelly.call(method, params, (res, err, msg) => {
                    if (!cb) { rpcCount--; return; }
                    queue.push({ method: method + ":callback", at: now, run: () => {
                        rpcCount--; cb(res, err, msg, data);
                    } });
                });
            } });
        },
    });
    const fakeTimer = {
        set: (ms, rep, cb, data) => {
            const id = ++nextTimer;
            if (rep && ms <= 0) throw new Error("Repeating timer needs a positive interval");
            const event = { id, at: now + ms, rep, run: () => {
                if (!timers.has(id)) return;
                if (rep) event.at = now + ms;
                else timers.delete(id);
                cb(data);
            } };
            timers.set(id, event); timerPeak = Math.max(timerPeak, timers.size);
            if (!rep) queue.push(event);
            return id;
        },
        clear: id => {
            timers.delete(id);
            const index = queue.findIndex(event => event.id === id);
            if (index !== -1) queue.splice(index, 1);
        },
    };
    const fakeMath = Object.create(Math);
    fakeMath.random = () => options.random ?? 0;
    const ctx = vm.createContext({ Shelly: asyncShelly,
        Timer: fakeTimer, Math: fakeMath, print, atob, Date, console: { log: print } });
    const t = {
        err: null,
        drive: code => {
            if (t.err || !active) return;
            try { return vm.runInContext(code, ctx, { timeout: 3000 }); }
            catch (e) { t.err = e; return undefined; }
        },
    };
    function moveTo(target) {
        const delta = target - now;
        world.now += delta;
        // A device awaiting time synchronization continues to report no time.
        if (world.unixtime > 0) world.unixtime = world.now / 1000;
        now = target;
    }
    function nextEvent(includeRepeating) {
        queue.sort((a, b) => a.at - b.at);
        let event = queue[0];
        if (includeRepeating) {
            for (const timer of timers.values()) {
                if (timer.rep && (!event || timer.at < event.at)) event = timer;
            }
        }
        return event;
    }
    function runEvent(event) {
        const index = queue.indexOf(event);
        if (index !== -1) queue.splice(index, 1);
        moveTo(Math.max(now, event.at));
        ctx.runCallback = event.run;
        t.drive("runCallback()");
    }
    // Explicit-step cases drain work already requested. They do not fire the
    // recurring clock: advanceBy/advanceTo are the timer-driven entry points.
    t.flush = () => {
        let steps = 0;
        while (queue.length && !t.err && steps++ < 500) runEvent(nextEvent(false));
        if (queue.length && !t.err) t.err = new Error("Asynchronous work did not settle");
        return { rpcPeak, timerPeak };
    };
    t.step = () => { if (queue.length && !t.err) runEvent(nextEvent(false)); };
    t.advanceBy = duration => {
        assert.ok(Number.isFinite(duration) && duration >= 0, "nonnegative finite duration");
        const target = now + duration;
        let event, steps = 0;
        while (!t.err && (event = nextEvent(true)) && event.at <= target) {
            if (++steps > 10000) { t.err = new Error("Clock advancement exceeded event limit"); break; }
            runEvent(event);
        }
        if (!t.err) moveTo(target);
        return { rpcPeak, timerPeak };
    };
    t.advanceTo = instant => t.advanceBy(instant - world.now);
    // Model a device wall-clock correction in legacy cases that explicitly
    // invoke a tick. This expires prices through the real update predicate,
    // without touching private script state or firing intervening timers.
    t.jumpToNextDay = () => {
        const next = new RealDate(world.now);
        next.setDate(next.getDate() + 1);
        next.setHours(23, 59, 0, 0);
        world.now = next.getTime();
        world.unixtime = world.now / 1000;
    };
    t.stop = () => { active = false; world.running[scriptId] = false; queue.length = 0; timers.clear(); };
    t.pending = () => queue.map(e => e.method || "timer");
    runtimes.push(t);
    t.drive(SRC);
    t.fcTm = () => { const r = t.drive("fcTm()"); if (autoDrain) t.flush(); return r; };
    t.loop = () => { const r = t.drive("loop()"); if (autoDrain) t.flush(); return r; };
    return t;
}

// ---- request-adaptive price server: honors whatever window the script asks for ----
function priceServer(priceFn, opts) {
    opts = opts || {};
    return (params) => {
        const mSt = params.url.match(/start=([^&]+)/), mEn = params.url.match(/end=([^&]+)/);
        const st = RealDate.parse(decodeURIComponent(mSt[1]));
        const en = RealDate.parse(decodeURIComponent(mEn[1]));
        const step = (opts.hourly ? 3600 : 900) * 1000;
        const incl = ((en - st) % 3600000) !== 0; // a not-whole-hours span means an inclusive end timestamp
        let rows = [];
        for (let t = st; incl ? t <= en : t < en; t += step) {
            rows.push('"' + (t / 1000) + '";"x";"' + priceFn(new RealDate(t).getHours(), t).toFixed(2).replace(".", ",") + '"');
        }
        const csv = '"h";"d";"p"\n' + rows.join("\n") + "\n";
        return [{ code: 200, body_b64: Buffer.from(csv, "latin1").toString("base64") }, 0];
    };
}

// ---- independent oracle (fee-free packages only) ----
function dayHours(eveIso) { // local hour labels of the target day, deduplicated
    const d = new RealDate(new RealDate(eveIso).getTime() + 3600 * 1000); // inside the target day
    const t = new RealDate(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0);
    const end = new RealDate(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0, 0, 0);
    const hrs = [];
    for (let ms = t.getTime(); ms < end.getTime(); ms += 3600 * 1000) {
        const h = new RealDate(ms).getHours();
        if (hrs.indexOf(h) === -1) hrs.push(h);
    }
    return hrs;
}
function cheapest(eveIso, tPer, hTim, priceFn) { // expected hour set, fee 0, thresholds inactive
    const hrs = dayHours(eveIso);
    const out = [];
    const nPer = Math.ceil(24 / tPer);
    for (let i = 0; i < nPer; i++) {
        const grp = hrs.filter(h => Math.floor(h / tPer) === i);
        grp.sort((a, b) => priceFn(a) - priceFn(b) || b - a);
        for (const h of grp.slice(0, hTim)) out.push(h);
    }
    return out.sort((a, b) => a - b).join(",");
}
function specHours(t) { return t ? t.split(" ")[2] : null; } // hour field of a timespec
const PRICE2 = h => (h * 5) % 24 + 10; // different ordering exposes stale schedules
const PRICE = h => (h * 7) % 24 + 10; // distinct per hour, all far from lowR=1 / higR=300
const FALLBACK = "0,1,2,3,4,5,6,7,8,9"; // documented offline hours for tPer 24, hTim 10
function conf(over) {
    const b = { TimePeriod: 24, HeatingTime: 10, IsForecastUsed: false, EnergyProvider: "NONE",
        AlwaysOnPrice: 1, AlwaysOffPrice: 300, InvertedRelay: false, RelayId: 0,
        Country: "ee", HeatingCurve: 0, ManualKVS: true };
    return JSON.stringify(Object.assign(b, over || {}));
}
const VC_SET = [
    ["group:200", "Smart Heating", null], ["enum:200", "Heating Period (h)", "12"],
    ["number:200", "Min On Time (h/period)", 5], ["enum:201", "Network Package", "NONE"],
    ["number:201", "Heat On (min price)", 1], ["number:202", "Heat Off (max price)", 300],
    ["boolean:201", "Inverted Relay", false], ["enum:202", "Market Price Country", "ee"],
    ["boolean:200", "Forecast Heat", false], ["number:203", "Forecast Impact +/-", 0],
];

const OLD_BACKUP = JSON.stringify(["12", 5, false, "NONE", 1, 300, true, "ee", 0]);

const CONTROL_DEFAULTS = {
    "enum:200": "24", "number:200": 10, "enum:201": "VORK2", "number:201": 1,
    "number:202": 300, "boolean:201": false, "enum:202": "ee",
    "boolean:200": false, "number:203": 0,
};

const groupCall = call => call.method.startsWith("Group.") ||
    call.method === "Virtual.Add" && call.params.type === "group";

function controlFixture(overrides = {}) {
    return VC_SET.map(([key, name, value]) => ({ key, config: { name },
        status: { value: Object.hasOwn(overrides, key) ? overrides[key] : value } }));
}

function completeGroup() {
    const group = W.vcs.find(v => v.key === "group:200");
    const expected = ["enum:200", "number:200", "boolean:200", "number:203", "enum:201",
        "number:201", "number:202", "boolean:201", "enum:202"].sort();
    return group && group.config.name === "Smart Heating" && Array.isArray(group.status.value) &&
        JSON.stringify(group.status.value.slice().sort()) === JSON.stringify(expected);
}

function manyForeign(n) {
    const a = [];
    for (let i = 0; i < n; i++) a.push({ key: "bthomesensor:" + (200 + i), config: { name: "BT sensor " + i }, status: { value: i } });
    return a;
}

function vcWorld() {
    W = freshWorld();
    W.device = { gen: 3, app: "Mini1G3", ver: "1.4.4" };
    W.http = priceServer(PRICE);
}

function changeCsv(transform) {
    return p => {
        const r = priceServer(PRICE)(p);
        r[0].body_b64 = Buffer.from(transform(atob(r[0].body_b64)), "latin1").toString("base64");
        return r;
    };
}

function existingHeating() {
    W.kvs.SmartHeatingSys1 = JSON.stringify({ ExistingSchedule: 41, Version: 5 });
    W.schedules = [{ id: 41, enable: true, timespec: "0 0 1 * * *",
        calls: [{ method: "Switch.Set", params: { id: 0, on: true } }] }];
    W.relayConfig = { auto_on: false, auto_off: true, auto_off_delay: 3610 };
}

function installControls() {
    return VC_SET.slice(1).map(e => ({ key: e[0], config: { name: e[1] },
        status: { value: e[0] === "boolean:201" ? true : e[2] } }));
}

let failures = 0, checks = 0;
function check(name, cond, detail) {
    checks++;
    const runtimeError = runtimes.find(runtime => runtime.err)?.err;
    if (cond && !runtimeError) console.log("PASS", name);
    else {
        failures++;
        const failure = runtimeError ? { kind: "RuntimeError", message: String(runtimeError) }
            : detail?.kind ? detail : { kind: "AssertionError", detail };
        console.log("FAIL", name, "--", JSON.stringify(failure));
    }
}

// A scenario owns every runtime it boots, including abandoned boots in restart
// tests. Errors from any of them fail the scenario instead of being overwritten.
const scenarios = [];
let runtimes = [];
function scenario(name, run) { scenarios.push({ name, run }); }
function runScenario({ name, run }) {
    FIXED_MS = new RealDate(EVE.normal).getTime();
    W = freshWorld();
    prints.length = 0;
    runtimes = [];
    const before = checks;
    try {
        run();
        for (const runtime of runtimes) assert.ifError(runtime.err);
        if (checks === before) check(name, true);
    } catch (error) {
        check(name, false, { kind: error?.operator === "ifError" ? "RuntimeError" : error?.name || "ThrownValue",
            message: error?.message || String(error) });
    }
}

function expectSchedule(runtime, hours, options = {}) {
    assert.ifError(runtime.err);
    assert.equal(W.schedules.length, hours === null ? 0 : 1, "schedule count");
    if (hours === null) return;
    const job = W.schedules[0];
    assert.equal(job.timespec, "0 0 " + hours + " * * *", "complete daily cron expression");
    assert.equal(job.enable, true, "schedule enabled");
    assert.deepEqual(JSON.parse(JSON.stringify(job.calls)), [{
        method: "Switch.Set", params: { id: options.relayId ?? 0, on: !options.inverted },
    }], "scheduled relay command");
}

// =====================================================================
scenario("S4 price windows and schedules follow the local day across DST", () => {
    let t;
    for (const [name, eve] of [["spring 23h", EVE.spring], ["autumn 25h", EVE.autumn]]) {
        FIXED_MS = new RealDate(eve).getTime();
        W = freshWorld();
        W.noDateMutation = true; //models a Shelly engine without mutating Date methods
        W.kvs["SmartHeatingConf1"] = conf();
        W.http = priceServer(PRICE);
        t = boot();
        t.fcTm();
        const inDay = new RealDate(new RealDate(eve).getTime() + 3600 * 1000); // inside the target day
        const d0 = new RealDate(inDay.getFullYear(), inDay.getMonth(), inDay.getDate(), 0, 0, 0).getTime();
        const d1 = new RealDate(inDay.getFullYear(), inDay.getMonth(), inDay.getDate() + 1, 0, 0, 0).getTime();
        const mSt = W.lastUrl && W.lastUrl.match(/start=([^&]+)/), mEn = W.lastUrl && W.lastUrl.match(/end=([^&]+)/);
        const rSt = mSt ? RealDate.parse(decodeURIComponent(mSt[1])) : NaN;
        const rEn = mEn ? RealDate.parse(decodeURIComponent(mEn[1])) : NaN;
        check("S4 " + name + " window starts at local midnight without Date mutation", !t.err && rSt === d0, [String(t.err || ""), W.lastUrl]);
        check("S4 " + name + " window ends at next local midnight without Date mutation", !t.err && (rEn === d1 || rEn === d1 - 900 * 1000), [String(t.err || ""), W.lastUrl]);
        const got = specHours(W.schedules[0] && W.schedules[0].timespec);
        check("S4 " + name + " cheapest real hours, no duplicates", got === cheapest(eve, 24, 10, PRICE), got);
    }

    FIXED_MS = new RealDate("2026-01-13T22:30:00+02:00").getTime();
    W = freshWorld();
    W.noDateMutation = true;
    W.kvs["SmartHeatingConf1"] = conf();
    W.http = priceServer(PRICE);
    t = boot();
    t.fcTm();
    {
        const mSt = W.lastUrl && W.lastUrl.match(/start=([^&]+)/);
        const rSt = mSt ? RealDate.parse(decodeURIComponent(mSt[1])) : NaN;
        const today = new RealDate("2026-01-13T00:00:00+02:00").getTime();
        check("S4 before 23:00 uses the current local day without Date mutation",
            !t.err && rSt === today && W.schedules.length === 1, [String(t.err || ""), W.lastUrl]);
    }
    FIXED_MS = new RealDate(EVE.normal).getTime();
});

// S6. Apply the user's minimum only when forecast demand exists; cap to the period.
// The warm case keeps a two-hour minimum to catch applying it without demand;
// S49's zero-minimum warm case instead detects a missing weather clamp.
for (const [name, temperature, hours] of [
    ["warm forecast does not apply the two-hour user minimum", 20, null],
    ["mild forecast retains the user minimum", 10, "0,4"],
    ["cold forecast is capped to the current period", -40, "0,1,2,3,4,5"],
]) {
    scenario("S6 " + name, () => {
        W.kvs.SmartHeatingConf1 = conf({ TimePeriod: 6, HeatingTime: 2, IsForecastUsed: true });
        W.http = p => p.url.includes("open-meteo")
            ? [{ code: 200, body: JSON.stringify({ hourly: { apparent_temperature: [temperature] } }) }, 0]
            : priceServer(PRICE)(p);
        const runtime = boot(); runtime.fcTm();
        expectSchedule(runtime, hours);
    });
}

scenario("S6b A missing device location must not crash and must not end heating management", () => {
    let t;
    W = freshWorld();
    W.sysConfig = { location: null };
    W.kvs["SmartHeatingConf1"] = conf({ IsForecastUsed: true });
    W.http = priceServer(PRICE);
    t = boot();
    t.fcTm();
    check("S6b no crash without location, fallback schedule exists", !t.err && specHours(W.schedules[0] && W.schedules[0].timespec) === FALLBACK,
        [String(t.err || ""), W.schedules[0]]);
});

scenario("S7 A failed watchdog lookup must not prevent later price refreshes", () => {
    let t;
    W = freshWorld(); W.kvs.SmartHeatingConf1 = conf(); W.http = priceServer(PRICE);
    W.fail["Script.List"] = true;
    t = boot(); t.fcTm();
    delete W.fail["Script.List"];
    W.http = priceServer(PRICE2); t.jumpToNextDay(); t.loop();
    expectSchedule(t, cheapest(EVE.normal, 24, 10, PRICE2));
});

scenario("S7b A transient component read must never replace user settings with defaults", () => {
    let t;

    W = freshWorld();
    W.device = { gen: 3, app: "Mini1G3", ver: "1.4.4" };
    W.kvs["SmartHeatingSys1"] = JSON.stringify({ LastCalculation: 0, ExistingSchedule: 0, Version: 4.9, VcInstalled: true });
    W.vcs = controlFixture();
    W.http = priceServer(PRICE);
    W.fail["Shelly.GetComponents"] = true;
    t = boot();
    t.fcTm();
    check("S7b failed VC read cannot apply defaults", !t.err && W.schedules.length === 0 &&
        W.relayConfigs.length === 0 && W.addAttempts.length === 0);
    delete W.fail["Shelly.GetComponents"];
    t.loop();
    {
        const userExp = cheapest(EVE.normal, 12, 5, PRICE);
        expectSchedule(t, userExp);
    }
});

scenario("S7c complete controls recover without SystemData; missing controls preserve heating", () => {
    let t;
    W = freshWorld();
    W.device = { gen: 3, app: "Mini1G3", ver: "1.4.4" };
    W.vcs = controlFixture();
    W.http = priceServer(PRICE);
    t = boot();
    t.fcTm();
    check("S7c missing SystemData: complete controls recover immediately",
        W.schedules.length === 1 && specHours(W.schedules[0].timespec) === cheapest(EVE.normal, 12, 5, PRICE),
        W.schedules.map(s => s.timespec));
    check("S7c missing SystemData: recovery neither adds nor deletes controls",
        W.vcs.length === VC_SET.length && W.vDeleted.length === 0, [W.vcs.length, W.vDeleted]);

    // A missing optional control must not replace an installed inverted-relay
    // configuration with defaults or stale KVS settings, even across retries.
    for (const savedConfig of [undefined, conf({ ManualKVS: false })]) {
        W = freshWorld();
        W.device = { gen: 3, app: "Mini1G3", ver: "1.4.4" };
        if (savedConfig !== undefined) W.kvs.SmartHeatingConf1 = savedConfig;
        W.kvs.SmartHeatingSys1 = JSON.stringify({ ExistingSchedule: 41, Version: 4.9 });
        const controls = controlFixture({ "boolean:201": true, "number:200": 2 });
        W.vcs = controls.filter(e => e.key !== "number:203");
        const expectedHours = cheapest(EVE.normal, 12, 2, PRICE);
        W.schedules = [{ id: 41, timespec: "0 0 " + expectedHours + " * * *",
            calls: [{ method: "Switch.Set", params: { id: 0, on: false } }] }];
        W.http = priceServer(PRICE);
        const oldSchedules = JSON.stringify(W.schedules);
        const oldKvs = JSON.stringify(W.kvs);
        const label = savedConfig === undefined ? "no saved config" : "stale saved config";
        t = boot();
        t.fcTm();
        const bootError = t.err;
        t.loop();
        check("S7c missing control, " + label + ": schedule and relay preserved on retries",
            !bootError && !t.err && JSON.stringify(W.schedules) === oldSchedules &&
            W.deleted.length === 0 && W.relayConfigs.length === 0,
            [String(bootError || t.err || ""), W.schedules, W.relayConfigs]);
        check("S7c missing control, " + label + ": stored configuration preserved",
            JSON.stringify(W.kvs) === oldKvs, W.kvs);
        W.vcs = controls;
        t.loop();
        const schedule = W.schedules[0];
        const relay = W.relayConfigs[0];
        check("S7c restored control, " + label + ": normal retry restores user heating hours",
            !t.err && W.schedules.length === 1 && schedule.id === 41 &&
            W.deleted.indexOf(41) === -1 && specHours(schedule.timespec) === expectedHours,
            [String(t.err || ""), W.schedules]);
        check("S7c restored control, " + label + ": inverted relay settings restored",
            schedule && schedule.calls[0].params.on === false &&
            relay && relay.auto_on === true && relay.auto_off === false,
            [schedule, relay]);
    }
});

scenario("S7d A stale persisted schedule ID can be safely replaced", () => {
    let t;
    // A stale persisted schedule id is safe to replace once Schedule.List confirms it is absent.
    W = freshWorld();
    W.kvs["SmartHeatingConf1"] = conf();
    W.kvs["SmartHeatingSys1"] = JSON.stringify({ LastCalculation: 0, ExistingSchedule: 44, Version: 5 });
    W.http = priceServer(PRICE);
    t = boot();
    t.fcTm();
    check("S7d stale schedule id is recovered", !t.err && W.schedules.length === 1 && W.schedules[0].id !== 44 &&
        JSON.parse(W.kvs.SmartHeatingSys1).ExistingSchedule === W.schedules[0].id, W.schedules);
});

scenario("S8 A foreign control on a reserved key is never deleted or adopted", () => {
    let t;
    W = freshWorld(); W.device = { gen: 3, app: "Mini1G3", ver: "1.4.4" };
    W.vcs = [{ key: "enum:200", config: { name: "Thermostat Mode" }, status: { value: "eco" } }];
    W.http = priceServer(PRICE);
    t = boot(); t.fcTm();
    check("S8 conflicting control is left untouched without scheduling unverified settings", !t.err &&
        W.vDeleted.length === 0 && W.addAttempts.length === 0 && W.vcs.length === 1 &&
        W.schedules.length === 0 && W.relayConfigs.length === 0 && Object.keys(W.kvs).length === 0);
});

scenario("S9 Unsupported packages are reported without rewriting user settings or applying guessed settings", () => {
    let t;
    for (const badPackage of [{ dRt: 60.7 }, "REMOVED_PACKAGE"]) {
        W = freshWorld();
        const saved = conf({ EnergyProvider: badPackage });
        W.kvs.SmartHeatingConf1 = saved;
        W.http = priceServer(PRICE);
        const start = prints.length;
        t = boot(); t.fcTm(); t.loop();
        check("S9 invalid package " + JSON.stringify(badPackage) + " is preserved without changing heating",
            !t.err && W.kvs.SmartHeatingConf1 === saved && W.schedules.length === 0 && W.relayConfigs.length === 0 &&
            prints.slice(start).some(line => line.includes("EnergyProvider")), [String(t.err || ""), W.kvs]);
        W.kvs.SmartHeatingConf1 = conf();
        t.loop();
        check("S9 corrected package resumes normal scheduling", !t.err && W.schedules.length === 1 && specHours(W.schedules[0].timespec) === cheapest(EVE.normal, 24, 10, PRICE));
    }
});

// These packages share threshold logic, but each name must remain supported.
// VORK1 is exercised in S52 and NONE throughout the suite.
for (const pack of ["PARTN24", "PARTN24PL", "PAMATA1", "SPECIAL1"]) {
    scenario("S9 supported flat package " + pack + " preserves market-price ranking", () => {
        W.kvs.SmartHeatingConf1 = conf({ EnergyProvider: pack });
        W.http = priceServer(PRICE);
        const runtime = boot(); runtime.fcTm();
        expectSchedule(runtime, cheapest(EVE.normal, 24, 10, PRICE));
    });
}

// S10. Literal schedules preserve historical preference within each period.
// Include short final periods, fractional demand and oversized demand with enum strings.
for (const [period, heating, expected] of [
    [6, 10, "0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23"],
    ["6", 10, "0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23"],
    [4, 3, "0,1,2,4,5,6,8,9,10,12,13,14,16,17,18,21,22,23"],
    [5, 2, "0,1,5,6,10,11,15,16,21,22"],
    [11, 2, "0,1,11,12,22,23"],
    [11, 2.5, "0,1,2,11,12,13,22,23"],
    [6, 3, "0,1,2,6,7,8,12,13,14,21,22,23"],
    [12, 8, "0,1,2,3,4,5,6,7,12,13,14,15,16,17,21,22"],
    [24, 20, "0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,21,22"],
]) {
    scenario("S10 offline period=" + JSON.stringify(period) + ", demand=" + heating + " respects period boundaries", () => {
        W.kvs.SmartHeatingConf1 = conf({ TimePeriod: period, HeatingTime: heating });
        W.http = () => [null, -114];
        const runtime = boot(); runtime.fcTm();
        expectSchedule(runtime, expected);
    });
}

// S11. Devices with many dynamic components paginate Shelly.GetComponents.
// The script must read all pages: user settings apply, nothing foreign is touched.
for (const ignoreKeys of [false, true]) {
    scenario("S11 paginated controls apply user values and preserve foreign components, ignored keys=" + ignoreKeys, () => {
        vcWorld(); W.pageSize = 4; W.ignoreKeys = ignoreKeys;
        W.vcs = manyForeign(25).concat(controlFixture());
        const before = JSON.stringify(W.vcs);
        const runtime = boot(); runtime.fcTm();
        expectSchedule(runtime, cheapest(EVE.normal, 12, 5, PRICE));
        assert.equal(JSON.stringify(W.vcs), before, "existing components preserved");
        assert.equal(W.vDeleted.length, 0, "no component deletion");
    });
}

function watchdogWorld() {
    return { kvs: {
        SmartHeatingSys1: JSON.stringify({ ExistingSchedule: 71, Version: 4.9, LastCalculation: "attempt" }),
        SmartHeatingSys2: JSON.stringify({ ExistingSchedule: 72, Version: 4.9 }),
    }, schedules: [71, 72], failDel: {}, running: {}, calls: [], logs: [] };
}
function kvTag(value) {
    return require("crypto").createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function watchdogSandbox(code, w) {
    const queue = [];
    let handler;
    const S = {
        addStatusHandler: h => { handler = h; },
        getComponentStatus: (name, id) => ({ running: !!w.running[id] }),
        call: (method, params, cb, data) => {
            w.calls.push({ method, params });
            queue.push(() => {
                const done = (res, err = 0) => { if (cb) cb(res, err, err ? "forced failure" : "", data); };
                if (method === "KVS.Get") return w.kvs[params.key] === undefined ? done(null, -105)
                    : done({ value: w.kvs[params.key], etag: w.noEtag ? undefined : kvTag(w.kvs[params.key]) });
                if (method.toLowerCase() === "kvs.set") {
                    if (params.etag !== undefined && (w.kvs[params.key] === undefined || params.etag !== kvTag(w.kvs[params.key]))) return done(null, -1);
                    w.kvs[params.key] = params.value; return done({ etag: kvTag(params.value) });
                }
                if (method === "Schedule.Delete") {
                    if (w.failDel && w.failDel[params.id]) return done(null, -1);
                    const index = w.schedules.findIndex(job => (typeof job === "number" ? job : job.id) === params.id);
                    if (index === -1) return done(null, -103);
                    w.schedules.splice(index, 1); return done({});
                }
                throw new Error("unstubbed watchdog method " + method);
            });
        },
    };
    new Function("Shelly", "print", code)(S, (...args) => (w.logs || prints).push(args.join(" ")));
    return { fire: id => handler({ name: "script", id, delta: { running: false } }),
        step: () => { if (queue.length) queue.shift()(); },
        flush: () => { let count = 0; while (queue.length && count++ < 100) queue.shift()(); assert.equal(queue.length, 0); } };
}
const watchdogCopies = ["watchdog.js", "watchdog-min.js"].map(name =>
    [name, fs.readFileSync(require("path").join(__dirname, "../files", name), "utf8")]);
scenario("S12 watchdog deletes only the stopped script's schedule and retains failed IDs", () => {
    for (const [name, code] of watchdogCopies) {
        for (const failed of [false, true]) {
            const w = watchdogWorld(), sb = watchdogSandbox(code, w);
            w.failDel[71] = failed; sb.fire(1); sb.flush();
            assert.deepEqual(w.schedules, failed ? [71, 72] : [72], name);
            const saved = JSON.parse(w.kvs.SmartHeatingSys1);
            assert.equal(saved.ExistingSchedule, failed ? 71 : 0, name);
            assert.equal(saved.LastCalculation, "attempt", name);
        }
        const w = watchdogWorld(), sb = watchdogSandbox(code, w);
        sb.fire(1); sb.fire(2); sb.flush();
        assert.deepEqual(w.schedules, [], name);
        assert.equal(JSON.parse(w.kvs.SmartHeatingSys1).ExistingSchedule, 0, name);
        assert.equal(JSON.parse(w.kvs.SmartHeatingSys2).ExistingSchedule, 0, name);
    }
});
scenario("S12a installed watchdog matches the tested minified artifact", () => {
    W.kvs.SmartHeatingConf1 = conf(); W.http = priceServer(PRICE);
    const runtime = boot(); runtime.fcTm();
    assert.equal(W.wdCode.trim(), watchdogCopies[1][1].trim());
});

scenario("S13 A healthy watchdog needs no script RPCs; stopped code restarts without a rewrite", () => {
    let t;
    W = freshWorld();
    W.kvs["SmartHeatingConf1"] = conf();
    W.http = priceServer(PRICE);
    t = boot();
    t.fcTm();
    const healthyCycleStart = W.calls.length;
    t.jumpToNextDay();
    t.loop();
    assert.deepEqual(W.calls.slice(healthyCycleStart).filter(c =>
        ["Script.List", "Script.Start", "Script.Create", "Script.PutCode", "Script.SetConfig"].includes(c.method)),
        [], "a healthy watchdog needs no script RPCs during a cycle");
    const noRewriteWhileRunning = W.putCode === 1;
    W.running[3] = false;
    t.jumpToNextDay();
    t.loop();
    check("S13 watchdog is written once and restarted without a rewrite", noRewriteWhileRunning && W.putCode === 1 && W.running[3] === true,
        [W.putCode, W.running]);
});

scenario("S14 Every mid-row truncation must terminate, fall back, then recover next cycle", () => {
    let t;
    for (const lastRow of [false, true]) {
        const bad = [];
        const sample = priceServer(PRICE)({ url: "https://fixture/?start=2026-01-13T22:00:00Z&end=2026-01-14T22:00:00Z" });
        const rows = atob(sample[0].body_b64).trimEnd().split("\n");
        const rowLength = rows[lastRow ? rows.length - 1 : 1].length;
        for (let cut = 0; cut < rowLength; cut++) {
            W = freshWorld();
            W.kvs.SmartHeatingConf1 = conf();
            W.http = changeCsv(csv => {
                const start = lastRow ? csv.lastIndexOf("\n", csv.length - 2) + 1 : csv.indexOf("\n") + 1;
                return csv.slice(0, start + cut);
            });
            t = boot(); t.fcTm();
            const fallback = !t.err && W.schedules.length === 1 && specHours(W.schedules[0].timespec) === FALLBACK;
            W.http = priceServer(PRICE);
            t.loop();
            if (!fallback || t.err || W.schedules.length !== 1 || specHours(W.schedules[0].timespec) !== cheapest(EVE.normal, 24, 10, PRICE)) bad.push(cut);
        }
        check("S14 all truncation offsets in " + (lastRow ? "last" : "first") + " row terminate, fall back and recover", bad.length === 0, bad);
    }
});

const onlineCsvHours = cheapest(EVE.normal, 24, 10, PRICE);
for (const [name, response, hours] of [
    ["LF without final newline gives correct hours", changeCsv(csv => csv.replace(/\n$/, "")), onlineCsvHours],
    ["CRLF gives correct hours", changeCsv(csv => csv.replace(/\n/g, "\r\n")), onlineCsvHours],
    ["CRLF without final newline gives correct hours", changeCsv(csv => csv.trimEnd().replace(/\n/g, "\r\n")), onlineCsvHours],
    ["missing price quote falls back", changeCsv(csv => csv.replace(';"10,00"', ';"10,00')), FALLBACK],
    ["nonnumeric price falls back", changeCsv(csv => csv.replace('"10,00"', '"unknown"')), FALLBACK],
    ["infinite price falls back", changeCsv(csv => csv.replace('"10,00"', '"Infinity"')), FALLBACK],
    ["duplicate quarter with correct row count falls back", changeCsv(csv => { const rows = csv.split("\n"); rows[2] = rows[1]; return rows.join("\n"); }), FALLBACK],
    ["only six hours of quarters falls back", changeCsv(csv => csv.split("\n").slice(0, 25).join("\n") + "\n"), FALLBACK],
    ["missing quarter falls back", changeCsv(csv => { const rows = csv.split("\n"); rows.splice(2, 1); return rows.join("\n"); }), FALLBACK],
    ["hourly rows still require offline fallback", priceServer(PRICE, { hourly: true }), FALLBACK],
]) {
    scenario("S14 " + name, () => {
        W.kvs.SmartHeatingConf1 = conf(); W.http = response;
        const runtime = boot(); runtime.fcTm();
        expectSchedule(runtime, hours);
    });
}

scenario("S15 Interrupted installs pause once any controls exist; manual restoration resumes heating", () => {
    let t;
    // Each failing add leaves a different partial set, so exercise every control key.
    for (const key of VC_SET.slice(1).map(e => e[0])) {
        vcWorld();
        W.fail["Virtual.Add"] = p => p.type + ":" + p.id === key;
        t = boot(); t.fcTm();
        const survivors = JSON.stringify(W.vcs);
        const partial = W.vcs.length > 0;
        const count = W.addAttempts.length;
        t.loop();
        const bounded = W.addAttempts.length === count + (partial ? 0 : 1) && JSON.stringify(W.vcs) === survivors;
        delete W.fail["Virtual.Add"];
        t = boot(); t.fcTm();
        check("S15 failed " + key + (partial ? " remains paused across retry and restart" : " retries with all slots empty"),
            bounded && !t.err && W.vDeleted.length === 0 && (partial ?
                JSON.stringify(W.vcs) === survivors && W.schedules.length === 0 && W.addAttempts.length === count :
                completeGroup() && W.schedules.length === 1));
        if (partial) {
            // User restores missing controls explicitly; surviving controls remain unchanged.
            for (const e of VC_SET.slice(1)) {
                if (!W.vcs.some(v => v.key === e[0])) W.vcs.push({ key: e[0], config: { name: e[1] }, status: { value: e[2] } });
            }
            t.loop();
            check("S15 manual restoration after failed " + key + " resumes heating", !t.err &&
                W.schedules.length === 1 && W.addAttempts.length === count && W.vDeleted.length === 0);
        }
    }
    // Intentional deletion of all controls permits reinstall without deleting SystemData.
    vcWorld(); t = boot(); t.fcTm();
    const reinstallId = W.schedules[0].id;
    W.vcs = []; t = boot(); t.fcTm();
    check("S15 deleting all controls reinstalls defaults and updates the recorded schedule", !t.err &&
        completeGroup() && W.schedules.length === 1 && W.schedules[0].id === reinstallId && W.vDeleted.length === 0);
});

scenario("S16 A failed timer update may proceed only with a verified equivalent existing timer", () => {
    let t;
    for (const inverted of [false, true]) {
        for (const offline of [false, true]) {
            W = freshWorld(); W.kvs.SmartHeatingConf1 = conf({ InvertedRelay: inverted });
            W.http = offline ? () => [null, -114] : priceServer(PRICE);
            W.fail["Switch.SetConfig"] = true;
            W.relayConfig = { auto_on: inverted, auto_off: !inverted, auto_on_delay: 3610, auto_off_delay: 3610 };
            t = boot(); t.fcTm();
            check("S16 verified " + (inverted ? "inverted" : "normal") + " timer permits " + (offline ? "fallback" : "price") + " schedule",
                !t.err && W.schedules.length === 1 && W.schedules[0].calls[0].params.on === !inverted &&
                specHours(W.schedules[0].timespec) === (offline ? FALLBACK : cheapest(EVE.normal, 24, 10, PRICE)), W.schedules);
        }
    }
    for (const inverted of [false, true]) {
        for (const wrong of ["polarity", "delay", "unavailable"]) {
            W = freshWorld(); W.kvs.SmartHeatingConf1 = conf({ InvertedRelay: inverted });
            W.http = priceServer(PRICE); W.fail["Switch.SetConfig"] = true;
            W.relayConfig = { auto_on: inverted, auto_off: !inverted, auto_on_delay: 3610, auto_off_delay: 3610 };
            if (wrong === "polarity") W.relayConfig.auto_on = !inverted;
            if (wrong === "delay") W.relayConfig[inverted ? "auto_on_delay" : "auto_off_delay"] = 0;
            if (wrong === "unavailable") W.relayConfig = null;
            const start = prints.length;
            t = boot(); t.fcTm();
            check("S16 " + (inverted ? "inverted" : "normal") + " timer " + wrong + " blocks new heating with accurate diagnostic",
                !t.err && W.schedules.length === 0 && prints.slice(start).some(line => line.includes("No heating schedule is recorded")),
                [String(t.err || ""), prints.slice(start)]);
        }
    }
    W = freshWorld(); W.kvs.SmartHeatingConf1 = conf(); W.http = priceServer(PRICE);
    t = boot(); t.fcTm();
    const preservedId = W.schedules[0].id;
    W.fail["Switch.SetConfig"] = true; W.relayConfig = null;
    const diagnosticStart = prints.length;
    t.jumpToNextDay(); t.loop();
    const preservationLogs = prints.slice(diagnosticStart);
    const scheduleReference = new RegExp("\\bschedule\\s+(?:id\\s*[:#]?\\s*|#\\s*)?" + preservedId + "\\b", "i");
    check("S16 local error identifies the recorded schedule being preserved", !t.err &&
        W.schedules.length === 1 && W.schedules[0].id === preservedId &&
        preservationLogs.some(line => line.includes("Schedule updates are paused")) &&
        preservationLogs.some(line => scheduleReference.test(line)) &&
        preservationLogs.some(line => line.includes("forced failure")), preservationLogs);
    delete W.fail["Switch.SetConfig"]; t.loop();
    expectSchedule(t, cheapest(EVE.normal, 24, 10, PRICE));
    check("S16 recovered timer updates the preserved schedule", W.schedules[0].id === preservedId);
});

scenario("S17 Queued interrupted installation, explicit reset, and later pause respect RPC/timer limits", () => {
    let t;
    vcWorld(); W.pageSize = 3; W.ignoreKeys = true; W.vcs = manyForeign(5);
    W.fail["Virtual.Add"] = p => p.type === "boolean" && p.id === 201;
    t = boot(true); t.fcTm(); const installLimits = t.flush();
    const failedInstallStopped = !t.err && W.schedules.length === 0;
    const stoppedControls = JSON.stringify(W.vcs), stoppedAdds = W.addAttempts.length;
    delete W.fail["Virtual.Add"]; t.loop(); const pauseLimits = t.flush();
    const partialPaused = !t.err && JSON.stringify(W.vcs) === stoppedControls && W.addAttempts.length === stoppedAdds;
    W.vcs = manyForeign(5); // user explicitly clears all required control slots to reinstall
    t.jumpToNextDay(); t.loop(); const retryLimits = t.flush();
    const installedAsync = !t.err && W.vcs.length === 15 && W.schedules.length === 1;
    W.vcs.find(v => v.key === "boolean:201").status.value = true;
    t.jumpToNextDay(); t.loop(); t.flush();
    W.vcs = W.vcs.filter(v => v.key !== "boolean:201");
    t = boot(true); t.fcTm();
    const limits = t.flush();
    check("S17 interrupted install pauses, explicit reset reinstalls, and missing controls pause within RPC/timer limits",
        failedInstallStopped && partialPaused && installedAsync && !t.err && W.schedules.length === 1 &&
        W.schedules[0].calls[0].params.on === false && W.vcs.length === 14 && W.vDeleted.length === 0 &&
        [installLimits, pauseLimits, retryLimits, limits].every(l => l.rpcPeak <= 5 && l.timerPeak <= 5),
        [String(t.err || ""), limits, W.schedules]);
});

scenario("S18 Unsupported and missing values are never substituted or written back", () => {
    let t;
    // Per-field invalid inputs detect omitted validation of that specific field.
    for (const [field, value] of [
        ["TimePeriod", -1], ["TimePeriod", 25], ["TimePeriod", 2.5], ["TimePeriod", true],
        ["TimePeriod", null], ["TimePeriod", ""], ["TimePeriod", "  "],
        ["HeatingTime", null], ["HeatingTime", ""], ["HeatingTime", "  "],
        ["InvertedRelay", null], ["InvertedRelay", "false"], ["IsForecastUsed", null],
        ["AlwaysOnPrice", null], ["AlwaysOffPrice", null], ["HeatingCurve", null],
        ["Country", null], ["RelayId", null], ["ManualKVS", "true"],
    ]) {
        W = freshWorld(); W.http = priceServer(PRICE);
        const saved = conf({ [field]: value });
        W.kvs.SmartHeatingConf1 = saved;
        W.schedules = [{ id: 41, timespec: "0 0 1 * * *", calls: [] }];
        W.kvs.SmartHeatingSys1 = JSON.stringify({ ExistingSchedule: 41, Version: 5 });
        const before = JSON.stringify([W.kvs, W.schedules]);
        const start = prints.length;
        t = boot(); t.fcTm();
        check("S18 " + field + "=" + JSON.stringify(value) + " is reported and preserved",
            !t.err && JSON.stringify([W.kvs, W.schedules]) === before && W.deleted.length === 0 && W.relayConfigs.length === 0 &&
            prints.slice(start).some(line => line.includes(field)), [String(t.err || ""), prints.slice(start)]);
        W.kvs.SmartHeatingConf1 = conf(); t.loop();
        check("S18 corrected " + field + " resumes scheduling", !t.err && W.schedules.length === 1 && W.schedules[0].id === 41);
    }
    for (const saved of ["invalid JSON", "null", "{}", "[]"]) {
        W = freshWorld(); W.http = priceServer(PRICE); W.kvs.SmartHeatingConf1 = saved;
        t = boot(); t.fcTm();
        check("S18 malformed configuration " + saved + " is retained without crashing",
            !t.err && W.kvs.SmartHeatingConf1 === saved && W.relayConfigs.length === 0 && W.schedules.length === 0, String(t.err || ""));
    }
    for (const period of Array.from({ length: 25 }, (_, i) => [i, String(i)]).flat()) {
        W = freshWorld(); W.http = priceServer(PRICE);
        const saved = conf({ TimePeriod: period, HeatingTime: 2 }); W.kvs.SmartHeatingConf1 = saved;
        t = boot(); t.fcTm(); t.jumpToNextDay(); t.loop();
        const expected = Number(period) === 0 ? null : cheapest(EVE.normal, Number(period), 2, PRICE);
        check("S18 supported period " + JSON.stringify(period) + " is used without rewriting KVS",
            !t.err && W.kvs.SmartHeatingConf1 === saved && !W.kvsWrites.includes("SmartHeatingConf1") &&
            (W.schedules.length ? specHours(W.schedules[0].timespec) : null) === expected, W.schedules);
    }
    W = freshWorld(); W.http = priceServer(() => -20);
    const specialConfig = conf({ HeatingTime: 30, AlwaysOnPrice: -10, AlwaysOffPrice: 600, HeatingCurve: 10 });
    W.kvs.SmartHeatingConf1 = specialConfig;
    t = boot(); t.fcTm();
    check("S18 KVS numeric settings retain their wider ranges", !t.err && W.kvs.SmartHeatingConf1 === specialConfig && W.schedules.length === 1 && specHours(W.schedules[0].timespec).split(",").length === 24);
});

// Literal expectations cover restored KVS periods independently of the hour oracle.
for (const [period, online, offline] of [
    [1, "0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23", "0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23"],
    [4, "0,4,8,12,16,20", "0,4,8,12,16,21"],
    [5, "0,5,10,15,20", "0,5,10,15,21"],
    [8, "0,8,16", "0,8,16"],
]) {
    for (const outage of [false, true]) {
        scenario("S18b KVS period=" + period + ", offline=" + outage, () => {
            W.kvs.SmartHeatingConf1 = conf({ TimePeriod: period, HeatingTime: 1, AlwaysOnPrice: -999 });
            W.http = outage ? () => [null, -114] : priceServer(h => 10 + h);
            const runtime = boot(); runtime.fcTm();
            expectSchedule(runtime, outage ? offline : online);
        });
    }
    scenario("S18c KVS forecast period=" + period + " starts at midnight", () => {
        W.kvs.SmartHeatingConf1 = conf({ TimePeriod: period, HeatingTime: 1,
            IsForecastUsed: true, AlwaysOnPrice: -999 });
        W.http = p => p.url.includes("open-meteo")
            ? [{ code: 200, body: '{"hourly":{"apparent_temperature":[10]}}' }, 0]
            : priceServer(h => 10 + h)(p);
        const runtime = boot(true); runtime.advanceBy(1500);
        expectSchedule(runtime, "0");
    });
}

for (const [season, eve] of [["spring", EVE.spring], ["autumn", EVE.autumn]]) {
    scenario("S18d Four-hour KVS periods follow local hours across " + season + " DST", () => {
        FIXED_MS = new RealDate(eve).getTime(); W = freshWorld();
        W.kvs.SmartHeatingConf1 = conf({ TimePeriod: 4, HeatingTime: 1, AlwaysOnPrice: -999 });
        W.http = priceServer(h => 10 + h);
        const runtime = boot(); runtime.fcTm();
        expectSchedule(runtime, "0,4,8,12,16,20");
    });
}

scenario("S19 A failed read is distinct from a confirmed missing key, including after a successful cycle", () => {
    let t;
    for (const virtual of [false, true]) {
        for (const priorSuccess of [false, true]) {
            vcWorld(); if (!virtual) W.device = { gen: 2, app: "Plus1PM", ver: "1.4.4" };
            W.kvs.SmartHeatingConf1 = conf({ InvertedRelay: true }); // also force KVS on a VC-capable device
            t = boot(true);
            if (priorSuccess) { t.fcTm(); t.flush(); }
            // Stored values may have changed since the last successful read.
            const changed = conf({ InvertedRelay: true, HeatingTime: 2, TimePeriod: 12 });
            W.kvs.SmartHeatingConf1 = changed;
            W.fail["KVS.Get"] = p => p.key === "SmartHeatingConf1";
            const before = JSON.stringify([W.kvs, W.schedules, W.vcs, W.relayConfigs]);
            t.jumpToNextDay(); t.fcTm(); t.flush();
            const firstError = t.err;
            t.loop(); t.flush();
            check("S19 failed read on " + (virtual ? "VC-capable" : "KVS-only") + " device " + (priorSuccess ? "after success" : "at boot") + " changes nothing",
                !firstError && !t.err && JSON.stringify([W.kvs, W.schedules, W.vcs, W.relayConfigs]) === before,
                [String(firstError || t.err || ""), W.kvs]);
            delete W.fail["KVS.Get"]; t.loop(); t.flush();
            check("S19 next successful read uses current saved settings",
                !t.err && W.kvs.SmartHeatingConf1 === changed && W.schedules.length === 1 &&
                specHours(W.schedules[0].timespec) === cheapest(EVE.normal, 12, 2, PRICE) && W.schedules[0].calls[0].params.on === false, W.schedules);
        }
    }
    W = freshWorld(); W.http = priceServer(PRICE);
    t = boot(); t.fcTm(); t.jumpToNextDay(); t.loop();
    check("S19 confirmed missing KVS config initializes once", !t.err && W.schedules.length === 1 && W.kvsWrites.filter(k => k === "SmartHeatingConf1").length === 1);
});

scenario("S20 Reject complete foreign sets and a single conflicting control before applying values", () => {
    let t;
    for (const badKey of ["all", ...VC_SET.slice(1).map(v => v[0])]) {
        for (const priorCalculation of [false, true]) {
            vcWorld(); W.pageSize = 3; W.ignoreKeys = true;
            W.vcs = manyForeign(5).concat(controlFixture());
            t = boot();
            if (priorCalculation) t.fcTm();
            for (const v of W.vcs) if (badKey === "all" || v.key === badKey) v.config.name = "Other script's control";
            W.vcs.find(v => v.key === "boolean:201").status.value = true;
            const before = JSON.stringify([W.kvs, W.schedules, W.vcs, W.relayConfigs]);
            t = boot(); t.fcTm();
            check("S20 foreign " + badKey + (priorCalculation ? " after calculation" : " at first boot") + " is never adopted",
                !t.err && JSON.stringify([W.kvs, W.schedules, W.vcs, W.relayConfigs]) === before, String(t.err || ""));
        }
    }
    {
        const missing = "config";
        vcWorld(); W.vcs = controlFixture();
        delete W.vcs.find(v => v.key === "boolean:201")[missing];
        t = boot(); t.fcTm();
        check("S20 missing " + missing + " blocks adoption without adding controls", !t.err && W.relayConfigs.length === 0 && W.addAttempts.length === 0 && W.kvs.SmartHeatingVC1 === undefined);
    }
});

scenario("S21 Present-but-invalid controls cannot silently select zero or stale values", () => {
    let t;
    for (const key of VC_SET.slice(1).map(v => v[0])) {
        for (const badValue of [null, ""]) {
            vcWorld(); W.vcs = controlFixture();
            t = boot(); t.fcTm();
            const control = W.vcs.find(v => v.key === key), goodValue = control.status.value;
            const priorId = W.schedules[0] && W.schedules[0].id;
            control.status.value = badValue;
            const before = JSON.stringify([W.kvs, W.schedules, W.vcs, W.relayConfigs]);
            t = boot(); t.fcTm();
            check("S21 " + key + "=" + JSON.stringify(badValue) + " preserves the last working configuration",
                !t.err && JSON.stringify([W.kvs, W.schedules, W.vcs, W.relayConfigs]) === before, String(t.err || ""));
            control.status.value = goodValue; t.loop();
            check("S21 restored " + key + " resumes on retry", !t.err && W.schedules.length === 1 && W.schedules[0].id === priorId && specHours(W.schedules[0].timespec) === cheapest(EVE.normal, 12, 5, PRICE));
        }
    }
    vcWorld(); W.vcs = controlFixture();
    W.vcs.find(v => v.key === "enum:200").status.value = "0";
    W.vcs.find(v => v.key === "number:200").status.value = 0;
    W.http = priceServer(() => 0);
    t = boot(); t.fcTm();
    check("S21 explicit zero remains valid price-only control", !t.err && W.schedules.length === 1 && specHours(W.schedules[0].timespec).split(",").length === 24);
});

scenario("S22 A cached watchdog ID is accepted or restarted only while its name still matches", () => {
    let t;
    for (const change of ["renamed running", "renamed stopped", "reused ID", "deleted", "replacement watchdog"]) {
        W = freshWorld(); W.kvs.SmartHeatingConf1 = conf(); W.http = priceServer(PRICE);
        t = boot(true); t.fcTm(); t.flush();
        if (change === "deleted" || change === "reused ID") W.scripts = W.scripts.filter(s => s.id !== 3);
        else W.scripts.find(s => s.id === 3).name = "Other automation";
        if (change === "reused ID") W.scripts.push({ id: 3, name: "Pump controller" });
        if (change === "replacement watchdog") { W.scripts.push({ id: 4, name: "watchdog" }); W.running[4] = false; }
        W.running[3] = change === "renamed running";
        const beforeRunning = W.running[3], start = W.calls.length;
        t.jumpToNextDay(); t.loop(); t.flush();
        const foreignWrites = W.calls.slice(start).filter(c => ["Script.Start", "Script.Stop", "Script.PutCode", "Script.SetConfig"].includes(c.method) && c.params.id === 3);
        const actual = W.scripts.find(s => s.name === "watchdog");
        check("S22 " + change + ": foreign ID left alone, actual watchdog runs",
            !t.err && foreignWrites.length === 0 && W.running[3] === beforeRunning && actual && actual.id !== 3 && W.running[actual.id],
            [String(t.err || ""), foreignWrites.map(c => c.method), W.scripts]);
    }
});

scenario("S23 Retry the same unsaved SystemData record, including ID zero, without reloading stale state", () => {
    let t;
    for (const priorRecord of [false, true]) {
        for (const noHeating of [false, true]) {
            W = freshWorld(); W.kvs.SmartHeatingConf1 = conf(); W.http = priceServer(PRICE);
            t = boot(true);
            if (priorRecord) { t.fcTm(); t.flush(); }
            W.kvs.SmartHeatingConf1 = conf({ HeatingTime: noHeating ? 0 : 2 });
            W.fail["KVS.set"] = p => p.key === "SmartHeatingSys1";
            t.jumpToNextDay(); t.fcTm(); t.flush();
            const initialError = t.err;
            const expectedJobs = JSON.stringify(W.schedules);
            const unsavedId = W.schedules.length ? W.schedules[0].id : 0;
            const record = W.calls.filter(c => c.method === "KVS.set" && c.params.key === "SmartHeatingSys1").slice(-1)[0].params.value;
            const start = W.calls.length;
            // Changes made while persistence is pending must wait, preserving the pending ID.
            W.kvs.SmartHeatingConf1 = conf({ HeatingTime: 3 });
            for (let i = 0; i < 3; i++) { t.jumpToNextDay(); t.loop(); t.flush(); }
            const retries = W.calls.slice(start);
            const writes = retries.filter(c => c.method === "KVS.set" && c.params.key === "SmartHeatingSys1");
            check("S23 " + (priorRecord ? "stale" : "missing") + " record, " + (noHeating ? "zero" : "new") + " ID retries once per cycle without other work",
                !initialError && !t.err && JSON.stringify(W.schedules) === expectedJobs && writes.length === 3 &&
                writes.every(c => c.params.value === record) && retries.every(c => c.method === "KVS.set"),
                [String(initialError || t.err || ""), retries.map(c => c.method)]);
            delete W.fail["KVS.set"]; t.loop(); t.flush();
            const activatedJobs = JSON.parse(expectedJobs);
            if (!noHeating) { activatedJobs[0].enable = true; }
            check("S23 successful persistence saves the same ID without creating another schedule",
                !t.err && W.kvs.SmartHeatingSys1 !== undefined && JSON.parse(W.kvs.SmartHeatingSys1).ExistingSchedule === unsavedId && JSON.stringify(W.schedules) === JSON.stringify(activatedJobs),
                [W.kvs.SmartHeatingSys1, W.schedules]);
            t.loop(); t.flush();
            check("S23 normal calculation resumes after saving, with no orphan schedule",
                !t.err && W.schedules.length === 1 && specHours(W.schedules[0].timespec) === cheapest(EVE.normal, 24, 3, PRICE), W.schedules);
        }
    }
});

scenario("S24 Polarity transitions never enable a command without its matching end timer", () => {
    for (const inverted of [false, true]) {
        for (const failure of ["list", "disable", "timer", "update", null]) {
            W = freshWorld(); W.kvs.SmartHeatingConf1 = conf({ InvertedRelay: inverted }); W.http = priceServer(PRICE);
            const runtime = boot(true); runtime.fcTm(); runtime.flush();
            const id = W.schedules[0].id, oldTimer = JSON.stringify(W.relayConfig);
            let mismatches = 0;
            W.observe = () => {
                for (const job of W.schedules) {
                    const on = job.calls[0].params.on;
                    if (job.enable && !(on ? W.relayConfig.auto_off : W.relayConfig.auto_on)) mismatches++;
                }
            };
            W.kvs.SmartHeatingConf1 = conf({ InvertedRelay: !inverted });
            if (failure === "list") W.fail["Schedule.List"] = true;
            if (failure === "disable") W.fail["Schedule.Update"] = p => p.enable === false;
            if (failure === "timer") W.fail["Switch.SetConfig"] = true;
            if (failure === "update") W.fail["Schedule.Update"] = p => p.timespec !== undefined;
            runtime.jumpToNextDay(); runtime.loop(); const limits = runtime.flush();
            assert.ifError(runtime.err); assert.equal(mismatches, 0, String(failure));
            assert.equal(W.schedules.length, 1); assert.equal(W.schedules[0].id, id);
            const beforeDisable = failure === "list" || failure === "disable";
            assert.equal(W.schedules[0].enable, !failure || beforeDisable, String(failure));
            if (beforeDisable) assert.equal(JSON.stringify(W.relayConfig), oldTimer);
            W.fail = {}; runtime.loop(); runtime.flush();
            assert.equal(mismatches, 0); assert.equal(W.schedules[0].enable, true);
            assert.equal(W.schedules[0].id, id); assert.equal(W.schedules[0].calls[0].params.on, inverted);
            assert.ok(limits.rpcPeak <= 5 && limits.timerPeak <= 5);
        }
    }
    W = freshWorld(); W.kvs.SmartHeatingConf1 = conf(); W.http = priceServer(PRICE);
    let runtime = boot(); runtime.fcTm(); const id = W.schedules[0].id;
    W.kvs.SmartHeatingConf1 = conf({ InvertedRelay: true });
    W.fail["Schedule.Update"] = p => p.timespec !== undefined;
    runtime.jumpToNextDay(); runtime.loop(); assert.equal(W.schedules[0].enable, false);
    runtime.stop(); runtime = boot(); runtime.fcTm();
    assert.equal(W.schedules[0].id, id); assert.equal(W.schedules[0].enable, false);
    delete W.fail["Schedule.Update"]; runtime.loop();
    assert.equal(W.schedules[0].id, id); assert.equal(W.schedules[0].enable, true);
    assert.equal(W.schedules[0].calls[0].params.on, false);

    const working = JSON.stringify(W.schedules);
    W.fail["Schedule.Update"] = true; runtime.jumpToNextDay(); runtime.loop();
    assert.equal(JSON.stringify(W.schedules), working, "same-polarity failure retains the working schedule");
    delete W.fail["Schedule.Update"]; runtime.loop();
    expectSchedule(runtime, cheapest(EVE.normal, 24, 10, PRICE), { inverted: true });
    assert.equal(W.schedules[0].id, id);
});

scenario("S25 A periodic tick cannot overlap an unfinished offline fallback", () => {
    let t;
    for (const pending of ["Switch.SetConfig", "Schedule.Create", "KVS.set"]) {
        W = freshWorld(); W.kvs.SmartHeatingConf1 = conf(); W.http = () => [null, -114];
        t = boot(true); t.fcTm();
        let steps = 0;
        while (!t.pending().includes(pending) && !t.err && steps++ < 100) t.step();
        const reached = t.pending().includes(pending);
        t.loop(); const limits = t.flush();
        check("S25 tick during fallback " + pending + " settles with one persisted schedule",
            reached && !t.err && W.schedules.length === 1 && specHours(W.schedules[0].timespec) === FALLBACK &&
            JSON.parse(W.kvs.SmartHeatingSys1 || "{}").ExistingSchedule === W.schedules[0].id &&
            limits.rpcPeak <= 5 && limits.timerPeak <= 5, String(t.err || ""));
        const fallbackId = W.schedules[0] && W.schedules[0].id;
        t.loop(); t.flush(); t.loop(); t.flush();
        check("S25 repeated outage retains the fallback at " + pending,
            !t.err && W.schedules.length === 1 && W.schedules[0].id === fallbackId);
        W.http = priceServer(PRICE); t.loop(); t.flush();
        check("S25 prices recover after overlapping tick at " + pending,
            !t.err && W.schedules.length === 1 && specHours(W.schedules[0].timespec) === cheapest(EVE.normal, 24, 10, PRICE));
    }
});

scenario("S26 Unreadable schedule identity never becomes an empty record", () => {
    let t;
    // Assert external state, including retention of the old schedule. Missing-key
    // recovery exposes a lost remembered ID that restoring the record would mask.
    for (const [priorSuccess, recovery] of [[false, "missing"], [true, "restored"], [true, "missing"]]) {
        for (const bad of ["read failure", "{", "null", "[]", "{}", '{"ExistingSchedule":null}', '{"ExistingSchedule":-1}', '{"ExistingSchedule":"5"}']) {
            W = freshWorld(); W.kvs.SmartHeatingConf1 = conf(); W.http = priceServer(PRICE);
            t = boot(true);
            if (priorSuccess) { t.fcTm(); t.flush(); }
            const goodRecord = W.kvs.SmartHeatingSys1;
            if (bad === "read failure") W.fail["KVS.Get"] = p => p.key === "SmartHeatingSys1";
            else W.kvs.SmartHeatingSys1 = bad;
            const before = JSON.stringify([W.kvs, W.schedules, W.relayConfigs]);
            t.jumpToNextDay(); t.fcTm(); t.flush(); t.loop(); t.flush();
            check("S26 " + bad + (priorSuccess ? " after success" : " at boot") + " preserves identity and relay",
                !t.err && JSON.stringify([W.kvs, W.schedules, W.relayConfigs]) === before,
                String(t.err || ""));
            delete W.fail["KVS.Get"];
            if (recovery === "missing") delete W.kvs.SmartHeatingSys1;
            else W.kvs.SmartHeatingSys1 = goodRecord;
            W.kvs.SmartHeatingConf1 = conf({ HeatingTime: 2 });
            const oldId = W.schedules[0] && W.schedules[0].id;
            t.loop(); t.flush();
            check("S26 " + recovery + " record resumes " + bad + "/" + priorSuccess, !t.err && W.schedules.length === 1 &&
                (!priorSuccess || W.schedules[0].id === oldId) && specHours(W.schedules[0].timespec) === cheapest(EVE.normal, 24, 2, PRICE) &&
                JSON.parse(W.kvs.SmartHeatingSys1).ExistingSchedule === W.schedules[0].id);
        }
    }
});

scenario("S27 The second occurrence has no cron slot but all its quarters must validate", () => {
    let t;
    // Cheap-first and cheap-second prices distinguish first-occurrence selection
    // from averaging the occurrences or taking their minimum.
    FIXED_MS = new RealDate(EVE.autumn).getTime();
    for (const firstCheap of [false, true]) {
        W = freshWorld(); W.kvs.SmartHeatingConf1 = conf({ HeatingTime: 1, AlwaysOnPrice: -1 });
        W.http = priceServer((hour, ms) => hour === 3 ?
            (new RealDate(ms).getTimezoneOffset() === -180 ? (firstCheap ? 0 : 100) : (firstCheap ? 100 : 0)) : hour === 4 ? 60 : 200);
        t = boot(true); t.fcTm(); t.flush();
        check("S27 autumn chooses by the first occurrence (cheap=" + firstCheap + ")",
            !t.err && W.schedules.length === 1 && specHours(W.schedules[0].timespec) === (firstCheap ? "3" : "4"));
    }
    W = freshWorld(); W.kvs.SmartHeatingConf1 = conf();
    W.http = p => {
        const res = priceServer(PRICE)(p);
        const rows = atob(res[0].body_b64).split("\n");
        rows[18] = rows[18].replace(/;"[^";]+"$/, ';"invalid"'); // second occurrence of 03:00
        res[0].body_b64 = Buffer.from(rows.join("\n"), "latin1").toString("base64");
        return res;
    };
    t = boot(); t.fcTm();
    check("S27 malformed second occurrence still rejects the day", !t.err && W.schedules.length === 1 && specHours(W.schedules[0].timespec) === FALLBACK);
    FIXED_MS = new RealDate(EVE.spring).getTime();
    W = freshWorld(); W.kvs.SmartHeatingConf1 = conf({ HeatingTime: 24 }); W.http = priceServer(PRICE);
    t = boot(); t.fcTm();
    check("S27 spring exposes exactly 23 candidates and no hour 3", !t.err && W.schedules.length === 1 &&
        specHours(W.schedules[0].timespec) === dayHours(EVE.spring).join(","));
    FIXED_MS = new RealDate(EVE.normal).getTime();
});

scenario("S28 An invisible added control stops this cycle; partial controls need manual restoration", () => {
    let t;
    vcWorld(); W.ghostAdd = "number:203";
    t = boot(true); t.fcTm(); const ghostLimits = t.flush();
    check("S28 invisible added control does not loop", !t.err && W.addAttempts.filter(k => k === W.ghostAdd).length === 1 &&
        W.schedules.length === 0 && t.pending().length === 0 && ghostLimits.rpcPeak <= 5 && ghostLimits.timerPeak <= 5);
    t.loop(); t.flush();
    check("S28 next cycle pauses without another installation attempt", !t.err &&
        W.addAttempts.filter(k => k === W.ghostAdd).length === 1 && W.schedules.length === 0 && t.pending().length === 0);
    W.vcs.push({ key: "number:203", config: { name: "Forecast Impact +/-" }, status: { value: 0 } });
    delete W.ghostAdd; t.loop(); t.flush();
    check("S28 manually restored control resumes heating", !t.err && W.schedules.length === 1);
});

scenario("S29 Only KVS mode validates the nine KVS heating values; mode/relay must always be known", () => {
    let t;
    for (const badSettings of [{ TimePeriod: 25 }, { EnergyProvider: "PARTN24P" }, { HeatingTime: null }, { Country: undefined }]) {
        vcWorld(); W.vcs = controlFixture();
        const saved = conf(Object.assign({ ManualKVS: false }, badSettings)); W.kvs.SmartHeatingConf1 = saved;
        t = boot(true); t.fcTm(); t.flush();
        check("S29 valid controls override inactive " + Object.keys(badSettings)[0] + " without rewriting KVS",
            !t.err && W.kvs.SmartHeatingConf1 === saved && W.schedules.length === 1 &&
            specHours(W.schedules[0].timespec) === cheapest(EVE.normal, 12, 5, PRICE));
    }
    for (const saved of [conf({ ManualKVS: "false" }), conf({ ManualKVS: false, RelayId: null }), "{"]) {
        vcWorld(); W.vcs = controlFixture();
        W.kvs.SmartHeatingConf1 = saved; t = boot(true); t.fcTm(); t.flush();
        check("S29 unknown mode or relay is never guessed: " + saved, !t.err && W.schedules.length === 0 && W.relayConfigs.length === 0 &&
            !W.calls.some(c => c.method === "Shelly.GetComponents") && W.kvsWrites.length === 0);
    }

    // Rejected KVS settings must not leave a mode override active for the next cycle.
    vcWorld(); W.kvs.SmartHeatingConf1 = conf({ ManualKVS: true, HeatingTime: null });
    t = boot(true); t.fcTm(); t.flush();
    check("S29 rejected ManualKVS override pauses without installing or scheduling", !t.err &&
        W.addAttempts.length === 0 && W.schedules.length === 0 && W.kvsWrites.length === 0);
    delete W.kvs.SmartHeatingConf1; t.loop(); t.flush();
    check("S29 removing rejected KVS record restores VC installation", !t.err && completeGroup() && W.schedules.length === 1 &&
        W.kvs.SmartHeatingConf1 === undefined && !W.kvsWrites.includes("SmartHeatingConf1"));
    for (const forced of [false, true]) {
        vcWorld(); const saved = JSON.stringify({ ManualKVS: forced }); W.kvs.SmartHeatingConf1 = saved;
        const relayLog = prints.length; t = boot(true); t.fcTm(); t.flush();
        check("S29 saved RelayId is required with ManualKVS=" + forced, !t.err && W.schedules.length === 0 &&
            W.addAttempts.length === 0 && W.relayConfigs.length === 0 && W.kvsWrites.length === 0 &&
            W.kvs.SmartHeatingConf1 === saved && prints.slice(relayLog).some(l => l.includes("RelayId")));
    }
    vcWorld(); W.kvs.SmartHeatingConf1 = JSON.stringify({ ManualKVS: false, RelayId: 1 });
    t = boot(true); t.fcTm(); t.flush();
    const selectedRelayCalls = W.calls.filter(c => c.method === "Switch.SetConfig");
    check("S29 VC mode honours saved relay 1 for both timer and schedule", !t.err && completeGroup() &&
        selectedRelayCalls.length > 0 && selectedRelayCalls.every(c => c.params.id === 1) &&
        W.schedules.length === 1 && W.schedules[0].calls.every(c => c.method === "Switch.Set" && c.params.id === 1) &&
        W.kvs.SmartHeatingConf1 === JSON.stringify({ ManualKVS: false, RelayId: 1 }));
});

scenario("S30 Custom groups are preserved during install and normal calculations", () => {
    let t;
    for (const complete of [false, true]) {
        vcWorld();
        W.vcs = [{ key: "group:200", config: { name: "Personal" }, status: { value: ["number:205"] } }];
        if (complete) W.vcs.push(...VC_SET.slice(1).map(e => ({ key: e[0], config: { name: e[1] }, status: { value: e[2] } })));
        const group = JSON.stringify(W.vcs[0]);
        t = boot(true); t.fcTm(); t.flush(); t.jumpToNextDay(); t.loop(); t.flush();
        check("S30 custom group survives " + (complete ? "normal reads" : "control installation"), !t.err &&
            W.schedules.length === 1 && JSON.stringify(W.vcs[0]) === group && !W.calls.some(c => c.method === "Group.Set"));
    }
});

scenario("S31 With no recorded schedule, other jobs require neither inspection nor changes", () => {
    let t;
    W = freshWorld(); W.http = priceServer(PRICE); W.kvs.SmartHeatingConf1 = conf({ HeatingTime: 0, AlwaysOnPrice: -1 });
    W.schedules = [{ id: 41, enable: true, timespec: "0 0 1 * * *", calls: [{ method: "Switch.Set", params: { id: 0, on: true } }] }];
    const foreignJobs = JSON.stringify(W.schedules);
    t = boot(true); t.fcTm(); t.flush(); t.jumpToNextDay(); t.loop(); t.flush();
    check("S31 no recorded ID skips schedule listing and preserves other jobs", !t.err &&
        !W.calls.some(c => c.method === "Schedule.List") && JSON.stringify(W.schedules) === foreignJobs &&
        JSON.parse(W.kvs.SmartHeatingSys1).ExistingSchedule === 0);
});

scenario("S34 Persistence diagnostics identify the failed key or schedule ID and RPC reason", () => {
    let t;
    for (const method of ["KVS.Get", "KVS.set"]) {
        vcWorld(); W.fail[method] = p => p.key === "SmartHeatingSys1";
        const logStart = prints.length; t = boot(true); t.fcTm(); t.flush();
        check("S34 " + method + " SystemData failure is actionable", !t.err &&
            prints.slice(logStart).some(l => l.includes("forced failure") && /SystemData|Schedule ID/.test(l)) &&
            prints.slice(logStart).some(l => l.includes("Schedule updates are paused")) &&
            (method !== "KVS.set" || prints.slice(logStart).some(l =>
                l.includes("Schedule ID " + W.schedules[0]?.id) && l.includes("forced failure") && l.includes("Schedule updates are paused"))));
    }
});

scenario("S36 Unavailable entries and values preserve heating and advise retry before restoration", () => {
    let t;
    for (const fault of ["omitted entry", "missing status"]) {
        vcWorld(); W.pageSize = 3;
        W.vcs = controlFixture();
        t = boot(true); t.fcTm(); t.flush();
        const control = W.vcs.find(v => v.key === "number:203"), status = control.status;
        if (fault === "omitted entry") W.hiddenStatusKey = control.key;
        else delete control.status;
        const before = JSON.stringify([W.kvs, W.vcs, W.schedules, W.relayConfig]);
        const start = W.calls.length, logStart = prints.length;
        t.jumpToNextDay(); t.loop(); t.flush();
        check("S36 " + fault + " changes neither controls nor heating", !t.err &&
            JSON.stringify([W.kvs, W.vcs, W.schedules, W.relayConfig]) === before &&
            !W.calls.slice(start).some(c => ["Virtual.Add", "Virtual.Delete", "Switch.SetConfig", "Switch.Set",
                "Schedule.Create", "Schedule.Delete", "Schedule.Update"].includes(c.method)));
        check("S36 " + fault + " names the control and advises waiting for the next read", prints.slice(logStart).some(l =>
            l.includes("Schedule updates are paused") && l.includes(control.key) && l.includes(control.config.name) &&
            /wait.*next.*read/i.test(l) && /restore.*only if.*missing/i.test(l)));
        delete W.hiddenStatusKey; control.status = status;
        t.loop(); t.flush();
        check("S36 " + fault + " recovers after a complete read", !t.err && W.schedules.length === 1 &&
            JSON.stringify(W.kvs) !== JSON.stringify(JSON.parse(before)[0]) && W.schedules[0].enable === true);
    }
});

scenario("S36b Numeric totals are required even for a single page with all nine valid controls", () => {
    let t;
    for (const total of [undefined, null, "10"]) {
        for (const installed of [false, true]) {
            vcWorld();
            t = boot(true);
            if (installed) { t.fcTm(); t.flush(); }
            W.componentTotal = total;
            const before = JSON.stringify([W.kvs, W.vcs, W.schedules, W.relayConfig]);
            const start = W.calls.length, logStart = prints.length;
            t.jumpToNextDay(); t.fcTm(); t.flush();
            check("S36b total=" + String(total) + ", installed=" + installed + " pauses without changing state", !t.err &&
                JSON.stringify([W.kvs, W.vcs, W.schedules, W.relayConfig]) === before &&
                !W.calls.slice(start).some(c => ["Virtual.Add", "Virtual.Delete", "Switch.SetConfig", "Switch.Set",
                    "Schedule.Create", "Schedule.Delete", "Schedule.Update"].includes(c.method)) &&
                prints.slice(logStart).some(l => l.includes("Schedule updates are paused") && /inventory.*incomplete/i.test(l)));
            delete W.componentTotal; t.loop(); t.flush();
            check("S36b valid total resumes " + (installed ? "normal reads" : "installation"), !t.err &&
                completeGroup() && W.schedules.length === 1 && JSON.stringify(W.kvs) !== JSON.stringify(JSON.parse(before)[0]) && W.schedules[0].enable === true);
        }
    }
});

scenario("S37 Only a verified numeric create response grants permission to populate", () => {
    let t;
    for (const response of [{}, { id: 201 }, { id: "200" }]) {
        vcWorld(); W.groupCreateResponse = response;
        const logStart = prints.length;
        t = boot(true); t.fcTm(); t.flush(); t.jumpToNextDay(); t.loop(); t.flush();
        check("S37 unverified create response " + JSON.stringify(response) + " leaves membership alone and heating active", !t.err &&
            W.schedules.length === 1 && !W.calls.some(c => c.method === "Group.Set") &&
            W.addAttempts.filter(k => k === "group:200").length === 1 &&
            prints.slice(logStart).filter(l => l.includes("Group setup incomplete")).length === 1);
        const diagnostic = prints.slice(logStart).find(l => l.includes("Group setup incomplete")) || "";
        check("S37 unverified response explains uncertainty without a zero error code", /unverified/i.test(diagnostic) &&
            !/\s0\s*$/.test(diagnostic), diagnostic);
    }
});

// S40. Pro firmware selects virtual controls only when the minimum is met.
// Different control and KVS hours make the selected mode observable in the schedule.
for (const [ver, virtual] of [
    ["1.4.2", false], ["1.4.3", true], ["1.4", false], ["1.5", true],
    [undefined, false], [140, false], [{}, false], [["1.4.4"], false],
]) {
    scenario("S40 Pro firmware=" + JSON.stringify(ver) + " uses " + (virtual ? "controls" : "KVS"), () => {
        W.device = { gen: 2, app: "Pro1", ver };
        W.kvs.SmartHeatingConf1 = conf({ ManualKVS: false });
        W.vcs = controlFixture(); W.http = priceServer(PRICE);
        const runtime = boot(); runtime.fcTm();
        expectSchedule(runtime, cheapest(EVE.normal, virtual ? 12 : 24, virtual ? 5 : 10, PRICE));
    });
}

scenario("S40b The mode diagnostic explains why controls are unavailable", () => {
    let t;
    for (const forced of [false, true]) {
        W = freshWorld(); W.http = priceServer(PRICE);
        if (forced) W.device = { gen: 3, app: "Plus1PM", ver: "1.4.4" };
        W.kvs.SmartHeatingConf1 = conf({ ManualKVS: forced });
        const reasonLog = prints.length; t = boot(true); t.fcTm(); t.flush();
        const lines = prints.slice(reasonLog).filter(l => /forcing KVS mode|Script in KVS mode/.test(l));
        check("S40b KVS mode explains " + (forced ? "ManualKVS override" : "unsupported hardware"), !t.err &&
            W.schedules.length === 1 && W.addAttempts.length === 0 && lines.length === 1 &&
            lines[0].includes(forced ? "forced by ManualKVS=true" : "device does not meet Virtual Component requirements"), lines);
    }
});

for (const device of [
    { gen: 2, app: "Pro1", ver: "1.4.3" },
    { gen: 3, app: "Mini1G3", ver: "1.4.4" },
]) {
    scenario("S40c " + device.app + " retains saved KVS settings when no heating controls exist", () => {
        W.device = device; W.http = priceServer(PRICE);
        // These values cannot all be represented by virtual controls.
        const saved = conf({ ManualKVS: false, TimePeriod: 4, HeatingTime: 2,
            AlwaysOnPrice: -10, AlwaysOffPrice: 600, HeatingCurve: 10, InvertedRelay: true, RelayId: 1 });
        W.kvs.SmartHeatingConf1 = saved;
        for (const restart of [false, true]) {
            const runtime = boot(); runtime.fcTm();
            expectSchedule(runtime, "0,1,4,7,8,11,14,15,18,19,21,22", { inverted: true, relayId: 1 });
            assert.equal(W.kvs.SmartHeatingConf1, saved, "saved KVS settings stay unchanged across restart=" + restart);
            assert.equal(W.addAttempts.length, 0, "no default controls are installed");
        }
        assert.ok(prints.some(line => line.includes("Script in KVS mode") && line.includes("saved KVS settings")),
            "diagnostic explains why saved KVS settings remain active");
        // Explicitly choosing a fresh VC installation must also work without a restart.
        W.kvs.SmartHeatingConf1 = JSON.stringify({ ManualKVS: false, RelayId: 1 });
        const runtime = runtimes[runtimes.length - 1];
        runtime.jumpToNextDay(); runtime.loop();
        assert.ok(completeGroup(), "explicit switch installs virtual controls");
        assert.equal(W.vcs.find(v => v.key === "enum:200").status.value, "24", "explicit switch installs defaults");
    });
}

scenario("S42 Price-only mode cannot derive historical heating hours; preserve the prior relay and schedule", () => {
    let t;
    for (const inverted of [false, true]) {
        for (const prior of [false, true]) {
            W = freshWorld(); W.http = priceServer(PRICE);
            W.kvs.SmartHeatingConf1 = conf({ TimePeriod: 0, AlwaysOnPrice: 20, InvertedRelay: inverted });
            t = boot(true);
            if (prior) { t.fcTm(); t.flush(); }
            const existing = JSON.stringify([W.kvs, W.schedules, W.relayConfigs]);
            const errorLog = prints.length;
            W.http = () => [null, -114]; t.jumpToNextDay(); t.fcTm(); t.flush(); t.loop(); t.flush();
            check("S42 threshold-only outage preserves state, inverted=" + inverted + ", prior=" + prior, !t.err &&
                JSON.stringify([W.kvs, W.schedules, W.relayConfigs]) === existing &&
                prints.slice(errorLog).some(l => l.includes("Threshold-only mode") && l.includes("Schedule updates are paused")) &&
                !prints.slice(errorLog).some(l => l.includes("using historical cheap hours")));
            W.http = priceServer(h => h < 2 ? 0 : 100); t.loop(); t.flush();
            check("S42 threshold-only pricing resumes, inverted=" + inverted + ", prior=" + prior, !t.err &&
                W.schedules.length === 1 && specHours(W.schedules[0].timespec) === "0,1" && W.schedules[0].calls[0].params.on === !inverted);
            W.http = priceServer(() => 100); t.jumpToNextDay(); t.loop(); t.flush();
            check("S42 valid prices can still stop threshold-only heating, inverted=" + inverted + ", prior=" + prior, !t.err &&
                W.schedules.length === 1 && !W.schedules[0].enable && JSON.parse(W.kvs.SmartHeatingSys1).ExistingSchedule === W.schedules[0].id);
        }
    }
    W = freshWorld(); W.http = () => [null, -114]; W.kvs.SmartHeatingConf1 = conf({ TimePeriod: 12, HeatingTime: 0, AlwaysOnPrice: -1 });
    W.kvs.SmartHeatingSys1 = JSON.stringify({ ExistingSchedule: 41, Version: 5 });
    W.schedules = [{ id: 41, enable: true, timespec: "0 0 1 * * *", calls: [{ method: "Switch.Set", params: { id: 0, on: true } }] }];
    t = boot(true); t.fcTm(); t.flush();
    check("S42 an explicit zero-hour timed fallback disables prior heating", !t.err && W.schedules.length === 1 &&
        !W.schedules[0].enable && W.schedules[0].id === 41 && JSON.parse(W.kvs.SmartHeatingSys1).ExistingSchedule === 41);
});

scenario("S43 Non-string device app identifiers do not crash capability detection", () => {
    let t;
    for (const app of [140, {}, ["Pro1"], null]) {
        vcWorld(); W.device = { gen: 2, app, ver: "1.4.4" }; W.kvs.SmartHeatingConf1 = conf({ ManualKVS: false });
        t = boot(true); t.fcTm(); t.flush();
        check("S43 non-string app " + JSON.stringify(app) + " does not throw", !t.err && W.schedules.length === 1, String(t.err || ""));
    }
});

scenario("S44 Diagnostics must not assume successful installation from an RPC response or fallback attempt", () => {
    let t;
    vcWorld(); W.controlCreateResponse = null;
    t = boot(true); t.fcTm(); t.flush();
    check("S44 null control-add response is verified by the subsequent complete read", !t.err && completeGroup() &&
        W.schedules.length === 1 && W.vcs.filter(v => v.key !== "group:200").length === 9);
    for (const empty of [false, true]) {
        W = freshWorld(); W.http = () => [null, -114];
        W.kvs.SmartHeatingConf1 = conf({ HeatingTime: empty ? 0 : 2, AlwaysOnPrice: -1 });
        if (!empty) W.fail["Schedule.Create"] = true;
        const fallbackLog = prints.length; t = boot(true); t.fcTm(); t.flush();
        const logs = prints.slice(fallbackLog);
        check("S44 " + (empty ? "empty" : "failed") + " fallback does not claim historical hours are active", !t.err &&
            W.schedules.length === 0 && logs.some(l => /internet error/i.test(l) && /fallback/i.test(l) && /attempt|calculat/i.test(l)) &&
            !logs.some(l => /using historical cheap hours/i.test(l)), logs);
    }
});

scenario("N1 Fresh installation preserves foreign controls and respects RPC/timer limits", () => {
    let t;
    for (const hasSystemData of [false, true]) {
        vcWorld(); W.pageSize = 3; W.ignoreKeys = true; W.vcs = manyForeign(4);
        if (hasSystemData) existingHeating();
        W.kvs.SmartHeatingConf1 = JSON.stringify({ ManualKVS: false, RelayId: 0 });
        const foreignBefore = JSON.stringify(W.vcs);
        t = boot(true); t.fcTm(); const limits = t.flush();
        check("N1 empty slots, SystemData=" + hasSystemData + ": install defaults and schedule heating", !t.err &&
            completeGroup() && Object.keys(CONTROL_DEFAULTS).every(key =>
                W.vcs.find(v => v.key === key)?.status.value === CONTROL_DEFAULTS[key]) &&
            W.schedules.length === 1 && (!hasSystemData || W.schedules[0].id === 41) &&
            JSON.parse(W.kvs.SmartHeatingSys1).ExistingSchedule === W.schedules[0].id);
        check("N1 fresh install, SystemData=" + hasSystemData + ": preserves foreign controls within RPC/timer limits",
            !t.err && JSON.stringify(W.vcs.slice(0, 4)) === foreignBefore && W.vDeleted.length === 0 &&
            limits.rpcPeak <= 5 && limits.timerPeak <= 5, limits);
    }
});

scenario("N2 Every missing control pauses despite absent SystemData; survivors remain untouched", () => {
    let t;
    for (const missing of Object.keys(CONTROL_DEFAULTS)) {
        vcWorld(); W.pageSize = 3; W.ignoreKeys = true;
        W.vcs = manyForeign(4).concat(installControls().filter(v => v.key !== missing));
        const before = JSON.stringify([W.vcs, W.kvs]);
        t = boot(true); t.fcTm(); t.flush();
        check("N2 absent SystemData pauses missing " + missing + " without changing any control", !t.err &&
            JSON.stringify([W.vcs, W.kvs]) === before && W.addAttempts.length === 0 && W.vDeleted.length === 0 &&
            W.schedules.length === 0 && W.relayConfigs.length === 0, String(t.err || ""));
    }
});

scenario("N3 Partial sets always pause, including across restarts and with obsolete backups", () => {
    let t;
    for (const hasSystemData of [false, true]) {
        vcWorld(); existingHeating(); W.kvs.SmartHeatingVC1 = OLD_BACKUP;
        if (!hasSystemData) delete W.kvs.SmartHeatingSys1;
        const missingControls = ["number:200", "boolean:201", "number:203"];
        W.vcs = installControls().filter(v => !missingControls.includes(v.key));
        const pausedBefore = JSON.stringify([W.vcs, W.schedules, W.relayConfig, W.kvs]);
        const pauseLog = prints.length;
        t = boot(true); t.fcTm(); t.flush(); t.loop(); t.flush();
        t = boot(true); t.fcTm(); t.flush();
        check("N3 SystemData=" + hasSystemData + ": partial controls pause without changing heating or settings", !t.err &&
            JSON.stringify([W.vcs, W.schedules, W.relayConfig, W.kvs]) === pausedBefore &&
            !W.calls.some(c => c.method === "Switch.SetConfig" || c.method === "Switch.Set" ||
                ["Schedule.Create", "Schedule.Delete", "Schedule.Update", "Virtual.Add", "Virtual.Delete"].includes(c.method)));
        check("N3 SystemData=" + hasSystemData + ": pause names every missing control", prints.slice(pauseLog).some(l =>
            l.includes("Schedule updates are paused") && l.includes("Missing controls")) &&
            missingControls.every(key => prints.slice(pauseLog).some(l => l.includes(key) &&
                l.includes(VC_SET.find(e => e[0] === key)[1]))));
    }
});

scenario("N4 Group failure is cosmetic and never creates background retry work", () => {
    let t;
    for (const failure of ["Virtual.Add", "Group.Set"]) {
        vcWorld();
        W.fail[failure] = failure === "Virtual.Add" ? p => p.type === "group" : true;
        const logStart = prints.length;
        t = boot(true); t.fcTm(); t.flush();
        check("N4 " + failure + " group failure logs once and heating proceeds", !t.err &&
            W.schedules.length === 1 && prints.slice(logStart).filter(l => l.includes("Group setup incomplete")).length === 1);
        check("N4 " + failure + " group RPC failure includes its code and reason", prints.slice(logStart).some(l =>
            l.includes("Group setup incomplete") && l.includes("-1") && l.includes("forced failure")));
        const later = W.calls.length;
        t.loop(); t.flush(); t.jumpToNextDay(); t.loop(); t.flush();
        W.fail = {}; t.jumpToNextDay(); t.loop(); t.flush();
        t = boot(true); t.fcTm(); t.flush();
        check("N4 " + failure + " has no group RPC or repeated failure log on later cycles/restart", !t.err &&
            W.schedules.length === 1 && !W.calls.slice(later).some(groupCall) &&
            prints.slice(logStart).filter(l => l.includes("Group setup incomplete")).length === 1);
    }
});

scenario("N5 Old backups are inert during install, normal scheduling and a partial pause", () => {
    let t;
    for (const backup of [undefined, "invalid JSON", OLD_BACKUP]) {
        vcWorld();
        if (backup !== undefined) W.kvs.SmartHeatingVC1 = backup;
        t = boot(true); t.fcTm(); t.flush();
        const installed = !t.err && W.schedules.length === 1;
        t.jumpToNextDay(); t.loop(); t.flush();
        W.vcs = W.vcs.filter(v => v.key !== "number:203");
        const before = JSON.stringify([W.vcs, W.schedules, W.relayConfig]);
        t.jumpToNextDay(); t.loop(); t.flush();
        check("N5 obsolete backup " + String(backup) + " is never read or written", installed && !t.err &&
            JSON.stringify([W.vcs, W.schedules, W.relayConfig]) === before &&
            !W.calls.some(c => c.params?.key === "SmartHeatingVC1") && W.kvs.SmartHeatingVC1 === backup);
    }
});

scenario("N6 Failed or invalid SystemData blocks installation into empty slots", () => {
    let t;
    // Partial slots cannot expose this guard: N2 already requires pausing there.
    for (const outcome of ["failed read", "invalid JSON", "invalid ID"]) {
        vcWorld();
        W.kvs.SmartHeatingSys1 = outcome === "invalid JSON" ? "{" : JSON.stringify({ ExistingSchedule: -1 });
        if (outcome === "failed read") W.fail["KVS.Get"] = p => p.key === "SmartHeatingSys1";
        const before = JSON.stringify([W.vcs, W.kvs]);
        t = boot(true); t.fcTm(); t.flush();
        check("N6 " + outcome + " with empty slots cannot authorize installation", !t.err &&
            JSON.stringify([W.vcs, W.kvs]) === before && W.addAttempts.length === 0 &&
            W.relayConfigs.length === 0 && W.schedules.length === 0);
    }
});

scenario("N4r A restart after adding controls leaves only a cosmetic group gap", () => {
    let t;
    vcWorld(); t = boot(true); t.fcTm();
    let setupSteps = 0;
    while (W.vcs.length < 9 && !t.err && setupSteps++ < 100) t.step();
    const controlsBeforeRestart = W.vcs.length === 9 && !W.vcs.some(v => v.key === "group:200");
    const restartCalls = W.calls.length;
    t = boot(true); t.fcTm(); t.flush();
    check("N4r restart between controls and group leaves a cosmetic gap while heating proceeds", controlsBeforeRestart &&
        !t.err && W.schedules.length === 1 && !W.calls.slice(restartCalls).some(groupCall));
});

// Both reads must complete before any state changes, irrespective of read order.
for (const outcome of ["KVS", "virtual", "missing configuration", "failed configuration", "both failed"]) {
    scenario("S45 " + outcome + " waits for configuration and SystemData before changing heating", () => {
        vcWorld(); existingHeating(); W.vcs = installControls();
        W.kvs.SmartHeatingConf1 = conf({ ManualKVS: outcome !== "virtual" });
        if (outcome === "missing configuration") delete W.kvs.SmartHeatingConf1;
        if (outcome.includes("failed")) W.fail["KVS.Get"] = p =>
            outcome === "both failed" || p.key === "SmartHeatingConf1";
        const state = () => JSON.stringify([W.schedules, W.relayConfig, W.vcs, W.kvs]);
        const before = state();
        const readsFinished = () => ["SmartHeatingConf1", "SmartHeatingSys1"].every(key =>
            W.calls.some(c => c.method === "KVS.Get" && c.params.key === key));
        let prematureChange = false;
        W.observe = () => { if (!readsFinished() && state() !== before) prematureChange = true; };
        const runtime = boot(true); runtime.fcTm();
        let steps = 0;
        while (!readsFinished() && !runtime.err && steps++ < 100) {
            runtime.step();
            if (!readsFinished()) runtime.loop();
        }
        runtime.flush();
        assert.ifError(runtime.err);
        assert.ok(readsFinished(), "both persisted records were read");
        assert.equal(prematureChange, false, "pending reads and overlapping ticks cannot change state");
        const paused = prints.filter(line => line.includes("Schedule updates are paused"));
        if (outcome.includes("failed")) {
            assert.equal(state(), before, "failed reads preserve settings and heating");
            assert.equal(paused.length, 1, "one actionable pause diagnostic");
            assert.ok(paused[0].includes(outcome === "both failed"
                ? "SystemData could not be loaded" : "Configuration could not be loaded"));
        } else {
            assert.equal(paused.length, 0);
            assert.equal(W.schedules.length, 1);
            assert.equal(W.schedules[0].id, 41, "successful reads update the recorded schedule");
        }
    });
}

scenario("S46 Record a new schedule attempt after creation, including failed and empty results", () => {
    for (const outcome of ["created", "failed", "empty"]) {
        W = freshWorld(); W.http = priceServer(PRICE);
        W.kvs.SmartHeatingConf1 = conf(outcome === "empty" ? { HeatingTime: 0, AlwaysOnPrice: -999 } : {});
        if (outcome === "failed") W.fail["Schedule.Create"] = true;
        const runtime = boot(true); runtime.fcTm();
        let steps = 0;
        const pending = outcome === "empty" ? "KVS.set" : "Schedule.Create";
        while (!runtime.pending().includes(pending) && !runtime.err && steps++ < 250) runtime.step();
        assert.ok(runtime.pending().includes(pending));
        assert.equal(W.kvsWrites.includes("SmartHeatingSys1"), false);
        runtime.loop(); runtime.flush(); assert.ifError(runtime.err);
        const saved = JSON.parse(W.kvs.SmartHeatingSys1);
        assert.equal(saved.ExistingSchedule, outcome === "created" ? W.schedules[0].id : 0);
        assert.equal(saved.Version, 5); assert.ok(saved.LastCalculation);
        assert.equal(W.schedules.length, outcome === "created" ? 1 : 0);
        assert.equal(W.kvsWrites.filter(k => k === "SmartHeatingSys1").length, 1);
        if (outcome === "failed") {
            delete W.fail["Schedule.Create"]; runtime.loop(); runtime.flush();
            expectSchedule(runtime, cheapest(EVE.normal, 24, 10, PRICE));
        }
    }
});

scenario("S47 Equal ranked prices prefer later hours at the cutoff in each period", () => {
    let t;
    // These literals also check the oracle that supplies expected hours in other scenarios.
    for (const fixture of [
        { name: "flat", price: h => 0, expected: "10,11,22,23" },
        { name: "cheap start", price: h => h % 12 < 4 ? 0 : 10, expected: "2,3,14,15" },
        { name: "cheap end", price: h => h % 12 >= 8 ? 0 : 10, expected: "10,11,22,23" },
    ]) {
        FIXED_MS = new RealDate(EVE.normal).getTime();
        W = freshWorld(); W.http = priceServer(fixture.price);
        W.kvs.SmartHeatingConf1 = conf({ TimePeriod: 12, HeatingTime: 2, AlwaysOnPrice: -999 });
        t = boot(); t.fcTm();
        const actual = specHours(W.schedules[0]?.timespec);
        check("S47 " + fixture.name + ": later tied hours win within each period", !t.err &&
            W.schedules.length === 1 && actual === fixture.expected,
            { actual, expected: fixture.expected });
        assert.equal(cheapest(EVE.normal, 12, 2, fixture.price), fixture.expected, "oracle agrees with literal tie ranking");
    }

    // All hours rank at 100 with VORK4: night 79 + 21, weekday day 63.1 + 36.9.
    // The last three hours win; 22 and 23 then exceed the market-price cutoff.
    // Preserve filtering AFTER selection: do not backfill with eligible earlier hours.
    W = freshWorld(); W.http = priceServer(h => h < 7 || h >= 22 ? 79 : 63.1);
    W.kvs.SmartHeatingConf1 = conf({ HeatingTime: 3, EnergyProvider: "VORK4",
        AlwaysOnPrice: -999, AlwaysOffPrice: 75 });
    t = boot(); t.fcTm();
    check("S47 tariff tie retains market-price filtering after the cutoff without backfill", !t.err &&
        W.schedules.length === 1 && specHours(W.schedules[0].timespec) === "21", W.schedules);
});

// S48. A useful schedule includes its timing, enabled state and complete command.
for (const inverted of [false, true]) {
    for (const offline of [false, true]) {
        scenario("S48 full schedule contract, inverted=" + inverted + ", offline=" + offline, () => {
            W.kvs.SmartHeatingConf1 = conf({ RelayId: 1, InvertedRelay: inverted });
            W.http = offline ? () => [null, -114] : priceServer(PRICE);
            const runtime = boot(true); runtime.fcTm(); runtime.flush();
            expectSchedule(runtime, offline ? FALLBACK : cheapest(EVE.normal, 24, 10, PRICE),
                { relayId: 1, inverted });
        });
    }
}

// S49. Hand-computed forecast demand and the warm-weather clamp. Prices rise
// with the hour; expected hour lists reuse neither production math nor the oracle.
for (const fixture of [
    // Mean 2.2 -> ceil 3. Daily demand: (16 - 3)/2 - 2 = 4.5 -> floor 4.
    { name: "24h fractional mean", period: 24, temperatures: [1.2, 3.2], curve: 0, hours: "0,1,2,3" },
    // Curve +1 adds two daily hours: (4.5 + 2)/2 = 3.25 -> floor 3.
    { name: "12h positive curve", period: 12, temperatures: [1.2, 3.2], curve: 1, hours: "0,1,2" },
    // Mean -4.2 -> ceil -4. ((16 + 4)/2 - 2 + 2)/4 = 2.5 -> floor 2.
    { name: "6h negative temperature", period: 6, temperatures: [-6.2, -2.2], curve: 1, hours: "0,1" },
    // Curve -1 removes two daily hours: 4.5 - 2 = 2.5 -> floor 2.
    { name: "24h negative curve", period: 24, temperatures: [1.2, 3.2], curve: -1, hours: "0,1" },
    // Mean 17 exceeds the 16-degree reference. The formula gives
    // (16 - 17)/2 - 2 + 4*2 = 5.5 hours, but the warm-weather clamp must zero it.
    { name: "24h warm forecast with positive curve", period: 24, temperatures: [17, 17], curve: 4, hours: null },
]) {
    scenario("S49 " + fixture.name + (fixture.hours === null
        ? " overrides positive formula demand above the reference" : " uses calculated demand between clamps"), () => {
        W.kvs.SmartHeatingConf1 = conf({ TimePeriod: fixture.period, HeatingTime: 0,
            IsForecastUsed: true, HeatingCurve: fixture.curve, AlwaysOnPrice: -999 });
        W.http = p => p.url.includes("open-meteo")
            ? [{ code: 200, body: JSON.stringify({ hourly: { apparent_temperature: fixture.temperatures } }) }, 0]
            : priceServer(h => h + 10)(p);
        const runtime = boot(true); runtime.fcTm(); runtime.flush();
        expectSchedule(runtime, fixture.hours);
    });
}

// S50/S52. Inclusive market-price boundaries in each mode, with and without
// a positive uniform fee. Other uniform fee amounts exercise the same subtraction.
for (const [id, pack] of [["S50", "NONE"], ["S52", "VORK1"]]) {
    for (const period of [0, 24]) {
        for (const boundary of ["on", "off"]) {
            scenario(id + " " + pack + " period=" + period + " market-price " + boundary + " boundary", () => {
                const on = boundary === "on";
                W.kvs.SmartHeatingConf1 = conf({ EnergyProvider: pack, TimePeriod: period,
                    HeatingTime: on ? 0 : 3, AlwaysOnPrice: on ? 20 : period === 0 ? 30 : -999,
                    AlwaysOffPrice: on ? 100 : 20 });
                W.http = priceServer(h => on
                    ? h === 0 ? 20 : h === 1 ? 20.01 : 100
                    : h === 0 ? 19.99 : h === 1 ? 20 : h === 2 ? 20.01 : 100);
                const runtime = boot(); runtime.fcTm();
                expectSchedule(runtime, "0");
            });
        }
    }
}
scenario("S50 timed thresholds override the cheapest count in both directions", () => {
    W.kvs.SmartHeatingConf1 = conf({ HeatingTime: 1, EnergyProvider: "VORK4",
        AlwaysOnPrice: 20, AlwaysOffPrice: 25 });
    // 00:00 ranks first (26 + 21 = 47) but is forced off. 12:00 ranks
    // second (19 + 36.9 = 55.9), outside the one-hour count, but is forced on.
    W.http = priceServer(h => h === 0 ? 26 : h === 12 ? 19 : 100);
    const runtime = boot(true); runtime.fcTm(); runtime.flush();
    expectSchedule(runtime, "12");
});

// S51. Independent tariff differences put two hours one cent either side of
// a ranking reversal. A uniform fee cannot affect ranking; see S52 instead.
const tariffCases = [
    { pack: "VORK2", delta: 25.6 }, { pack: "VORK4", delta: 15.9 },
    { pack: "PARTN12", delta: 30.4 },
    { pack: "PARTN12PL", delta: 19.3 },
].map(f => ({ ...f, name: f.pack + " day/night", eve: EVE.normal, hour: 8 }));
// VORK5 winter weekdays: night 30.3, day 52.9, peak 81.8.
for (const [hour, delta] of [[6, 0], [7, 22.6], [8, 22.6], [9, 51.5], [11, 51.5],
    [12, 22.6], [15, 22.6], [16, 51.5], [19, 51.5], [20, 22.6], [21, 22.6], [22, 0]]) {
    tariffCases.push({ pack: "VORK5", name: "winter weekday hour " + hour, eve: EVE.normal, hour, delta });
}
// Weekend peak 47.4 versus night 30.3; morning remains night rate.
for (const [hour, delta] of [[9, 0], [11, 0], [15, 0], [16, 17.1], [19, 17.1], [20, 0]]) {
    tariffCases.push({ pack: "VORK5", name: "winter weekend hour " + hour,
        eve: "2026-01-09T23:30:00+02:00", hour, delta });
}
for (const [eve, hour, delta] of [
    ["2026-03-30T23:30:00+03:00", 9, 51.5], // March 31: peak season includes March.
    ["2026-03-31T23:30:00+03:00", 9, 22.6], // April 1: ordinary day rate.
    ["2026-10-30T23:30:00+02:00", 16, 0],  // October 31: ordinary weekend night rate.
    ["2026-10-31T23:30:00+02:00", 16, 17.1], // November 1: weekend peak begins.
]) tariffCases.push({ pack: "VORK5", name: "season boundary " + eve.slice(0, 10), eve, hour, delta });
for (const [eve, boundaries] of [
    [EVE.normal, [[6, 0], [7, 30.4], [22, 30.4], [23, 0]]],
    ["2026-07-14T23:30:00+03:00", [[7, 0], [8, 30.4], [22, 30.4], [23, 30.4]]],
    ["2026-01-09T23:30:00+02:00", [[12, 0]]],
    ["2026-07-17T23:30:00+03:00", [[12, 0]]],
]) {
    for (const [hour, delta] of boundaries) tariffCases.push({ pack: "PARTN12",
        name: "Imatra boundary " + eve.slice(0, 10) + " hour " + hour, eve, hour, delta });
}
for (const fixture of tariffCases) {
    for (const cent of [-0.01, 0.01]) {
        scenario("S51 " + fixture.name + " ranking difference " + cent, () => {
            FIXED_MS = new RealDate(fixture.eve).getTime(); W = freshWorld();
            W.kvs.SmartHeatingConf1 = conf({ EnergyProvider: fixture.pack,
                HeatingTime: 1, AlwaysOnPrice: -999, AlwaysOffPrice: 9999 });
            W.http = priceServer(h => h === fixture.hour ? 10 : h === 0 ? 10 + fixture.delta + cent : 1000);
            const runtime = boot(true); runtime.fcTm(); runtime.flush();
            expectSchedule(runtime, cent < 0 ? "0" : String(fixture.hour));
        });
    }
}

// S53. System entry points: only boot and time passage, never fcTm/loop calls.
for (const random of [0, 0.5]) {
    scenario("S53 registered startup timer and jitter=" + random + " start heating", () => {
        W.kvs.SmartHeatingConf1 = conf(); W.http = priceServer(PRICE);
        const start = W.now, runtime = boot(true, { random });
        const due = start + 1000 + (random === 0 ? 0 : 2000);
        runtime.advanceTo(due - 1);
        assert.equal(W.calls.length, 0, "no RPC before startup timer and jitter elapse");
        runtime.advanceBy(501);
        expectSchedule(runtime, cheapest(EVE.normal, 24, 10, PRICE));
    });
}
scenario("S53 price outage retries at five minutes, never early, then recovers", () => {
    W.kvs.SmartHeatingConf1 = conf(); W.http = () => [null, -114];
    const start = W.now, runtime = boot(true);
    runtime.advanceBy(1500);
    expectSchedule(runtime, FALLBACK);
    const fallbackId = W.schedules[0].id;
    W.http = priceServer(PRICE2);
    runtime.advanceTo(start + 300000 - 1);
    assert.ifError(runtime.err);
    assert.equal(W.calls.filter(c => c.method === "HTTP.GET").length, 1, "no early price retry");
    assert.equal(W.schedules[0].id, fallbackId, "fallback remains until retry is due");
    const limits = runtime.advanceBy(501);
    expectSchedule(runtime, cheapest(EVE.normal, 24, 10, PRICE2));
    assert.equal(W.calls.filter(c => c.method === "HTTP.GET").length, 2, "one retry at five minutes");
    assert.equal(W.schedules[0].id, fallbackId, "successful retry updates fallback in place");
    assert.ok(limits.rpcPeak <= 5 && limits.timerPeak <= 5, "device resource limits");
});
scenario("S53 local failure retries on consecutive five-minute ticks", () => {
    W.kvs.SmartHeatingConf1 = conf(); W.http = priceServer(PRICE);
    W.fail["Schedule.Create"] = true;
    const start = W.now, runtime = boot(true);
    const attempts = () => W.calls.filter(c => c.method === "Schedule.Create").length;
    runtime.advanceBy(1500);
    assert.equal(attempts(), 1, "first creation attempted");
    runtime.advanceTo(start + 300000 - 1);
    assert.equal(attempts(), 1, "first retry is not early");
    runtime.advanceBy(501);
    assert.equal(attempts(), 2, "first retry attempted");
    delete W.fail["Schedule.Create"];
    runtime.advanceTo(start + 600000 - 1);
    assert.equal(attempts(), 2, "second retry is not early");
    runtime.advanceBy(501);
    expectSchedule(runtime, cheapest(EVE.normal, 24, 10, PRICE));
    assert.equal(attempts(), 3, "repeating timer produces a second retry");
});
scenario("S53 daily refresh waits for its randomized update minute and repeats next day", () => {
    FIXED_MS = new RealDate("2026-01-13T22:58:00+02:00").getTime(); W = freshWorld();
    W.kvs.SmartHeatingConf1 = conf(); W.http = priceServer(PRICE);
    // random=.5 selects update minute 23, and two seconds of startup jitter.
    const runtime = boot(true, { random: 0.5 });
    runtime.advanceBy(3500);
    expectSchedule(runtime, cheapest(EVE.normal, 24, 10, PRICE));
    const firstId = W.schedules[0].id;
    const requests = () => W.calls.filter(c => c.method === "HTTP.GET").length;
    runtime.advanceTo(new RealDate("2026-01-13T23:23:00+02:00").getTime() - 1);
    assert.equal(requests(), 1, "ticks before the configured update minute retain today's prices");
    assert.equal(W.schedules[0].id, firstId);
    runtime.advanceBy(501);
    assert.equal(requests(), 2, "refresh at the due tick");
    assert.equal(RealDate.parse(new URL(W.lastUrl).searchParams.get("start")), RealDate.parse("2026-01-13T22:00:00Z"),
        "request starts at tomorrow's local midnight");
    const nextId = W.schedules[0].id;
    runtime.advanceTo(new RealDate("2026-01-14T23:23:00+02:00").getTime() - 1);
    assert.equal(requests(), 2, "no duplicate refresh before the following day's update minute");
    assert.equal(W.schedules[0].id, nextId);
    runtime.advanceBy(501);
    expectSchedule(runtime, cheapest(EVE.normal, 24, 10, PRICE));
    assert.equal(requests(), 3, "next day's repeating tick refreshes again");
    assert.equal(RealDate.parse(new URL(W.lastUrl).searchParams.get("start")), RealDate.parse("2026-01-14T22:00:00Z"));
});

scenario("S53 missing device time waits thirty seconds, falls back, then synchronizes", () => {
    W.unixtime = 0; W.kvs.SmartHeatingConf1 = conf(); W.http = priceServer(PRICE);
    const runtime = boot(true);
    runtime.advanceBy(30999);
    assert.equal(W.calls.length, 0, "no heating calculation during the initial time wait");
    runtime.advanceBy(501);
    expectSchedule(runtime, FALLBACK);
    assert.equal(W.calls.filter(c => c.method === "HTTP.GET").length, 0, "no dated request without device time");
    W.unixtime = W.now / 1000;
    runtime.advanceBy(1000);
    expectSchedule(runtime, cheapest(EVE.normal, 24, 10, PRICE));
    assert.equal(W.calls.filter(c => c.method === "HTTP.GET").length, 1, "next time-check callback resumes online heating");
});

// S54. Requests are the script's external contract. Keep the response fixtures
// unchanged, but assert the emitted service, path and relevant query arguments.
for (const country of ["ee", "fi", "lv", "lt"]) {
    scenario("S54 price request uses configured country " + country, () => {
        W.kvs.SmartHeatingConf1 = conf({ Country: country });
        W.http = priceServer(PRICE);
        const runtime = boot(true); runtime.advanceBy(1500);
        expectSchedule(runtime, cheapest(EVE.normal, 24, 10, PRICE));
        const requests = W.calls.filter(c => c.method === "HTTP.GET");
        assert.equal(requests.length, 1, "one market-price request");
        const url = new URL(requests[0].params.url);
        assert.equal(url.origin, "https://dashboard.elering.ee", "price service");
        assert.equal(url.pathname, "/api/nps/price/csv", "price endpoint");
        assert.deepEqual(url.searchParams.getAll("fields"), [country], "configured market field");
    });
}
for (const fixture of [
    { period: 6, lat: 59.44, lon: 24.75 },
    { period: 12, lat: 60.17, lon: 24.94 },
    { period: 24, lat: 56.95, lon: 24.11 },
]) {
    scenario("S54 forecast request uses configured coordinates and " + fixture.period + " hours", () => {
        W.sysConfig.location = { lat: fixture.lat, lon: fixture.lon };
        W.kvs.SmartHeatingConf1 = conf({ TimePeriod: fixture.period, HeatingTime: 0,
            IsForecastUsed: true, AlwaysOnPrice: -999 });
        W.http = p => p.url.includes("open-meteo")
            ? [{ code: 200, body: JSON.stringify({ hourly: { apparent_temperature: [20, 20] } }) }, 0]
            : priceServer(PRICE)(p);
        const runtime = boot(true); runtime.advanceBy(1500);
        expectSchedule(runtime, null);
        const requests = W.calls.filter(c => c.method === "HTTP.GET");
        assert.equal(requests.length, 2, "forecast followed by market prices");
        const url = new URL(requests[0].params.url);
        assert.equal(url.origin, "https://api.open-meteo.com", "forecast service");
        assert.equal(url.pathname, "/v1/forecast", "forecast endpoint");
        assert.deepEqual(url.searchParams.getAll("latitude"), [String(fixture.lat)], "device latitude");
        assert.deepEqual(url.searchParams.getAll("longitude"), [String(fixture.lon)], "device longitude");
        assert.deepEqual(url.searchParams.getAll("forecast_hours"), [String(fixture.period)], "configured forecast horizon");
        assert.deepEqual(url.searchParams.getAll("hourly"), ["apparent_temperature"], "temperature measure");
    });
}

// S55. Each disabled script needs an enable command for its own ID.
// The outgoing command is sufficient evidence; its saved stub copy adds none.
for (const [id, name] of [[1, "heating"], [3, "watchdog"]]) {
    scenario("S55 enables autostart for the disabled " + name + " script", () => {
        W.scriptEnabled = { 1: true, 3: true };
        W.scriptEnabled[id] = false;
        W.kvs.SmartHeatingConf1 = conf(); W.http = priceServer(PRICE);
        const runtime = boot(true); runtime.advanceBy(1500);
        expectSchedule(runtime, cheapest(EVE.normal, 24, 10, PRICE));
        const writes = W.calls.filter(c => c.method === "Script.SetConfig").map(c => c.params);
        assert.deepEqual(JSON.parse(JSON.stringify(writes)), [{ id, config: { enable: true } }],
            "enable the disabled script without rewriting the enabled script");
    });
}

// S56. Literal unequal prices anchor both production and oracle ranking.
scenario("S56 unequal prices select two hours in each six-hour period", () => {
    const prices = [
        90, 40, 10, 70, 20, 60,     // 00–05: hours 02 and 04 cost 10 and 20.
        15, 80, 35, 5, 65, 45,      // 06–11: hours 09 and 06 cost 5 and 15.
        55, 25, 95, 75, 85, 30,     // 12–17: hours 13 and 17 cost 25 and 30.
        100, 50, 110, 120, 130, 115, // 18–23: hours 19 and 18 cost 50 and 100.
    ];
    const expected = "2,4,6,9,13,17,18,19";
    W.kvs.SmartHeatingConf1 = conf({ TimePeriod: 6, HeatingTime: 2, AlwaysOnPrice: -999 });
    W.http = priceServer(h => prices[h]);
    const runtime = boot(true); runtime.advanceBy(1500);
    expectSchedule(runtime, expected);
    assert.equal(cheapest(EVE.normal, 6, 2, h => prices[h]), expected, "oracle agrees with hand-ranked periods");
});

scenario("S57 legacy empty schedule IDs migrate only from JSON-era versions", () => {
    for (const version of [4.2, 4.5, 4.8, 4.9, 4.1, 5, 6, "4.9", null, undefined]) {
        W = freshWorld(); W.http = priceServer(PRICE); W.kvs.SmartHeatingConf1 = conf();
        const record = JSON.stringify({ ExistingSchedule: "", Version: version });
        W.kvs.SmartHeatingSys1 = record;
        const runtime = boot(); runtime.fcTm();
        assert.ifError(runtime.err);
        if ([4.2, 4.5, 4.8, 4.9].includes(version)) {
            expectSchedule(runtime, cheapest(EVE.normal, 24, 10, PRICE));
            assert.equal(JSON.parse(W.kvs.SmartHeatingSys1).ExistingSchedule, W.schedules[0].id);
        } else {
            assert.equal(W.schedules.length, 0, String(version));
            assert.equal(W.kvs.SmartHeatingSys1, record, String(version));
        }
    }
});
scenario("S58 an evening outage continues retries after midnight", () => {
    for (const [period, forecast, failure] of [[24, false, "price"], [24, true, "price"], [6, true, "forecast"], [0, false, "price"]]) {
        FIXED_MS = RealDate.parse("2026-01-13T22:50:00+02:00"); W = freshWorld();
        W.kvs.SmartHeatingConf1 = conf({ TimePeriod: period, HeatingTime: 2, IsForecastUsed: forecast, AlwaysOnPrice: period === 0 ? 20 : 1 });
        let offline = false;
        W.http = p => {
            const weather = p.url.includes("open-meteo");
            if (offline && (weather ? failure === "forecast" : failure === "price")) return [null, -114];
            return weather ? [{ code: 200, body: '{"apparent_temperature":[10,10]}' }, 0] : priceServer(PRICE2)(p);
        };
        const runtime = boot(true); runtime.advanceBy(1500);
        offline = true;
        runtime.advanceTo(RealDate.parse("2026-01-13T23:06:00+02:00"));
        const fallback = JSON.stringify(W.schedules);
        runtime.advanceTo(RealDate.parse("2026-01-13T23:59:00+02:00"));
        assert.equal(JSON.stringify(W.schedules), fallback, "outage does not reinstall fallback");
        offline = false;
        const count = W.calls.filter(c => c.method === "HTTP.GET").length;
        runtime.advanceTo(RealDate.parse("2026-01-14T00:06:00+02:00"));
        assert.ifError(runtime.err);
        assert.ok(W.calls.filter(c => c.method === "HTTP.GET").length > count, "retry crosses midnight: " + [period, forecast, failure]);
        assert.ok(W.schedules.some(s => s.enable), "calculated heating resumes");
    }
});
scenario("S59 malformed watchdog records do not stop other cleanup", () => {
    for (const [name, code] of watchdogCopies) {
        for (const value of ["{", "null", "[]", "false", "1", '"text"', "{}", '{"ExistingSchedule":null}', '{"ExistingSchedule":"71"}', '{"ExistingSchedule":-1}', '{"ExistingSchedule":1.5}', '{"ExistingSchedule":1e400}']) {
            const w = watchdogWorld(); w.kvs.SmartHeatingSys1 = value;
            const sb = watchdogSandbox(code, w);
            sb.fire(1); assert.doesNotThrow(() => sb.flush(), name + " " + value);
            assert.deepEqual(w.schedules, [71, 72]); assert.equal(w.kvs.SmartHeatingSys1, value);
            assert.ok(w.logs.some(line => line.includes("1") && /invalid|JSON/i.test(line)), name + " diagnostic");
            sb.fire(2); sb.flush(); assert.deepEqual(w.schedules, [71]);
        }
    }
});
scenario("S60 watchdog cannot clear newer records or clean up a restarted script", () => {
    for (const [name, code] of watchdogCopies) {
        let w = watchdogWorld(), sb = watchdogSandbox(code, w);
        sb.fire(1); sb.step(); sb.step();
        const newer = JSON.stringify({ ExistingSchedule: 73, Version: 5, LastCalculation: "new" });
        w.kvs.SmartHeatingSys1 = newer; w.schedules.push(73); sb.flush();
        assert.equal(w.kvs.SmartHeatingSys1, newer, name + " conditional clear");
        assert.deepEqual(w.schedules, [72, 73]);
        w = watchdogWorld(); w.noEtag = true; sb = watchdogSandbox(code, w);
        const old = w.kvs.SmartHeatingSys1; sb.fire(1); sb.flush();
        assert.equal(w.kvs.SmartHeatingSys1, old, name + " missing etag preserves record");
        w = watchdogWorld(); sb = watchdogSandbox(code, w); sb.fire(1);
        w.running[1] = true; sb.flush();
        assert.deepEqual(w.schedules, [71, 72], name + " restarted script");
    }
});

function stopBeforeCallback(runtime, method) {
    let steps = 0;
    while (!runtime.pending().includes(method + ":callback") && !runtime.err && steps++ < 250) runtime.step();
    assert.ifError(runtime.err);
    assert.ok(runtime.pending().includes(method + ":callback"), "device completed " + method);
    runtime.stop();
}
scenario("S61 interrupted creation never leaves a newly enabled unrecorded job", () => {
    for (const checkpoint of ["Schedule.Create", "KVS.set", "Schedule.Update"]) {
        W = freshWorld(); W.kvs.SmartHeatingConf1 = conf(); W.http = priceServer(PRICE);
        let unrecorded = false;
        W.observe = () => {
            const saved = JSON.parse(W.kvs.SmartHeatingSys1 || "{}").ExistingSchedule;
            if (W.schedules.some(job => job.enable && job.id !== saved)) unrecorded = true;
        };
        let runtime = boot(true); runtime.fcTm(); stopBeforeCallback(runtime, checkpoint);
        const firstId = W.schedules[0].id;
        assert.equal(unrecorded, false, checkpoint + " persists before enabling");
        W.observe = null;
        runtime = boot(true); runtime.fcTm(); runtime.flush();
        const enabled = W.schedules.filter(job => job.enable);
        assert.equal(enabled.length, 1, checkpoint);
        assert.equal(JSON.parse(W.kvs.SmartHeatingSys1).ExistingSchedule, enabled[0].id);
        assert.equal(W.schedules.length, checkpoint === "Schedule.Create" ? 2 : 1);
        assert.equal(W.schedules.find(job => job.id === firstId).enable, checkpoint !== "Schedule.Create");
    }
});
scenario("S62 zero-hour days and restarts retain the recorded schedule ID", () => {
    W.kvs.SmartHeatingConf1 = conf(); W.http = priceServer(PRICE);
    let runtime = boot(); runtime.fcTm(); const id = W.schedules[0].id;
    W.kvs.SmartHeatingConf1 = conf({ HeatingTime: 0 });
    runtime.jumpToNextDay(); runtime.loop();
    assert.equal(W.schedules.length, 1); assert.equal(W.schedules[0].id, id);
    assert.equal(W.schedules[0].enable, false);
    assert.equal(JSON.parse(W.kvs.SmartHeatingSys1).ExistingSchedule, id);
    runtime.stop(); runtime = boot(); runtime.fcTm();
    assert.equal(W.schedules[0].id, id); assert.equal(W.schedules[0].enable, false);
    W.kvs.SmartHeatingConf1 = conf({ HeatingTime: 2 }); runtime.jumpToNextDay(); runtime.loop();
    expectSchedule(runtime, cheapest(EVE.normal, 24, 2, PRICE)); assert.equal(W.schedules[0].id, id);
    assert.equal(W.calls.filter(c => c.method === "Schedule.Create").length, 1);
    assert.equal(W.calls.filter(c => c.method === "Schedule.Delete").length, 0);
});
scenario("S63 failed activation retries the persisted ID", () => {
    W.kvs.SmartHeatingConf1 = conf(); W.http = priceServer(PRICE);
    W.fail["Schedule.Update"] = p => p.enable === true;
    const runtime = boot(true); runtime.advanceBy(1500);
    assert.ifError(runtime.err); assert.equal(W.schedules.length, 1);
    const id = W.schedules[0].id;
    assert.equal(W.schedules[0].enable, false);
    assert.equal(JSON.parse(W.kvs.SmartHeatingSys1).ExistingSchedule, id);
    delete W.fail["Schedule.Update"]; runtime.advanceBy(300000);
    expectSchedule(runtime, cheapest(EVE.normal, 24, 10, PRICE)); assert.equal(W.schedules[0].id, id);
});
scenario("S63a invalid create IDs leave only disabled jobs", () => {
    for (const response of [null, {}, { id: 0 }, { id: -1 }, { id: 1.5 }, { id: "5" }]) {
        W = freshWorld(); W.kvs.SmartHeatingConf1 = conf(); W.http = priceServer(PRICE); W.createResponse = response;
        const runtime = boot(); runtime.fcTm();
        assert.ifError(runtime.err); assert.equal(W.schedules.length, 1);
        assert.equal(W.schedules[0].enable, false);
        assert.equal(JSON.parse(W.kvs.SmartHeatingSys1).ExistingSchedule, 0);
    }
});
scenario("S63b malformed schedule inventories cannot authorize replacement", () => {
    for (const response of [null, {}, { jobs: {} }, { jobs: { length: 0 } }, { jobs: "" }, { jobs: [null] }]) {
        W = freshWorld(); existingHeating(); W.kvs.SmartHeatingConf1 = conf(); W.http = priceServer(PRICE); W.listResponse = response;
        const before = JSON.stringify([W.schedules, W.kvs, W.relayConfig]);
        const runtime = boot(); runtime.fcTm();
        assert.ifError(runtime.err); assert.equal(JSON.stringify([W.schedules, W.kvs, W.relayConfig]), before);
    }
});
scenario("S64 delayed watchdog clearing cannot erase a restarted instance's ID", () => {
    W.kvs.SmartHeatingConf1 = conf(); W.http = priceServer(PRICE);
    let runtime = boot(); runtime.fcTm(); runtime.stop();
    const watchdog = watchdogSandbox(watchdogCopies[1][1], W);
    watchdog.fire(1); watchdog.step(); watchdog.step();
    runtime = boot(); runtime.fcTm(); const record = W.kvs.SmartHeatingSys1;
    watchdog.flush(); assert.equal(W.kvs.SmartHeatingSys1, record);
    expectSchedule(runtime, cheapest(EVE.normal, 24, 10, PRICE));
});
scenario("S65 restart after an in-place update reuses its recorded identity", () => {
    W.kvs.SmartHeatingConf1 = conf(); W.http = priceServer(PRICE);
    let runtime = boot(true); runtime.fcTm(); runtime.flush(); const id = W.schedules[0].id;
    W.http = priceServer(PRICE2); runtime.jumpToNextDay(); runtime.loop();
    stopBeforeCallback(runtime, "Schedule.Update");
    runtime = boot(); runtime.fcTm();
    expectSchedule(runtime, cheapest(EVE.normal, 24, 10, PRICE2)); assert.equal(W.schedules[0].id, id);
});
scenario("S66 two instances sharing a relay retain independent schedules", () => {
    W.kvs.SmartHeatingConf1 = conf(); W.kvs.SmartHeatingConf2 = conf(); W.http = priceServer(PRICE);
    const first = boot(true), second = boot(true, { scriptId: 2 });
    first.fcTm(); second.fcTm(); first.flush(); second.flush();
    assert.ifError(first.err); assert.ifError(second.err);
    const id1 = JSON.parse(W.kvs.SmartHeatingSys1).ExistingSchedule;
    const id2 = JSON.parse(W.kvs.SmartHeatingSys2).ExistingSchedule;
    const other = JSON.stringify(W.schedules.find(s => s.id === id2));
    assert.notEqual(id1, id2);
    W.kvs.SmartHeatingConf1 = conf({ HeatingTime: 2 }); first.jumpToNextDay(); first.loop(); first.flush();
    assert.equal(JSON.stringify(W.schedules.find(s => s.id === id2)), other);
    assert.equal(JSON.parse(W.kvs.SmartHeatingSys1).ExistingSchedule, id1);
    first.stop(); const watchdog = watchdogSandbox(watchdogCopies[1][1], W); watchdog.fire(1); watchdog.flush();
    assert.equal(W.schedules.length, 1); assert.equal(W.schedules[0].id, id2);
});

scenario("S67 a remembered ID is persisted again before reactivation after key deletion", () => {
    W.kvs.SmartHeatingConf1 = conf(); W.http = priceServer(PRICE);
    const runtime = boot(); runtime.fcTm(); const id = W.schedules[0].id;
    delete W.kvs.SmartHeatingSys1;
    W.fail["KVS.set"] = p => p.key === "SmartHeatingSys1";
    runtime.jumpToNextDay(); runtime.loop();
    assert.ifError(runtime.err); assert.equal(W.schedules.length, 1);
    assert.equal(W.schedules[0].id, id); assert.equal(W.schedules[0].enable, false);
    delete W.fail["KVS.set"]; runtime.loop();
    assert.equal(JSON.parse(W.kvs.SmartHeatingSys1).ExistingSchedule, id);
    assert.equal(W.schedules[0].enable, true);
});

scenario("S68 pending watchdog deletion is reconciled on the next tick", () => {
    for (const offline of [false, true]) {
        W = freshWorld(); W.kvs.SmartHeatingConf1 = conf();
        W.http = offline ? () => [null, -114] : priceServer(PRICE);
        let runtime = boot(); runtime.fcTm(); runtime.stop();
        const oldId = W.schedules[0].id;
        const watchdog = watchdogSandbox(watchdogCopies[1][1], W);
        watchdog.fire(1); watchdog.step();
        runtime = boot(true); runtime.fcTm();
        let steps = 0;
        while (!runtime.pending().includes("KVS.set") && !runtime.err && steps++ < 250) runtime.step();
        assert.ifError(runtime.err); assert.ok(runtime.pending().includes("KVS.set"));
        watchdog.flush(); runtime.flush();
        assert.equal(W.schedules.length, 0, "old deletion took effect after restart updated its job");
        const limits = runtime.advanceBy(300000);
        expectSchedule(runtime, offline ? FALLBACK : cheapest(EVE.normal, 24, 10, PRICE));
        assert.notEqual(W.schedules[0].id, oldId, "confirmed absence permits a replacement");
        assert.equal(JSON.parse(W.kvs.SmartHeatingSys1).ExistingSchedule, W.schedules[0].id);
        assert.ok(limits.rpcPeak <= 5 && limits.timerPeak <= 5);
        const before = JSON.stringify([W.kvs, W.schedules, W.relayConfig]);
        W.listResponse = { jobs: { length: 0 } };
        runtime.advanceBy(300000);
        assert.ifError(runtime.err);
        assert.equal(JSON.stringify([W.kvs, W.schedules, W.relayConfig]), before,
            "malformed periodic inventory cannot authorize replacement");
    }
});

const options = process.argv.slice(3);
const filter = options.find(arg => arg.startsWith("--filter="))?.slice("--filter=".length);
const selected = scenarios.filter(({ name }) => !filter || name.startsWith(filter));
if (!selected.length) {
    console.error("No scenarios match " + filter);
    process.exit(1);
}
if (options.includes("--reverse")) selected.reverse();
if (options.includes("--list")) {
    console.log(selected.map(({ name }) => name).join("\n"));
    process.exit(0);
}
for (const test of selected) runScenario(test);

console.log(failures === 0 ? "\nALL SPEC CHECKS PASSED" : "\n" + failures + " SPEC FAILURES");
process.exitCode = failures === 0 ? 0 : 1;
