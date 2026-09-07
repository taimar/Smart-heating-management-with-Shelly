/*
Created by Leivo Sepp, 2024-2025
Licensed under the MIT License
https://github.com/LeivoSepp/Smart-heating-management-with-Shelly
 
This Shelly script is designed to retrieve energy market prices from Elering and
activate heating during the most cost-effective hours each day, employing various algorithms. 
 
1. Dynamic calculation of heating time for the next day based on weather forecasts.
2. Division of heating into time periods, with activation during the cheapest hour within each period.
3. Utilization of min-max price levels to maintain the Shelly system consistently on or off.
The script executes daily after 23:00 to establish heating timeslots for the following day.
*/

/* Electricity transmission fees (EUR/MWh) excluding VAT.
Elektrilevi https://elektrilevi.ee/en/vorguleping/vorgupaketid/eramu 
Imatra https://imatraelekter.ee/vorguteenus/vorguteenuse-hinnakirjad/
Latvia https://sadalestikls.lv/en/tarifi
*/
function pack(key, checkOnly) {
    if (checkOnly) {
        return key === "VORK1" || key === "VORK2" || key === "VORK4" || key === "VORK5" ||
            key === "PARTN24" || key === "PARTN24PL" || key === "PARTN12" || key === "PARTN12PL" ||
            key === "PAMATA1" || key === "SPECIAL1" || key === "NONE";
    }
    let rate = null;
    if (key === "VORK1") { rate = { dRt: 77.2, nRt: 77.2, dMRt: 77.2, hMRt: 77.2 }; }
    else if (key === "VORK2") { rate = { dRt: 60.7, nRt: 35.1, dMRt: 60.7, hMRt: 35.1 }; }
    else if (key === "VORK4") { rate = { dRt: 36.9, nRt: 21, dMRt: 36.9, hMRt: 21 }; }
    else if (key === "VORK5") { rate = { dRt: 52.9, nRt: 30.3, dMRt: 81.8, hMRt: 47.4 }; }
    else if (key === "PARTN24") { rate = { dRt: 60.7, nRt: 60.7, dMRt: 60.7, hMRt: 60.7 }; }
    else if (key === "PARTN24PL") { rate = { dRt: 38.6, nRt: 38.6, dMRt: 38.6, hMRt: 38.6 }; }
    else if (key === "PARTN12") { rate = { dRt: 72.4, nRt: 42, dMRt: 72.4, hMRt: 42 }; }
    else if (key === "PARTN12PL") { rate = { dRt: 46.4, nRt: 27.1, dMRt: 46.4, hMRt: 27.1 }; }
    else if (key === "PAMATA1") { rate = { dRt: 39.62, nRt: 39.62, dMRt: 39.62, hMRt: 39.62 }; }
    else if (key === "SPECIAL1") { rate = { dRt: 158.48, nRt: 158.48, dMRt: 158.48, hMRt: 158.48 }; }
    else if (key === "NONE") { rate = { dRt: 0, nRt: 0, dMRt: 0, hMRt: 0 }; }
    return rate;
}
/****** INITIAL SETTINGS ******/
/* 
After the initial run, all user settings are stored in the Shelly 1) KVS or 2) Virtual components (in case virtual components are supported).
To modify user settings, you’ll need to access the Shelly KVS via: Menu → Advanced → KVS on the Shelly web page.
Once you’ve updated the settings, restart the script to apply the changes or wait for the next scheduled run.
 
timePeriod: Heating Period is the time during which heating time is calculated. (0 -> only min-max price used, 24 -> period is one day).
heatingTime: Heating Time is the duration of the cheapest hours within a Heating Period when the heating system is activated. or duration of heating in a day in case of internet connection failure.
isFcstUsed: true/false - Using weather forecast to calculate heating duration.
*/
let c = {
    tPer: 24,       // KVS:TimePeriod VC:Heating Period (h) 24/12/6/0
    hTim: 10,       // KVS:HeatingTime VC:Heating Time (h/period)
    isFc: false,    // KVS:IsForecastUsed VC:Forecast Heat
    pack: "VORK2",  // KVS:EnergyProvider VC:Network Package (NONE, VORK1, VORK2, VORK4, VORK5, PARTN24, PARTN24PL, PARTN12, PARTN12PL, PAMATA1, SPECIAL1)
    lowR: 1,        // KVS:AlwaysOnPrice VC:Heat On (min price) (EUR/MWh)
    higR: 300,      // KVS:AlwaysOffPrice VC:Heat Off (max price) (EUR/MWh)
    Inv: false,     // KVS:InvertedRelay VC:Inverted Relay
    rId: 0,         // KVS:RelayId selects the relay in both modes; required in saved configuration
    cnty: "ee",     // KVS:Country VC:Market Price Country (ee, fi, lv, lt)
    hCur: 0,        // KVS:HeatingCurve VC:Heating Curve 
    tmr: 60,        // Default timer
    pFac: 0.5,      // Power factor
    mnKv: false,    // Forcing script to KVS mode (true) or Virtual components mode (false)
}
/****** PROGRAM INITIAL SETTINGS ******/

let s = {
    last: 0,        // KVS:LastCalculation Last calculation timestamp
    exSc: 0,        // KVS:ExistingSchedule Existing heating schedule
    vers: 0,        // KVS:Version
}

/*
Heating time dependency on heating curve and outside temperature for 24h and 12h (power factor 0.5).
 
    |   ------   24h heating curve   ------   |  
°C  |-10  -8  -6  -4  -2  0   2   4   6   8   10
_________________________________________________
17  | 0   0   0   0   0   0   0   0   0   0   0
15  | 0   0   0   0   0   0   0   2   4   6   8
10  | 0   0   0   0   0   1   3   5   7   9   11
5   | 0   0   0   0   1   3   5   7   9   11  13
0   | 0   0   0   2   4   6   8   10  12  14  16
-5  | 0   0   2   4   6   8   10  12  14  16  18
-10 | 1   3   5   7   9   11  13  15  17  19  21
-15 | 3   5   7   9   11  13  15  17  19  21  23
-20 | 6   8   10  12  14  16  18  20  22  24  24
-25 | 8   10  12  14  16  18  20  22  24  24  24
 
    |   -------   12h heating curve   -------   |
°C  |-10  -8  -6  -4  -2  0   2   4   6   8   10
_________________________________________________
17  | 0   0   0   0   0   0   0   0   0   0   0
15  | 0   0   0   0   0   0   0   1   2   3   4
10  | 0   0   0   0   0   1   2   3   4   5   6
5   | 0   0   0   0   1   2   3   4   5   6   7
0   | 0   0   0   1   2   3   4   5   6   7   8
-5  | 0   0   1   2   3   4   5   6   7   8   9
-10 | 1   2   3   4   5   6   7   8   9   10  11
-15 | 2   3   4   5   6   7   8   9   10  11  12
-20 | 3   4   5   6   7   8   9   10  11  12  12
-25 | 4   5   6   7   8   9   10  11  12  12  12
 
Forecast temp °C is "feels like": more information here: https://en.wikipedia.org/wiki/Apparent_temperature
*/

let _ = {
    hTim: 0,       //heating time
    cPer: 0,       //number of periods
    tsPr: '',       //timestamp for prices
    tsFc: '',       //timestamp for forecast
    freq: 300,      //frequency of script execution in seconds (5 min)
    isLp: false,    //loop flag
    updD: Math.floor(Math.random() * 46),           //delay for server requests (max 45min)
    sId: Shelly.getCurrentScriptId(),               //script ID
    pId: "Id" + Shelly.getCurrentScriptId() + ": ", //print ID
    scId: '',       //schedule ID
    sysPending: false, //new schedule ID still needs to be saved
    manu: false,    //manual heating flag
    prov: "None",   //network provider name
    newV: 5.0,      //new script version
    sdOk: false,    //system data OK
    cdOk: false,    //configuration read succeeded this cycle
    vcRepair: false, //at most one repair batch per calculation
    grpState: 0,   //0 idle, 1 creation pending, 2 population pending; survives cycles only
    grpSeen: false, //do not recreate a group removed during this run
    grpTried: false, //at most one group attempt per calculation
    grpFails: 0,   //shared creation/population retryable failures; maximum three per boot
    grpNotice: false, //existing-group notice once per boot
    relayScanned: false, //inspect other relay jobs in the first successful list once per boot
    vcState: 0,    //backup outcome: 0 failed, 1 succeeded, 2 missing, 3 invalid
    cdMissing: false, //configuration key is confirmed absent
    wdOk: false,    //watchdog code verified since boot
    vcVals: null,   //last complete Virtual Component values, backed up in KVS
    wdId: 0,        //watchdog script ID
};
let cntr = 0;    //counter for async functions

function dtVc() {
    return [
        {
            type: "group", id: 200, config: {
                name: "Smart Heating"
            }
        },
        {
            type: "enum", id: 200, config: {
                name: "Heating Period (h)",
                options: ["24", "12", "6", "0"],
                default_value: "24",
                persisted: true,
                meta: { ui: { view: "dropdown", webIcon: 13, titles: { "24": "24 hour", "12": "12 hour", "6": "6 hour", "0": "No period" } } }
            }
        },
        {
            type: "number", id: 200, config: {
                name: "Min On Time (h/period)",
                default_value: 10,
                min: 0,
                max: 24,
                persisted: true,
                meta: { ui: { view: "slider", unit: "h/period" } }
            }
        },
        {
            type: "enum", id: 201, config: {
                name: "Network Package",
                options: ["NONE", "VORK1", "VORK2", "VORK4", "VORK5", "PARTN24", "PARTN24PL", "PARTN12", "PARTN12PL", "PAMATA1", "SPECIAL1"],
                default_value: "VORK2",
                persisted: true,
                meta: { ui: { view: "dropdown", webIcon: 22, titles: { "NONE": "No package", "VORK1": "Võrk1 Base", "VORK2": "Võrk2 DayNight", "VORK4": "Võrk4 DayNight", "VORK5": "Võrk5 DayNightPeak", "PARTN24": "Partner24 Base", "PARTN24PL": "Partner24Plus Base", "PARTN12": "Partner12 DayNight", "PARTN12PL": "Partner12Plus DayNight", "PAMATA1": "Pamata-1", "SPECIAL1": "Speciālais 1" } } }
            }
        },
        {
            type: "number", id: 201, config: {
                name: "Heat On (min price)",
                default_value: 1,
                min: 0,
                max: 100,
                persisted: true,
                meta: { ui: { view: "slider", unit: "€/MWh or less" } }
            }
        },
        {
            type: "number", id: 202, config: {
                name: "Heat Off (max price)",
                default_value: 300,
                min: 0,
                max: 500,
                persisted: true,
                meta: { ui: { view: "slider", unit: "€/MWh or more" } }
            }
        },
        {
            type: "boolean", id: 201, config: {
                name: "Inverted Relay",
                default_value: false,
                persisted: true,
                meta: { ui: { view: "toggle", webIcon: 7, titles: ["No", "Yes"] } }
            }
        },
        {
            type: "enum", id: 202, config: {
                name: "Market Price Country",
                options: ["ee", "fi", "lv", "lt"],
                default_value: "ee",
                persisted: true,
                meta: { ui: { view: "dropdown", webIcon: 9, titles: { "ee": "Estonia", "fi": "Finland", "lv": "Latvia", "lt": "Lithuania" } } }
            }
        },
        {
            type: "boolean", id: 200, config: {
                name: "Forecast Heat",
                default_value: false,
                persisted: true,
                meta: { ui: { view: "toggle", webIcon: 14, titles: ["No", "Yes"] } }
            }
        },
        {
            type: "number", id: 203, config: {
                name: "Forecast Impact +/-",
                default_value: 0,
                min: -4,
                max: 8,
                persisted: true,
                meta: { ui: { view: "slider", unit: "h more heat" } }
            }
        },
    ];
}

function strt() {
    sAut();
    gKvs();
}
/* set the script to sart automatically on boot */
function sAut() {
    if (!Shelly.getComponentConfig("script", _.sId).enable) {
        Shelly.call('Script.SetConfig', { id: _.sId, config: { enable: true } },
            function (res, err, msg) {
                if (err != 0) {
                    print(_.pId, "Heating script autostart is not enabled.", msg);
                }
            });
    }
}

// check if Shelly supports Virtual components
function isVC() {
    const info = Shelly.getDeviceInfo();

    if (c.mnKv === true) {
        return false;
    }

    // Gen4 ja Gen3 OK; Gen2 ainult Pro + min FW 1.4.3
    const gen2ok = (info.gen === 2 && typeof info.app === "string" && info.app.substring(0, 3) === "Pro" && verC('1.4.3', typeof info.ver === "string" ? info.ver : ''));
    return (info.gen === 4 || info.gen === 3 || gen2ok);
}
// compare Shelly FW versions
function verC(old, newV) {
    const oldP = old.split('.');
    const newP = newV.split('.');
    for (var i = 0; i < oldP.length || i < newP.length; i++) {
        let a = ~~newP[i]; // parse int
        let b = ~~oldP[i]; // parse int
        if (a > b) return true;
        if (a < b) return false;
    }
    return true; //equal versions meet the minimum requirement
}
// Validate before converting supported numeric enum strings. Never replace invalid settings.
function normC() {
    const problem = cErr(kvsC());
    if (problem) { rErr("Invalid configuration: " + problem); return false; }
    c.tPer = Number(c.tPer);
    return true;
}
// Validate a saved configuration before copying any of it into the active settings.
function modeErr(dt) {
    if (!dt || typeof dt !== "object") { return "expected a configuration object"; }
    if (!idOk(dt.RelayId)) { return "RelayId must be a non-negative integer"; }
    if (dt.ManualKVS !== undefined && typeof dt.ManualKVS !== "boolean") { return "ManualKVS must be true or false"; }
    return "";
}
function cErr(dt) {
    const modeProblem = modeErr(dt);
    if (modeProblem) { return modeProblem; }
    const problem = vErr([
        typeof dt.TimePeriod === "number" ? "" + dt.TimePeriod : dt.TimePeriod,
        dt.HeatingTime, dt.IsForecastUsed, dt.EnergyProvider, dt.AlwaysOnPrice,
        dt.AlwaysOffPrice, dt.InvertedRelay, dt.Country, dt.HeatingCurve
    ], true);
    if (problem) { return problem; }
    return "";
}
// Get KVS ConfigurationData into memory
function memC(dt) {
    c.tPer = dt.TimePeriod;
    c.hTim = dt.HeatingTime;
    c.isFc = dt.IsForecastUsed;
    c.pack = dt.EnergyProvider;
    c.lowR = dt.AlwaysOnPrice;
    c.higR = dt.AlwaysOffPrice;
    c.Inv = dt.InvertedRelay;
    c.rId = dt.RelayId;
    c.cnty = dt.Country;
    c.hCur = dt.HeatingCurve;
    c.mnKv = typeof dt.ManualKVS === "boolean" ? dt.ManualKVS : c.mnKv;
    return c;
}
// ConfigurationData data to KVS store
function kvsC() {
    let cdat = {};
    cdat.TimePeriod = c.tPer;
    cdat.HeatingTime = c.hTim;
    cdat.IsForecastUsed = c.isFc;
    cdat.EnergyProvider = c.pack;
    cdat.AlwaysOnPrice = c.lowR;
    cdat.AlwaysOffPrice = c.higR;
    cdat.InvertedRelay = c.Inv;
    cdat.RelayId = c.rId;
    cdat.Country = c.cnty;
    cdat.HeatingCurve = c.hCur;
    cdat.ManualKVS = c.mnKv;
    return cdat;
}
// Get KVS SystemData into memory
function memS(dt) {
    s.exSc = dt.ExistingSchedule;
    s.vers = dt.Version;
    return s;
}
// SystemData data to KVS store
function kvsS() {
    let sdat = {};
    sdat.LastCalculation = s.last;
    sdat.ExistingSchedule = s.exSc;
    sdat.Version = s.vers;
    return sdat;
}
// Get KVS ConfigurationData and SystemData
function gKvs() {
    _.cdOk = false;
    _.sdOk = false;
    _.vcRepair = false;
    _.grpTried = false;
    _.vcState = 0; //until this cycle's backup read succeeds
    _.cdMissing = false;
    cntr = 3;
    Shelly.call('KVS.Get', { key: "SmartHeatingConf" + _.sId },
        function (res, err, msg) {
            cntr--;
            if (err === -105) { // NOT FOUND: first-time initialization is allowed
                _.cdMissing = true;
                _.cdOk = true;
                return;
            }
            if (err !== 0 || !res) {
                print(_.pId, "Configuration read failed:", msg);
                return;
            }
            let saved;
            try { saved = JSON.parse(res.value); }
            catch (e) { print(_.pId, "Saved configuration is not valid JSON."); return; }
            // Validate mode and relay before reading or backing up any live controls.
            const modeProblem = modeErr(saved);
            if (modeProblem) { print(_.pId, "Correct saved configuration:", modeProblem); return; }
            const priorMode = c.mnKv;
            if (saved.ManualKVS !== undefined) { c.mnKv = saved.ManualKVS; }
            if (isVC()) {
                c.rId = saved.RelayId;
            } else {
                const problem = cErr(saved);
                if (problem) {
                    c.mnKv = priorMode;
                    print(_.pId, "Invalid saved configuration; correct this setting:", problem); return;
                }
                c = memC(saved);
            }
            _.cdOk = true;
        });

    Shelly.call('KVS.Get', { key: "SmartHeatingSys" + _.sId },
        function (res, err, msg) {
            cntr--;
            // A deleted key does not erase the schedule ID already known this boot.
            if (err === -105) { _.sdOk = true; return; }
            if (err !== 0 || !res) { print(_.pId, "SystemData read failed:", err, msg); return; }
            try {
                const saved = JSON.parse(res.value);
                if (!saved || !idOk(saved.ExistingSchedule)) {
                    print(_.pId, "Invalid SystemData: ExistingSchedule must be a non-negative integer."); return;
                }
                s = memS(saved);
                _.sdOk = true;
            } catch (e) { print(_.pId, "SystemData is not valid JSON; restore the record with the correct schedule ID."); }
        });
    Shelly.call('KVS.Get', { key: "SmartHeatingVC" + _.sId }, function (res, err, msg) {
        cntr--;
        const key = "SmartHeatingVC" + _.sId;
        if (err === -105) { _.vcState = 2; return; }
        if (err !== 0 || !res) { print(_.pId, key + " backup read failed:", err, msg); return; }
        _.vcState = 3; //a readable record must also pass parsing and validation
        let values;
        try { values = JSON.parse(res.value); }
        catch (e) { print(_.pId, key + " backup is not valid JSON; stored record retained."); return; }
        const problem = vErr(values);
        if (problem) { print(_.pId, key + " backup is invalid:", problem); return; }
        _.vcVals = values;
        _.vcState = 1;
    });
    wait(inst);
}

// Select running mode like KVS or Virtual components
function inst() {
    if (!_.sdOk) { rErr("SystemData could not be loaded; schedule identity and relay settings were left unchanged."); return; }
    if (!_.cdOk) { rErr("Configuration could not be loaded; stored values and relay settings were left unchanged."); return; }
    if (isVC()) {
        rVc();
    } else {
        _.grpState = 0; //switching modes cancels decorative-group retries
        print(_.pId, c.mnKv === true ? "Script in KVS mode: forced by ManualKVS=true." :
            "Script in KVS mode: device does not meet Virtual Component requirements.");
        if (_.cdMissing) { tKvs(); }
        else { main(); }
    }
}

// Store configuration data to KVS
function tKvs() {
    if (!_.cdOk || !_.cdMissing || !normC()) { return; }
    Shelly.call("KVS.set", { key: "SmartHeatingConf" + _.sId, value: JSON.stringify(kvsC()) },
        function (res, err, msg) {
            if (err !== 0) {
                print(_.pId, "Configuration not stored in KVS:", err, msg);
            } else {
                print(_.pId, "Configuration settings stored in KVS");
            }
        }
    );
    main();
}

// Compact backup order matches rVc's setting map; only complete, valid sets can repair controls.
function nOk(v) { return typeof v === "number" && v - v === 0; }
function idOk(v) { return nOk(v) && v >= 0 && v % 1 === 0; }
function vErr(v, kvs) {
    if (!v || v.length !== 9) { return "expected nine control values"; }
    if (v[0] !== "0" && v[0] !== "6" && v[0] !== "12" && v[0] !== "24") { return "TimePeriod must be 0, 6, 12 or 24"; }
    if (!nOk(v[1]) || v[1] < 0 || (!kvs && v[1] > 24)) { return "HeatingTime must be a non-negative number (0 to 24 in virtual controls)"; }
    if (typeof v[2] !== "boolean") { return "IsForecastUsed must be true or false"; }
    if (!pack(v[3], true)) { return "EnergyProvider is not a supported network package"; }
    if (!nOk(v[4]) || (!kvs && !(v[4] >= 0 && v[4] <= 100))) { return "AlwaysOnPrice must be a number (0 to 100 in virtual controls)"; }
    if (!nOk(v[5]) || (!kvs && !(v[5] >= 0 && v[5] <= 500))) { return "AlwaysOffPrice must be a number (0 to 500 in virtual controls)"; }
    if (typeof v[6] !== "boolean") { return "InvertedRelay must be true or false"; }
    if (v[7] !== "ee" && v[7] !== "fi" && v[7] !== "lv" && v[7] !== "lt") { return "Country must be ee, fi, lv or lt"; }
    if (!nOk(v[8]) || (!kvs && !(v[8] >= -4 && v[8] <= 8))) { return "HeatingCurve must be a number (-4 to 8 in virtual controls)"; }
    return "";
}
// Save only changed values. Fresh installation must save its intended values before adding controls.
function bVc(values, next, data) {
    const text = JSON.stringify(values);
    // A matching cache can cover a transient read failure, never a missing or corrupt record.
    if (_.vcState < 2 && _.vcVals && JSON.stringify(_.vcVals) === text) { next(data); return; }
    Shelly.call("KVS.set", { key: "SmartHeatingVC" + _.sId, value: text }, function (res, err, msg, saved) {
        if (err === 0) { _.vcVals = saved.values; _.vcState = 1; }
        else if (saved.next !== main) { rErr("Cannot save Virtual Component recovery data: " + msg); return; }
        else { print(_.pId, "Virtual Component backup failed; current complete controls will still be used:", msg); }
        saved.next(saved.data);
    }, { values: values, next: next, data: data });
}
// Check all reserved slots before adding only missing controls. Never delete or reset surviving controls.
function gVc(state, live) {
    if (!state || state.offset === undefined) {
        if (_.vcRepair) { rErr("Virtual Component repair did not produce a complete set; check the missing controls before retrying."); return; }
        _.vcRepair = true;
        if (_.vcState === 0 && !_.vcVals) {
            rErr("SmartHeatingVC" + _.sId + " backup is unreadable; initialization and repair are paused. Restore the record or retry the read."); return;
        }
        if (_.vcState === 3 && !_.vcVals) {
            rErr("SmartHeatingVC" + _.sId + " backup is invalid. Restore valid backup JSON or all nine controls. If all reserved controls are already absent and you want defaults, delete SmartHeatingVC" + _.sId + " and restart."); return;
        }
        state = { offset: 0, defs: dtVc(), keys: [], present: [], live: live };
        for (let i = 0; i < state.defs.length; i++) {
            state.keys.push(state.defs[i].type + ":" + state.defs[i].id);
            state.present.push(false);
        }
    }
    Shelly.call("Shelly.GetComponents", {
        dynamic_only: true, keys: state.keys, include: ["config"], offset: state.offset
    }, function (res, err, msg, data) {
        if (err !== 0 || !res || !res.components) { rErr("Cannot inspect Virtual Components: " + msg); return; }
        const comp = res.components;
        for (let i = 0; i < comp.length; i++) {
            const n = data.keys.indexOf(comp[i].key);
            if (n < 0) { continue; }
            if (n > 0 && (!comp[i].config || comp[i].config.name !== data.defs[n].config.name)) {
                rErr("Cannot repair Virtual Component " + comp[i].key + "; restore its expected name '" + data.defs[n].config.name + "'.");
                return;
            }
            if (n === 0) { gNotice(comp[i]); }
            data.present[n] = true;
        }
        const next = (typeof res.offset === "number" ? res.offset : data.offset) + comp.length;
        if (typeof res.total !== "number" || (next < res.total && comp.length === 0)) {
            rErr("Virtual Component inventory is incomplete; repair postponed."); return;
        }
        if (next < res.total) { data.offset = next; gVc(data); return; }
        if (data.present[0]) { _.grpSeen = true; } //remember an observed group even if control validation pauses repair
        // dtVc uses UI order; backups use the rVc map order.
        const order = [-1, 0, 1, 3, 4, 5, 6, 7, 2, 8];
        const values = []; //merge into a new array; a failed write must not alter the validated cache
        const missing = [];
        let found = 0;
        for (let i = 1; i < data.defs.length; i++) {
            if (data.present[i]) { found++; }
        }
        if (found === data.defs.length - 1) {
            rErr("Virtual Component values are unavailable; waiting for a complete read."); return;
        }
        if (found > 0 && !_.vcVals) {
            let missingNames = "";
            for (let i = 1; i < data.defs.length; i++) {
                if (!data.present[i]) { missingNames += (missingNames ? ", " : "") + data.keys[i] + " (" + data.defs[i].config.name + ")"; }
            }
            rErr("Cannot safely repair without a control backup. Missing controls: " + missingNames +
                ". Restore these controls. The backup key is confirmed absent; removing all reserved controls and restarting installs defaults." +
                " To use KVS instead, set ManualKVS=true."); return;
        }
        for (let i = 1; i < data.defs.length; i++) {
            if (data.present[i]) {
                if (!data.live[order[i]][3]) {
                    rErr("Virtual Component values are unavailable; waiting for a complete read."); return;
                }
                values[order[i]] = data.live[order[i]][2];
            } else {
                values[order[i]] = _.vcVals ? _.vcVals[order[i]] : data.defs[i].config.default_value;
                data.defs[i].config.default_value = values[order[i]];
                missing.push(data.defs[i]);
            }
        }
        const problem = vErr(values);
        if (problem) { rErr("Invalid Virtual Component setting: " + problem); return; }
        if (!data.present[0] && !_.grpSeen) { _.grpState = 1; }
        _.grpSeen = true;
        if (data.present[0] && found > 0) {
            print(_.pId, "Control repair leaves existing group membership unchanged; add restored controls manually if needed.");
        }
        bVc(values, aVc, missing);
    }, state);
}
// One add at a time. A failed item stays missing and is retried after a fresh inventory on the next cycle.
function aVc(vCom) {
    if (vCom.length === 0) { rVc(); return; }
    const comp = vCom[0];
    Shelly.call("Virtual.Add", { type: comp.type, id: comp.id, config: comp.config }, function (res, err, msg, data) {
        if (err !== 0) { rErr("Virtual Component " + data[0].type + ":" + data[0].id + " was not added: " + msg); return; }
        print(_.pId, "Added virtual component:", data[0].type + ":" + data[0].id);
        data.splice(0, 1);
        Timer.set(1000, false, aVc, data);
    }, vCom);
}

// Existing groups are decorative and remain untouched, even if renamed or intentionally empty.
function gNotice(comp) {
    if (!_.grpNotice && comp.config && comp.config.name !== "Smart Heating") {
        print(_.pId, "Existing group:200 has a different name; its name and membership are left unchanged.");
        _.grpNotice = true;
    }
}
// Count only failures that would otherwise remain pending; terminal outcomes need no retry.
function grpRetry() {
    _.grpFails++;
    if (_.grpFails >= 3) {
        _.grpState = 0;
        print(_.pId, "Group setup stopped after three retryable failures this boot. Create or populate the group manually if needed; heating continues.");
    } else { print(_.pId, "Group setup will retry during the next required heating calculation."); }
}
// Run only during a required heating calculation, after all nine controls are valid.
// Only a successful create authorizes population.
function sGrp() {
    _.grpTried = true;
    if (_.grpState === 1) {
        Shelly.call("Virtual.Add", { type: "group", id: 200, config: { name: "Smart Heating" } }, function (res, err, msg) {
            if (err === 0 && res && res.id === 200) { _.grpState = 2; sGrp(); return; }
            if (err === 0) { print(_.pId, "Group create response did not confirm numeric id 200; ownership is unverified."); }
            else { print(_.pId, "Decorative group creation failed:", err, msg); }
            // The API does not document a unique already-exists code. Inspect the slot without assuming ownership.
            Shelly.call("Group.GetConfig", { id: 200 }, function (res, err, msg, unverified) {
                if (err === 0 && res) {
                    _.grpState = 0;
                    if (unverified) {
                        print(_.pId, "Group:200 is present, but creation was not verified; retries stopped and membership left unchanged.");
                    } else {
                        _.grpNotice = true;
                        print(_.pId, "Group creation found occupied group:200; retries stopped, existing membership left unchanged.");
                    }
                } else { grpRetry(); }
                main();
            }, err === 0);
        });
        return;
    }
    Shelly.call("Group.Set", { id: 200, value: [
        "enum:200", "number:200", "boolean:200", "number:203", "enum:201",
        "number:201", "number:202", "boolean:201", "enum:202"
    ] }, function (res, err, msg) {
        if (err === 0) { _.grpState = 0; }
        else if (err === -105) {
            _.grpState = 0;
            print(_.pId, "Created group:200 no longer exists; retries stopped and it will not be recreated.");
        } else {
            print(_.pId, "Group membership was not set:", err, msg);
            grpRetry();
        }
        main();
    });
}

// Read every page of this script's Virtual Components and commit only a complete value set.
function rVc(state) {
    if (!state || typeof state !== "object" || !state.map) {
        cntr++;
        state = {
            offset: 0,
            map: [
                ["tPer", "enum:200", null, false, "Heating Period (h)"],
                ["hTim", "number:200", null, false, "Min On Time (h/period)"],
                ["isFc", "boolean:200", null, false, "Forecast Heat"],
                ["pack", "enum:201", null, false, "Network Package"],
                ["lowR", "number:201", null, false, "Heat On (min price)"],
                ["higR", "number:202", null, false, "Heat Off (max price)"],
                ["Inv", "boolean:201", null, false, "Inverted Relay"],
                ["cnty", "enum:202", null, false, "Market Price Country"],
                ["hCur", "number:203", null, false, "Forecast Impact +/-"]
            ],
            keys: []
        };
        for (let i = 0; i < state.map.length; i++) { state.keys.push(state.map[i][1]); }
        state.keys.push("group:200"); //read its name for diagnostics, never adopt its membership
    }
    Shelly.call("Shelly.GetComponents", {
        dynamic_only: true,
        keys: state.keys,
        include: ["status", "config"],
        offset: state.offset
    }, function (res, err, msg, data) {
        if (err !== 0 || !res || !res.components) {
            cntr--;
            rErr("Virtual Component read failed" + (msg ? ": " + msg : ""));
            return;
        }
        const comp = res.components;
        for (let i = 0; i < comp.length; i++) {
            if (comp[i].key === "group:200") { gNotice(comp[i]); }
        }
        for (let i = 0; i < data.map.length; i++) {
            if (data.map[i][3]) { continue; }
            for (let j = 0; j < comp.length; j++) {
                if (data.map[i][1] === comp[j].key) {
                    if (!comp[j].config || comp[j].config.name !== data.map[i][4]) {
                        cntr--;
                        rErr("Virtual Component " + comp[j].key + " has missing configuration or a conflicting name; expected '" + data.map[i][4] + "'.");
                        return;
                    }
                    if (!comp[j].status || comp[j].status.value === undefined) {
                        cntr--;
                        rErr("Virtual Component " + comp[j].key + " has no usable value.");
                        return;
                    }
                    data.map[i][2] = comp[j].status.value;
                    data.map[i][3] = true;
                    break;
                }
            }
        }
        const next = (typeof res.offset === "number" ? res.offset : data.offset) + comp.length;
        if (typeof res.total === "number" && next < res.total && comp.length > 0) {
            data.offset = next;
            rVc(data);
            return;
        }
        let found = 0;
        for (let i = 0; i < data.map.length; i++) {
            if (data.map[i][3]) { found++; }
        }
        const isOk = found === data.map.length;
        cntr--;
        if (isOk) {
            _.grpSeen = true;
            const values = [];
            for (let i = 0; i < data.map.length; i++) { values.push(data.map[i][2]); }
            const problem = vErr(values);
            if (problem) { rErr("Invalid Virtual Component setting: " + problem); return; }
            for (let i = 0; i < data.map.length; i++) { c[data.map[i][0]] = data.map[i][2]; }
            print(_.pId, "Virtual Component mode active");
            bVc(values, main);
        } else {
            gVc(null, data.map);
        }
    }, state);
}

// Main script where all the logic starts.
function main() {
    if (!normC()) { return; }
    if (_.grpState && !_.grpTried && isVC()) { sGrp(); return; }
    _.cPer = c.tPer <= 0 ? 0 : Math.ceil((24 * 100) / (c.tPer * 100));  //number of periods in a day
    _.hTim = c.hTim > c.tPer ? c.tPer : c.hTim;                         //heating time can't be more than the period
    //check if Shelly has time
    if (!isTm) {
        hErr("Shelly has no time");
        return;
    }
    // set the network provider
    if (c.pack.substring(0, 4) == "VORK") {
        _.prov = "Elektlevi";
    } else if (c.pack.substring(0, 4) == "PART") {
        _.prov = "Imatra";
    } else if (c.pack.substring(0, 4) == "PAMA" || c.pack.substring(0, 7) == "SPECIAL") {
        _.prov = "Lv";
    }
    print(_.pId, "Network provider: ", _.prov, c.pack);


    // If weather forecast is used for heating hours
    if (c.isFc && c.tPer > 0) {
        gFcs();
    } else {
        gEle();
    }
}

// Get Open-Meteo min and max "feels like" temperatures
function gFcs() {
    const loc = Shelly.getComponentConfig("sys").location;
    if (!loc || loc.lat === null || loc.lat === undefined || loc.lon === null || loc.lon === undefined) {
        hErr("Shelly has no location for the forecast; set the device location.");
        return;
    }
    let url = "https://api.open-meteo.com/v1/forecast?hourly=apparent_temperature&timezone=auto&forecast_days=1&forecast_hours=";
    url = url + c.tPer + "&latitude=" + loc.lat + "&longitude=" + loc.lon;
    print(_.pId, "Forecast query: ", url)
    Shelly.call("HTTP.GET", { url: url, timeout: 5, ssl_ca: "*" }, function (res, err) {
        url = null;
        if (err != 0 || res === null || res.code != 200 || !res.body) {
            hErr("Get forecast HTTP.GET error, check again in " + _.freq / 60 + " min.");
            return;
        }
        // Scan only the needed array instead of materializing the full JSON response.
        let sumT = 0;
        let nTmp = 0;
        let pos = res.body.indexOf("\"apparent_temperature\":[");
        if (pos >= 0) {
            pos += 24;
            const end = res.body.indexOf("]", pos);
            while (pos > 0 && pos < end) {
                let next = res.body.indexOf(",", pos);
                if (next < 0 || next > end) { next = end; }
                const temp = Number(res.body.substring(pos, next));
                if (temp === temp) {
                    sumT += temp;
                    nTmp++;
                }
                pos = next + 1;
            }
        }
        res = null;
        if (nTmp === 0) {
            hErr("Forecast response has no temperatures, check again in " + _.freq / 60 + " min.");
            return;
        }

        const tFcs = Math.ceil(sumT / nTmp);        //AVG and round temperature up
        _.tsFc = Math.floor(Date.now() / 1000.0);   //store the timestamp into memory
        print(_.pId, "We got weather forecast from Open Meteo at ", new Date().toString());

        // calculating heating hours
        const maxT = 16;                            //max temperature for the forecast
        let fcTm = ((maxT - tFcs) * (c.pFac - 1) + (maxT - tFcs + c.hCur * 2 - 2)); //the main heating time calculation algorithm
        fcTm = fcTm < 0 || tFcs > maxT ? 0 : fcTm;  //heating time can't be negative
        _.hTim = Math.floor(fcTm / _.cPer);         //heating time per period (round-down heating time)
        if (fcTm > 0 && _.hTim < c.hTim) {
            _.hTim = c.hTim;                       //apply minimum only when heating demand exists
        }
        _.hTim = _.hTim > c.tPer ? c.tPer : _.hTim; //heating time can't be more than the period

        print(_.pId, "Temperture forecast width windchill is ", tFcs, " °C, and heating enabled for ", _.hTim, " hours.");
        gEle();
    });
}
// Parse exactly one quoted CSV row within its line boundaries.
function pRow(body, start, end, row) {
    if (body.slice(start, start + 1) !== '"') { return false; }
    const epEnd = body.indexOf('"', start + 1);
    if (epEnd <= start + 1 || epEnd >= end || body.slice(epEnd, epEnd + 3) !== '";"') { return false; }
    const dtEnd = body.indexOf('"', epEnd + 3);
    if (dtEnd < 0 || dtEnd >= end || body.slice(dtEnd, dtEnd + 3) !== '";"') { return false; }
    const priceStart = dtEnd + 3;
    const priceEnd = body.indexOf('"', priceStart);
    if (priceEnd <= priceStart || priceEnd !== end - 1) { return false; }
    const epoch = Number(body.substring(start + 1, epEnd));
    const price = Number(body.substring(priceStart, priceEnd).replace(",", "."));
    // Subtracting a finite number from itself is zero; NaN and infinities fail this check.
    if (epoch - epoch !== 0 || price - price !== 0) { return false; }
    row[0] = epoch; row[1] = price;
    return true;
}
// Get electricity market price CSV file from Elering
function gEle() {
    // set the date range for Elering query
    const epch = Shelly.getComponentStatus("sys").unixtime;
    const shHr = new Date(epch * 1000).getHours();
    // After 23:00 tomorrow's energy prices are used
    // before 23:00 today's energy prices are used.
    const day = shHr >= 23 ? 1 : 0;
    const epSt = lMid(epch, day);
    const epEn = lMid(epch, day + 1);
    const qExp = Math.floor((epEn - epSt) / (15 * 60));
    const dtSt = new Date(epSt * 1000).toISOString().slice(0, 19) + "Z";
    // Elering includes the end timestamp, so request the final quarter instead of next midnight.
    const dtEn = new Date((epEn - 15 * 60) * 1000).toISOString().slice(0, 19) + "Z";
    // Build Elering URL
    let url = "https://dashboard.elering.ee/api/nps/price/csv?fields=";
    url += c.cnty + "&start=" + dtSt + "&end=" + dtEn;
    print(_.pId, "Elering query: ", url);

    Shelly.call("HTTP.GET", { url: url, timeout: 5, ssl_ca: "*" }, function (res, err) {
        url = null;
        if (err != 0 || res === null || res.code != 200 || !res.body_b64) {
            hErr("Elering HTTP.GET error, check again in " + _.freq / 60 + " min.");
            return;
        }
        let p = pack(c.pack, false); //allocate only the selected transfer fee package
        if (!p) {
            c.pack = "NONE";
            rErr("Unknown network package; reset to NONE and retrying.");
            return;
        }

        let body = atob(res.body_b64); //decode base64 to text
        res = null;
        let raw = [];
        let eler = [];
        let pos = body.indexOf("\n") + 1;
        let qCnt = 0;
        let hour = -1, first = 0, sum = 0, count = 0;
        let valid = pos > 0;
        const row = [0, 0]; //reuse one row while scanning the response
        while (valid && pos < body.length) {
            let end = body.indexOf("\n", pos);
            if (end < 0) { end = body.length; }
            let rowEnd = end;
            if (body.slice(rowEnd - 1, rowEnd) === "\r") { rowEnd--; }
            if (!pRow(body, pos, rowEnd, row) || row[0] !== epSt + qCnt * 900) { valid = false; break; }
            const hr = new Date(row[0] * 1000).getHours();
            if (hr !== hour) {
                if (count > 0) { raw.push([first, Math.round(sum / count * 100) / 100 + fFee(first, p)]); }
                hour = hr; first = row[0]; sum = 0; count = 0;
            }
            // Cron fires only at the first occurrence of a repeated local hour.
            // Price its first four quarters; still validate every quarter of the 25-hour day.
            if (count < 4) { sum += row[1]; count++; }
            qCnt++;
            pos = end + 1;
        }
        body = null;
        if (!valid || qCnt !== qExp) {
            hErr("Elering response is incomplete or malformed; retrying in " + _.freq / 60 + " min.");
            return;
        }
        if (count > 0) { raw.push([first, Math.round(sum / count * 100) / 100 + fFee(first, p)]); }
        //store the timestamp into memory
        _.tsPr = Math.floor(Date.now() / 1000.0);
        print(_.pId, "We got market prices from Elering ", new Date().toString());

        if (c.tPer <= 0) {
            // Calculate schedules based on alwaysOnLowPrice.
            for (let a = 0; a < raw.length; a++) {
                let ts = raw[a][0];
                let pric = raw[a][1];
                let fee = fFee(ts, p);
                let mPric = Math.round((pric - fee) * 100) / 100;
                let forceOn = mPric <= c.lowR;
                let forceOff = mPric >= c.higR;
                if (forceOn && !forceOff) {
                    eler.push([new Date(ts * 1000).getHours(), pric]);
                    print(_.pId, "Energy price ", mPric, " EUR/MWh at ", new Date(ts * 1000).getHours() + ":00 is at or below min price and used for heating.");
                }
            }
            if (!eler.length) {
                print(_.pId, "No energy prices at or below min price level. No heating.");
            }
        } else {    // Calculate schedules based on the cheap hours in the heating period.
            let numP = Math.ceil((new Date().getHours() % 23 + 2) / c.tPer);    //finds the current period for forecast calculation    

            // Create an array for each heating period, sort, and push the prices 
            for (let i = 0; i < _.cPer; i++) {                              //loop through the periods
                if (c.isFc && (i + 1) != numP) { continue; }                //use only the current period in case of forecast, skip the rest
                let hPer = (i + 1) * c.tPer > 24 ? 24 : (i + 1) * c.tPer;   //finds the end of the period
                let oneP = [];
                for (let j = 0; j < raw.length; j++) {                      //find prices by local hour (DST-safe)
                    let rHr = new Date(raw[j][0] * 1000).getHours();
                    if (rHr >= i * c.tPer && rHr < hPer) {
                        oneP.push(raw[j]);
                    }
                }
                oneP = srAr(oneP, 1); //sort by price
                let hHrs = oneP.length < _.hTim ? oneP.length : _.hTim;     //finds max hours to heat in that period 

                for (let a = 0; a < oneP.length; a++) {
                    let ts = oneP[a][0];
                    let pric = oneP[a][1];
                    let fee = fFee(ts, p);
                    let mPric = Math.round((pric - fee) * 100) / 100;
                    let forceOn = mPric <= c.lowR;
                    let forceOff = mPric >= c.higR;
                    if (!forceOff && (a < hHrs || forceOn)) {
                        eler.push([new Date((ts) * 1000).getHours(), pric]);
                    }
                }
            }
            if (!eler.length) {
                print(_.pId, "Current configuration does not permit heating during any hours; it is likely that the AlwaysOffPrice value is set too low.")
            }
        }
        p = null;
        raw = null;
        _.manu = false;
        fTmr(eler); //set the fail-safe timer before replacing the existing schedule
        eler = null;
    });
}

// Get Shelly timezone offset in seconds 
function gTz(epoch) {
    const shDt = new Date(epoch * 1000);
    const shHr = shDt.getHours();
    const utcH = Number(shDt.toISOString().slice(11, 13));
    let tz = shHr - utcH;
    if (tz > 12) { tz -= 24; }
    if (tz < -12) { tz += 24; }
    return tz * 60 * 60;
}

// UTC epoch of local midnight, addD local days from the supplied epoch.
function lMid(epoch, addD) {
    const day = Math.floor((epoch + gTz(epoch)) / (24 * 60 * 60)) + addD;
    return day * 24 * 60 * 60 - gTz(day * 24 * 60 * 60);
}

// Calculate transfer fee based on the timestamp.
function fFee(epoch, p) {
    const dt = new Date(epoch * 1000);
    const hour = dt.getHours();
    const day = dt.getDay();
    const mnth = dt.getMonth();
    if (_.prov === "Elektlevi") {
        if ((mnth >= 10 || mnth <= 2) && (day === 0 || day === 6) && hour >= 16 && hour < 20) {
            // peak holiday: Nov-Mar, SA-SU at 16:00–20:00
            return p.hMRt;
        } else if ((mnth >= 10 || mnth <= 2) && day !== 0 && day !== 6 && ((hour >= 9 && hour < 12) || (hour >= 16 && hour < 20))) {
            // peak daytime: Nov-Mar: MO-FR at 09:00–12:00 and at 16:00–20:00
            return p.dMRt;
        } else if (hour < 7 || hour >= 22 || day === 6 || day === 0) {
            //night-time: MO-FR at 22:00–07:00, SA-SU all day
            return p.nRt;
        } else {
            //daytime: MO-FR at 07:00–22:00
            return p.dRt;
        }
    } else if (_.prov === "Imatra") {
        if (gTz(epoch) / 60 / 60 === 3) { //summer time
            if (hour < 8 || day === 6 || day === 0) {
                //summer-night-time: MO-FR at 00:00–08:00, SA-SU all day
                return p.nRt;
            } else {
                //daytime: MO-FR at 08:00–24:00
                return p.dRt;
            }
        } else {
            if (hour < 7 || hour >= 23 || day === 6 || day === 0) {
                //winter-night-time: MO-FR at 23:00–07:00, SA-SU all day
                return p.nRt;
            } else {
                //daytime: MO-FR at 07:00–23:00
                return p.dRt;
            }
        }
    } else if (_.prov === "Lv") {
        return p.dRt;
    } else {
        return 0;
    }
}

// Check the old schedule's actual relay command before changing its timer.
function fTmr(eler) {
    if (!(s.exSc > 0) && _.relayScanned) { sTmr(eler); return; }
    Shelly.call("Schedule.List", null, function (res, err, msg, data) {
        if (err !== 0 || !res || !res.jobs) {
            if (!(s.exSc > 0)) { print(_.pId, "Could not inspect additional relay schedules:", msg); sTmr(data); return; }
            rErr("Cannot check the existing schedule before updating its timer: " + msg); return;
        }
        for (let i = 0; !_.relayScanned && i < res.jobs.length; i++) {
            const job = res.jobs[i];
            if (job.id === s.exSc || !job.calls) { continue; }
            for (let j = 0; j < job.calls.length; j++) {
                const call = job.calls[j];
                if (call.method === "Switch.Set" && call.params && call.params.id === c.rId) {
                    print(_.pId, "Additional schedule ID " + job.id + " controls relay " + c.rId + "; ownership unknown, left unchanged. Scheduling continues."); break;
                }
            }
        }
        _.relayScanned = true; //an empty successful scan also completes the diagnostic
        for (let i = 0; i < res.jobs.length; i++) {
            const job = res.jobs[i];
            if (job.id !== s.exSc) { continue; }
            const call = job.calls && job.calls.length === 1 ? job.calls[0] : null;
            res = null; //release the other jobs before sending the next RPC
            if (job.enable === false || (call && call.method === "Switch.Set" && call.params &&
                call.params.id === c.rId && call.params.on === !c.Inv)) {
                sTmr(data);
            } else {
                Shelly.call("Schedule.Update", { id: job.id, enable: false }, function (res, err, msg, hours) {
                    if (err !== 0) { rErr("Cannot disable the old schedule before changing relay polarity: " + msg); return; }
                    print(_.pId, "Old schedule disabled before changing relay polarity; it will stay disabled if replacement fails.");
                    sTmr(hours);
                }, data);
            }
            return;
        }
        s.exSc = 0; //the recorded schedule is already absent
        sTmr(data);
    }, eler);
}
// Set countdown timer to flip Shelly status after any incompatible schedule is disabled.
function sTmr(eler) {
    const timr = c.tmr * 60 + 10; //+10sec to remove flap between continous heating hours
    Shelly.call("Switch.SetConfig", {
        id: c.rId,
        config: {
            auto_on: c.Inv,
            auto_on_delay: timr,
            auto_off: !c.Inv,
            auto_off_delay: timr
        }
    }, function (res, err, msg, data) {
        if (err !== 0) {
            const config = Shelly.getComponentConfig("switch", c.rId);
            const delay = c.tmr * 60 + 10;
            if (!config || config.auto_on !== c.Inv || config.auto_off !== !c.Inv ||
                (c.Inv ? config.auto_on_delay : config.auto_off_delay) !== delay) {
                rErr("Relay timer update failed and a matching timer could not be verified: " + msg);
                return;
            }
            print(_.pId, "Relay timer update failed, but the existing timer matches; continuing.");
        }
        fdSc(data);
    }, eler);
}
// Delete the existing schedule if it exists
function fdSc(eler) {
    if (!(s.exSc > 0)) {
        fScd(eler);
        return;
    }
    Shelly.call("Schedule.Delete", { id: s.exSc }, function (res, err, msg, data) {
        if (err !== 0) {
            // A stale KVS ID is safe to replace only after confirming that no such schedule exists.
            Shelly.call("Schedule.List", null, function (list, listErr, listMsg, old) {
                let found = false;
                if (listErr === 0 && list && list.jobs) {
                    for (let i = 0; i < list.jobs.length; i++) {
                        if (list.jobs[i].id === old.id) {
                            found = true;
                            break;
                        }
                    }
                    if (!found) {
                        s.exSc = 0;
                        fScd(old.eler);
                        return;
                    }
                }
                rErr("Schedule " + old.id + " was not deleted: " + msg + ". " + listMsg);
            }, data);
            return;
        }
        s.exSc = 0;
        fScd(data.eler);
    }, { id: s.exSc, eler: eler });
}

// Create a new schedule with the advanced timespec to cover all the hours within the same schedule item
function fScd(eler) {
    cntr = 1;
    _.scId = 0;
    if (eler === undefined || eler.length == 0) {
        print(_.pId, "No heating calculated for any hours with the current configuration.")
        fKvs();
        return;
    }
    // Sort the heating by hour
    let sArr = srAr(eler, 0);
    eler = [];
    let hArr = [];
    let pArr = [];
    for (let i = 0; i < sArr.length; i++) {
        let hr = sArr[i][0];
        hArr.push(hr);
        let t = hr < 10 ? "0" + hr : hr;
        pArr.push(t + ":00 (" + sArr[i][1] + ")");
    }
    const hrs = hArr.join(",");     //create timespec
    const pric = pArr.join(", ");   //create hours (prices) for print
    Shelly.call("Schedule.Create", {
        enable: true,
        timespec: "0 0 " + hrs + " * * *",
        calls: [{
            method: "Switch.Set",
            params: {
                id: c.rId,
                on: !c.Inv
            }
        }]
    }, function (res, err, msg) {
        if (err !== 0) {
            print(_.pId, "Scheduler not created:", err, msg);
            _.tsPr = 0;
            if (c.isFc) { _.tsFc = 0; }
            _.manu = false;
        } else {
            _.scId = res.id; //last scheduleID to store in KVS
        }
        cntr--;
    });
    print(_.pId, "Heating will be turned on to following hours 'HH:mm (EUR/MWh Energy Price + Transmission)':\n", pric);
    wait(fKvs);
}

// Keep the new ID in memory until it is saved; later cycles retry this write before reading stale KVS.
function fKvs() {
    s.last = new Date().toString();
    s.exSc = _.scId;
    s.vers = _.newV;
    _.sysPending = true;
    pSys();
}
function pSys() {
    cntr = 1;
    Shelly.call("KVS.set", { key: "SmartHeatingSys" + _.sId, value: JSON.stringify(kvsS()) },
        function (res, err, msg) {
            cntr--;
            if (err !== 0) {
                print(_.pId, "Schedule updates are paused. Schedule ID", s.exSc, "could not be saved:", msg,
                    "Retrying the same record in", _.freq / 60, "min.");
                _.isLp = false;
                return;
            }
            _.sysPending = false;
            s.last = null;
            print(_.pId, "Script v", _.newV, (s.exSc > 0 ? " saved schedule ID:" + s.exSc : " saved no heating schedule") +
                ", next heating calculation at", nxHr(1) + (_.updD < 10 ? ":0" : ":") + _.updD);
            f_Wd();
        });
}

//if the internet is not working or Elering is down
function fMan() {
    if (_.manu) {
        _.isLp = false; //a previous cycle already installed the fallback; no RPCs are pending
        return;
    }
    _.manu = true;

    let chpH = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 21, 22, 23, 18, 19, 20];
    let eler = [];
    const fbTim = c.hTim > c.tPer ? c.tPer : c.hTim;
    for (let i = 0; i < _.cPer; i++) {                  //create schedule for each period
        let hT = (i * c.tPer) + fbTim;                  //use configured fallback time
        hT = hT > 24 ? 24 : hT;                         //if the end of the period is more than 24, set it to 24
        for (let j = i * c.tPer; j < hT; j++) {         //find the prices in each period
            eler.push([chpH[j], "-"]);                  //copy the price to the new array
        }
    }
    chpH = null;
    fTmr(eler); //set the fail-safe timer before replacing the existing schedule
}

// Shelly doesnt support Javascript sort function so this basic math algorithm will do the sorting job
function srAr(arr, sort) {
    let i, j, k, min, max, minX, maxX, tmp;
    j = arr.length - 1;
    for (i = 0; i < j; i++) {
        min = max = arr[i][sort];
        minX = maxX = i;
        for (k = i; k <= j; k++) {
            if (arr[k][sort] > max) {
                max = arr[k][sort];
                maxX = k;
            } else if (arr[k][sort] < min) {
                min = arr[k][sort];
                minX = k;
            }
        }
        tmp = arr[i];
        arr[i] = arr[minX];
        arr[minX] = tmp;

        if (arr[minX][sort] === max) {
            tmp = arr[j];
            arr[j] = arr[minX];
            arr[minX] = tmp;
        } else {
            tmp = arr[j];
            arr[j] = arr[maxX];
            arr[maxX] = tmp;
        }
        j--;
    }
    return arr;
}

// Handle errors by logging and setting manual mode.
function hErr(msg) {
    if (c.tPer === 0) {
        rErr("Threshold-only mode needs current prices; no historical-hour fallback is defined. Relay settings and any existing schedule are left unchanged. " + msg);
        return;
    }
    print(_.pId, "# Internet error; calculating offline fallback:", msg);
    fMan();     //keep the loop locked until the asynchronous fallback finishes
}
// Handle local RPC failures without replacing the last known working schedule.
function rErr(msg) {
    print(_.pId, "Schedule updates are paused.", msg);
    print(_.pId, s.exSc > 0 ? "Keeping recorded schedule ID " + s.exSc + "." : "No heating schedule is recorded.",
        "Retrying in " + _.freq / 60 + " min.");
    _.tsPr = 0;
    if (c.isFc) { _.tsFc = 0; }
    _.manu = false;
    _.isLp = false;
}
// Wait for the RPC calls to be completed before starting next function.
function wait(data) {
    if (cntr !== 0) {
        Timer.set(1000, false, wait, data);
        return;
    }
    if (typeof data === "function") {   //if data is a function, call it
        data();
    } else {                            //if data is an array, the first element is a function and the second element is a parameter
        data[0](data[1]);
    }
}

// Next hour for heating calculation
function nxHr(adHr) {
    const chkT = c.isFc && c.tPer > 0 ? c.tPer : 24;
    const hr = (Math.ceil((new Date(Date.now() + (adHr * 60 * 60 * 1000)).getHours() + 1) / chkT) * chkT) - 1;
    return hr > 23 ? 23 : hr;
}

/**
Getting prices or forecast for today if 
    * prices or forecast have never been fetched OR 
    * prices or forecast are not from today or yesterday OR 
    * prices or forecast needs regular update
 */
function updt(ts) {
    const nHr = nxHr(0);                                //next hour for heating calculation
    const now = new Date();                             //now
    const yDt = new Date(now - 60 * 60 * 24 * 1000);    //yesterday
    const tDt = new Date(ts * 1000);                    //timestamp
    const tTd = tDt.getFullYear() === now.getFullYear() && tDt.getMonth() === now.getMonth() && tDt.getDate() === now.getDate();
    const tYd = tDt.getFullYear() === yDt.getFullYear() && tDt.getMonth() === yDt.getMonth() && tDt.getDate() === yDt.getDate();
    const tAft = tDt.getHours() === nHr && tTd;
    const isTm = now.getHours() === nHr && now.getMinutes() >= _.updD;
    return (isTm && !tAft) || !(tTd || tYd);
}

// This loop is to update the heating schedule
function loop() {
    if (_.isLp) {
        return;
    }
    _.isLp = true;
    if (_.sysPending) { pSys(); return; }
    if (updt(_.tsPr) || c.isFc && updt(_.tsFc)) {   //check if the prices or forecast needs to be updated
        strt();                                     //start the program
    } else {
        _.isLp = false;
    }
}

let isTm = false;   //check if Shelly has time
let t_hd;           //timer handle
let t_ct = 0;       //time counter
let lNot = true;    //loop notification
function fcTm() {
    const epch = Shelly.getComponentStatus("sys").unixtime;
    if (epch > 0) {
        //if time is OK, then stop the timer
        Timer.clear(t_hd);
        isTm = true;
        print(_.pId, "Shelly has time ", new Date(epch * 1000));
        //start the main loop with a random delay (0-5 sec) to avoid the same starting time for concurrent instances
        Timer.set(Math.floor(Math.random() * 5) * 1000, false, loop);
    } else {
        t_ct++;
        print(_.pId, "Shelly has no time", t_ct, "seconds. We wait for the time to be set.");
        if (t_ct > 30 && lNot) {
            loop(); //start the main loop if the time is not set in 30 seconds
            lNot = false;
        }
        return;
    }
}

/*  ---------  WATCHDOG START  ---------   */
/** find watchdog script ID */
function f_Wd() {
    if (_.wdOk) {
        const config = Shelly.getComponentConfig("script", _.wdId);
        const status = config && config.name === "watchdog" ? Shelly.getComponentStatus("script", _.wdId) : null;
        if (status && status.running) {
            _.isLp = false;
            return;
        }
        _.wdOk = false;
        if (status) {
            // Restart stopped code without another flash write.
            Shelly.call('Script.Start', { id: _.wdId }, function (res, err) {
                if (err === 0) {
                    _.wdOk = true;
                    print(_.pId, "Watchdog script started again.");
                    _.isLp = false;
                } else {
                    f_Wd(); //fall back to reinstalling the watchdog
                }
            });
            return;
        }
    }
    Shelly.call('Script.List', null, function (res, err, msg) {
        if (err !== 0 || !res || !res.scripts) {
            print(_.pId, "Watchdog script list failed:", msg);
            _.isLp = false;
            return;
        }
        let id = 0;
        const scr = res.scripts;
        res = null;
        for (let i = 0; i < scr.length; i++) {
            if (scr[i].name === "watchdog") {
                id = scr[i].id;
                break;
            }
        }
        /** Create a new script (id==0) or stop the existing script (id<>0) if watchdog found. */
        if (id === 0) {
            Shelly.call('Script.Create', { name: "watchdog" }, putC, { id: id });   //create a new watchdog
        } else {
            Shelly.call('Script.Stop', { id: id }, putC, { id: id });               //stop the existing watchdog
        }
    });
}

// Add code to the watchdog
function putC(res, err, msg, data) {
    if (err !== 0) {
        print(_.pId, "Watchdog script not created:", msg, ". Schedule will not be deleted if heating script is stopped or deleted.");
        _.isLp = false;
    } else {
        let code = 'function strt(e){Shelly.call("KVS.Get",{key:"SmartHeatingSys"+e},(function(t,l,n,i){0===l&&t&&delS(JSON.parse(t.value),i.id)}),{id:e})}function delS(e,t){let l=e.ExistingSchedule;l>0&&Shelly.call("Schedule.Delete",{id:l},(function(e,t,l,n){if(0!==t){print("Script #"+n.scId,"schedule ",n.id," deletion by watchdog failed.");return}print("Script #"+n.scId,"schedule ",n.id," deleted by watchdog."),updK(n.sDat,n.scId)}),{id:l,scId:t,sDat:e})}function updK(e,t){e.ExistingSchedule=0,Shelly.call("KVS.set",{key:"SmartHeatingSys"+t,value:JSON.stringify(e)})}Shelly.addStatusHandler((function(e){"script"===e.name&&!e.delta.running&&strt(e.id)}));'
        const id = res.id > 0 ? res.id : data.id;   //get the script ID
        Shelly.call('Script.PutCode', { id: id, code: code }, function (res, err, msg, data) {
            if (err === 0) {
                a_St(data.id);
            } else {
                print(_.pId, "Code is not added to the script:", msg, ". Schedule will not be deleted if heating script is stopped or deleted.")
                _.isLp = false;
            }
        }, { id: id });
    }
}

// Enable autostart for the watchdog
function a_St(sId) {
    if (!Shelly.getComponentConfig("script", sId).enable) {
        Shelly.call('Script.SetConfig', { id: sId, config: { enable: true } }, function (res, err, msg) {
            if (err !== 0) {
                print(_.pId, "Watchdog script autostart is not enabled.", msg, ". After Shelly restart, this script will not start and schedule is not deleted if heating script is stopped or deleted.");
            }
        });
    }
    // Start the watchdog
    Shelly.call('Script.Start', { id: sId }, function (res, err, msg) {
        if (err === 0) {
            _.wdOk = true;
            _.wdId = sId;
            print(_.pId, "Watchdog script created and started successfully.");
            print("// Memory Used:", Shelly.getComponentStatus("script", Shelly.getCurrentScriptId()).mem_used,
                "Peak:", Shelly.getComponentStatus("script", Shelly.getCurrentScriptId()).mem_peak);

        } else {
            _.wdOk = false;
            print(_.pId, "Watchdog script is not started.", msg, ". Schedule will not be deleted if heating script is stopped or deleted.");
        }
        _.isLp = false;
    });
}
/*  ---------  WATCHDOG END  ---------   */

t_hd = Timer.set(1000, true, fcTm);     //start the Shelly timecheck timer
Timer.set(_.freq * 1000, true, loop);   //start the main loop with a frequency of 5 minutes
