// Implementation-agnostic requirement suite for SmartHeatingWidthShelly.js.
// Asserts WHAT the script must do, never HOW. Safe for TDD and merge gating.
// Run: TZ=Europe/Tallinn node tests/spec.js <path-to-script>
const fs = require("fs");
const vm = require("vm");
const SRC = fs.readFileSync(process.argv[2], "utf8");

const RealDate = global.Date;
const EVE = { // fetch instants: the evening before the target day, 23:30 local
    normal: "2026-01-13T23:30:00+02:00", // target Wed Jan 14 (24h)
    spring: "2026-03-28T23:30:00+02:00", // target Sun Mar 29 (23h)
    autumn: "2026-10-24T23:30:00+03:00", // target Sun Oct 25 (25h)
};
let FIXED_MS = new RealDate(EVE.normal).getTime();
class Date extends RealDate {
    constructor(...a) { a.length === 0 ? super(FIXED_MS) : super(...a); }
    static now() { return FIXED_MS; }
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
        kvs: {}, schedules: [], deleted: [], nextId: 5,
        scripts: [{ id: 3, name: "watchdog" }], running: { 3: true },
        vcs: [], vDeleted: [], http: null, fail: {}, lastUrl: null,
        putCode: 0, ignoreKeys: false, relayConfigs: [], kvsWrites: [], addAttempts: [],
        device: { gen: 2, app: "Plus1PM", ver: "1.4.4" },
        sysConfig: { location: { lat: 59.44, lon: 24.75 } },
        unixtime: FIXED_MS / 1000,
    };
}
const prints = [];
function print(...a) { prints.push(a.join(" ")); }
function atob(b) { return Buffer.from(b, "base64").toString("latin1"); }
const Timer = { set: (ms, rep, cb, d) => { if (!rep) cb(d); return 1; }, clear: () => { } };
const Shelly = {
    getCurrentScriptId: () => 1,
    getDeviceInfo: () => W.device,
    getComponentConfig: (n) => n === "sys" ? W.sysConfig : n === "switch" ? W.relayConfig : { enable: true },
    getComponentStatus: (n, id) => {
        if (n === "sys") return { unixtime: W.unixtime };
        if (n === "script" && id !== undefined && id !== 1) {
            const ex = W.scripts.find(s => s.id === id);
            return ex ? { running: !!W.running[id], mem_used: 1, mem_peak: 2 } : null;
        }
        return { running: true, mem_used: 1, mem_peak: 2 };
    },
    call: (m, p, cb, ud) => {
        const done = (r, e, s) => { if (cb) cb(r, e || 0, s || "", ud); };
        if (m === "Virtual.Add") W.addAttempts.push(p.type + ":" + p.id);
        if (W.fail[m] && (typeof W.fail[m] !== "function" || W.fail[m](p))) return done(null, -1, "forced failure");
        switch (m) {
            case "KVS.Get": return W.kvs[p.key] !== undefined ? done({ value: W.kvs[p.key] }, 0) : done(null, -105, "not found");
            case "KVS.set": case "KVS.Set": W.kvsWrites.push(p.key); W.kvs[p.key] = p.value; return done({}, 0);
            case "HTTP.GET": { W.lastUrl = p.url; const r = W.http(p); return done(r[0], r[1], ""); }
            case "Switch.SetConfig": W.relayConfigs.push(p.config); return done({}, 0);
            case "Schedule.Delete": {
                const i = W.schedules.findIndex(s => s.id === p.id);
                if (i === -1) return done(null, -103, "no such schedule");
                W.deleted.push(p.id); W.schedules.splice(i, 1); return done({}, 0);
            }
            case "Schedule.Create": {
                const id = W.nextId++;
                W.schedules.push({ id, timespec: p.timespec, calls: p.calls });
                return done({ id }, 0);
            }
            case "Schedule.List": return done({ jobs: W.schedules.map(s => ({ id: s.id, timespec: s.timespec })) }, 0);
            case "Script.List": return done({ scripts: W.scripts.slice() }, 0);
            case "Script.Create": { W.scripts.push({ id: 9, name: p.name }); W.running[9] = false; return done({ id: 9 }, 0); }
            case "Script.Stop": W.running[p.id] = false; return done({}, 0);
            case "Script.Start": W.running[p.id] = true; return done({}, 0);
            case "Script.SetConfig": return done({ id: p.id }, 0);
            case "Script.PutCode": W.wdCode = p.code; W.putCode++; return done({ id: p.id }, 0);
            case "Shelly.GetComponents": {
                // models a keys-capable, PAGINATED firmware: filters by p.keys, pages by p.offset
                let list = W.vcs.slice();
                if (p.keys && !W.ignoreKeys) list = list.filter(v => p.keys.indexOf(v.key) !== -1);
                const ps = W.pageSize || 1000;
                const off = p.offset || 0;
                const components = list.slice(off, off + ps).map(v => {
                    const entry = { key: v.key };
                    if (!p.include || p.include.includes("status")) entry.status = v.status;
                    if (!p.include || p.include.includes("config")) entry.config = v.config;
                    return entry;
                });
                return done({ components, total: list.length, offset: off }, 0);
            }
            case "Virtual.Delete": {
                W.vDeleted.push(p.key);
                W.vcs = W.vcs.filter(v => v.key !== p.key);
                return done({}, 0);
            }
            case "Virtual.Add": {
                W.vcs.push({ key: p.type + ":" + p.id, config: p.config, status: { value: p.config.default_value } });
                return done({ id: p.id }, 0);
            }
            case "Group.Set": return done({}, 0);
            default: throw new Error("unstubbed: " + m);
        }
    },
};
// Each candidate runs in its own VM context. A hung parser or loop becomes a
// scenario failure instead of stopping the rest of the suite.
function boot(queued) {
    const queue = [], timers = new Set();
    let now = 0, nextTimer = 0, rpcCount = 0, rpcPeak = 0, timerPeak = 0;
    const asyncShelly = Object.assign({}, Shelly, { call: (m, p, cb, ud) => {
        rpcCount++; rpcPeak = Math.max(rpcPeak, rpcCount);
        queue.push({ at: now + 10, run: () => { rpcCount--; Shelly.call(m, p, cb, ud); } });
    } });
    const asyncTimer = {
        set: (ms, rep, cb, data) => {
            const id = ++nextTimer;
            timers.add(id); timerPeak = Math.max(timerPeak, timers.size);
            if (!rep) queue.push({ at: now + ms, run: () => {
                if (timers.delete(id)) cb(data);
            } });
            return id;
        },
        clear: id => timers.delete(id),
    };
    const ctx = vm.createContext({ Shelly: queued ? asyncShelly : Shelly, Timer: queued ? asyncTimer : Timer, print, atob, Date, console: { log: print } });
    const t = {
        err: null,
        drive: (code) => {
            t.err = null;
            try { return vm.runInContext(code, ctx, { timeout: 3000 }); }
            catch (e) { t.err = e; return undefined; }
        },
    };
    t.flush = () => {
        let steps = 0;
        while (queue.length && !t.err && steps++ < 500) {
            queue.sort((a, b) => a.at - b.at);
            const event = queue.shift(); now = event.at;
            ctx.runCallback = event.run;
            t.drive("runCallback()");
        }
        if (queue.length && !t.err) t.err = new Error("Asynchronous work did not settle");
        return { rpcPeak, timerPeak };
    };
    t.drive(SRC);
    t.fcTm = () => t.drive("fcTm()");
    t.loop = () => t.drive("loop()");
    t.stale = () => t.drive("_.tsPr = 0");
    t.verC = (oldV, newV) => t.drive("verC(" + JSON.stringify(oldV) + "," + JSON.stringify(newV) + ")");
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
            rows.push('"' + (t / 1000) + '";"x";"' + priceFn(new RealDate(t).getHours()).toFixed(2).replace(".", ",") + '"');
        }
        if (opts.truncate !== undefined) rows = rows.slice(0, opts.truncate);
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
        grp.sort((a, b) => priceFn(a) - priceFn(b));
        for (const h of grp.slice(0, hTim)) out.push(h);
    }
    return out.sort((a, b) => a - b).join(",");
}
function specHours(t) { return t ? t.split(" ")[2] : null; } // hour field of a timespec
const PRICE = h => (h * 7) % 24 + 10; // distinct per hour, all far from lowR=1 / higR=300
const FALLBACK = "0,1,2,3,4,5,6,7,8,9"; // documented offline hours for tPer 24, hTim 10
function conf(over) {
    const b = { TimePeriod: 24, HeatingTime: 10, IsForecastUsed: false, EnergyProvider: "NONE",
        AlwaysOnPrice: 1, AlwaysOffPrice: 300, InvertedRelay: false, RelayId: 0,
        Country: "ee", HeatingCurve: 0, ManualKVS: true };
    return JSON.stringify(Object.assign(b, over || {}));
}
let failures = 0;
function check(name, cond, detail) {
    if (cond) console.log("PASS", name);
    else { failures++; console.log("FAIL", name, "--", detail === undefined ? "" : JSON.stringify(detail)); }
}

// =====================================================================
// S1. A normal day yields the cheapest configured hours, relay set to heat.
W = freshWorld();
W.kvs["SmartHeatingConf1"] = conf();
W.http = priceServer(PRICE);
let t = boot();
t.fcTm();
check("S1 cheapest 10 hours scheduled", specHours(W.schedules[0] && W.schedules[0].timespec) === cheapest(EVE.normal, 24, 10, PRICE), W.schedules[0]);
check("S1 schedule turns the relay on", W.schedules[0] && W.schedules[0].calls[0].params.on === true);

// S2. The parser terminates and yields the same result without a trailing newline.
W = freshWorld();
W.kvs["SmartHeatingConf1"] = conf();
W.http = (p) => { const r = priceServer(PRICE)(p); const csv = atob(r[0].body_b64).replace(/\n$/, ""); return [{ code: 200, body_b64: Buffer.from(csv, "latin1").toString("base64") }, 0]; };
t = boot();
t.fcTm();
check("S2 no trailing newline: same schedule", specHours(W.schedules[0] && W.schedules[0].timespec) === cheapest(EVE.normal, 24, 10, PRICE), W.schedules[0]);

// S3. Truncated data must never pass as a complete day.
// 24 quarter-records covering six hours: accept -> wrong; reject -> offline fallback.
W = freshWorld();
W.kvs["SmartHeatingConf1"] = conf();
W.http = priceServer(PRICE, { truncate: 24 });
t = boot();
t.fcTm();
{
    const got = specHours(W.schedules[0] && W.schedules[0].timespec);
    const ok = got === FALLBACK || got === cheapest(EVE.normal, 24, 10, PRICE);
    check("S3 six hours of quarters not accepted as a full day", ok, got);
}

// S4. DST days: the requested window covers exactly the target local day,
// and the schedule holds the real cheapest hours of that day, no duplicates.
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

// S5. Winter weekend mornings are night rate: with VORK5 on a Saturday the
// cheap-energy hours 09-11 must be selected (a peak-fee bug would skip them).
FIXED_MS = new RealDate("2026-01-09T23:30:00+02:00").getTime(); // eve of Sat Jan 10
W = freshWorld();
W.kvs["SmartHeatingConf1"] = conf({ EnergyProvider: "VORK5", HeatingTime: 4 });
W.http = priceServer(h => (h >= 9 && h < 12) ? 20 : 40);
t = boot();
t.fcTm();
{
    const got = (specHours(W.schedules[0] && W.schedules[0].timespec) || "").split(",");
    const ok = got.indexOf("9") !== -1 && got.indexOf("10") !== -1 && got.indexOf("11") !== -1;
    check("S5 Saturday 09-11 cheap energy is used despite winter peak windows", ok, got.join(","));
}
FIXED_MS = new RealDate(EVE.normal).getTime();

// S6. Forecast rules: warm day -> no forced heating; mild -> user minimum; cold -> full period.
function fcRun(temps, hTim) {
    W = freshWorld();
    W.kvs["SmartHeatingConf1"] = conf({ TimePeriod: 6, HeatingTime: hTim, IsForecastUsed: true });
    W.http = (p) => p.url.indexOf("open-meteo") !== -1
        ? [{ code: 200, body: JSON.stringify({ hourly: { time: [], apparent_temperature: temps } }) }, 0]
        : priceServer(PRICE)(p);
    t = boot();
    t.fcTm();
    return specHours(W.schedules[0] && W.schedules[0].timespec);
}
check("S6 warm forecast: no heating hours forced", fcRun([20, 20, 20, 20, 20, 20], 2) === null, W.schedules[0]);
check("S6 mild forecast: user minimum applies", fcRun([10, 10, 10, 10, 10, 10], 2) === cheapest(EVE.normal, 6, 2, PRICE).split(",").filter(h => Number(h) < 6).join(","), W.schedules[0]);
check("S6 cold forecast: full period heating", fcRun([-40, -40, -40, -40, -40, -40], 2) === "0,1,2,3,4,5", W.schedules[0]);

// S6b. A missing device location must not crash and must not end heating management.
W = freshWorld();
W.sysConfig = { location: null };
W.kvs["SmartHeatingConf1"] = conf({ IsForecastUsed: true });
W.http = priceServer(PRICE);
t = boot();
t.fcTm();
check("S6b no crash without location, fallback schedule exists", !t.err && specHours(W.schedules[0] && W.schedules[0].timespec) === FALLBACK,
    [String(t.err || ""), W.schedules[0]]);

// S7. Liveness: after one failed cycle, the next healthy cycle must schedule correctly.
const PRICE2 = h => (h * 5) % 24 + 10; //different ordering exposes a stuck first-cycle schedule
function recovers(name, breakFn, healFn, stale) {
    W = freshWorld();
    W.kvs["SmartHeatingConf1"] = conf();
    W.http = priceServer(PRICE);
    breakFn();
    t = boot();
    t.fcTm();
    const crashed = !!t.err;
    healFn();
    let exp = cheapest(EVE.normal, 24, 10, PRICE);
    if (stale) {
        W.http = priceServer(PRICE2);
        exp = cheapest(EVE.normal, 24, 10, PRICE2);
        t.stale();
    }
    if (!crashed) t.loop(); // the regular 5-minute tick
    const got = W.schedules.length ? specHours(W.schedules[W.schedules.length - 1].timespec) : null;
    check("S7 " + name, !crashed && !t.err && got === exp, [String(t.err || ""), got]);
}
recovers("recovers after Elering outage", () => { W.http = () => [null, -114]; }, () => { W.http = priceServer(PRICE); }, false);
recovers("recovers after Schedule.Create failure", () => { W.fail["Schedule.Create"] = true; }, () => { delete W.fail["Schedule.Create"]; }, false);
recovers("recovers after watchdog list failure", () => { W.fail["Script.List"] = true; }, () => { delete W.fail["Script.List"]; }, true);

// S7b. A transient component read must never replace user settings with defaults.
const VC_SET = [
    ["group:200", "Smart Heating", null], ["enum:200", "Heating Period (h)", "12"],
    ["number:200", "Min On Time (h/period)", 5], ["enum:201", "Network Package", "NONE"],
    ["number:201", "Heat On (min price)", 1], ["number:202", "Heat Off (max price)", 300],
    ["boolean:201", "Inverted Relay", false], ["enum:202", "Market Price Country", "ee"],
    ["boolean:200", "Forecast Heat", false], ["number:203", "Forecast Impact +/-", 0],
];
W = freshWorld();
W.device = { gen: 3, app: "Mini1G3", ver: "1.4.4" };
W.kvs["SmartHeatingSys1"] = JSON.stringify({ LastCalculation: 0, ExistingSchedule: 0, Version: 4.9, VcInstalled: true });
W.vcs = VC_SET.map(e => ({ key: e[0], config: { name: e[1] }, status: { value: e[2] } }));
W.http = priceServer(PRICE);
W.fail["Shelly.GetComponents"] = true;
t = boot();
t.fcTm();
delete W.fail["Shelly.GetComponents"];
t.loop();
{
    const userExp = cheapest(EVE.normal, 12, 5, PRICE);
    const defExp = cheapest(EVE.normal, 24, 10, PRICE);
    const everDefault = W.schedules.some(s => specHours(s.timespec) === defExp) || W.deleted.length > W.schedules.length + 1;
    const finalOk = W.schedules.length > 0 && specHours(W.schedules[W.schedules.length - 1].timespec) === userExp;
check("S7b transient VC read never yields a defaults schedule", !everDefault && finalOk, W.schedules.map(s => s.timespec));
}

// S7c. Missing SystemData must recover a complete VC configuration immediately,
// install when no reserved controls exist, and leave unverified partial sets untouched.
W = freshWorld();
W.device = { gen: 3, app: "Mini1G3", ver: "1.4.4" };
W.vcs = VC_SET.map(e => ({ key: e[0], config: { name: e[1] }, status: { value: e[2] } }));
W.http = priceServer(PRICE);
t = boot();
t.fcTm();
check("S7c missing SystemData: complete controls recover immediately",
    W.schedules.length === 1 && specHours(W.schedules[0].timespec) === cheapest(EVE.normal, 12, 5, PRICE),
    W.schedules.map(s => s.timespec));
check("S7c missing SystemData: recovery neither adds nor deletes controls",
    W.vcs.length === VC_SET.length && W.vDeleted.length === 0, [W.vcs.length, W.vDeleted]);

W = freshWorld();
W.device = { gen: 3, app: "Mini1G3", ver: "1.4.4" };
W.http = priceServer(PRICE);
t = boot();
t.fcTm();
check("S7c missing SystemData: empty reserved slots install controls",
    W.vcs.length === VC_SET.length && W.vDeleted.length === 0 && W.schedules.length === 1,
    [W.vcs.length, W.vDeleted, W.schedules.length]);

W = freshWorld();
W.device = { gen: 3, app: "Mini1G3", ver: "1.4.4" };
W.vcs = [{ key: "enum:200", config: { name: "Heating Period (h)" }, status: { value: "12" } }];
W.http = priceServer(PRICE);
const partialLogStart = prints.length;
t = boot();
t.fcTm();
check("S7c missing SystemData: partial controls are left untouched",
    W.vcs.length === 1 && W.vDeleted.length === 0 && W.schedules.length === 0 &&
    W.relayConfigs.length === 0 && Object.keys(W.kvs).length === 0,
    [W.vcs.length, W.vDeleted, W.schedules.length]);
check("S7c missing SystemData: ambiguous recovery is explained",
    prints.slice(partialLogStart).some(line => /incomplete|partial|ambiguous/i.test(line)),
    prints.slice(partialLogStart));

// A missing optional control must not replace an installed inverted-relay
// configuration with defaults or stale KVS settings, even across retries.
for (const savedConfig of [undefined, conf({ ManualKVS: false })]) {
    W = freshWorld();
    W.device = { gen: 3, app: "Mini1G3", ver: "1.4.4" };
    if (savedConfig !== undefined) W.kvs.SmartHeatingConf1 = savedConfig;
    W.kvs.SmartHeatingSys1 = JSON.stringify({ ExistingSchedule: 41, Version: 4.9 });
    const controls = VC_SET.map(e => {
        let value = e[2];
        if (e[0] === "boolean:201") value = true; // Inverted relay
        if (e[0] === "number:200") value = 2;     // Heating hours
        return {
            key: e[0], config: { name: e[1] },
            status: { value },
        };
    });
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
        !t.err && W.schedules.length === 1 && schedule.id !== 41 &&
        W.deleted.indexOf(41) !== -1 && specHours(schedule.timespec) === expectedHours,
        [String(t.err || ""), W.schedules]);
    check("S7c restored control, " + label + ": inverted relay settings restored",
        schedule && schedule.calls[0].params.on === false &&
        relay && relay.auto_on === true && relay.auto_off === false,
        [schedule, relay]);
}

// S7d. Local RPC failures must leave the last working schedule intact and retry later.
function preservesSchedule(name, method) {
    W = freshWorld();
    W.kvs["SmartHeatingConf1"] = conf();
    W.http = priceServer(PRICE);
    t = boot();
    t.fcTm();
    const oldId = W.schedules[0].id;
    W.fail[method] = true;
    t.stale();
    t.loop();
    const preserved = W.schedules.length === 1 && W.schedules[0].id === oldId && W.deleted.indexOf(oldId) === -1;
    delete W.fail[method];
    t.loop();
    const replaced = W.schedules.length === 1 && W.schedules[0].id !== oldId && W.deleted.indexOf(oldId) !== -1;
    check("S7d " + name + " preserves then replaces the working schedule", preserved && replaced,
        [W.schedules.map(s => s.id), W.deleted]);
}
preservesSchedule("relay timer failure", "Switch.SetConfig");
preservesSchedule("schedule deletion failure", "Schedule.Delete");

// A stale persisted schedule id is safe to replace once Schedule.List confirms it is absent.
W = freshWorld();
W.kvs["SmartHeatingConf1"] = conf();
W.kvs["SmartHeatingSys1"] = JSON.stringify({ LastCalculation: 0, ExistingSchedule: 44, Version: 5 });
W.http = priceServer(PRICE);
t = boot();
t.fcTm();
check("S7d stale schedule id is recovered", W.schedules.length === 1 && W.schedules[0].id === 5, W.schedules);

// S8. Components this script did not create are never deleted.
for (const [name, comps] of [
    ["look-alike on a reserved key", [{ key: "enum:200", config: { name: "Heating Period (h)" }, status: { value: "12" } }]],
    ["foreign name on a reserved key", [{ key: "enum:200", config: { name: "Thermostat Mode" }, status: { value: "eco" } }]],
]) {
    W = freshWorld();
    W.device = { gen: 3, app: "Mini1G3", ver: "1.4.4" };
    W.vcs = comps.slice();
    W.http = priceServer(PRICE);
    t = boot();
    t.fcTm();
    check("S8 " + name + " is left untouched without scheduling unverified settings",
        W.vDeleted.length === 0 && W.vcs.length === comps.length &&
        W.schedules.length === 0 && W.relayConfigs.length === 0 && Object.keys(W.kvs).length === 0,
        [W.vDeleted, W.schedules.length, W.kvs]);
}

// S9. Unsupported packages are reported without rewriting user settings or applying guessed settings.
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

// S10. Virtual component enums deliver strings: schedules must stay valid.
W = freshWorld();
W.kvs["SmartHeatingConf1"] = conf({ TimePeriod: "6", HeatingTime: 10 });
W.http = () => [null, -114]; // offline: fallback path does the arithmetic
t = boot();
t.fcTm();
{
    const got = (specHours(W.schedules[0] && W.schedules[0].timespec) || "").split(",");
    const ok = got.length > 0 && got.length <= 24 && new Set(got).size === got.length;
    check("S10 string period config: fallback hours are unique and bounded", ok, got.join(","));
}

// S11. Devices with many dynamic components paginate Shelly.GetComponents.
// The script must read all pages: user settings apply, nothing foreign is touched.
function manyForeign(n) {
    const a = [];
    for (let i = 0; i < n; i++) a.push({ key: "bthomesensor:" + (200 + i), config: { name: "BT sensor " + i }, status: { value: i } });
    return a;
}
W = freshWorld();
W.device = { gen: 3, app: "Mini1G3", ver: "1.4.4" };
W.pageSize = 4; //the nine requested settings span three filtered pages
W.vcs = manyForeign(25).concat(VC_SET.map(e => ({ key: e[0], config: { name: e[1] }, status: { value: e[2] } })));
W.kvs["SmartHeatingSys1"] = JSON.stringify({ LastCalculation: 0, ExistingSchedule: 0, Version: 4.9, VcInstalled: true });
W.http = priceServer(PRICE);
t = boot();
t.fcTm();
check("S11 paginated read: user settings applied, not defaults",
    W.schedules.length > 0 && specHours(W.schedules[W.schedules.length - 1].timespec) === cheapest(EVE.normal, 12, 5, PRICE),
    W.schedules.map(s => s.timespec));
check("S11 paginated read: nothing deleted", W.vDeleted.length === 0, W.vDeleted);

// Firmware before 1.5 ignores the keys filter, so the reader must page through foreign components client-side.
W = freshWorld();
W.device = { gen: 3, app: "Mini1G3", ver: "1.4.4" };
W.pageSize = 7;
W.ignoreKeys = true;
W.vcs = manyForeign(25).concat(VC_SET.map(e => ({ key: e[0], config: { name: e[1] }, status: { value: e[2] } })));
W.kvs["SmartHeatingSys1"] = JSON.stringify({ LastCalculation: 0, ExistingSchedule: 0, Version: 4.9 });
W.http = priceServer(PRICE);
t = boot();
t.fcTm();
check("S11 pre-1.5 ignored keys: all pages read client-side",
    W.schedules.length > 0 && specHours(W.schedules[W.schedules.length - 1].timespec) === cheapest(EVE.normal, 12, 5, PRICE),
    W.schedules.map(s => s.timespec));
check("S11 pre-1.5 ignored keys: foreign components untouched", W.vDeleted.length === 0, W.vDeleted);

// fresh install on a crowded device: install completes, foreign components survive
W = freshWorld();
W.device = { gen: 3, app: "Mini1G3", ver: "1.4.4" };
W.pageSize = 4;
W.ignoreKeys = true;
W.vcs = manyForeign(5);
W.http = priceServer(PRICE);
t = boot();
t.fcTm();
check("S11 crowded fresh install: 10 own added, nothing deleted",
    W.vcs.length === 15 && W.vDeleted.length === 0, [W.vcs.length, W.vDeleted]);
check("S11 crowded fresh install: heating scheduled", W.schedules.length > 0, W.schedules.length);

// S12. The embedded watchdog code must be correct on its own. It is executed
// here in a sandbox with queued (asynchronous) RPC, as on the device.
W = freshWorld();
W.kvs["SmartHeatingConf1"] = conf();
W.http = priceServer(PRICE);
t = boot();
t.fcTm(); // the install captured the code in W.wdCode
{
    const code = W.wdCode;
    check("S12 watchdog code captured from Script.PutCode", typeof code === "string" && code.length > 0, typeof code);
    function wdWorld() {
        return {
            kvs: {
                SmartHeatingSys1: JSON.stringify({ ExistingSchedule: 71, Version: 4.9 }),
                SmartHeatingSys2: JSON.stringify({ ExistingSchedule: 72, Version: 4.9 }),
            },
            schedules: [71, 72], failDel: {},
        };
    }
    function sandbox(w) {
        const q = [];
        let handler = null;
        const S = {
            addStatusHandler: h => { handler = h; },
            call: (m, p, cb, ud) => {
                q.push(() => {
                    const done = (r, e, ms) => { if (cb) cb(r, e || 0, ms || "", ud); };
                    if (m === "KVS.Get") return w.kvs[p.key] !== undefined ? done({ value: w.kvs[p.key] }, 0) : done(null, -105, "");
                    if (m === "KVS.set" || m === "KVS.Set") { w.kvs[p.key] = p.value; return done({}, 0); }
                    if (m === "Schedule.Delete") {
                        if (w.failDel[p.id]) return done(null, -1, "fail");
                        const ix = w.schedules.indexOf(p.id);
                        if (ix === -1) return done(null, -103, "");
                        w.schedules.splice(ix, 1); return done({}, 0);
                    }
                    throw new Error("wd unstubbed " + m);
                });
            },
        };
        new Function("Shelly", "print", code)(S, () => { });
        return { fire: e => handler(e), flush: () => { let g = 0; while (q.length && g++ < 100) q.shift()(); } };
    }
    let w = wdWorld(), sb = sandbox(w);
    sb.fire({ name: "script", id: 1, delta: { running: false } });
    sb.flush();
    check("S12 stop deletes the schedule and clears the stored id",
        w.schedules.indexOf(71) === -1 && JSON.parse(w.kvs.SmartHeatingSys1).ExistingSchedule === 0, w.kvs.SmartHeatingSys1);
    w = wdWorld(); w.failDel[71] = true; sb = sandbox(w);
    sb.fire({ name: "script", id: 1, delta: { running: false } });
    sb.flush();
    check("S12 failed deletion keeps the stored id for a retry",
        JSON.parse(w.kvs.SmartHeatingSys1).ExistingSchedule === 71, w.kvs.SmartHeatingSys1);
    w = wdWorld(); sb = sandbox(w);
    sb.fire({ name: "script", id: 1, delta: { running: false } });
    sb.fire({ name: "script", id: 2, delta: { running: false } });
    sb.flush();
    check("S12 concurrent stops update each script's own record",
        JSON.parse(w.kvs.SmartHeatingSys1).ExistingSchedule === 0 && JSON.parse(w.kvs.SmartHeatingSys2).ExistingSchedule === 0,
        [w.kvs.SmartHeatingSys1, w.kvs.SmartHeatingSys2]);
}

// S13. Minimum firmware comparison is inclusive, and a healthy watchdog is not rewritten to flash each cycle.
W = freshWorld();
t = boot();
check("S13 minimum firmware version is accepted", t.verC("1.4.3", "1.4.3") === true);
check("S13 older firmware version is rejected", t.verC("1.4.3", "1.4.2") === false);

W = freshWorld();
W.kvs["SmartHeatingConf1"] = conf();
W.http = priceServer(PRICE);
t = boot();
t.fcTm();
t.stale();
t.loop();
const noRewriteWhileRunning = W.putCode === 1;
W.running[3] = false;
t.stale();
t.loop();
check("S13 watchdog is written once and restarted without a rewrite", noRewriteWhileRunning && W.putCode === 1 && W.running[3] === true,
    [W.putCode, W.running]);

// S14. Every mid-row truncation must terminate, fall back, then recover next cycle.
function changeCsv(transform, opts) {
    return p => {
        const r = priceServer(PRICE, opts)(p);
        r[0].body_b64 = Buffer.from(transform(atob(r[0].body_b64)), "latin1").toString("base64");
        return r;
    };
}
for (const lastRow of [false, true]) {
    const bad = [];
    // The fixture's quoted row is 24 characters long, including all three fields.
    for (let cut = 0; cut < 24; cut++) {
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
for (const [name, transform] of [
    ["CRLF", csv => csv.replace(/\n/g, "\r\n")],
    ["CRLF without final newline", csv => csv.trimEnd().replace(/\n/g, "\r\n")],
]) {
    W = freshWorld(); W.kvs.SmartHeatingConf1 = conf(); W.http = changeCsv(transform);
    t = boot(); t.fcTm();
    check("S14 " + name + " gives correct hours", !t.err && W.schedules.length === 1 && specHours(W.schedules[0].timespec) === cheapest(EVE.normal, 24, 10, PRICE), String(t.err || ""));
}
for (const [name, transform] of [
    ["missing price quote", csv => csv.replace(';"10,00"', ';"10,00')],
    ["nonnumeric price", csv => csv.replace('"10,00"', '"unknown"')],
    ["infinite price", csv => csv.replace('"10,00"', '"Infinity"')],
    ["duplicate quarter with correct row count", csv => { const rows = csv.split("\n"); rows[2] = rows[1]; return rows.join("\n"); }],
    ["missing quarter", csv => { const rows = csv.split("\n"); rows.splice(2, 1); return rows.join("\n"); }],
]) {
    W = freshWorld(); W.kvs.SmartHeatingConf1 = conf(); W.http = changeCsv(transform);
    t = boot(); t.fcTm();
    check("S14 " + name + " falls back", !t.err && W.schedules.length === 1 && specHours(W.schedules[0].timespec) === FALLBACK, String(t.err || ""));
}
W = freshWorld(); W.kvs.SmartHeatingConf1 = conf(); W.http = priceServer(PRICE, { hourly: true });
t = boot(); t.fcTm();
check("S14 hourly rows still require offline fallback", !t.err && W.schedules.length === 1 && specHours(W.schedules[0].timespec) === FALLBACK);

// S15. A failed addition is retried without duplicating or resetting surviving controls.
function vcWorld() {
    W = freshWorld();
    W.device = { gen: 3, app: "Mini1G3", ver: "1.4.4" };
    W.http = priceServer(PRICE);
}
for (const key of VC_SET.map(e => e[0])) {
    vcWorld();
    W.fail["Virtual.Add"] = p => p.type + ":" + p.id === key;
    t = boot(); t.fcTm();
    const saved = W.kvs.SmartHeatingVC1;
    const survivors = JSON.stringify(W.vcs);
    const count = W.addAttempts.length;
    t.loop();
    const bounded = W.addAttempts.length === count + 1 && JSON.stringify(W.vcs) === survivors;
    delete W.fail["Virtual.Add"];
    t = boot(); t.fcTm(); // persistent backup also survives script restarts
    check("S15 failed " + key + " resumes across retry and restart",
        saved !== undefined && bounded && !t.err && W.vcs.length === VC_SET.length &&
        new Set(W.vcs.map(v => v.key)).size === VC_SET.length && W.vDeleted.length === 0 && W.schedules.length === 1,
        [String(t.err || ""), W.addAttempts]);
}
for (const keepBackup of [false, true]) {
    vcWorld(); t = boot(); t.fcTm();
    W.vcs = [];
    if (!keepBackup) delete W.kvs.SmartHeatingVC1;
    t = boot(); t.fcTm();
    check("S15 version 5 reinstall " + (keepBackup ? "with" : "without") + " backup",
        !t.err && W.vcs.length === VC_SET.length && W.schedules.length === 1 && W.vDeleted.length === 0,
        [String(t.err || ""), W.vcs.length]);
}

// Capture a complete user's settings, then remove each control in turn.
for (const missing of VC_SET.slice(1).map(e => e[0])) {
    vcWorld();
    W.pageSize = 3;
    W.ignoreKeys = true;
    W.vcs = manyForeign(4).concat(VC_SET.map(e => ({
        key: e[0], config: { name: e[1] }, status: { value: e[0] === "boolean:201" ? true : e[2] },
    })));
    t = boot(); t.fcTm();
    const value = W.vcs.find(v => v.key === missing).status.value;
    W.vcs = W.vcs.filter(v => v.key !== missing);
    // A surviving setting changed since backup must be retained.
    if (missing !== "number:200") W.vcs.find(v => v.key === "number:200").status.value = 2;
    const survivors = JSON.stringify(W.vcs);
    t = boot(); t.fcTm();
    const restored = W.vcs.find(v => v.key === missing);
    const schedule = W.schedules[0];
    check("S15 missing " + missing + " restores its saved value without changing survivors",
        !t.err && restored && restored.status.value === value && JSON.stringify(W.vcs.filter(v => v.key !== missing)) === survivors &&
        W.vDeleted.length === 0 && W.schedules.length === 1 && schedule.calls[0].params.on === false &&
        specHours(schedule.timespec) === cheapest(EVE.normal, 12, missing === "number:200" ? 5 : 2, PRICE),
        [String(t.err || ""), restored, schedule]);
}
vcWorld();
W.fail["KVS.set"] = p => p.key === "SmartHeatingVC1";
t = boot(); t.fcTm();
check("S15 new installation waits for persistent recovery data", !t.err && W.addAttempts.length === 0 && W.schedules.length === 0);
delete W.fail["KVS.set"]; t.loop();
check("S15 installation recovers after backup write failure", !t.err && W.vcs.length === VC_SET.length && W.schedules.length === 1);

vcWorld();
W.vcs = VC_SET.map(e => ({ key: e[0], config: { name: e[1] }, status: { value: e[2] } }));
W.fail["KVS.set"] = p => p.key === "SmartHeatingVC1";
t = boot(); t.fcTm();
check("S15 backup write failure does not block complete usable controls", !t.err && W.schedules.length === 1 && specHours(W.schedules[0].timespec) === cheapest(EVE.normal, 12, 5, PRICE));

vcWorld(); t = boot(); t.fcTm();
const backupWrites = () => W.kvsWrites.filter(key => key === "SmartHeatingVC1").length;
const initialWrites = backupWrites();
t.stale(); t.loop(); t = boot(); t.fcTm();
check("S15 unchanged backup is not rewritten across cycles or restarts", initialWrites === 1 && backupWrites() === initialWrites, W.kvsWrites);
W.vcs.find(v => v.key === "number:200").status.value = 2;
t.stale(); t.loop();
check("S15 changed values update the compact backup once", backupWrites() === initialWrites + 1 && JSON.parse(W.kvs.SmartHeatingVC1)[1] === 2 && Buffer.byteLength(W.kvs.SmartHeatingVC1) <= 253, W.kvs.SmartHeatingVC1);

for (const invalidBackup of [false, true]) {
    vcWorld(); t = boot(); t.fcTm();
    W.vcs = W.vcs.filter(v => v.key !== "boolean:201");
    if (invalidBackup) W.kvs.SmartHeatingVC1 = "invalid JSON";
    else W.vcs.find(v => v.key === "enum:200").config.name = "Other thermostat";
    const before = JSON.stringify([W.vcs, W.schedules, W.kvs]);
    t = boot(); t.fcTm();
    check("S15 " + (invalidBackup ? "invalid backup" : "foreign reserved control") + " blocks unsafe repair",
        !t.err && JSON.stringify([W.vcs, W.schedules, W.kvs]) === before && W.vDeleted.length === 0, String(t.err || ""));
}

// S16. A failed timer update may proceed only with a verified equivalent existing timer.
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
W.fail["Switch.SetConfig"] = true;
const diagnosticStart = prints.length;
t.stale(); t.loop();
check("S16 local error identifies the recorded schedule being preserved", W.schedules[0].id === preservedId && prints.slice(diagnosticStart).some(line => line.includes("Keeping recorded schedule ID " + preservedId + ".")));

// S17. Queue RPCs and timers as on the device, including a failed install and repair.
vcWorld(); W.pageSize = 3; W.ignoreKeys = true; W.vcs = manyForeign(5);
W.fail["Virtual.Add"] = p => p.type === "boolean" && p.id === 201;
t = boot(true); t.fcTm(); const installLimits = t.flush();
const failedInstallStopped = !t.err && W.schedules.length === 0;
delete W.fail["Virtual.Add"]; t.loop(); const retryLimits = t.flush();
const installedAsync = !t.err && W.vcs.length === 15 && W.schedules.length === 1;
W.vcs.find(v => v.key === "boolean:201").status.value = true;
t.stale(); t.loop(); t.flush();
W.vcs = W.vcs.filter(v => v.key !== "boolean:201");
t = boot(true); t.fcTm();
const limits = t.flush();
check("S17 asynchronous install retry and restart repair finish within RPC/timer limits",
    failedInstallStopped && installedAsync && !t.err && W.schedules.length === 1 &&
    W.schedules[0].calls[0].params.on === false && W.vcs.length === 15 && W.vDeleted.length === 0 &&
    [installLimits, retryLimits, limits].every(l => l.rpcPeak <= 5 && l.timerPeak <= 5),
    [String(t.err || ""), limits, W.schedules]);

// S18. Unsupported and missing values are never substituted or written back.
for (const [field, value] of [
    ["TimePeriod", 8], ["TimePeriod", null], ["TimePeriod", ""], ["TimePeriod", "  "],
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
    check("S18 corrected " + field + " resumes scheduling", !t.err && W.schedules.length === 1 && W.schedules[0].id !== 41);
}
for (const saved of ["invalid JSON", "null", "{}", "[]"]) {
    W = freshWorld(); W.http = priceServer(PRICE); W.kvs.SmartHeatingConf1 = saved;
    t = boot(); t.fcTm();
    check("S18 malformed configuration " + saved + " is retained without crashing",
        !t.err && W.kvs.SmartHeatingConf1 === saved && W.relayConfigs.length === 0 && W.schedules.length === 0, String(t.err || ""));
}
for (const period of [0, "0", 6, "6", 12, "12", 24, "24"]) {
    W = freshWorld(); W.http = priceServer(PRICE);
    const saved = conf({ TimePeriod: period, HeatingTime: 2 }); W.kvs.SmartHeatingConf1 = saved;
    t = boot(); t.fcTm(); t.stale(); t.loop();
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

// S19. A failed read is distinct from a confirmed missing key, including after a successful cycle.
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
        t.stale(); t.fcTm(); t.flush();
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
t = boot(); t.fcTm(); t.stale(); t.loop();
check("S19 confirmed missing KVS config initializes once", !t.err && W.schedules.length === 1 && W.kvsWrites.filter(k => k === "SmartHeatingConf1").length === 1);

// S20. Reject complete foreign sets and a single conflicting control before applying or backing up values.
for (const badKey of ["all", ...VC_SET.slice(1).map(v => v[0])]) {
    for (const hasBackup of [false, true]) {
        vcWorld(); W.pageSize = 3; W.ignoreKeys = true;
        W.vcs = manyForeign(5).concat(VC_SET.map(e => ({ key: e[0], config: { name: e[1] }, status: { value: e[2] } })));
        t = boot();
        if (hasBackup) t.fcTm();
        for (const v of W.vcs) if (badKey === "all" || v.key === badKey) v.config.name = "Other script's control";
        W.vcs.find(v => v.key === "boolean:201").status.value = true;
        const before = JSON.stringify([W.kvs, W.schedules, W.vcs, W.relayConfigs]);
        t = boot(); t.fcTm();
        check("S20 foreign " + badKey + (hasBackup ? " with backup" : " without backup") + " is never adopted",
            !t.err && JSON.stringify([W.kvs, W.schedules, W.vcs, W.relayConfigs]) === before, String(t.err || ""));
    }
}
for (const missing of ["config", "status"]) {
    vcWorld(); W.vcs = VC_SET.map(e => ({ key: e[0], config: { name: e[1] }, status: { value: e[2] } }));
    delete W.vcs.find(v => v.key === "boolean:201")[missing];
    t = boot(); t.fcTm();
    check("S20 missing " + missing + " blocks adoption without adding or backing up controls", !t.err && W.relayConfigs.length === 0 && W.addAttempts.length === 0 && W.kvs.SmartHeatingVC1 === undefined);
}

// S21. Even with a backup, present-but-invalid controls cannot silently select zero or stale values.
for (const key of VC_SET.slice(1).map(v => v[0])) {
    for (const badValue of [null, ""]) {
        vcWorld(); W.vcs = VC_SET.map(e => ({ key: e[0], config: { name: e[1] }, status: { value: e[2] } }));
        t = boot(); t.fcTm();
        const control = W.vcs.find(v => v.key === key), goodValue = control.status.value;
        const priorId = W.schedules[0] && W.schedules[0].id;
        control.status.value = badValue;
        const before = JSON.stringify([W.kvs, W.schedules, W.vcs, W.relayConfigs]);
        t = boot(); t.fcTm();
        check("S21 " + key + "=" + JSON.stringify(badValue) + " preserves the last working configuration",
            !t.err && JSON.stringify([W.kvs, W.schedules, W.vcs, W.relayConfigs]) === before, String(t.err || ""));
        control.status.value = goodValue; t.loop();
        check("S21 restored " + key + " resumes on retry", !t.err && W.schedules.length === 1 && W.schedules[0].id !== priorId && specHours(W.schedules[0].timespec) === cheapest(EVE.normal, 12, 5, PRICE));
    }
}
vcWorld(); W.vcs = VC_SET.map(e => ({ key: e[0], config: { name: e[1] }, status: { value: e[2] } }));
W.vcs.find(v => v.key === "enum:200").status.value = "0";
W.vcs.find(v => v.key === "number:200").status.value = 0;
W.http = priceServer(() => 0);
t = boot(); t.fcTm();
check("S21 explicit zero remains valid price-only control", !t.err && W.schedules.length === 1 && specHours(W.schedules[0].timespec).split(",").length === 24 && W.kvs.SmartHeatingVC1 !== undefined);

// =====================================================================
console.log(failures === 0 ? "\nALL SPEC CHECKS PASSED" : "\n" + failures + " SPEC FAILURES");
process.exit(failures === 0 ? 0 : 1);
