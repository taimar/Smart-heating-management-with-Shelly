// Implementation-agnostic requirement suite for SmartHeatingWithShelly.js.
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
        kvs: {}, schedules: [], deleted: [], nextId: 5, nextScriptId: 9, calls: [],
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
    getComponentConfig: (n, id) => {
        if (n === "sys") return W.sysConfig;
        if (n === "switch") return W.relayConfig;
        if (n === "script" && id !== 1) {
            const script = W.scripts.find(s => s.id === id);
            return script ? { name: script.name, enable: true } : null;
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
            case "KVS.Get": return W.kvs[p.key] !== undefined ? done({ value: W.kvs[p.key] }, 0) : done(null, -105, "not found");
            case "KVS.set": case "KVS.Set": W.kvsWrites.push(p.key); W.kvs[p.key] = p.value; return done({}, 0);
            case "HTTP.GET": { W.lastUrl = p.url; const r = W.http(p); return done(r[0], r[1], ""); }
            case "Switch.SetConfig": W.relayConfigs.push(p.config); W.relayConfig = Object.assign({}, p.config); return done({}, 0);
            case "Schedule.Delete": {
                const i = W.schedules.findIndex(s => s.id === p.id);
                if (i === -1) return done(null, -103, "no such schedule");
                W.deleted.push(p.id); W.schedules.splice(i, 1); return done({}, 0);
            }
            case "Schedule.Create": {
                const id = W.nextId++;
                W.schedules.push({ id, enable: p.enable !== false, timespec: p.timespec, calls: p.calls });
                return done({ id }, 0);
            }
            case "Schedule.List": return done({ jobs: W.schedules.map(s => Object.assign({}, s)) }, 0);
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
            case "Script.SetConfig": return done({ id: p.id }, 0);
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
function boot(queued) {
    const queue = [], timers = new Set();
    let now = 0, nextTimer = 0, rpcCount = 0, rpcPeak = 0, timerPeak = 0;
    const asyncShelly = Object.assign({}, Shelly, { call: (m, p, cb, ud) => {
        rpcCount++; rpcPeak = Math.max(rpcPeak, rpcCount);
        queue.push({ method: m, at: now + 10, run: () => { rpcCount--; Shelly.call(m, p, cb, ud); } });
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
    t.step = () => {
        if (!queue.length || t.err) return;
        queue.sort((a, b) => a.at - b.at);
        const event = queue.shift(); now = event.at;
        ctx.runCallback = event.run;
        t.drive("runCallback()");
    };
    t.pending = () => queue.map(e => e.method || "timer");
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
            rows.push('"' + (t / 1000) + '";"x";"' + priceFn(new RealDate(t).getHours(), t).toFixed(2).replace(".", ",") + '"');
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
function completeGroup() {
    const group = W.vcs.find(v => v.key === "group:200");
    const expected = ["enum:200", "number:200", "boolean:200", "number:203", "enum:201",
        "number:201", "number:202", "boolean:201", "enum:202"].sort();
    return group && group.config.name === "Smart Heating" && Array.isArray(group.status.value) &&
        JSON.stringify(group.status.value.slice().sort()) === JSON.stringify(expected);
}

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
// install when no required controls exist. Partial installation rules are specified in N2/N3.
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
    if (method === "Switch.SetConfig") W.relayConfig = null; // an existing timer cannot be verified
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

// S8. A foreign control on a reserved key is never deleted or adopted.
W = freshWorld(); W.device = { gen: 3, app: "Mini1G3", ver: "1.4.4" };
W.vcs = [{ key: "enum:200", config: { name: "Thermostat Mode" }, status: { value: "eco" } }];
W.http = priceServer(PRICE);
t = boot(); t.fcTm();
check("S8 conflicting control is left untouched without scheduling unverified settings", !t.err &&
    W.vDeleted.length === 0 && W.addAttempts.length === 0 && W.vcs.length === 1 &&
    W.schedules.length === 0 && W.relayConfigs.length === 0 && Object.keys(W.kvs).length === 0);

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

// S15. Interrupted installs pause once any controls exist; manual restoration resumes heating.
function vcWorld() {
    W = freshWorld();
    W.device = { gen: 3, app: "Mini1G3", ver: "1.4.4" };
    W.http = priceServer(PRICE);
}
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
check("S15 deleting all controls reinstalls defaults and replaces the recorded schedule", !t.err &&
    completeGroup() && W.schedules.length === 1 && W.deleted.includes(reinstallId) && W.vDeleted.length === 0);

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
W.fail["Switch.SetConfig"] = true; W.relayConfig = null;
const diagnosticStart = prints.length;
t.stale(); t.loop();
check("S16 local error identifies the recorded schedule being preserved", W.schedules[0].id === preservedId && prints.slice(diagnosticStart).some(line => line.includes("Keeping recorded schedule ID " + preservedId + ".")));

// S17. Queued interrupted installation, explicit reset, and later pause respect RPC/timer limits.
vcWorld(); W.pageSize = 3; W.ignoreKeys = true; W.vcs = manyForeign(5);
W.fail["Virtual.Add"] = p => p.type === "boolean" && p.id === 201;
t = boot(true); t.fcTm(); const installLimits = t.flush();
const failedInstallStopped = !t.err && W.schedules.length === 0;
const stoppedControls = JSON.stringify(W.vcs), stoppedAdds = W.addAttempts.length;
delete W.fail["Virtual.Add"]; t.loop(); const pauseLimits = t.flush();
const partialPaused = !t.err && JSON.stringify(W.vcs) === stoppedControls && W.addAttempts.length === stoppedAdds;
W.vcs = manyForeign(5); // user explicitly clears all required control slots to reinstall
t.stale(); t.loop(); const retryLimits = t.flush();
const installedAsync = !t.err && W.vcs.length === 15 && W.schedules.length === 1;
W.vcs.find(v => v.key === "boolean:201").status.value = true;
t.stale(); t.loop(); t.flush();
W.vcs = W.vcs.filter(v => v.key !== "boolean:201");
t = boot(true); t.fcTm();
const limits = t.flush();
check("S17 interrupted install pauses, explicit reset reinstalls, and missing controls pause within RPC/timer limits",
    failedInstallStopped && partialPaused && installedAsync && !t.err && W.schedules.length === 1 &&
    W.schedules[0].calls[0].params.on === false && W.vcs.length === 14 && W.vDeleted.length === 0 &&
    [installLimits, pauseLimits, retryLimits, limits].every(l => l.rpcPeak <= 5 && l.timerPeak <= 5),
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

// S20. Reject complete foreign sets and a single conflicting control before applying values.
for (const badKey of ["all", ...VC_SET.slice(1).map(v => v[0])]) {
    for (const priorCalculation of [false, true]) {
        vcWorld(); W.pageSize = 3; W.ignoreKeys = true;
        W.vcs = manyForeign(5).concat(VC_SET.map(e => ({ key: e[0], config: { name: e[1] }, status: { value: e[2] } })));
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
for (const missing of ["config", "status"]) {
    vcWorld(); W.vcs = VC_SET.map(e => ({ key: e[0], config: { name: e[1] }, status: { value: e[2] } }));
    delete W.vcs.find(v => v.key === "boolean:201")[missing];
    t = boot(); t.fcTm();
    check("S20 missing " + missing + " blocks adoption without adding controls", !t.err && W.relayConfigs.length === 0 && W.addAttempts.length === 0 && W.kvs.SmartHeatingVC1 === undefined);
}

// S21. Present-but-invalid controls cannot silently select zero or stale values.
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
check("S21 explicit zero remains valid price-only control", !t.err && W.schedules.length === 1 && specHours(W.schedules[0].timespec).split(",").length === 24);

// S22. A cached watchdog ID is accepted or restarted only while its name still matches.
for (const change of ["renamed running", "renamed stopped", "reused ID", "deleted", "replacement watchdog"]) {
    W = freshWorld(); W.kvs.SmartHeatingConf1 = conf(); W.http = priceServer(PRICE);
    t = boot(true); t.fcTm(); t.flush();
    if (change === "deleted" || change === "reused ID") W.scripts = W.scripts.filter(s => s.id !== 3);
    else W.scripts.find(s => s.id === 3).name = "Other automation";
    if (change === "reused ID") W.scripts.push({ id: 3, name: "Pump controller" });
    if (change === "replacement watchdog") { W.scripts.push({ id: 4, name: "watchdog" }); W.running[4] = false; }
    W.running[3] = change === "renamed running";
    const beforeRunning = W.running[3], start = W.calls.length;
    t.stale(); t.loop(); t.flush();
    const foreignWrites = W.calls.slice(start).filter(c => ["Script.Start", "Script.Stop", "Script.PutCode", "Script.SetConfig"].includes(c.method) && c.params.id === 3);
    const actual = W.scripts.find(s => s.name === "watchdog");
    check("S22 " + change + ": foreign ID left alone, actual watchdog runs",
        !t.err && foreignWrites.length === 0 && W.running[3] === beforeRunning && actual && actual.id !== 3 && W.running[actual.id],
        [String(t.err || ""), foreignWrites.map(c => c.method), W.scripts]);
}

// S23. Retry the same unsaved SystemData record, including ID zero, without reloading stale state.
for (const priorRecord of [false, true]) {
    for (const noHeating of [false, true]) {
        W = freshWorld(); W.kvs.SmartHeatingConf1 = conf(); W.http = priceServer(PRICE);
        t = boot(true);
        if (priorRecord) { t.fcTm(); t.flush(); }
        W.kvs.SmartHeatingConf1 = conf({ HeatingTime: noHeating ? 0 : 2 });
        W.fail["KVS.set"] = p => p.key === "SmartHeatingSys1";
        t.stale(); t.fcTm(); t.flush();
        const initialError = t.err;
        const expectedJobs = JSON.stringify(W.schedules);
        const unsavedId = W.schedules.length ? W.schedules[0].id : 0;
        const record = W.calls.filter(c => c.method === "KVS.set" && c.params.key === "SmartHeatingSys1").slice(-1)[0].params.value;
        const start = W.calls.length;
        // Changes made while persistence is pending must wait, preserving the pending ID.
        W.kvs.SmartHeatingConf1 = conf({ HeatingTime: 3 });
        for (let i = 0; i < 3; i++) { t.stale(); t.loop(); t.flush(); }
        const retries = W.calls.slice(start);
        const writes = retries.filter(c => c.method === "KVS.set" && c.params.key === "SmartHeatingSys1");
        check("S23 " + (priorRecord ? "stale" : "missing") + " record, " + (noHeating ? "zero" : "new") + " ID retries once per cycle without other work",
            !initialError && !t.err && JSON.stringify(W.schedules) === expectedJobs && writes.length === 3 &&
            writes.every(c => c.params.value === record) && retries.every(c => c.method === "KVS.set"),
            [String(initialError || t.err || ""), retries.map(c => c.method)]);
        delete W.fail["KVS.set"]; t.loop(); t.flush();
        check("S23 successful persistence saves the same ID without creating another schedule",
            !t.err && W.kvs.SmartHeatingSys1 !== undefined && JSON.parse(W.kvs.SmartHeatingSys1).ExistingSchedule === unsavedId && JSON.stringify(W.schedules) === expectedJobs,
            [W.kvs.SmartHeatingSys1, W.schedules]);
        t.loop(); t.flush();
        check("S23 normal calculation resumes after saving, with no orphan schedule",
            !t.err && W.schedules.length === 1 && specHours(W.schedules[0].timespec) === cheapest(EVE.normal, 24, 3, PRICE), W.schedules);
    }
}

// S24. Keep the old schedule and timer compatible through every failed polarity-transition step.
for (const inverted of [false, true]) {
    for (const failStep of ["Schedule.List", "Schedule.Update", "Switch.SetConfig", "Schedule.Delete", "Schedule.Create", null]) {
        W = freshWorld(); W.kvs.SmartHeatingConf1 = conf({ InvertedRelay: inverted }); W.http = priceServer(PRICE);
        t = boot(true); t.fcTm(); t.flush();
        const oldId = W.schedules[0].id, oldTimer = JSON.stringify(W.relayConfig);
        const oldEndTimer = inverted ? "auto_on" : "auto_off";
        let mismatches = 0;
        W.observe = () => {
            const old = W.schedules.find(s => s.id === oldId);
            if (old && old.enable && !W.relayConfig[oldEndTimer]) mismatches++;
        };
        W.kvs.SmartHeatingConf1 = conf({ InvertedRelay: !inverted });
        if (failStep) W.fail[failStep] = true;
        const start = W.calls.length;
        t.stale(); t.loop();
        const limits = t.flush();
        const beforeDisable = failStep === "Schedule.List" || failStep === "Schedule.Update";
        const active = W.schedules.filter(s => s.enable);
        const old = W.schedules.find(s => s.id === oldId);
        const expectedState = beforeDisable
            ? old && old.enable && JSON.stringify(W.relayConfig) === oldTimer
            : failStep ? active.length === 0 : active.length === 1 && active[0].id !== oldId && active[0].calls[0].params.on === inverted;
        check("S24 " + inverted + " -> " + !inverted + ", " + (failStep || "success") + ": old schedule never loses its end timer while enabled",
            !t.err && mismatches === 0 && expectedState && limits.rpcPeak <= 5 && limits.timerPeak <= 5,
            [String(t.err || ""), mismatches, W.schedules, W.relayConfig]);
        if (!failStep) {
            const calls = W.calls.slice(start).map(c => c.method);
            check("S24 successful transition disables before timer update and replacement",
                calls.indexOf("Schedule.Update") < calls.indexOf("Switch.SetConfig") && calls.indexOf("Switch.SetConfig") < calls.indexOf("Schedule.Delete") &&
                calls.indexOf("Schedule.Delete") < calls.indexOf("Schedule.Create"), calls);
        } else {
            delete W.fail[failStep]; t.loop(); t.flush();
            check("S24 " + failStep + " recovers on retry with only the new-polarity schedule",
                !t.err && mismatches === 0 && W.schedules.length === 1 && W.schedules[0].enable && W.schedules[0].calls[0].params.on === inverted,
                [String(t.err || ""), W.schedules]);
        }
    }
}
// A restart after disabling must not re-enable the incompatible schedule.
W = freshWorld(); W.kvs.SmartHeatingConf1 = conf(); W.http = priceServer(PRICE);
t = boot(true); t.fcTm(); t.flush();
W.kvs.SmartHeatingConf1 = conf({ InvertedRelay: true }); W.fail["Schedule.Delete"] = true;
t.stale(); t.loop(); t.flush();
const disabledId = W.schedules[0].id;
t = boot(true); t.fcTm(); t.flush();
check("S24 disabled schedule remains disabled across restart and another deletion failure", !t.err && W.schedules.length === 1 && W.schedules[0].id === disabledId && W.schedules[0].enable === false);
delete W.fail["Schedule.Delete"]; t.loop(); t.flush();
check("S24 restarted transition finishes after deletion recovers", !t.err && W.schedules.length === 1 && W.schedules[0].id !== disabledId && W.schedules[0].enable && W.schedules[0].calls[0].params.on === false);

// Ordinary same-polarity recalculation keeps the working schedule enabled if deletion fails.
W = freshWorld(); W.kvs.SmartHeatingConf1 = conf(); W.http = priceServer(PRICE);
t = boot(); t.fcTm();
const stableId = W.schedules[0].id;
W.fail["Schedule.Delete"] = true;
const stableStart = W.calls.length;
t.stale(); t.loop();
check("S24 same polarity does not disable the working schedule", !t.err && W.schedules[0].id === stableId && W.schedules[0].enable && !W.calls.slice(stableStart).some(c => c.method === "Schedule.Update"));

// =====================================================================
// S25. A periodic tick cannot overlap an unfinished offline fallback.
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

// S26. Unreadable schedule identity never becomes an empty record.
for (const priorSuccess of [false, true]) {
    for (const bad of ["read failure", "{", "null", "[]", "{}", '{"ExistingSchedule":null}', '{"ExistingSchedule":-1}', '{"ExistingSchedule":"5"}']) {
        W = freshWorld(); W.kvs.SmartHeatingConf1 = conf(); W.http = priceServer(PRICE);
        t = boot(true);
        if (priorSuccess) { t.fcTm(); t.flush(); }
        const knownState = t.drive("JSON.stringify(s)");
        const goodRecord = W.kvs.SmartHeatingSys1;
        if (bad === "read failure") W.fail["KVS.Get"] = p => p.key === "SmartHeatingSys1";
        else W.kvs.SmartHeatingSys1 = bad;
        const before = JSON.stringify([W.kvs, W.schedules, W.relayConfigs]);
        t.stale(); t.fcTm(); t.flush(); t.loop(); t.flush();
        check("S26 " + bad + (priorSuccess ? " after success" : " at boot") + " preserves identity and relay",
            !t.err && JSON.stringify([W.kvs, W.schedules, W.relayConfigs]) === before && t.drive("JSON.stringify(s)") === knownState,
            String(t.err || ""));
        delete W.fail["KVS.Get"];
        if (goodRecord === undefined) delete W.kvs.SmartHeatingSys1;
        else W.kvs.SmartHeatingSys1 = goodRecord;
        W.kvs.SmartHeatingConf1 = conf({ HeatingTime: 2 });
        const oldId = W.schedules[0] && W.schedules[0].id;
        t.loop(); t.flush();
        check("S26 corrected record resumes " + bad + "/" + priorSuccess, !t.err && W.schedules.length === 1 &&
            W.schedules[0].id !== oldId && specHours(W.schedules[0].timespec) === cheapest(EVE.normal, 24, 2, PRICE) &&
            JSON.parse(W.kvs.SmartHeatingSys1).ExistingSchedule === W.schedules[0].id);
    }
}

// A deleted persistence key does not erase a schedule ID already known this boot.
W = freshWorld(); W.kvs.SmartHeatingConf1 = conf(); W.http = priceServer(PRICE);
t = boot(true); t.fcTm(); t.flush();
const deletedRecordId = W.schedules[0].id;
delete W.kvs.SmartHeatingSys1;
W.kvs.SmartHeatingConf1 = conf({ HeatingTime: 2 });
t.stale(); t.loop(); t.flush();
check("S26 missing SystemData mid-run replaces the known schedule without orphaning it", !t.err &&
    W.deleted.includes(deletedRecordId) && W.schedules.length === 1 && W.schedules[0].id !== deletedRecordId &&
    specHours(W.schedules[0].timespec) === cheapest(EVE.normal, 24, 2, PRICE) &&
    JSON.parse(W.kvs.SmartHeatingSys1).ExistingSchedule === W.schedules[0].id);

// S27. The second occurrence has no cron slot but all its quarters must validate.
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

// S28. An invisible added control stops this cycle; partial controls need manual restoration.
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

// S29. Only KVS mode validates the nine KVS heating values; mode/relay must always be known.
for (const badSettings of [{ TimePeriod: 8 }, { EnergyProvider: "PARTN24P" }, { HeatingTime: null }, { Country: undefined }]) {
    vcWorld(); W.vcs = VC_SET.map(e => ({ key: e[0], config: { name: e[1] }, status: { value: e[2] } }));
    const saved = conf(Object.assign({ ManualKVS: false }, badSettings)); W.kvs.SmartHeatingConf1 = saved;
    t = boot(true); t.fcTm(); t.flush();
    check("S29 valid controls override inactive " + Object.keys(badSettings)[0] + " without rewriting KVS",
        !t.err && W.kvs.SmartHeatingConf1 === saved && W.schedules.length === 1 &&
        specHours(W.schedules[0].timespec) === cheapest(EVE.normal, 12, 5, PRICE));
}
for (const saved of [conf({ ManualKVS: "false" }), conf({ ManualKVS: false, RelayId: null }), "{"]) {
    vcWorld(); W.vcs = VC_SET.map(e => ({ key: e[0], config: { name: e[1] }, status: { value: e[2] } }));
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

// S30. Custom groups are preserved during install and normal calculations.
for (const complete of [false, true]) {
    vcWorld();
    W.vcs = [{ key: "group:200", config: { name: "Personal" }, status: { value: ["number:205"] } }];
    if (complete) W.vcs.push(...VC_SET.slice(1).map(e => ({ key: e[0], config: { name: e[1] }, status: { value: e[2] } })));
    const group = JSON.stringify(W.vcs[0]);
    t = boot(true); t.fcTm(); t.flush(); t.stale(); t.loop(); t.flush();
    check("S30 custom group survives " + (complete ? "normal reads" : "control installation"), !t.err &&
        W.schedules.length === 1 && JSON.stringify(W.vcs[0]) === group && !W.calls.some(c => c.method === "Group.Set"));
}

// S31. With no recorded schedule, other jobs require neither inspection nor changes.
W = freshWorld(); W.http = priceServer(PRICE); W.kvs.SmartHeatingConf1 = conf({ HeatingTime: 0, AlwaysOnPrice: -1 });
W.schedules = [{ id: 41, enable: true, timespec: "0 0 1 * * *", calls: [{ method: "Switch.Set", params: { id: 0, on: true } }] }];
const foreignJobs = JSON.stringify(W.schedules);
t = boot(true); t.fcTm(); t.flush(); t.stale(); t.loop(); t.flush();
check("S31 no recorded ID skips schedule listing and preserves other jobs", !t.err &&
    !W.calls.some(c => c.method === "Schedule.List") && JSON.stringify(W.schedules) === foreignJobs &&
    JSON.parse(W.kvs.SmartHeatingSys1).ExistingSchedule === 0);
check("S31 short firmware version respects the patch minimum", !t.verC("1.4.3", "1.4") &&
    t.verC("1.4.3", "1.4.3") && t.verC("1.4.3", "1.5"));

// S34. Persistence diagnostics identify the failed key or schedule ID and RPC reason.
for (const method of ["KVS.Get", "KVS.set"]) {
    vcWorld(); W.fail[method] = p => p.key === "SmartHeatingSys1";
    const logStart = prints.length; t = boot(true); t.fcTm(); t.flush();
    check("S34 " + method + " SystemData failure is actionable", !t.err &&
        prints.slice(logStart).some(l => l.includes("forced failure") && /SystemData|Schedule ID/.test(l)) &&
        prints.slice(logStart).some(l => l.includes("Schedule updates are paused")) &&
        (method !== "KVS.set" || prints.slice(logStart).some(l =>
            l.includes("Schedule ID " + W.schedules[0]?.id) && l.includes("forced failure") && l.includes("Schedule updates are paused"))));
}

// S36. Unavailable entries and values preserve heating and advise retry before restoration.
for (const fault of ["omitted entry", "missing status"]) {
    vcWorld(); W.pageSize = 3;
    W.vcs = VC_SET.map(e => ({ key: e[0], config: { name: e[1] }, status: { value: e[2] } }));
    t = boot(true); t.fcTm(); t.flush();
    const control = W.vcs.find(v => v.key === "number:203"), status = control.status;
    if (fault === "omitted entry") W.hiddenStatusKey = control.key;
    else delete control.status;
    const before = JSON.stringify([W.kvs, W.vcs, W.schedules, W.relayConfig]);
    const start = W.calls.length, logStart = prints.length;
    t.stale(); t.loop(); t.flush();
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
        JSON.stringify(W.schedules) !== JSON.stringify(JSON.parse(before)[2]));
}

// S36b. Numeric totals are required even for a single page with all nine valid controls.
for (const total of [undefined, null, "10"]) {
    for (const installed of [false, true]) {
        vcWorld();
        t = boot(true);
        if (installed) { t.fcTm(); t.flush(); }
        W.componentTotal = total;
        const before = JSON.stringify([W.kvs, W.vcs, W.schedules, W.relayConfig]);
        const start = W.calls.length, logStart = prints.length;
        t.stale(); t.fcTm(); t.flush();
        check("S36b total=" + String(total) + ", installed=" + installed + " pauses without changing state", !t.err &&
            JSON.stringify([W.kvs, W.vcs, W.schedules, W.relayConfig]) === before &&
            !W.calls.slice(start).some(c => ["Virtual.Add", "Virtual.Delete", "Switch.SetConfig", "Switch.Set",
                "Schedule.Create", "Schedule.Delete", "Schedule.Update"].includes(c.method)) &&
            prints.slice(logStart).some(l => l.includes("Schedule updates are paused") && /inventory.*incomplete/i.test(l)));
        delete W.componentTotal; t.loop(); t.flush();
        check("S36b valid total resumes " + (installed ? "normal reads" : "installation"), !t.err &&
            completeGroup() && W.schedules.length === 1 && JSON.stringify(W.schedules) !== JSON.stringify(JSON.parse(before)[2]));
    }
}

// S37. Only a verified numeric create response grants permission to populate.
for (const response of [{}, { id: 201 }, { id: "200" }]) {
    vcWorld(); W.groupCreateResponse = response;
    const logStart = prints.length;
    t = boot(true); t.fcTm(); t.flush(); t.stale(); t.loop(); t.flush();
    check("S37 unverified create response " + JSON.stringify(response) + " leaves membership alone and heating active", !t.err &&
        W.schedules.length === 1 && !W.calls.some(c => c.method === "Group.Set") &&
        W.addAttempts.filter(k => k === "group:200").length === 1 &&
        prints.slice(logStart).filter(l => l.includes("Group setup incomplete")).length === 1);
    const diagnostic = prints.slice(logStart).find(l => l.includes("Group setup incomplete")) || "";
    check("S37 unverified response explains uncertainty without a zero error code", /unverified/i.test(diagnostic) &&
        !/\s0\s*$/.test(diagnostic), diagnostic);
}

// S40. Capability checks are quiet and reject non-string firmware values without throwing.
for (const ver of [140, {}, ["1.4.4"]]) {
    vcWorld(); W.device = { gen: 2, app: "Pro1", ver }; W.kvs.SmartHeatingConf1 = conf({ ManualKVS: false });
    t = boot(true); t.fcTm(); t.flush();
    check("S40 non-string firmware " + JSON.stringify(ver) + " does not throw", !t.err && W.schedules.length === 1, String(t.err || ""));
}
vcWorld(); W.device = { gen: 2, app: "Pro1" }; W.kvs.SmartHeatingConf1 = conf({ ManualKVS: false });
t = boot(true); t.fcTm(); t.flush();
check("S40 missing firmware version uses valid KVS settings without installing controls", !t.err &&
    W.addAttempts.length === 0 && !W.calls.some(c => c.method === "Shelly.GetComponents") &&
    W.schedules.length === 1 && specHours(W.schedules[0].timespec) === cheapest(EVE.normal, 24, 10, PRICE));
W = freshWorld(); W.http = priceServer(PRICE); W.kvs.SmartHeatingConf1 = conf();
const modeLog = prints.length; t = boot(true); t.fcTm(); t.flush();
check("S40 KVS selection prints one mode line per calculation", prints.slice(modeLog).filter(l => /forcing KVS mode|Script in KVS mode/.test(l)).length === 1);

// The single mode line explains why controls are unavailable.
for (const forced of [false, true]) {
    W = freshWorld(); W.http = priceServer(PRICE);
    if (forced) W.device = { gen: 3, app: "Plus1PM", ver: "1.4.4" };
    W.kvs.SmartHeatingConf1 = conf({ ManualKVS: forced });
    const reasonLog = prints.length; t = boot(true); t.fcTm(); t.flush();
    const lines = prints.slice(reasonLog).filter(l => /forcing KVS mode|Script in KVS mode/.test(l));
    check("S40 KVS mode explains " + (forced ? "ManualKVS override" : "unsupported hardware"), !t.err &&
        W.schedules.length === 1 && W.addAttempts.length === 0 && lines.length === 1 &&
        lines[0].includes(forced ? "forced by ManualKVS=true" : "device does not meet Virtual Component requirements"), lines);
}

// S42. Price-only mode cannot derive historical heating hours; preserve the prior relay and schedule.
for (const inverted of [false, true]) {
    for (const prior of [false, true]) {
        W = freshWorld(); W.http = priceServer(PRICE);
        W.kvs.SmartHeatingConf1 = conf({ TimePeriod: 0, AlwaysOnPrice: 20, InvertedRelay: inverted });
        t = boot(true);
        if (prior) { t.fcTm(); t.flush(); }
        const existing = JSON.stringify([W.kvs, W.schedules, W.relayConfigs]);
        const errorLog = prints.length;
        W.http = () => [null, -114]; t.stale(); t.fcTm(); t.flush(); t.loop(); t.flush();
        check("S42 threshold-only outage preserves state, inverted=" + inverted + ", prior=" + prior, !t.err &&
            JSON.stringify([W.kvs, W.schedules, W.relayConfigs]) === existing &&
            prints.slice(errorLog).some(l => l.includes("Threshold-only mode") && l.includes("Schedule updates are paused")) &&
            !prints.slice(errorLog).some(l => l.includes("using historical cheap hours")));
        W.http = priceServer(h => h < 2 ? 0 : 100); t.loop(); t.flush();
        check("S42 threshold-only pricing resumes, inverted=" + inverted + ", prior=" + prior, !t.err &&
            W.schedules.length === 1 && specHours(W.schedules[0].timespec) === "0,1" && W.schedules[0].calls[0].params.on === !inverted);
        W.http = priceServer(() => 100); t.stale(); t.loop(); t.flush();
        check("S42 valid prices can still stop threshold-only heating, inverted=" + inverted + ", prior=" + prior, !t.err &&
            W.schedules.length === 0 && JSON.parse(W.kvs.SmartHeatingSys1).ExistingSchedule === 0);
    }
}
W = freshWorld(); W.http = () => [null, -114]; W.kvs.SmartHeatingConf1 = conf({ TimePeriod: 12, HeatingTime: 0, AlwaysOnPrice: -1 });
W.kvs.SmartHeatingSys1 = JSON.stringify({ ExistingSchedule: 41, Version: 5 });
W.schedules = [{ id: 41, enable: true, timespec: "0 0 1 * * *", calls: [{ method: "Switch.Set", params: { id: 0, on: true } }] }];
t = boot(true); t.fcTm(); t.flush();
check("S42 an explicit zero-hour timed fallback still removes prior heating", !t.err && W.schedules.length === 0 &&
    W.deleted.includes(41) && JSON.parse(W.kvs.SmartHeatingSys1).ExistingSchedule === 0);

// S43. Non-string device app identifiers do not crash capability detection.
for (const app of [140, {}, ["Pro1"], null]) {
    vcWorld(); W.device = { gen: 2, app, ver: "1.4.4" }; W.kvs.SmartHeatingConf1 = conf({ ManualKVS: false });
    t = boot(true); t.fcTm(); t.flush();
    check("S43 non-string app " + JSON.stringify(app) + " does not throw", !t.err && W.schedules.length === 1, String(t.err || ""));
}

// S44. Diagnostics must not assume successful installation from an RPC response or fallback attempt.
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

// Install contract: these scenarios were added before removing automatic repair.
const OLD_BACKUP = JSON.stringify(["12", 5, false, "NONE", 1, 300, true, "ee", 0]);
const CONTROL_DEFAULTS = {
    "enum:200": "24", "number:200": 10, "enum:201": "VORK2", "number:201": 1,
    "number:202": 300, "boolean:201": false, "enum:202": "ee",
    "boolean:200": false, "number:203": 0,
};
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
const groupCall = call => call.method.startsWith("Group.") ||
    call.method === "Virtual.Add" && call.params.type === "group";

// N1. Fresh installation preserves foreign controls and respects RPC/timer limits.
for (const hasSystemData of [false, true]) {
    vcWorld(); W.pageSize = 3; W.ignoreKeys = true; W.vcs = manyForeign(4);
    if (hasSystemData) existingHeating();
    W.kvs.SmartHeatingConf1 = conf({ ManualKVS: false });
    const foreignBefore = JSON.stringify(W.vcs);
    t = boot(true); t.fcTm(); const limits = t.flush();
    check("N1 empty slots, SystemData=" + hasSystemData + ": install defaults and schedule heating", !t.err &&
        completeGroup() && Object.keys(CONTROL_DEFAULTS).every(key =>
            W.vcs.find(v => v.key === key)?.status.value === CONTROL_DEFAULTS[key]) &&
        W.schedules.length === 1 && (!hasSystemData || W.deleted.includes(41)) &&
        JSON.parse(W.kvs.SmartHeatingSys1).ExistingSchedule === W.schedules[0].id);
    check("N1 fresh install, SystemData=" + hasSystemData + ": preserves foreign controls within RPC/timer limits",
        !t.err && JSON.stringify(W.vcs.slice(0, 4)) === foreignBefore && W.vDeleted.length === 0 &&
        limits.rpcPeak <= 5 && limits.timerPeak <= 5, limits);
}

// N2. Every missing control pauses despite absent SystemData; survivors remain untouched.
for (const missing of Object.keys(CONTROL_DEFAULTS)) {
    vcWorld(); W.pageSize = 3; W.ignoreKeys = true;
    W.vcs = manyForeign(4).concat(installControls().filter(v => v.key !== missing));
    const before = JSON.stringify([W.vcs, W.kvs]);
    t = boot(true); t.fcTm(); t.flush();
    check("N2 absent SystemData pauses missing " + missing + " without changing any control", !t.err &&
        JSON.stringify([W.vcs, W.kvs]) === before && W.addAttempts.length === 0 && W.vDeleted.length === 0 &&
        W.schedules.length === 0 && W.relayConfigs.length === 0, String(t.err || ""));
}

// N3. Partial sets always pause, including across restarts and with obsolete backups.
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

// N4. Group failure is cosmetic and never creates background retry work.
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
    t.loop(); t.flush(); t.stale(); t.loop(); t.flush();
    W.fail = {}; t.stale(); t.loop(); t.flush();
    t = boot(true); t.fcTm(); t.flush();
    check("N4 " + failure + " has no group RPC or repeated failure log on later cycles/restart", !t.err &&
        W.schedules.length === 1 && !W.calls.slice(later).some(groupCall) &&
        prints.slice(logStart).filter(l => l.includes("Group setup incomplete")).length === 1);
}

// N5. Old backups are inert during install, normal scheduling and a partial pause.
for (const backup of [undefined, "invalid JSON", OLD_BACKUP]) {
    vcWorld();
    if (backup !== undefined) W.kvs.SmartHeatingVC1 = backup;
    t = boot(true); t.fcTm(); t.flush();
    const installed = !t.err && W.schedules.length === 1;
    t.stale(); t.loop(); t.flush();
    W.vcs = W.vcs.filter(v => v.key !== "number:203");
    const before = JSON.stringify([W.vcs, W.schedules, W.relayConfig]);
    t.stale(); t.loop(); t.flush();
    check("N5 obsolete backup " + String(backup) + " is never read or written", installed && !t.err &&
        JSON.stringify([W.vcs, W.schedules, W.relayConfig]) === before &&
        !W.calls.some(c => c.params?.key === "SmartHeatingVC1") && W.kvs.SmartHeatingVC1 === backup);
}

// Failed/invalid SystemData must block fresh installation as well as partial controls.
for (const outcome of ["failed read", "invalid JSON", "invalid ID"]) {
    for (const partial of [false, true]) {
        vcWorld();
        if (partial) W.vcs = installControls().filter(v => v.key !== "number:203");
        W.kvs.SmartHeatingSys1 = outcome === "invalid JSON" ? "{" : JSON.stringify({ ExistingSchedule: -1 });
        if (outcome === "failed read") W.fail["KVS.Get"] = p => p.key === "SmartHeatingSys1";
        const before = JSON.stringify([W.vcs, W.kvs]);
        t = boot(true); t.fcTm(); t.flush();
        check("N6 " + outcome + ", " + (partial ? "partial controls" : "empty slots") + " cannot authorize installation", !t.err &&
            JSON.stringify([W.vcs, W.kvs]) === before && W.addAttempts.length === 0 &&
            W.relayConfigs.length === 0 && W.schedules.length === 0);
    }
}

// A restart after adding controls has no group-setup state to resume.
vcWorld(); t = boot(true); t.fcTm();
let setupSteps = 0;
while (W.vcs.length < 9 && !t.err && setupSteps++ < 100) t.step();
const controlsBeforeRestart = W.vcs.length === 9 && !W.vcs.some(v => v.key === "group:200");
const restartCalls = W.calls.length;
t = boot(true); t.fcTm(); t.flush();
check("N4 restart between controls and group leaves a cosmetic gap while heating proceeds", controlsBeforeRestart &&
    !t.err && W.schedules.length === 1 && !W.calls.slice(restartCalls).some(groupCall));

// S45. Read configuration, then SystemData, before dispatching either mode.
for (const outcome of ["KVS", "virtual", "missing configuration", "failed configuration", "both failed"]) {
    vcWorld(); existingHeating(); W.vcs = installControls();
    W.kvs.SmartHeatingConf1 = conf({ ManualKVS: outcome !== "virtual" });
    if (outcome === "missing configuration") delete W.kvs.SmartHeatingConf1;
    if (outcome.includes("failed")) W.fail["KVS.Get"] = p =>
        outcome === "both failed" || p.key === "SmartHeatingConf1";
    const before = JSON.stringify([W.schedules, W.relayConfig, W.vcs, W.kvs]);
    const logStart = prints.length;
    t = boot(true); t.fcTm(); t.step();
    check("S45 " + outcome + ": only configuration is pending initially", !t.err &&
        JSON.stringify(t.pending()) === JSON.stringify(["KVS.Get"]), t.pending());
    t.step();
    check("S45 " + outcome + ": SystemData follows every configuration result", !t.err &&
        W.calls.length === 1 && W.calls[0].params.key === "SmartHeatingConf1" &&
        JSON.stringify(t.pending()) === JSON.stringify(["KVS.Get"]), [W.calls, t.pending()]);
    t.loop();
    check("S45 " + outcome + ": pending SystemData blocks calculation and overlapping ticks", !t.err &&
        W.calls.length === 1 && JSON.stringify([W.schedules, W.relayConfig, W.vcs, W.kvs]) === before &&
        JSON.stringify(t.pending()) === JSON.stringify(["KVS.Get"]));
    t.step(); t.flush();
    const paused = prints.slice(logStart).filter(l => l.includes("Schedule updates are paused"));
    check("S45 " + outcome + ": both reads finish with the original diagnostic priority", !t.err &&
        W.calls[1]?.params.key === "SmartHeatingSys1" && (outcome.includes("failed")
            ? JSON.stringify([W.schedules, W.relayConfig, W.vcs, W.kvs]) === before && paused.length === 1 &&
                paused[0].includes(outcome === "both failed" ? "SystemData could not be loaded" : "Configuration could not be loaded")
            : paused.length === 0 && W.schedules.length === 1 && W.deleted.includes(41)));
}

// S46. Persist the create result (or zero) only after schedule work finishes.
for (const outcome of ["created", "failed", "empty"]) {
    W = freshWorld(); existingHeating(); W.http = priceServer(PRICE);
    W.kvs.SmartHeatingConf1 = conf(outcome === "empty" ? { HeatingTime: 0, AlwaysOnPrice: -999 } : {});
    if (outcome === "failed") W.fail["Schedule.Create"] = true;
    t = boot(true); t.fcTm();
    let steps = 0;
    const pending = outcome === "empty" ? "KVS.set" : "Schedule.Create";
    while (!t.pending().includes(pending) && !t.err && steps++ < 100) t.step();
    check("S46 " + outcome + ": no SystemData write before schedule work completes", !t.err &&
        t.pending().includes(pending) && !W.kvsWrites.includes("SmartHeatingSys1") && W.deleted.includes(41));
    t.loop(); t.flush();
    const saved = JSON.parse(W.kvs.SmartHeatingSys1);
    check("S46 " + outcome + ": saves the resulting ID and version 5 once", !t.err &&
        saved.ExistingSchedule === (outcome === "created" ? W.schedules[0]?.id : 0) && saved.Version === 5 &&
        W.schedules.length === (outcome === "created" ? 1 : 0) &&
        W.kvsWrites.filter(k => k === "SmartHeatingSys1").length === 1);
    if (outcome === "failed") {
        delete W.fail["Schedule.Create"]; t.loop(); t.flush();
        check("S46 failed creation retries on the next tick", !t.err && W.schedules.length === 1 &&
            JSON.parse(W.kvs.SmartHeatingSys1).ExistingSchedule === W.schedules[0].id);
    }
}

console.log(failures === 0 ? "\nALL SPEC CHECKS PASSED" : "\n" + failures + " SPEC FAILURES");
process.exit(failures === 0 ? 0 : 1);
