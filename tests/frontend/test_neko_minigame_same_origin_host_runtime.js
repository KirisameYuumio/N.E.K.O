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
  const fetchImpl = async (url, init = {}) => {
    const pathName = String(url);
    if (pathName.startsWith('/api/config/page_config')) {
      return jsonResponse({ autostart_csrf_token: 'test-token' });
    }
    const body = init.body ? JSON.parse(init.body) : {};
    calls.push({ url: pathName, init, body });
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
    navigator: { sendBeacon: () => false },
    location: { origin: 'http://127.0.0.1:48911' },
    localStorage: storage(),
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    addEventListener(type, handler) { listeners.set(type, handler); },
    removeEventListener(type, handler) {
      if (listeners.get(type) === handler) listeners.delete(type);
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
      optionalCapabilities: ['dialogue', 'quick-lines', 'context-read', 'memory'],
    },
  });
  assert(handshake.grantedCapabilities.includes('context-read'),
    'same-origin host did not grant its context adapter');
  assert(handshake.grantedCapabilities.includes('memory'),
    'same-origin host did not grant its memory adapter');
  assert(handshake.grantedCapabilities.includes('quick-lines'),
    'registered soccer quick-lines were not granted');

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

  genericHost.dispose();
  host.dispose();
  process.stdout.write('mini-game same-origin host runtime test passed\n');
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
