const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { execFileSync } = require('node:child_process');
const test = require('node:test');
const root = path.resolve(__dirname, '../..');
const frontendRequire = createRequire(process.env.NEKO_FRONTEND_PACKAGE
    || path.join(root, 'frontend/react-neko-chat/package.json'));
const { JSDOM } = frontendRequire('jsdom');
const source = process.env.VRM_EMOTION_REVISION
    ? execFileSync('git', ['show', `${process.env.VRM_EMOTION_REVISION}:static/js/vrm_emotion_manager.js`], { cwd: root, encoding: 'utf8' })
    : fs.readFileSync(path.join(root, 'static/js/vrm_emotion_manager.js'), 'utf8');

async function flush() { for (let i = 0; i < 30; i++) await Promise.resolve(); }
function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
// Execute the production selection pipeline and source wiring, with only external
// rendering/network services controlled by the fixture. Never copy its logic.
function installController(parent, manager, models, options, calls) {
    const code = fs.readFileSync(path.join(root, 'static/js/model_manager/page-controller.js'), 'utf8');
    const pathHelpers = fs.readFileSync(path.join(root, 'static/js/model_manager/path-request-fullscreen.js'), 'utf8');
    const selectionStart = code.indexOf('    let vrmSelectionLoad');
    const selectionEnd = code.indexOf('    function currentMotionLocale()', selectionStart);
    const resetStart = code.indexOf('    async function loadVrmModelWithCatalogReset(');
    const resetEnd = code.indexOf('    function mergeVrmAnimationLists(', resetStart);
    const uploadStart = code.indexOf('                        await loadVrmModelWithCatalogReset(', code.indexOf('// 临时加载模型'));
    const uploadEnd = code.indexOf('                        );', uploadStart) + '                        );'.length;
    assert.ok(selectionStart >= 0 && selectionEnd > selectionStart && resetStart >= 0 && resetEnd > resetStart);
    assert.ok(uploadStart >= 0 && uploadEnd > uploadStart);
    parent.vrmManager = manager;
    const select = parent.document.createElement('select');
    for (const model of models) {
        const option = parent.document.createElement('option');
        option.value = model.url;
        option.setAttribute('data-sub-type', 'vrm');
        option.setAttribute('data-path', model.url);
        option.setAttribute('data-filename', `${model.name}.vrm`);
        select.appendChild(option);
    }
    parent.document.body.appendChild(select);
    const run = new parent.Function('deps', `
        const { vrmModelSelect, vrmContainer, mmdContainer, savePositionBtn,
            checkVoiceModeStatus, loadVRMAnimations, loadCharacterLighting, vrmMotionCatalogPlayer } = deps;
        let vrmManager = deps.manager, currentModelType = 'live3d', currentLive3dSubType = 'vrm';
        let userModelSelectionGeneration = 0;
        let currentModelInfo = null, animationsLoaded = true, isVrmAnimationPlaying = false,
            isVrmExpressionPlaying = false, vrmAnimationPlaybackRequestId = 0;
        const t = (_key, fallback) => fallback;
        const showStatus = message => deps.calls.push({ status: message });
        const updateVRMModelSelectButtonText = () => deps.calls.push({ selectionLabel: vrmModelSelect.value });
        const stopIdleRotation = () => {},
            updateVRMAnimationPlayButtonIcon = () => {}, updateVRMExpressionPlayButtonIcon = () => {},
            loadVRMExpressions = () => {}, markModelChangedForCardFacePrompt = () => {};
        const isSuppressedModelManagerChangeEvent = () => false;
        ${pathHelpers}
        ${code.slice(selectionStart, selectionEnd)}
        ${code.slice(resetStart, resetEnd)}
        return { get loadCount() { return typeof vrmSelectionLoadCount === 'number'
            ? vrmSelectionLoadCount : Number(Boolean(vrmSelectionLoad)); },
            get retainedLoadCount() { return typeof vrmSelectionLoads !== 'undefined'
                ? vrmSelectionLoads.size : Number(Boolean(vrmSelectionLoad)); },
            get playbackRequestId() { return vrmAnimationPlaybackRequestId; }, select: vrmModelSelect,
            uploadProbe: async modelUrl => { ${code.slice(uploadStart, uploadEnd)} } };
    `);
    return run({ manager, calls, vrmModelSelect: select,
        vrmContainer: parent.document.createElement('div'), mmdContainer: parent.document.createElement('div'),
        savePositionBtn: parent.document.createElement('button'),
        checkVoiceModeStatus: options.voiceCheck || (async () => ({ isCurrent: false, isVoiceMode: false })),
        loadVRMAnimations: options.animationsLoad || (async () => {}),
        loadCharacterLighting: options.lightingLoad || (async () => {}),
        vrmMotionCatalogPlayer: { cancel: (reason, detail) => calls.push({ cancel: reason, resume: detail.resume }) }
    });
}
function surface(t, options = {}) {
    const html = fs.readFileSync(path.join(root, 'templates/vrm_emotion_manager.html'), 'utf8');
    const dom = new JSDOM(html, { url: 'http://localhost:48911/vrm_emotion_manager', runScripts: 'outside-only', pretendToBeVisual: true });
    const w = dom.window;
    w.CSS = { escape: value => String(value).replace(/"/g, '\\"') };
    w.console = { log() {}, warn() {}, error() {} };
    const timers = new Map();
    let timerId = 0, now = 0;
    w.Date.now = () => now;
    w.setTimeout = (fn, delay) => { const id = ++timerId; timers.set(id, { fn, at: now + delay }); return id; };
    w.clearTimeout = id => timers.delete(id);
    w.requestAnimationFrame = fn => { fn(); return 0; };
    const models = ['A', 'B'].map(name => ({ name, url: `/static/vrm/${name}.vrm` }));
    const calls = [], previews = [];
    let state = options.state || 'loading';
    let token = 1;
    let expressions = options.expressions || ['happy', 'sad'];
    let activeUrl = models[0].url;
    const provider = {
        request(info, force) {
            activeUrl = info.url;
            calls.push({ request: info.name, force });
            return { state, modelUrl: activeUrl, loadToken: token, expressions, error: 'injected load failure' };
        },
        isCurrent(snapshot) { return state === 'ready' && snapshot.modelUrl === activeUrl && snapshot.loadToken === token; },
        preview(snapshot, expression) { if (!this.isCurrent(snapshot)) return false; previews.push(expression); return true; }
    };
    w.opener = options.noOpener ? null : {
        closed: false, VRMEmotionSource: provider,
        vrmManager: { expression: { getExpressionList: () => state === 'ready' ? expressions : [], setBaseExpression: x => previews.push(x) } },
        postMessage() {}
    };
    let controller;
    if (options.actualSource || options.actualController) {
        const parent = new JSDOM('', { url: 'http://localhost:48911/model_manager', runScripts: 'outside-only' });
        parent.window.console = w.console;
        parent.window.Date.now = () => now;
        parent.window.eval(fs.readFileSync(path.join(root, 'static/js/model_manager/vrm-emotion-source.js'), 'utf8'));
        const manager = {
            get currentModel() { return { url: activeUrl, vrm: {} }; },
            get _activeLoadToken() { return token; },
            get _isModelReadyForInteraction() { return state === 'ready'; },
            expression: { getExpressionList: () => expressions, setBaseExpression: value => previews.push(value) }
        };
        if (options.actualController) {
            let loadedUrl = activeUrl;
            const realManager = {
                scene: {}, camera: {}, renderer: {},
                get currentModel() { return { url: loadedUrl, vrm: {} }; },
                get _activeLoadToken() { return token; },
                get _isModelReadyForInteraction() { return state === 'ready'; },
                expression: { ...manager.expression, loadMoodMap: name => calls.push({ moodMap: name }) },
                async loadModel(url, loadOptions) {
                    calls.push({ load: url, loadOptions }); const loadToken = ++token; state = 'loading';
                    try {
                        if (options.modelLoad) await options.modelLoad({ url });
                        if (loadToken !== token) return;
                        loadedUrl = url; state = 'ready';
                    } catch (error) { if (loadToken === token) state = 'failed'; throw error; }
                }
            };
            controller = installController(parent.window, realManager, models, options, calls);
        } else {
            let loadingTask = null;
            parent.window.VRMEmotionSource = parent.window.createVrmEmotionSource({
            getManager: () => manager, getSelectedUrl: () => activeUrl, getLoadingTask: () => loadingTask,
            loadModel: async info => {
                const task = { startedAt: now, settled: false };
                loadingTask = task;
                calls.push({ load: info.url }); activeUrl = info.url; token++; state = 'loading';
                try { if (options.modelLoad) await options.modelLoad(info); state = 'ready'; }
                catch (error) { state = 'failed'; throw error; }
                finally { task.settled = true; if (loadingTask === task) loadingTask = null; }
            }
        });
        }
        w.opener = parent.window;
        t.after(() => { parent.window.VRMEmotionSource.dispose(); parent.window.close(); });
    }
    w.fetch = async (url, init = {}) => {
        calls.push({ url, method: init.method, body: init.body });
        if (url.endsWith('/models')) return { ok: true, json: async () => ({ success: true, models }) };
        if (url.includes('/emotion_mapping/')) {
            if (init.method === 'POST') return { ok: true, json: async () => ({ success: true }) };
            if (options.mappingDeferred) return options.mappingDeferred(url, init);
            return { ok: !options.mappingError, status: 500, text: async () => '', json: async () => ({ success: true, config: options.config || { happy: ['happy'] } }) };
        }
        return { ok: !options.apiError, status: 500, json: async () => ({ success: true, expressions: ['neutral', 'happy'] }) };
    };
    w.eval(source);
    t.after(() => { w.dispatchEvent(new w.Event('pagehide')); dom.window.close(); });
    return {
        w, calls, previews, timers, models, controller,
        setState(value) { state = value; },
        setToken(value) { token = value; },
        async select(name) { await flush(); const el = w.document.querySelector(`.singleselect-item[data-value="${name}"]`); el.click(); await flush(); },
        async advance(ms) {
            const until = now + ms;
            for (let steps = 0; steps < 1000; steps++) {
                const entry = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
                if (!entry || entry[1].at > until) break;
                now = entry[1].at; timers.delete(entry[0]); entry[1].fn(); await flush();
            }
            now = until; await flush();
        },
        get save() { return w.document.getElementById('save-btn'); },
        get phase() { return w.document.getElementById('emotion-load-state')?.dataset.state; },
        posts() { return calls.filter(x => x.method === 'POST'); }
    };
}

test('loading stays visibly blocked past three seconds and direct save cannot write', async t => {
    const s = surface(t); await s.select('A'); await s.advance(4000);
    assert.equal(s.save.disabled, true);
    assert.equal(s.phase, 'loading');
    assert.equal(s.w.document.getElementById('emotion-load-state').hidden, false);
    await s.w.VRMEmotionManager.saveEmotionMapping(); assert.equal(s.posts().length, 0);
});
test('successful load automatically clears waiting and unlocks configuration, preview and save', async t => {
    const s = surface(t); await s.select('A'); s.setState('ready'); await s.advance(250);
    assert.equal(s.phase, 'ready'); assert.equal(s.save.disabled, false);
    assert.equal(s.w.document.getElementById('emotion-load-state').hidden, true);
    s.w.document.querySelector('.preview-btn[data-expression="happy"]').click(); assert.deepEqual(s.previews, ['happy']);
    await s.w.VRMEmotionManager.saveEmotionMapping(); assert.equal(s.posts().length, 1);
});
test('failed model load never uses generic candidates and retries until success', async t => {
    const s = surface(t, { state: 'failed' }); await s.select('A');
    assert.equal(s.phase, 'failed'); assert.equal(s.save.disabled, true);
    assert.equal(s.w.document.querySelectorAll('.preview-btn').length, 0);
    assert.equal(s.calls.some(x => x.url?.includes('/expressions/')), false);
    s.setState('loading'); s.w.document.getElementById('retry-load-btn').click(); await flush();
    assert.equal(s.phase, 'loading'); assert.equal(s.calls.some(x => x.force), true);
    s.setState('ready'); await s.advance(250); assert.equal(s.save.disabled, false);
});
test('successful empty list stays empty and cannot save or preview', async t => {
    const s = surface(t, { state: 'ready', expressions: [] }); await s.select('A');
    assert.equal(s.phase, 'empty'); assert.equal(s.save.disabled, true);
    assert.equal(s.w.document.querySelectorAll('.preview-btn').length, 0);
    await s.w.VRMEmotionManager.saveEmotionMapping(); assert.equal(s.posts().length, 0);
});
test('opener unavailable gives an accurate failure and never opens fallback editing', async t => {
    const s = surface(t, { noOpener: true }); await s.select('A'); await s.advance(4000);
    assert.equal(s.phase, 'failed'); assert.equal(s.save.disabled, true);
    assert.equal(s.calls.some(x => x.url?.includes('/expressions/')), false);
});
test('switch immediately revokes old model permission and readiness', async t => {
    const s = surface(t, { state: 'ready' }); await s.select('A'); assert.equal(s.save.disabled, false);
    s.setState('loading'); await s.select('B'); assert.equal(s.save.disabled, true);
    await s.w.VRMEmotionManager.saveEmotionMapping(); assert.equal(s.posts().length, 0);
    s.setState('ready'); await s.advance(250); assert.equal(s.save.disabled, false);
    await s.w.VRMEmotionManager.saveEmotionMapping(); assert.match(s.posts()[0].url, /\/B$/);
});
test('mapping initialization must finish before save unlocks', async t => {
    let resolve;
    const mapping = new Promise(r => { resolve = r; });
    const s = surface(t, { state: 'ready', mappingDeferred: () => mapping }); await s.select('A');
    assert.equal(s.save.disabled, true);
    resolve({ ok: true, json: async () => ({ success: true, config: { happy: ['happy'] } }) }); await flush();
    assert.equal(s.save.disabled, false);
});
test('late old mapping does not initialize a newly selected model', async t => {
    let resolveA;
    const mappingA = new Promise(r => { resolveA = r; });
    const s = surface(t, { state: 'ready', mappingDeferred: url => url.endsWith('/A') ? mappingA
        : Promise.resolve({ ok: true, json: async () => ({ success: true, config: { sad: ['sad'] } }) }) });
    await s.select('A'); await s.select('B');
    resolveA({ ok: true, json: async () => ({ success: true, config: { happy: ['happy'] } }) }); await flush();
    await s.w.VRMEmotionManager.saveEmotionMapping();
    assert.deepEqual(JSON.parse(s.posts()[0].body), { sad: ['sad'] });
});
test('mapping read failure blocks overwrite rather than installing defaults', async t => {
    const s = surface(t, { state: 'ready', mappingError: true }); await s.select('A');
    assert.equal(s.save.disabled, true); await s.w.VRMEmotionManager.saveEmotionMapping(); assert.equal(s.posts().length, 0);
});
test('unsupported existing bindings remain reference data and survive ordinary save', async t => {
    const s = surface(t, { state: 'ready', config: { happy: ['happy', 'customMissing'] } }); await s.select('A');
    assert.equal(s.w.document.querySelector('input[value="customMissing"]'), null);
    await s.w.VRMEmotionManager.saveEmotionMapping();
    assert.deepEqual(JSON.parse(s.posts()[0].body), { happy: ['happy', 'customMissing'] });
});
test('explicit default reset removes unavailable bindings and their notice before saving', async t => {
    const s = surface(t, { state: 'ready', config: { happy: ['happy', 'customMissing'] } }); await s.select('A');
    s.w.document.getElementById('reset-btn').click();
    await s.w.VRMEmotionManager.saveEmotionMapping();
    assert.equal(JSON.stringify(JSON.parse(s.posts()[0].body)).includes('customMissing'), false);
    assert.equal(s.w.document.getElementById('unavailable-bindings').hidden, true);
});
test('configuration stylesheet has the same cache version as the page scripts', () => {
    const html = fs.readFileSync(path.join(root, 'templates/vrm_emotion_manager.html'), 'utf8');
    const css = html.match(/href="\/static\/css\/vrm_emotion_manager\.css(\?v=[^"]+)"/);
    const script = html.match(/src="\/static\/js\/vrm_emotion_manager\.js(\?v=[^"]+)"/);
    assert.ok(css); assert.equal(css[1], script[1]);
});
test('save timeout reports an unconfirmed result and releases the save deadline', async t => {
    const s = surface(t, { state: 'ready' }); await s.select('A');
    s.w.fetch = (_url, init) => new Promise((_, reject) => init.signal.addEventListener('abort',
        () => reject(new s.w.DOMException('Aborted', 'AbortError')), { once: true }));
    const saving = s.w.VRMEmotionManager.saveEmotionMapping();
    await s.advance(120001); await saving;
    assert.match(s.w.document.getElementById('status-message').textContent, /保存超时.*未确认/);
    assert.equal(s.save.disabled, false); await s.advance(4000); assert.equal(s.timers.size, 0);
});
test('selection cancellation during save is silent and late response cannot report success', async t => {
    const s = surface(t, { state: 'ready' }); await s.select('A');
    const originalFetch = s.w.fetch, response = deferred();
    s.w.fetch = (url, init) => init?.method === 'POST' ? response.promise : originalFetch(url, init);
    const saving = s.w.VRMEmotionManager.saveEmotionMapping(); await s.select('B');
    response.resolve({ ok: true, json: async () => ({ success: true }) }); await saving;
    assert.doesNotMatch(s.w.document.getElementById('status-message').textContent, /保存成功|保存超时/);
});
test('external load token change blocks direct save and stale preview', async t => {
    const s = surface(t, { state: 'ready' }); await s.select('A'); s.setToken(2);
    s.w.document.querySelector('.preview-btn[data-expression="happy"]').click();
    await s.w.VRMEmotionManager.saveEmotionMapping(); assert.equal(s.posts().length, 0); assert.equal(s.previews.length, 0);
});
test('pagehide cancels current polling and all page timers', async t => {
    const s = surface(t); await s.select('A'); s.w.dispatchEvent(new s.w.Event('pagehide')); await flush();
    assert.equal(s.timers.size, 0); await s.advance(4000); assert.equal(s.posts().length, 0);
});
test('load timeout releases polling and stays blocked', async t => {
    const s = surface(t); await s.select('A'); await s.advance(120500);
    assert.equal(s.phase, 'failed'); assert.equal(s.save.disabled, true); assert.equal(s.timers.size, 0);
});

test('two-window integration loads model B through the real capability source and unlocks automatically', async t => {
    const s = surface(t, { state: 'ready', actualSource: true }); await s.select('A');
    assert.equal(s.save.disabled, false); await s.select('B'); assert.equal(s.save.disabled, true);
    assert.deepEqual(s.calls.filter(x => x.load).map(x => x.load), ['/static/vrm/B.vrm']);
    await s.advance(250); assert.equal(s.save.disabled, false);
    s.w.document.querySelector('.preview-btn[data-expression="happy"]').click();
    assert.deepEqual(s.previews, ['happy']); await s.w.VRMEmotionManager.saveEmotionMapping();
    assert.match(s.posts()[0].url, /\/B$/);
});
test('two-window integration retains parse failure until real reload retry succeeds', async t => {
    let fail = true;
    const s = surface(t, { state: 'ready', actualSource: true, modelLoad: () => { if (fail) throw new Error('injected parse failure'); } });
    await s.select('B'); await s.advance(250); assert.equal(s.phase, 'failed'); assert.equal(s.save.disabled, true);
    fail = false; s.w.document.getElementById('retry-load-btn').click(); await flush(); await s.advance(250);
    assert.equal(s.phase, 'ready'); assert.equal(s.save.disabled, false);
    assert.equal(s.calls.filter(x => x.load).length, 2);
});
test('pagehide during an outstanding save clears its deadline and aborts request', async t => {
    const s = surface(t, { state: 'ready' }); await s.select('A');
    let signal;
    s.w.fetch = async (_url, init) => { signal = init.signal; return new Promise(() => {}); };
    void s.w.VRMEmotionManager.saveEmotionMapping();
    s.w.dispatchEvent(new s.w.Event('pagehide')); await flush();
    assert.equal(signal.aborted, true); assert.equal(s.timers.size, 0);
});

test('production controller stays blocked during actual load and initialization, then unlocks automatically', async t => {
    const load = deferred(), lighting = deferred();
    const s = surface(t, { state: 'ready', actualController: true,
        modelLoad: () => load.promise, lightingLoad: () => lighting.promise });
    await s.select('B'); await s.advance(4000);
    assert.equal(s.controller.loadCount, 1); assert.equal(s.phase, 'loading'); assert.equal(s.save.disabled, true);
    assert.equal(s.w.document.getElementById('emotion-load-state').hidden, false);
    assert.equal(s.calls.filter(x => x.load).length, 1);
    assert.equal(s.calls.filter(x => x.cancel).length, 1);
    assert.equal(s.controller.playbackRequestId, 1);
    load.resolve(); await flush(); await s.advance(250);
    assert.equal(s.save.disabled, true); assert.equal(s.controller.loadCount, 1);
    lighting.resolve(); await flush(); await s.advance(250);
    assert.equal(s.controller.loadCount, 0); assert.equal(s.phase, 'ready'); assert.equal(s.save.disabled, false);
    assert.equal(s.w.document.getElementById('emotion-load-state').hidden, true);
    s.w.document.querySelector('.preview-btn[data-expression="happy"]').click();
    assert.deepEqual(s.previews, ['happy']);
    await s.w.VRMEmotionManager.saveEmotionMapping(); assert.match(s.posts()[0].url, /\/B$/);
});

test('production controller parse failure releases busy count and retry performs a fresh load', async t => {
    let failed = true;
    const s = surface(t, { state: 'ready', actualController: true,
        modelLoad: () => { if (failed) throw new Error('injected parse failure'); } });
    await s.select('B'); await s.advance(250);
    assert.equal(s.phase, 'failed'); assert.equal(s.save.disabled, true); assert.equal(s.controller.loadCount, 0);
    failed = false; s.w.document.getElementById('retry-load-btn').click(); await flush(); await s.advance(250);
    assert.equal(s.phase, 'ready'); assert.equal(s.save.disabled, false); assert.equal(s.controller.loadCount, 0);
    assert.equal(s.calls.filter(x => x.load).length, 2);
});

test('production controller voice check keeps waiting and veto cannot grant stale model access', async t => {
    const voice = deferred();
    const s = surface(t, { state: 'ready', actualController: true, voiceCheck: () => voice.promise });
    await s.select('B'); await s.advance(4000);
    assert.equal(s.phase, 'loading'); assert.equal(s.save.disabled, true); assert.equal(s.controller.loadCount, 1);
    assert.equal(s.calls.filter(x => x.load).length, 0);
    voice.resolve({ isCurrent: true, isVoiceMode: true }); await flush(); await s.advance(250);
    assert.equal(s.phase, 'failed'); assert.equal(s.save.disabled, true); assert.equal(s.controller.loadCount, 0);
    await s.w.VRMEmotionManager.saveEmotionMapping(); assert.equal(s.posts().length, 0);
    assert.equal(s.controller.select.value, '/static/vrm/A.vrm');
    assert.equal(s.calls.filter(x => 'selectionLabel' in x).at(-1).selectionLabel, '/static/vrm/A.vrm');
});

test('production controller rapid B to A selection never edits B while A initialization is pending', async t => {
    const loads = [];
    const s = surface(t, { state: 'ready', actualController: true,
        modelLoad: info => { const job = deferred(); loads.push({ ...job, url: info.url }); return job.promise; } });
    await s.select('B'); await s.select('A'); await s.advance(4000);
    assert.equal(loads.length, 1); assert.equal(s.save.disabled, true);
    loads[0].resolve(); await flush(); await s.advance(250);
    assert.equal(loads.length, 2); assert.equal(loads[1].url, '/static/vrm/A.vrm'); assert.equal(s.save.disabled, true);
    loads[1].resolve(); await flush(); await s.advance(250);
    assert.equal(s.phase, 'ready'); assert.equal(s.save.disabled, false);
    await s.w.VRMEmotionManager.saveEmotionMapping(); assert.match(s.posts()[0].url, /\/A$/);
    assert.equal(s.controller.loadCount, 0);
});

test('production controller successful model with no genuine expressions stays blocked', async t => {
    const s = surface(t, { state: 'ready', actualController: true, expressions: [] });
    await s.select('B'); await s.advance(250);
    assert.equal(s.phase, 'empty'); assert.equal(s.save.disabled, true); assert.equal(s.controller.loadCount, 0);
    assert.equal(s.w.document.querySelectorAll('.preview-btn').length, 0);
    await s.w.VRMEmotionManager.saveEmotionMapping(); assert.equal(s.posts().length, 0);
});

test('production controller load completion cannot bypass a pending mapping read', async t => {
    const mapping = deferred();
    const s = surface(t, { state: 'ready', actualController: true, mappingDeferred: () => mapping.promise });
    await s.select('B'); await s.advance(250);
    assert.equal(s.controller.loadCount, 0); assert.equal(s.phase, 'loading'); assert.equal(s.save.disabled, true);
    mapping.resolve({ ok: true, json: async () => ({ success: true, config: { happy: ['happy'] } }) }); await flush();
    assert.equal(s.phase, 'ready'); assert.equal(s.save.disabled, false);
});

test('closing configuration during production controller loading releases polling and ignores late readiness', async t => {
    const load = deferred();
    const s = surface(t, { state: 'ready', actualController: true, modelLoad: () => load.promise });
    await s.select('B'); s.w.dispatchEvent(new s.w.Event('pagehide')); await flush();
    assert.equal(s.timers.size, 0); load.resolve(); await flush(); await s.advance(250);
    assert.equal(s.controller.loadCount, 0); assert.equal(s.save.disabled, true); assert.equal(s.posts().length, 0);
});

test('production controller retry recovers a stuck load and ignores late old continuation', async t => {
    const oldLoad = deferred(); let count = 0;
    const s = surface(t, { state: 'ready', actualController: true,
        modelLoad: () => ++count === 1 ? oldLoad.promise : undefined });
    await s.select('B'); await s.advance(120001);
    assert.equal(s.phase, 'failed'); assert.equal(s.save.disabled, true);
    s.w.document.getElementById('retry-load-btn').click(); await flush(); await s.advance(250);
    assert.equal(count, 2); assert.equal(s.controller.loadCount, 0);
    assert.equal(s.phase, 'ready'); assert.equal(s.save.disabled, false);
    const before = s.calls.filter(x => x.moodMap).length;
    oldLoad.resolve(); await flush();
    assert.equal(s.calls.filter(x => x.moodMap).length, before);
    assert.equal(s.controller.loadCount, 0); assert.equal(s.save.disabled, false);
});

test('old controller completion cannot clear the replacement loading gate', async t => {
    const jobs = [];
    const s = surface(t, { state: 'ready', actualController: true,
        modelLoad: () => { const job = deferred(); jobs.push(job); return job.promise; } });
    await s.select('B'); await s.advance(120001);
    s.w.document.getElementById('retry-load-btn').click(); await flush();
    assert.equal(jobs.length, 2);
    jobs[0].resolve(); await flush(); await s.advance(250);
    assert.equal(s.controller.loadCount, 1); assert.equal(s.phase, 'loading'); assert.equal(s.save.disabled, true);
    jobs[1].resolve(); await flush(); await s.advance(250);
    assert.equal(s.controller.loadCount, 0); assert.equal(s.phase, 'ready'); assert.equal(s.save.disabled, false);
});

test('production controller retry replaces a model-manager initiated hung load', async t => {
    const oldLoad = deferred(); let count = 0;
    const s = surface(t, { state: 'ready', actualController: true,
        modelLoad: () => ++count === 1 ? oldLoad.promise : undefined });
    s.controller.select.value = '/static/vrm/B.vrm';
    s.controller.select.dispatchEvent(new s.w.opener.Event('change')); await flush();
    await s.select('B'); await s.advance(120001);
    assert.equal(s.phase, 'failed'); assert.equal(count, 1);
    s.w.document.getElementById('retry-load-btn').click(); await flush(); await s.advance(250);
    assert.equal(count, 2); assert.equal(s.phase, 'ready'); assert.equal(s.save.disabled, false);
    oldLoad.resolve(); await flush();
    assert.equal(s.controller.loadCount, 0); assert.equal(s.calls.filter(x => x.moodMap).length, 1);
});
test('ordinary model-manager voice veto restores the previous model URL and label', async t => {
    const s = surface(t, { state: 'ready', actualController: true,
        voiceCheck: async () => ({ isCurrent: true, isVoiceMode: true }) });
    s.controller.select.value = '/static/vrm/B.vrm';
    s.controller.select.dispatchEvent(new s.w.opener.Event('change')); await flush();
    assert.equal(s.controller.select.value, '/static/vrm/A.vrm');
    assert.equal(s.calls.filter(x => 'selectionLabel' in x).at(-1).selectionLabel, '/static/vrm/A.vrm');
    assert.equal(s.calls.filter(x => x.load).length, 0); assert.equal(s.controller.loadCount, 0);
});
test('production controller overlapping source and opener loads block a third parse and recover after settlement', async t => {
    const jobs = [];
    const s = surface(t, { state: 'ready', actualController: true,
        modelLoad: () => { const job = deferred(); jobs.push(job); return job.promise; } });
    await s.select('B');
    s.controller.select.value = '/static/vrm/A.vrm';
    s.controller.select.dispatchEvent(new s.w.opener.Event('change')); await flush();
    await s.advance(120001);
    for (let i = 0; i < 100; i++) {
        s.w.document.getElementById('retry-load-btn').click(); await flush();
    }
    assert.equal(jobs.length, 2); assert.equal(s.phase, 'failed'); assert.equal(s.save.disabled, true);
    jobs[0].resolve(); await flush();
    s.w.document.getElementById('retry-load-btn').click(); await flush();
    assert.equal(jobs.length, 3); assert.equal(s.phase, 'loading');
    jobs[1].resolve(); jobs[2].resolve(); await flush(); await s.advance(250);
    assert.equal(s.phase, 'ready'); assert.equal(s.save.disabled, false); assert.equal(s.controller.loadCount, 0);
});
test('late veto from a superseded voice check cannot restore an obsolete selection', async t => {
    const firstVoice = deferred(); let checks = 0;
    const s = surface(t, { state: 'ready', actualController: true,
        voiceCheck: () => ++checks === 1 ? firstVoice.promise : Promise.resolve({ isCurrent: false }) });
    s.controller.select.value = '/static/vrm/B.vrm';
    s.controller.select.dispatchEvent(new s.w.opener.Event('change')); await flush();
    s.controller.select.value = '/static/vrm/A.vrm';
    s.controller.select.dispatchEvent(new s.w.opener.Event('change')); await flush();
    firstVoice.resolve({ isCurrent: true, isVoiceMode: true }); await flush();
    assert.equal(s.controller.select.value, '/static/vrm/A.vrm');
    assert.equal(s.calls.filter(x => x.status?.includes('语音模式')).length, 0);
    assert.equal(s.controller.loadCount, 0);
});

for (const settlesFirst of [0, 1]) test(`production controller retains both opener loads for recovery capacity (settlesFirst=${settlesFirst})`, async t => {
    const jobs = [];
    const s = surface(t, { state: 'ready', actualController: true,
        modelLoad: () => { const job = deferred(); jobs.push(job); return job.promise; } });
    for (const name of ['B', 'A']) {
        s.controller.select.value = `/static/vrm/${name}.vrm`;
        s.controller.select.dispatchEvent(new s.w.opener.Event('change')); await flush();
    }
    await s.select('B'); await s.advance(120001);
    for (let i = 0; i < 100; i++) {
        s.w.document.getElementById('retry-load-btn').click(); await flush();
    }
    assert.equal(jobs.length, 2); assert.equal(s.save.disabled, true); assert.equal(s.controller.retainedLoadCount, 2);
    jobs[settlesFirst].resolve(); await flush();
    s.w.document.getElementById('retry-load-btn').click(); await flush();
    assert.equal(jobs.length, 3);
    jobs[1 - settlesFirst].resolve(); jobs[2].resolve(); await flush(); await s.advance(250);
    assert.equal(s.phase, 'ready'); assert.equal(s.save.disabled, false); assert.equal(s.controller.retainedLoadCount, 0);
});
test('production controller direct selections have a hard two-job bound and retain accepted selection', async t => {
    const jobs = [];
    const s = surface(t, { state: 'ready', actualController: true,
        modelLoad: () => { const job = deferred(); jobs.push(job); return job.promise; } });
    for (const name of ['B', 'A']) {
        s.controller.select.value = `/static/vrm/${name}.vrm`;
        s.controller.select.dispatchEvent(new s.w.opener.Event('change')); await flush();
    }
    for (let i = 0; i < 100; i++) {
        s.controller.select.value = '/static/vrm/B.vrm';
        s.controller.select.dispatchEvent(new s.w.opener.Event('change')); await flush();
    }
    assert.equal(jobs.length, 2); assert.equal(s.controller.retainedLoadCount, 2); assert.equal(s.controller.select.value, '/static/vrm/A.vrm');
    assert.equal(s.calls.filter(x => 'selectionLabel' in x).at(-1).selectionLabel, '/static/vrm/A.vrm');
    jobs[0].reject(new Error('old parse failed')); await flush();
    s.controller.select.value = '/static/vrm/B.vrm';
    s.controller.select.dispatchEvent(new s.w.opener.Event('change')); await flush();
    assert.equal(jobs.length, 3);
    jobs[1].resolve(); jobs[2].resolve(); await flush();
    assert.equal(s.controller.loadCount, 0);
});
test('closing the opener clears both selection slots and fences late callbacks and future changes', async t => {
    const jobs = [];
    const s = surface(t, { state: 'ready', actualController: true,
        modelLoad: () => { const job = deferred(); jobs.push(job); return job.promise; } });
    for (const name of ['B', 'A']) {
        s.controller.select.value = `/static/vrm/${name}.vrm`;
        s.controller.select.dispatchEvent(new s.w.opener.Event('change')); await flush();
    }
    s.w.opener.dispatchEvent(new s.w.opener.Event('pagehide'));
    assert.equal(s.controller.loadCount, 0);
    assert.equal(s.controller.retainedLoadCount, 0);
    for (let i = 0; i < 10; i++) s.controller.select.dispatchEvent(new s.w.opener.Event('change'));
    jobs[0].resolve(); jobs[1].resolve(); await flush();
    assert.equal(jobs.length, 2); assert.equal(s.calls.filter(x => x.moodMap).length, 0);
});

test('ordinary source polling retains an expired admitted opener model without a capacity error', async t => {
    const jobs = [];
    const s = surface(t, { state: 'ready', actualController: true,
        modelLoad: () => { const job = deferred(); jobs.push(job); return job.promise; } });
    for (const name of ['B', 'A']) {
        s.controller.select.value = `/static/vrm/${name}.vrm`;
        s.controller.select.dispatchEvent(new s.w.opener.Event('change')); await flush();
    }
    await s.advance(120001);
    const provider = s.w.opener.VRMEmotionSource;
    assert.equal(provider.request({ url: '/static/vrm/A.vrm' }).state, 'loading');
    assert.equal(provider.request({ url: '/static/vrm/A.vrm' }, true).errorCode, 'recoveryBlocked');
    assert.equal(jobs.length, 2);
    jobs[1].resolve(); await flush();
    await s.select('A'); await s.advance(250);
    assert.equal(s.phase, 'ready'); assert.equal(s.save.disabled, false); assert.equal(jobs.length, 2);
    jobs[0].resolve(); await flush();
});
test('new URL at full capacity fails immediately and cannot start later until explicit retry', async t => {
    const jobs = [];
    const s = surface(t, { state: 'ready', actualController: true,
        modelLoad: () => { const job = deferred(); jobs.push(job); return job.promise; } });
    for (const name of ['B', 'A']) {
        s.controller.select.value = `/static/vrm/${name}.vrm`;
        s.controller.select.dispatchEvent(new s.w.opener.Event('change')); await flush();
    }
    await s.select('B');
    const initialPhase = s.phase;
    assert.equal(s.save.disabled, true); assert.equal(jobs.length, 2);
    jobs[1].resolve(); await flush(); await s.advance(500);
    assert.equal(jobs.length, 2); assert.equal(initialPhase, 'failed');
    for (let i = 0; i < 100; i++) {
        const result = s.w.opener.VRMEmotionSource.request({ url: '/static/vrm/B.vrm' });
        assert.equal(result.state, 'failed'); assert.equal(result.errorCode, 'recoveryBlocked');
    }
    await flush(); assert.equal(jobs.length, 2); assert.equal(s.phase, 'failed');
    s.w.document.getElementById('retry-load-btn').click(); await flush();
    assert.equal(jobs.length, 3);
    jobs[0].resolve(); jobs[2].resolve(); await flush(); await s.advance(250);
    assert.equal(s.phase, 'ready'); assert.equal(s.save.disabled, false);
});
test('ordinary polling of an admitted source job remains loading at full expired capacity', async t => {
    const jobs = [];
    const s = surface(t, { state: 'ready', actualController: true,
        modelLoad: () => { const job = deferred(); jobs.push(job); return job.promise; } });
    await s.select('B');
    s.controller.select.value = '/static/vrm/A.vrm';
    s.controller.select.dispatchEvent(new s.w.opener.Event('change')); await flush();
    await s.advance(120001);
    assert.equal(s.w.opener.VRMEmotionSource.request({ url: '/static/vrm/B.vrm' }).state, 'loading');
    assert.equal(jobs.length, 2);
    jobs[0].resolve(); jobs[1].resolve(); await flush();
});

for (const settlesFirst of [0, 1]) test(`upload probe shares editor recovery capacity (settlesFirst=${settlesFirst})`, async t => {
    const jobs = [];
    const s = surface(t, { state: 'ready', actualController: true,
        modelLoad: () => { const job = deferred(); jobs.push(job); return job.promise; } });
    const probe = s.controller.uploadProbe('/user_vrm/upload.vrm');
    await flush(); await s.select('B'); await s.advance(120001);
    for (let i = 0; i < 100; i++) {
        s.w.document.getElementById('retry-load-btn').click(); await flush();
    }
    assert.equal(jobs.length, 2); assert.equal(s.controller.retainedLoadCount, 2);
    assert.equal(s.save.disabled, true);
    jobs[settlesFirst].resolve(); await flush();
    s.w.document.getElementById('retry-load-btn').click(); await flush();
    assert.equal(jobs.length, 3); assert.equal(s.controller.retainedLoadCount, 2);
    jobs[1 - settlesFirst].resolve(); jobs[2].resolve(); await probe; await flush(); await s.advance(250);
    assert.equal(s.phase, 'ready'); assert.equal(s.save.disabled, false);
    assert.equal(s.controller.retainedLoadCount, 0);
});

test('upload at full selection capacity cannot parse or cancel current playback', async t => {
    const jobs = [];
    const s = surface(t, { state: 'ready', actualController: true,
        modelLoad: () => { const job = deferred(); jobs.push(job); return job.promise; } });
    for (const name of ['B', 'A']) {
        s.controller.select.value = `/static/vrm/${name}.vrm`;
        s.controller.select.dispatchEvent(new s.w.opener.Event('change')); await flush();
    }
    const playbackRequestId = s.controller.playbackRequestId;
    const cancellations = s.calls.filter(x => x.cancel).length;
    for (let i = 0; i < 100; i++) {
        const probe = s.controller.uploadProbe('/user_vrm/upload.vrm');
        // Resolve any mistakenly admitted old-code call so this failure has no hanging promise.
        if (jobs[2]) jobs[2].resolve();
        await assert.rejects(probe, error => error.errorCode === 'recoveryBlocked');
    }
    assert.equal(jobs.length, 2); assert.equal(s.controller.retainedLoadCount, 2);
    assert.equal(s.controller.playbackRequestId, playbackRequestId);
    assert.equal(s.calls.filter(x => x.cancel).length, cancellations);
    jobs[0].resolve(); jobs[1].resolve(); await flush();
});

for (const fails of [false, true]) test(`upload probe releases its shared slot on settlement (fails=${fails})`, async t => {
    const job = deferred();
    const s = surface(t, { state: 'ready', actualController: true, modelLoad: () => job.promise });
    const probe = s.controller.uploadProbe('/user_vrm/upload.vrm');
    const observed = probe.catch(error => error);
    await flush();
    assert.equal(s.controller.retainedLoadCount, 1);
    if (fails) job.reject(new Error('upload parse failed')); else job.resolve();
    await observed; await flush();
    assert.equal(s.controller.retainedLoadCount, 0);
    assert.equal(s.calls.filter(x => x.load).length, 1);
});

test('opener close clears an upload slot and rejects late and future upload work', async t => {
    const job = deferred();
    const s = surface(t, { state: 'ready', actualController: true, modelLoad: () => job.promise });
    const probe = s.controller.uploadProbe('/user_vrm/upload.vrm');
    const observed = probe.catch(error => error);
    await flush(); s.w.opener.dispatchEvent(new s.w.opener.Event('pagehide'));
    assert.equal(s.controller.retainedLoadCount, 0);
    job.resolve();
    const outcome = await observed;
    assert.equal(outcome?.errorCode, 'sourceUnavailable');
    const playbackRequestId = s.controller.playbackRequestId;
    await assert.rejects(s.controller.uploadProbe('/user_vrm/next.vrm'), error => error.errorCode === 'sourceUnavailable');
    assert.equal(s.calls.filter(x => x.load).length, 1);
    assert.equal(s.controller.playbackRequestId, playbackRequestId);
});
