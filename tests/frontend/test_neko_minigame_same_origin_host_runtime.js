const fs = require('fs');
const path = require('path');
const vm = require('vm');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function jsonResponse(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return data; },
    clone() { return jsonResponse(data, status); },
  };
}

function storage() {
  const values = new Map();
  return {
    get length() { return values.size; },
    key(index) { return [...values.keys()][index] ?? null; },
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(String(key), String(value)); },
    removeItem(key) { values.delete(String(key)); },
  };
}

async function main() {
  const calls = [];
  const listeners = new Map();
  let releaseProtocolTwo;
  let markProtocolTwoStarted;
  const protocolTwoGate = new Promise((resolve) => { releaseProtocolTwo = resolve; });
  const protocolTwoStarted = new Promise((resolve) => { markProtocolTwoStarted = resolve; });
  const fetchImpl = async (url, init = {}) => {
    const pathName = String(url);
    if (pathName.startsWith('/api/config/page_config')) {
      return jsonResponse({ autostart_csrf_token: 'test-token' });
    }
    const body = init.body ? JSON.parse(init.body) : {};
    calls.push({ url: pathName, init, body });
    if (pathName.endsWith('/protocol') && body.sequence === 2) {
      markProtocolTwoStarted();
      await protocolTwoGate;
    }
    if (pathName.endsWith('/route/start')) {
      return jsonResponse({
        ok: true,
        state: {
          game_route_active: true,
          session_id: 'server-session',
          lanlan_name: 'Server Neko',
        },
      });
    }
    if (pathName.endsWith('/route/drain')) {
      return jsonResponse({
        ok: true,
        outputs: [{
          ts: 123,
          result: { control: { mood: 'happy' } },
        }],
      });
    }
    return jsonResponse({ ok: true, accepted: true });
  };
  const windowMock = {
    AbortController,
    console: { warn() {}, error() {}, log() {} },
    fetch: fetchImpl,
    navigator: {
      sendBeacon: () => false,
      locks: { request: async (_name, _options, callback) => callback() },
    },
    location: { origin: 'http://127.0.0.1:48911' },
    localStorage: storage(),
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(handler);
    },
    removeEventListener(type, handler) {
      listeners.get(type)?.delete(handler);
      if (!listeners.get(type)?.size) listeners.delete(type);
    },
    dispatchEvent(event) {
      for (const handler of Array.from(listeners.get(event.type) || [])) handler(event);
    },
    CustomEvent: class CustomEventMock {
      constructor(type, options = {}) { this.type = type; this.detail = options.detail; }
    },
  };
  global.window = windowMock;

  const sourcePath = path.resolve(
    __dirname,
    '../../static/game/sdk/neko-minigame-same-origin-host.js',
  );
  vm.runInThisContext(fs.readFileSync(sourcePath, 'utf8'), { filename: sourcePath });

  const host = window.createNekoMiniGameSameOriginHost({
    gameType: 'soccer',
    sessionId: 'client-session',
    fetchImpl,
    windowImpl: windowMock,
    navigatorImpl: windowMock.navigator,
  });
  const handshake = host.connectGame({
    protocolVersions: ['1'],
    manifest: {
      id: 'soccer',
      version: '1.0.0',
      requiredCapabilities: ['runtime', 'logging'],
      optionalCapabilities: [
        'dialogue', 'quick-lines', 'context-read', 'memory', 'storage', 'leaderboard-local',
      ],
    },
  });
  assert(handshake.grantedCapabilities.includes('context-read'),
    'same-origin host did not grant its context adapter');
  assert(handshake.grantedCapabilities.includes('memory'),
    'same-origin host did not grant its memory adapter');
  assert(handshake.grantedCapabilities.includes('quick-lines'),
    'registered soccer quick-lines were not granted');
  assert(handshake.grantedCapabilities.includes('storage')
    && handshake.grantedCapabilities.includes('leaderboard-local'),
  'cross-window-safe local leaderboard capability was not granted');
  let storageLockEntered = false;
  await host.runGameStorageExclusive('leaderboards/main', async () => {
    storageLockEntered = true;
  });
  assert(storageLockEntered, 'trusted host did not enter its origin-wide storage lock');

  let initialSpeechError = null;
  windowMock.localStorage.setItem('neko_speech_playback_state', JSON.stringify({
    type: 'speech_playback_state',
    active: true,
    speech_id: 'initial-speech',
  }));
  host.startSpeechOutputBridge({
    onState() { throw new Error('consumer failed'); },
    onError(error, source) { initialSpeechError = { error, source }; },
  });
  assert(initialSpeechError?.error?.message === 'consumer failed'
    && initialSpeechError.source === 'local_storage_initial',
  'initial speech state callback failures did not reach the host error bridge');
  host.stopSpeechOutputBridge();

  await host.configureGameMemoryConsent({ enabled: true, session_id: 'client-session' });
  const startResponse = await host.start({
    session_id: 'attacker-session',
    lanlan_name: 'Attacker Neko',
  });
  const startData = await startResponse.clone().json();
  host.applyRouteState(startData.state);
  const startCall = calls.find((call) => call.url.endsWith('/route/start'));
  assert(startCall.body.session_id === 'client-session',
    'route start trusted an application-supplied session id');
  assert(startCall.body.game_memory_enabled === true,
    'opening-screen memory consent was not attached to route start');
  assert(host.sessionId === 'server-session' && host.routeLanlanName === 'Server Neko',
    'authoritative route identity did not replace the provisional host identity');

  await host.publishGameProtocol('event', {
    protocolVersion: '1',
    sequence: 1,
    type: 'round-started',
    sessionId: 'attacker-session',
    payload: { round: 1 },
  });
  const protocolCall = calls.find((call) => call.url.endsWith('/protocol'));
  assert(protocolCall.body.session_id === 'server-session',
    'protocol messages did not use the authoritative route session');
  assert(protocolCall.body._csrf_token === 'test-token'
    && protocolCall.init.headers['X-CSRF-Token'] === 'test-token',
  'protocol mutation did not carry the host CSRF contract');

  const protocolTwo = host.publishGameProtocol('event', {
    protocolVersion: '1', sequence: 2, type: 'second', payload: {},
  });
  const protocolThree = host.publishGameProtocol('state', {
    protocolVersion: '1', sequence: 3, type: 'third', payload: {},
  });
  await protocolTwoStarted;
  assert(!calls.some((call) => call.url.endsWith('/protocol') && call.body.sequence === 3),
    'protocol transport allowed a later sequence to overtake an active request');
  releaseProtocolTwo();
  await Promise.all([protocolTwo, protocolThree]);
  assert(calls.filter((call) => call.url.endsWith('/protocol')).map((call) => call.body.sequence).join(',') === '1,2,3',
    'protocol transport did not preserve SDK call order');

  await host.readGameContext({
    session_id: 'attacker-session',
    scopes: ['character-public'],
  });
  await host.submitGameMemory({
    session_id: 'attacker-session',
    submission: { summary: 'visible result' },
  });
  const contextCall = calls.find((call) => call.url.endsWith('/context/read'));
  const memoryCall = calls.find((call) => call.url.endsWith('/memory/submit'));
  assert(contextCall.body.session_id === 'server-session',
    'context read did not bind the authoritative route session');
  assert(contextCall.body._csrf_token === 'test-token'
    && contextCall.init.headers['X-CSRF-Token'] === 'test-token',
  'context read did not carry the host CSRF contract');
  assert(memoryCall.body.session_id === 'server-session'
    && memoryCall.body._csrf_token === 'test-token',
  'memory submission did not bind the authoritative session and CSRF token');

  const controls = [];
  host.startGameControlBridge({ onControl: (control) => controls.push(control) });
  await host.drain({ session_id: 'attacker-session' });
  assert(controls.length === 1 && controls[0].type === 'mood'
    && controls[0].payload === 'happy',
  'route outputs were not converted into SDK control envelopes');
  assert(controls[0].sessionId === 'server-session',
    'control envelope did not carry the authoritative route session');
  assert(controls[0].timestamp === 123000,
    'second-based backend control timestamps were not normalized to milliseconds');

  const millisecondControls = [];
  host.stopGameControlBridge();
  host.startGameControlBridge({ onControl: (control) => millisecondControls.push(control) });
  host._dispatchGameControls([{ ts: 1700000000123, control: { mood: 'happy' } }]);
  assert(millisecondControls[0].timestamp === 1700000000123,
    'millisecond control timestamps were changed during normalization');

  let sameDocumentState = null;
  host.startVoiceControlBridge({
    BroadcastChannelImpl: null,
    onState: (state, source) => { sameDocumentState = { state, source }; },
  });
  windowMock.dispatchEvent(new windowMock.CustomEvent('neko-game-voice-control-message', {
    detail: {
      type: 'game_voice_control_state',
      game_type: 'soccer',
      session_id: 'server-session',
      reason: 'state-sync',
    },
  }));
  assert(sameDocumentState?.source === 'same_document'
    && sameDocumentState.state.reason === 'state-sync',
  'same-document voice fallback state was not received');
  const sameDocumentController = (event) => {
    if (event?.detail?.type !== 'game_voice_control_request') return;
    windowMock.dispatchEvent(new windowMock.CustomEvent('neko-game-voice-control-message', {
      detail: {
        type: 'game_voice_control_state',
        game_type: 'soccer',
        session_id: 'server-session',
        request_id: event.detail.request_id,
        reason: 'queried',
        ok: true,
      },
    }));
  };
  windowMock.addEventListener('neko-game-voice-control-message', sameDocumentController);
  const sameDocumentResponse = await host.requestVoiceControl('query', { timeoutMs: 500 });
  assert(sameDocumentResponse.reason === 'queried',
    'same-document voice fallback request did not complete without BroadcastChannel');
  windowMock.removeEventListener('neko-game-voice-control-message', sameDocumentController);
  host.stopVoiceControlBridge();
  assert(!listeners.has('neko-game-voice-control-message'),
    'same-document voice fallback listener was not released');

  let releaseLimitedProtocol;
  let markLimitedProtocolStarted;
  const limitedProtocolGate = new Promise((resolve) => { releaseLimitedProtocol = resolve; });
  const limitedProtocolStarted = new Promise((resolve) => { markLimitedProtocolStarted = resolve; });
  const limitedFetch = async (url, init = {}) => {
    if (String(url).startsWith('/api/config/page_config')) {
      return jsonResponse({ autostart_csrf_token: 'test-token' });
    }
    if (String(url).endsWith('/protocol')) {
      markLimitedProtocolStarted();
      await limitedProtocolGate;
    }
    return jsonResponse({ ok: true });
  };
  const limitedHost = window.createNekoMiniGameSameOriginHost({
    gameType: 'soccer',
    protocolQueueLimit: 2,
    fetchImpl: limitedFetch,
    windowImpl: windowMock,
    navigatorImpl: windowMock.navigator,
  });
  const limitedFirst = limitedHost.publishGameProtocol('event', {
    protocolVersion: '1', sequence: 1, type: 'first', payload: {},
  });
  await limitedProtocolStarted;
  const limitedQueued = limitedHost.publishGameProtocol('event', {
    protocolVersion: '1', sequence: 2, type: 'second', payload: {},
  });
  let queueLimitError = null;
  try {
    await limitedHost.publishGameProtocol('event', {
      protocolVersion: '1', sequence: 3, type: 'third', payload: {},
    });
  } catch (error) {
    queueLimitError = error;
  }
  assert(queueLimitError?.code === 'busy', 'protocol queue did not enforce its hard capacity');
  limitedHost.dispose({ preservePendingOperations: ['game_protocol'] });
  releaseLimitedProtocol();
  await limitedFirst;
  let disposedQueueError = null;
  try { await limitedQueued; } catch (error) { disposedQueueError = error; }
  assert(disposedQueueError?.code === 'disposed',
    'queued protocol work survived host disposal');

  const genericHost = window.createNekoMiniGameSameOriginHost({
    gameType: 'third-party-game',
    fetchImpl,
    windowImpl: windowMock,
    navigatorImpl: windowMock.navigator,
  });
  const genericHandshake = genericHost.connectGame({
    protocolVersions: ['1'],
    manifest: {
      id: 'third-party-game',
      version: '1.0.0',
      requiredCapabilities: ['logging'],
      optionalCapabilities: ['dialogue', 'quick-lines'],
    },
  });
  assert(genericHandshake.grantedCapabilities.includes('dialogue')
    && !genericHandshake.grantedCapabilities.includes('quick-lines'),
  'generic games received a quick-lines route without a registered dictionary');

  const noLockHost = window.createNekoMiniGameSameOriginHost({
    gameType: 'no-lock-game',
    fetchImpl,
    windowImpl: windowMock,
    navigatorImpl: { sendBeacon: () => false },
  });
  const noLockHandshake = noLockHost.connectGame({
    protocolVersions: ['1'],
    manifest: {
      id: 'no-lock-game',
      version: '1.0.0',
      requiredCapabilities: ['logging'],
      optionalCapabilities: ['storage', 'leaderboard-local'],
    },
  });
  assert(noLockHandshake.grantedCapabilities.includes('storage')
    && !noLockHandshake.grantedCapabilities.includes('leaderboard-local'),
  'host granted cross-window leaderboard mutations without an origin-wide lock');

  noLockHost.dispose();
  genericHost.dispose();
  host.dispose();
  process.stdout.write('mini-game same-origin host runtime test passed\n');
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
