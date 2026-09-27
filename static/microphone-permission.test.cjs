const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function readSection(file, startMarker, endMarker) {
    const source = fs.readFileSync(path.join(__dirname, file), 'utf8');
    const start = source.indexOf(startMarker);
    const end = source.indexOf(endMarker, start);
    assert.ok(start >= 0 && end > start, `missing permission entry in ${file}`);
    return source.slice(start, end);
}

const capturePermission = readSection(
    'app/app-audio-capture.js',
    'async function ensureMicrophonePermission()',
    '// 监听设备变化',
);
const avatarPermission = readSection(
    'avatar/avatar-ui-popup.js',
    'ManagerProto.renderMicList = async function',
    '// 新增方法连接',
);

for (const entry of ['capture', 'avatar']) {
    for (const enumerationFails of [false, true]) {
        test(`${entry} permission disables AGC and releases tracks (enumeration fails: ${enumerationFails})`, async () => {
            const requests = [];
            const tracks = [{ stopped: false }, { stopped: false }];
            for (const track of tracks) track.stop = () => { track.stopped = true; };
            let enumerationCount = 0;
            const enumerateDevices = async () => {
                enumerationCount += 1;
                assert.ok(tracks.every(track => track.stopped), 'release before enumeration');
                if (enumerationFails) throw new Error('device enumeration failed');
                return [];
            };
            const context = vm.createContext({
                navigator: { mediaDevices: {
                    getUserMedia: async constraints => {
                        requests.push(constraints);
                        return { getTracks: () => tracks };
                    },
                    enumerateDevices,
                } },
                window: {},
                document: { createElement: () => ({ style: {} }) },
                console: { log() {}, warn() {}, error() {} },
                ManagerProto: {},
                micPermissionGranted: false,
                cachedMicDevices: null,
                enumerateAndCacheMediaDevices: enumerateDevices,
            });
            if (entry === 'capture') {
                vm.runInContext(capturePermission, context);
                await context.ensureMicrophonePermission();
            } else {
                vm.runInContext(avatarPermission, context);
                await context.ManagerProto.renderMicList({ innerHTML: '', appendChild() {} });
            }
            assert.equal(requests.length, 1);
            assert.equal(requests[0].audio.autoGainControl, false,
                'permission-only capture must not use browser-default AGC');
            assert.ok(enumerationCount > 0);
            assert.ok(tracks.every(track => track.stopped));
        });
    }
}
