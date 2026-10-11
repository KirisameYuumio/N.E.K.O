const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const source = fs.readFileSync(path.resolve(__dirname, '../../static/js/model_manager/vrm-emotion-source.js'), 'utf8');
async function flush() { for (let i = 0; i < 15; i++) await Promise.resolve(); }
function setup(options = {}) {
    const listeners = new Map(), previews = [], loads = [];
    const window = { location: { href: 'http://localhost:48911/model_manager', origin: 'http://localhost:48911' },
        addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name) };
    vm.runInNewContext(source, { window, URL });
    let selectedUrl = options.selectedUrl || '/static/vrm/A.vrm';
    let loading = false;
    const manager = { currentModel: { url: selectedUrl, vrm: {} }, _activeLoadToken: 1,
        _isModelReadyForInteraction: true, expression: {
            getExpressionList: () => options.expressions || ['happy'], setBaseExpression: value => previews.push(value)
        } };
    const bridge = window.createVrmEmotionSource({ getManager: () => manager,
        getSelectedUrl: () => selectedUrl, isLoading: () => loading,
        loadModel: async info => {
            loads.push(info.url); loading = true; selectedUrl = info.url;
            manager._activeLoadToken++; manager._isModelReadyForInteraction = false;
            try {
                const result = options.load ? await options.load(info, manager) : undefined;
                if (result?.error) return result;
                manager.currentModel = { url: info.url, vrm: {} }; manager._isModelReadyForInteraction = true;
                return result;
            } finally { loading = false; }
        } });
    return { bridge, manager, previews, loads, listeners, changeSelected: value => { selectedUrl = value; } };
}
test('ready capability is tied to exact URL and load token, with real preview', () => {
    const s = setup(); const snapshot = s.bridge.request({ url: '/static/vrm/A.vrm' });
    assert.equal(snapshot.state, 'ready'); assert.equal(s.bridge.isCurrent(snapshot), true);
    assert.equal(s.bridge.preview(snapshot, 'happy'), true); assert.deepEqual(s.previews, ['happy']);
    s.manager._activeLoadToken++; assert.equal(s.bridge.isCurrent(snapshot), false);
    assert.equal(s.bridge.preview(snapshot, 'happy'), false);
});
test('same filename in different locations cannot supply the other model capability', async () => {
    const s = setup(); const r = s.bridge.request({ url: '/user_vrm/A.vrm' });
    assert.equal(r.state, 'loading'); await flush();
    assert.deepEqual(s.loads, ['/user_vrm/A.vrm']);
    assert.equal(s.bridge.request({ url: '/user_vrm/A.vrm' }).modelUrl, 'http://localhost:48911/user_vrm/A.vrm');
});
test('one pending load stays bounded during repeated and switched requests', async () => {
    let resolve;
    const pending = new Promise(r => { resolve = r; });
    const s = setup({ load: () => pending });
    s.bridge.request({ url: '/static/vrm/B.vrm' }); await flush();
    for (let i = 0; i < 100; i++) assert.equal(s.bridge.request({ url: `/static/vrm/${i}.vrm` }).state, 'loading');
    assert.equal(s.loads.length, 1);
    resolve(); await flush(); assert.equal(s.bridge.request({ url: '/static/vrm/C.vrm' }).state, 'loading'); await flush();
    assert.equal(s.loads.length, 2); assert.equal(s.bridge.request({ url: '/static/vrm/C.vrm' }).state, 'ready');
});
test('a model load error persists until explicit retry and then clears', async () => {
    let fails = true;
    const s = setup({ load: () => { if (fails) throw new Error('injected parse error'); } });
    s.bridge.request({ url: '/static/vrm/B.vrm' }); await flush();
    const failed = s.bridge.request({ url: '/static/vrm/B.vrm' });
    assert.equal(failed.state, 'failed'); assert.equal(failed.error, 'injected parse error');
    assert.equal(s.loads.length, 1);
    fails = false; assert.equal(s.bridge.request({ url: '/static/vrm/B.vrm' }, true).state, 'loading'); await flush();
    assert.equal(s.bridge.request({ url: '/static/vrm/B.vrm' }).state, 'ready');
});
test('ready-but-empty is returned distinctly from no loaded model', () => {
    const s = setup({ expressions: [] }); const r = s.bridge.request({ url: '/static/vrm/A.vrm' });
    assert.equal(r.state, 'ready'); assert.equal(r.expressions.length, 0);
});
test('foreign model URL never starts a load', () => {
    const s = setup(); assert.equal(s.bridge.request({ url: 'https://example.com/A.vrm' }).state, 'failed');
    assert.equal(s.loads.length, 0);
});
test('unsupported names cannot be previewed, neutral remains a valid reset', () => {
    const s = setup(); const r = s.bridge.request({ url: '/static/vrm/A.vrm' });
    assert.equal(s.bridge.preview(r, 'invented'), false); assert.equal(s.bridge.preview(r, 'neutral'), true);
});
test('selection veto returns failure even if the renderer still has the requested model', async () => {
    const s = setup({ load: () => ({ error: 'voice mode prevents reload' }) });
    s.bridge.request({ url: '/static/vrm/A.vrm' }, true); await flush();
    const result = s.bridge.request({ url: '/static/vrm/A.vrm' });
    assert.equal(result.state, 'failed'); assert.equal(result.error, 'voice mode prevents reload');
    assert.equal(s.loads.length, 1);
});
test('disposal removes source lifecycle listener and ignores late load completion', async () => {
    let resolve; const pending = new Promise(r => { resolve = r; });
    const s = setup({ load: () => pending }); s.bridge.request({ url: '/static/vrm/B.vrm' }); await flush();
    s.bridge.dispose(); assert.equal(s.listeners.size, 0); resolve(); await flush();
    assert.equal(s.bridge.request({ url: '/static/vrm/B.vrm' }).state, 'failed');
});
