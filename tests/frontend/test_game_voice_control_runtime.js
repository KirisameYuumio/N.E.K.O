const fs = require('fs');
const path = require('path');
const vm = require('vm');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

async function main() {
  const listeners = new Map();
  const intervals = new Map();
  const clearedIntervals = [];
  const posted = [];
  let nextIntervalId = 1;
  let channelClosed = false;
  const localValues = new Map();

  const addEventListener = (type, handler) => {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type).add(handler);
  };
  const removeEventListener = (type, handler) => listeners.get(type)?.delete(handler);

  const appState = {
    gameRouteActive: true,
    gameRouteGameType: 'soccer',
    gameRouteSessionId: 'soccer-runtime',
    isRecording: false,
    voiceStartPending: false,
    isMicMuted: false,
    gameVoiceTranscriptionMode: 'unavailable',
    gameVoiceTranscriptionProvider: '',
    gameVoiceTranscriptionReady: false,
    gameVoiceTranscriptionReason: 'voice_inactive',
    voiceInputRouteBlocked: false,
  };
  const micButton = {
    disabled: false,
    classList: { contains: () => false },
    click() { appState.isRecording = true; },
  };
  const documentMock = {
    getElementById(id) { return id === 'micButton' ? micButton : null; },
  };

  class BroadcastChannelMock {
    constructor(name) {
      this.name = name;
      this.onmessage = null;
      global.__gameVoiceChannel = this;
    }
    postMessage(message) {
      if (this.failPosts) throw new Error('channel unavailable');
      posted.push(message);
    }
    close() { channelClosed = true; }
  }

  const windowMock = {
    appState,
    document: documentMock,
    console: { log() {}, warn() {} },
    isMicStarting: false,
    stopMicCapture: async () => { appState.isRecording = false; },
    addEventListener,
    removeEventListener,
    dispatchEvent(event) {
      for (const handler of Array.from(listeners.get(event.type) || [])) handler(event);
    },
    CustomEvent: class CustomEventMock {
      constructor(type, options = {}) { this.type = type; this.detail = options.detail; }
    },
  };

  global.window = windowMock;
  global.document = documentMock;
  global.BroadcastChannel = BroadcastChannelMock;
  global.localStorage = {
    getItem(key) { return localValues.has(key) ? localValues.get(key) : null; },
    setItem(key, value) { localValues.set(key, String(value)); },
    removeItem(key) { localValues.delete(key); },
  };
  global.setInterval = (callback, delay) => {
    const id = nextIntervalId++;
    intervals.set(id, { callback, delay });
    return id;
  };
  global.clearInterval = (id) => {
    intervals.delete(id);
    clearedIntervals.push(id);
  };

  const sourcePath = path.resolve(__dirname, '../../static/app/app-game-voice-control.js');
  vm.runInThisContext(fs.readFileSync(sourcePath, 'utf8'), { filename: sourcePath });
  const channel = global.__gameVoiceChannel;
  assert(channel?.name === 'neko_game_voice_control_channel', 'host channel was not created');
  assert(intervals.size === 1, 'bounded state synchronization timer was not installed');
  assert(listeners.get('storage')?.size === 1, 'localStorage fallback listener was not installed');
  assert(listeners.get('neko-game-voice-control-message')?.size === 1,
    'same-document fallback listener was not installed');
  assert(listeners.get('neko-game-window-state-change')?.size === 1, 'route reconciliation listener was not installed');
  assert(listeners.get('neko-game-voice-transcription-state-change')?.size === 1,
    'transcription state listener was not installed');
  assert(listeners.get('neko:user-voice-content-received')?.size === 1,
    'final transcript relay listener was not installed');

  const routeWindowListener = listeners.get('neko-game-window-state-change')?.values().next().value;
  appState.gameRouteActive = false;
  appState.gameRouteGameType = '';
  appState.gameRouteSessionId = '';
  routeWindowListener({ detail: { action: 'opened', sessionId: 'missing-type' } });
  assert(appState.gameRouteGameType === '',
    'host voice bridge invented a soccer identity for a route without game_type');
  routeWindowListener({ detail: { action: 'closed', sessionId: 'missing-type' } });
  appState.gameRouteActive = true;
  appState.gameRouteGameType = 'soccer';
  appState.gameRouteSessionId = 'soccer-runtime';

  channel.onmessage({ data: {
    type: 'game_voice_control_request',
    sender_id: 'soccer-window',
    request_id: 'start-1',
    action: 'start',
    game_type: 'soccer',
    session_id: 'soccer-runtime',
  } });
  await flush();
  assert(appState.isRecording, 'start request did not use the official microphone button');
  assert(posted.some((message) => message.request_id === 'start-1' && message.reason === 'started' && message.active),
    'start request did not acknowledge the confirmed active state');
  assert(posted.some((message) => message.request_id === 'start-1'
    && message.capture_owner === 'host'
    && message.transcription_mode === 'backend_pending'
    && message.ready === false),
  'start response did not expose the host-owned pending transcription contract');

  appState.gameVoiceTranscriptionMode = 'native_core';
  appState.gameVoiceTranscriptionProvider = 'free';
  appState.gameVoiceTranscriptionReady = true;
  appState.gameVoiceTranscriptionReason = 'native_ready';
  const transcriptionListener = listeners.get('neko-game-voice-transcription-state-change')?.values().next().value;
  transcriptionListener({ detail: {} });
  assert(posted.some((message) => message.active
    && message.capture_owner === 'host'
    && message.transcription_mode === 'native_core'
    && message.provider === 'free'
    && message.ready === true),
  'resolved native Core transcription state was not forwarded to the game');

  const transcriptListener = listeners.get('neko:user-voice-content-received')?.values().next().value;
  transcriptListener({ detail: { requestId: 'voice-final-1', text: '  hello game  ', source: 'voice' } });
  assert(posted.some((message) => message.type === 'game_voice_transcript'
    && message.game_type === 'soccer'
    && message.session_id === 'soccer-runtime'
    && message.request_id === 'voice-final-1'
    && message.text === 'hello game'),
  'final normalized transcript was not relayed to the active game route');
  const transcriptCount = posted.filter((message) => message.type === 'game_voice_transcript').length;
  appState.gameRouteActive = false;
  transcriptListener({ detail: { requestId: 'inactive-voice', text: 'must not escape' } });
  assert(posted.filter((message) => message.type === 'game_voice_transcript').length === transcriptCount,
    'transcript was relayed without an active game route');
  appState.gameRouteActive = true;

  channel.onmessage({ data: {
    type: 'game_voice_control_request',
    sender_id: 'soccer-window',
    request_id: 'stop-1',
    action: 'stop',
    game_type: 'soccer',
    session_id: 'soccer-runtime',
  } });
  await flush();
  assert(!appState.isRecording, 'stop request did not use the official microphone teardown');
  assert(posted.some((message) => message.request_id === 'stop-1' && message.reason === 'stopped' && !message.active),
    'stop request did not acknowledge the confirmed inactive state');

  channel.onmessage({ data: {
    type: 'game_voice_control_request',
    sender_id: 'other-game',
    request_id: 'wrong-route',
    action: 'start',
    game_type: 'badminton',
    session_id: 'badminton-runtime',
  } });
  await flush();
  assert(posted.some((message) => message.request_id === 'wrong-route' && message.reason === 'route_mismatch'),
    'route mismatch was not rejected');

  const sameDocumentResponses = [];
  const sameDocumentObserver = (event) => {
    if (event?.detail?.type === 'game_voice_control_state') sameDocumentResponses.push(event.detail);
  };
  addEventListener('neko-game-voice-control-message', sameDocumentObserver);
  channel.failPosts = true;
  windowMock.dispatchEvent(new windowMock.CustomEvent('neko-game-voice-control-message', {
    detail: {
      type: 'game_voice_control_request',
      sender_id: 'soccer-window',
      request_id: 'same-document-query',
      action: 'query',
      game_type: 'soccer',
      session_id: 'soccer-runtime',
    },
  }));
  await flush();
  assert(sameDocumentResponses.some((message) => message.request_id === 'same-document-query'),
    'same-document fallback request was not answered after BroadcastChannel failure');
  removeEventListener('neko-game-voice-control-message', sameDocumentObserver);

  const dispose = listeners.get('pagehide')?.values().next().value;
  assert(typeof dispose === 'function', 'pagehide cleanup was not installed');
  dispose();
  assert(channelClosed, 'host voice control channel was not closed');
  assert(clearedIntervals.length === 1 && intervals.size === 0, 'state synchronization timer was not released');
  assert(!listeners.get('pagehide')?.size, 'pagehide cleanup listener was not released');
  assert(!listeners.get('beforeunload')?.size, 'beforeunload cleanup listener was not released');
  assert(!listeners.get('storage')?.size, 'localStorage fallback listener was not released');
  assert(!listeners.get('neko-game-voice-control-message')?.size,
    'same-document fallback listener was not released');
  assert(!listeners.get('neko-game-window-state-change')?.size, 'route reconciliation listener was not released');
  assert(!listeners.get('neko-game-voice-transcription-state-change')?.size,
    'transcription state listener was not released');
  assert(!listeners.get('neko:user-voice-content-received')?.size,
    'final transcript listener was not released');

  process.stdout.write('game voice control runtime test passed\n');
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
