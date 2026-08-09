// This is a watchdog reference code.
function strt(scId) {
    Shelly.call('KVS.Get', { key: "SmartHeatingSys" + scId },
        function (res, err, msg, data) {
            if (err === 0 && res) {
                delS(JSON.parse(res.value), data.id);
            }
        }, { id: scId });
}
function delS(sDat, scId) {
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
            updK(data.sDat, data.scId);
        }, { id: scheduleId, scId: scId, sDat: sDat }
    );
}
function updK(sDat, scId) {
    sDat.ExistingSchedule = 0;
    Shelly.call("KVS.set", { key: "SmartHeatingSys" + scId, value: JSON.stringify(sDat) },);
}
Shelly.addStatusHandler(function (res) {
    if (res.name === 'script' && !res.delta.running) {
        strt(res.id);
    }
});
