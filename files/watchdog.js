// This is a watchdog reference code.
function strt(scId) {
    Shelly.call('KVS.Get', { key: "SmartHeatingSys" + scId },
        function (res, err, msg, data) {
            if (err === 0 && res) {
                let saved;
                try { saved = JSON.parse(res.value); }
                catch (e) { print('Script #' + data.id, 'SystemData is not valid JSON.'); return; }
                const id = saved && saved.ExistingSchedule;
                if (!saved || typeof saved !== 'object' || typeof id !== 'number' ||
                    id - id !== 0 || id < 0 || id % 1 !== 0) {
                    print('Script #' + data.id, 'Invalid SystemData schedule ID.');
                    return;
                }
                const status = Shelly.getComponentStatus('script', data.id);
                if (status && status.running) { return; }
                delS(saved, data.id, res.etag);
            }
        }, { id: scId });
}
function delS(sDat, scId, etag) {
    const scheduleId = sDat.ExistingSchedule;
    if (!(scheduleId > 0)) {
        return;
    }
    Shelly.call("Schedule.Delete", { id: scheduleId },
        function (res, err, msg, data) {
            if (err !== 0) {
                print('Script #' + data.scId, 'schedule ', data.id, ' deletion by watchdog failed.');
                return;
            }
            print('Script #' + data.scId, 'schedule ', data.id, ' deleted by watchdog.');
            updK(data.sDat, data.scId, data.etag);
        }, { id: scheduleId, scId: scId, sDat: sDat, etag: etag }
    );
}
function updK(sDat, scId, etag) {
    if (typeof etag !== 'string' || etag === '') {
        print('Script #' + scId, 'SystemData not cleared: missing etag.');
        return;
    }
    sDat.ExistingSchedule = 0;
    Shelly.call("KVS.set", { key: "SmartHeatingSys" + scId, value: JSON.stringify(sDat), etag: etag },
        function (res, err, msg) {
            if (err !== 0) { print('Script #' + scId, 'SystemData not cleared; record may have changed:', msg); }
        });
}
Shelly.addStatusHandler(function (res) {
    if (res.name === 'script' && !res.delta.running) {
        strt(res.id);
    }
});
