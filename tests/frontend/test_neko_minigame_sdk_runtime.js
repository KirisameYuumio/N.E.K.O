const fs = require('fs');
const path = require('path');
const vm = require('vm');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const calls = [];
  let voiceOptions = null;
  let voiceStopped = 0;
  let disposed = 0;
  let avatarDisposed = 0;
  let avatarMountFailure = false;
  let avatarFocusFailure = false;
  let mountedAvatarConfig = null;
  const handshakeRequests = [];
  const protocolMessages = [];
  let controlBridgeOptions = null;
  let controlBridgeStopped = 0;
  let protocolPendingMode = false;
  const protocolPending = new Set();
  let dialoguePendingMode = false;
  const dialoguePending = new Set();
  let runtimeState = { sessionId: 'sdk-test-session', characterName: '' };
  const logger = {
    log: (...args) => calls.push(['log', ...args]),
    info: (...args) => calls.push(['info', ...args]),
    warn: (...args) => calls.push(['warn', ...args]),
    error: (...args) => calls.push(['error', ...args]),
    enable: async (reason) => ({ ok: true, reason }),
    enableAfterRouteStart: async () => ({ ok: true }),
    flush: async () => ({ ok: true }),
    reset: () => calls.push(['reset']),
  };
  const transport = {
    logger,
    async connectGame(request) {
      handshakeRequests.push(request);
      return {
        accepted: true,
        protocolVersion: '1',
        hostVersion: 'test-host-1.2.3',
        registration: {
          mode: 'registered',
          gameId: request.manifest.id,
          publisherId: 'test-publisher',
          version: request.manifest.version,
        },
        grantedCapabilities: [
          ...request.manifest.requiredCapabilities,
          ...request.manifest.optionalCapabilities,
        ],
      };
    },
    configureLogger: (options) => calls.push(['configure', options]),
    resetRuntime({ newSession } = {}) {
      runtimeState = {
        sessionId: newSession ? 'sdk-test-session-2' : runtimeState.sessionId,
        characterName: '',
      };
      return runtimeState;
    },
    getRuntimeState() { return runtimeState; },
    applyRuntimeState(state) {
      runtimeState = {
        ...runtimeState,
        characterName: String(state?.lanlan_name || runtimeState.characterName || ''),
      };
      return runtimeState;
    },
    start: async (payload) => ({
      ok: true,
      state: { game_route_active: true, session_id: runtimeState.sessionId },
      payload,
    }),
    end: async (payload) => ({ ok: true, payload }),
    heartbeat: async (payload) => ({ ok: true, active: true, payload }),
    drain: async (payload) => ({ ok: true, outputs: [], payload }),
    requestDialogue(payload, options = {}) {
      if (!dialoguePendingMode) return Promise.resolve({ ok: true, payload });
      return new Promise((resolve, reject) => {
        const entry = { resolve, reject };
        dialoguePending.add(entry);
        const rejectOnAbort = () => {
          dialoguePending.delete(entry);
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        };
        if (options.signal?.aborted) rejectOnAbort();
        else options.signal?.addEventListener('abort', rejectOnAbort, { once: true });
      });
    },
    getQuickLines: async (payload) => ({
      ok: true,
      lines: { goal: ['nice shot'] },
      payload,
    }),
    publishGameProtocol: async (kind, envelope, options = {}) => {
      protocolMessages.push({ kind, envelope, options });
      if (protocolPendingMode) {
        return new Promise((resolve, reject) => {
          const entry = { resolve, reject, signal: options.signal };
          protocolPending.add(entry);
          const rejectOnAbort = () => {
            protocolPending.delete(entry);
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          };
          if (options.signal?.aborted) rejectOnAbort();
          else options.signal?.addEventListener('abort', rejectOnAbort, { once: true });
        });
      }
      return { ok: true, accepted: true };
    },
    startGameControlBridge(options) {
      controlBridgeOptions = options;
      return true;
    },
    stopGameControlBridge() { controlBridgeStopped += 1; },
    startVoiceControlBridge(options) {
      voiceOptions = options;
      return true;
    },
    requestVoiceControl: async (action) => ({ ok: true, action }),
    stopVoiceControlBridge() { voiceStopped += 1; },
    async mountAvatar(config) {
      if (avatarMountFailure) {
        throw Object.assign(new Error('viewport unavailable'), { code: 'viewport_unavailable' });
      }
      mountedAvatarConfig = config;
      return {
        async setModel(model) { calls.push(['avatar-model', model]); },
        focus(point) {
          if (avatarFocusFailure) {
            throw Object.assign(new Error('avatar host busy'), { code: 'busy' });
          }
          calls.push(['avatar-focus', point]);
        },
        setEmotion(name) { calls.push(['avatar-emotion', name]); },
        pause() { calls.push(['avatar-pause']); },
        resume() { calls.push(['avatar-resume']); },
        getState() { return { ready: true }; },
        dispose() { avatarDisposed += 1; },
      };
    },
    dispose() { disposed += 1; },
  };
  const windowMock = { console: { error() {} } };
  global.window = windowMock;

  const sourcePath = path.resolve(__dirname, '../../static/game/sdk/neko-minigame-sdk.js');
  vm.runInThisContext(fs.readFileSync(sourcePath, 'utf8'), { filename: sourcePath });

  const game = await window.NekoMiniGame.connect({
    id: 'soccer',
    version: '1.0.0',
    requiredCapabilities: ['runtime', 'logging'],
    optionalCapabilities: [
      'dialogue', 'quick-lines', 'voice-input', 'avatar-renderer', 'not-installed',
    ],
    contracts: {
      events: {
        'round-started': {
          type: 'object',
          properties: { round: { type: 'integer', minimum: 1, maximum: 99 } },
          required: ['round'],
        },
      },
      states: {
        score: {
          type: 'object',
          properties: {
            player: { type: 'integer', minimum: 0, maximum: 999 },
            opponent: { type: 'integer', minimum: 0, maximum: 999 },
          },
          required: ['player', 'opponent'],
        },
      },
      controls: {
        mood: ['calm', 'happy', 'angry'],
      },
      results: {
        match: {
          type: 'object',
          properties: { winner: { type: 'string', enum: ['player', 'opponent', 'draw'] } },
          required: ['winner'],
        },
      },
    },
  }, { transport });

  assert(Object.isFrozen(game), 'SDK client must be immutable');
  assert(window.NekoMiniGame.version === '0.1.0', 'public SDK version was not exposed');
  assert(handshakeRequests.length === 1, 'connect did not negotiate with the trusted host');
  assert(handshakeRequests[0].sdkVersion === window.NekoMiniGame.version,
    'host handshake did not include the SDK version');
  assert(handshakeRequests[0].protocolVersions[0] === '1',
    'host handshake did not include the supported protocol');
  assert(game.host.version === 'test-host-1.2.3', 'negotiated host version was not exposed');
  assert(game.host.registration.mode === 'registered', 'registered identity was not exposed');
  assert(Object.isFrozen(game.manifest.contracts.events['round-started']),
    'manifest contract schemas were not immutable');
  assert(game.controls.connected, 'declared control bridge was not connected');

  await game.events.emit('round-started', { round: 1 });
  await game.state.update('score', { player: 2, opponent: 1 });
  await game.results.submit('match', { winner: 'player' });
  assert(protocolMessages.length === 3, 'declared game protocol messages were not published');
  assert(protocolMessages.map((item) => item.kind).join(',') === 'event,state,result',
    'game protocol message kinds were not distinguished');
  assert(protocolMessages[0].envelope.sequence === 1
    && protocolMessages[2].envelope.sequence === 3,
  'game protocol sequence was not monotonic');
  assert(protocolMessages.every((item) => item.envelope.sessionId === 'sdk-test-session'),
    'game protocol messages did not bind the runtime session');
  let invalidEventError = null;
  try { await game.events.emit('round-started', { round: 1, undeclared: true }); }
  catch (error) { invalidEventError = error; }
  assert(invalidEventError?.code === 'invalid_contract',
    'undeclared event payload fields were not rejected');

  const controls = [];
  const controlErrors = [];
  const removeControl = game.controls.on('mood', (control) => controls.push(control));
  const removeControlError = game.controls.onError((error) => controlErrors.push(error));
  controlBridgeOptions.onControl({
    protocolVersion: '1',
    sequence: 1,
    type: 'mood',
    sessionId: 'sdk-test-session',
    timestamp: 123,
    payload: 'happy',
  });
  controlBridgeOptions.onControl({
    protocolVersion: '1',
    sequence: 1,
    type: 'mood',
    sessionId: 'sdk-test-session',
    payload: 'angry',
  });
  controlBridgeOptions.onControl({
    protocolVersion: '1',
    sequence: 2,
    type: 'mood',
    sessionId: 'sdk-test-session',
    payload: 'not-declared',
  });
  assert(controls.length === 1 && controls[0].payload === 'happy',
    'declared host control was not validated and delivered exactly once');
  assert(controlErrors.length === 1 && controlErrors[0].code === 'invalid_contract',
    'invalid host control did not produce a bounded public error');
  removeControl();
  removeControlError();
  assert(game.capabilities.has('runtime'), 'required runtime capability was not granted');
  assert(game.capabilities.has('voice-input'), 'available optional voice capability was not granted');
  assert(game.capabilities.has('avatar-renderer'), 'available avatar capability was not granted');
  assert(!game.capabilities.has('not-installed'), 'unsupported optional capability was granted');
  assert(typeof voiceOptions?.onTranscript === 'function', 'host transcript callback was not connected');

  const transcriptEvents = [];
  const removeTranscript = game.voice.onTranscript((event) => transcriptEvents.push(event));
  voiceOptions.onTranscript({
    text: '  final words  ',
    request_id: 'voice-1',
    source: 'voice',
    timestamp: 123,
  });
  assert(transcriptEvents.length === 1, 'final transcript was not emitted');
  assert(transcriptEvents[0].text === 'final words', 'transcript was not normalized');
  assert(transcriptEvents[0].requestId === 'voice-1', 'transcript request id was not normalized');
  removeTranscript();
  voiceOptions.onTranscript({ text: 'after unsubscribe' });
  assert(transcriptEvents.length === 1, 'unsubscribe did not release transcript listener');

  const voiceState = await game.voice.toggle();
  assert(voiceState.action === 'toggle', 'voice toggle did not use the host transport');
  let inactiveDialogueError = null;
  try { await game.dialogue.request({ event: 'before-start' }); }
  catch (error) { inactiveDialogueError = error; }
  assert(inactiveDialogueError?.code === 'invalid_state',
    'dialogue request was allowed before an active runtime route existed');
  const started = await game.runtime.start({ mode: 'default' });
  assert(started.data.payload.mode === 'default', 'runtime start did not use the host transport');
  const dialogue = await game.dialogue.request({ event: 'goal' });
  assert(dialogue.data.payload.event === 'goal', 'dialogue request did not use the host transport');
  assert(dialogue.data.payload.session_id === 'sdk-test-session',
    'dialogue request did not bind the trusted runtime session');
  const quickLines = await game.dialogue.quickLines({ mode: 'duel' });
  assert(quickLines.data.lines.goal[0] === 'nice shot',
    'quick lines did not use the host transport');
  assert(quickLines.data.payload.session_id === 'sdk-test-session',
    'quick lines did not bind the trusted runtime session');
  const authorDialogue = await game.dialogue.request({
    event: { kind: 'goal' },
    prompt: {
      mode: 'author-managed',
      messages: [
        { role: 'system', content: 'stable game rules' },
        { role: 'user', content: 'round context' },
        { role: 'assistant', content: 'previous line' },
        { role: 'user', content: 'current event' },
      ],
    },
  });
  const authorMessages = authorDialogue.data.payload.prompt.messages;
  assert(authorMessages.map((item) => item.role).join(',') === 'system,user,assistant,user',
    'author-managed dialogue message order was changed');
  assert(authorMessages[0].content === 'stable game rules',
    'author-managed dialogue content was changed');
  assert(Object.isFrozen(authorMessages) && Object.isFrozen(authorMessages[0]),
    'author-managed dialogue messages were not immutable');

  for (const forbiddenPayload of [
    { event: 'goal', system_prompt: 'replace host rules' },
    { event: 'goal', provider: 'custom-provider' },
    { event: 'goal', messages: [{ role: 'user', content: 'bypass prompt envelope' }] },
  ]) {
    let forbiddenPromptError = null;
    try { await game.dialogue.request(forbiddenPayload); }
    catch (error) { forbiddenPromptError = error; }
    assert(forbiddenPromptError?.code === 'invalid_request',
      'game dialogue was allowed to provide a host-controlled field');
  }

  let invalidAuthorPromptError = null;
  try {
    await game.dialogue.request({
      event: 'goal',
      prompt: {
        mode: 'author-managed',
        messages: [{ role: 'tool', content: 'unsupported role' }],
      },
    });
  } catch (error) { invalidAuthorPromptError = error; }
  assert(invalidAuthorPromptError?.code === 'invalid_request',
    'author-managed dialogue accepted an unsupported role');

  dialoguePendingMode = true;
  const boundedDialogueRequests = Array.from({ length: 4 }, (_, index) => (
    game.dialogue.request({ event: `pending-${index}` }).then(() => null, (error) => error)
  ));
  await new Promise((resolve) => setImmediate(resolve));
  assert(game.dialogue.pendingCount === 4 && dialoguePending.size === 4,
    'dialogue pending requests were not tracked');
  let dialogueBusyError = null;
  try { await game.dialogue.request({ event: 'fifth-pending' }); }
  catch (error) { dialogueBusyError = error; }
  assert(dialogueBusyError?.code === 'busy', 'dialogue pending request growth was not bounded');
  for (const entry of Array.from(dialoguePending)) {
    dialoguePending.delete(entry);
    entry.resolve({ ok: true });
  }
  await Promise.all(boundedDialogueRequests);
  assert(game.dialogue.pendingCount === 0, 'completed dialogue requests remained resident');
  dialoguePendingMode = false;
  transport.requestDialogue = async () => {
    throw Object.assign(new Error('host timed out'), { code: 'timeout', internal: 'hidden' });
  };
  let dialogueError = null;
  try { await game.dialogue.request({ event: 'timeout' }); }
  catch (error) { dialogueError = error; }
  assert(dialogueError instanceof window.NekoMiniGame.Error,
    'transport failures were not normalized to the public SDK error');
  assert(dialogueError.code === 'timeout' && dialogueError.details.operation === 'dialogue.request',
    'public transport error lost its stable code or operation');
  assert(dialogueError.details.internal === undefined,
    'public transport error leaked transport-specific details');
  game.logger.info('runtime', 'ready', 'ready');
  assert(calls.some((entry) => entry[0] === 'info'), 'SDK logger did not use the required host logger');

  const avatar = await game.avatar.mount({
    slot: 'ai',
    model: { type: 'live2d', path: '/models/ai.model3.json' },
    viewport: { mode: 'fixed', width: 200, height: 300 },
    fit: { mode: 'contain', align: 'bottom-center', padding: 6, scaleMultiplier: 1 },
    resize: { mode: 'fixed' },
  });
  assert(Object.isFrozen(avatar), 'avatar controller must be immutable');
  assert(game.avatar.activeCount === 1, 'active avatar controller was not tracked');
  assert(mountedAvatarConfig?.viewport?.width === 200, 'avatar viewport was not normalized');
  assert(mountedAvatarConfig?.resize?.mode === 'fixed', 'fixed resize policy was not forwarded');
  assert(Object.isFrozen(mountedAvatarConfig.fit), 'avatar layout contract must be immutable');
  avatar.focus({ x: 12, y: 34 });
  avatar.setEmotion('happy');
  await avatar.setModel({ type: 'vrm', path: '/models/ai.vrm' });
  assert(calls.some((entry) => entry[0] === 'avatar-focus' && entry[1].x === 12),
    'avatar focus did not use the host controller');
  assert(calls.some((entry) => entry[0] === 'avatar-model' && entry[1].type === 'vrm'),
    'avatar model switch did not use the host controller');
  const boundedAvatars = [avatar];
  for (let index = 1; index < 8; index += 1) {
    boundedAvatars.push(await game.avatar.mount({
      slot: `slot-${index}`,
      model: { type: 'live2d', path: `/models/${index}.model3.json` },
      viewport: { mode: 'fixed', width: 200, height: 300 },
      resize: { mode: 'fixed' },
    }));
  }
  let avatarLimitError = null;
  try {
    await game.avatar.mount({
      slot: 'overflow',
      model: { type: 'vrm', path: '/models/overflow.vrm' },
      viewport: { mode: 'fixed', width: 200, height: 300 },
      resize: { mode: 'fixed' },
    });
  } catch (error) {
    avatarLimitError = error;
  }
  assert(avatarLimitError?.code === 'busy', 'avatar renderer growth was not bounded');
  boundedAvatars[0].dispose();
  assert(game.avatar.activeCount === 7, 'explicit avatar disposal did not release its slot');
  avatarMountFailure = true;
  let avatarMountTransportError = null;
  try {
    await game.avatar.mount({
      slot: 'failed-host-mount',
      model: { type: 'vrm', path: '/models/failed.vrm' },
      viewport: { mode: 'fixed', width: 200, height: 300 },
      resize: { mode: 'fixed' },
    });
  } catch (error) { avatarMountTransportError = error; }
  avatarMountFailure = false;
  assert(avatarMountTransportError instanceof window.NekoMiniGame.Error
    && avatarMountTransportError.code === 'request_failed'
    && avatarMountTransportError.details.operation === 'avatar.mount'
    && game.avatar.activeCount === 7,
  'avatar mount leaked a host error or retained a failed controller');
  avatarFocusFailure = true;
  let avatarControllerTransportError = null;
  try { boundedAvatars[1].focus({ x: 1, y: 2 }); }
  catch (error) { avatarControllerTransportError = error; }
  avatarFocusFailure = false;
  assert(avatarControllerTransportError instanceof window.NekoMiniGame.Error
    && avatarControllerTransportError.code === 'busy'
    && avatarControllerTransportError.details.operation === 'avatar.focus',
  'avatar controller leaked a host-specific error');

  const stateListeners = [];
  for (let index = 0; index < 32; index += 1) {
    stateListeners.push(game.voice.onState(() => {}));
  }
  let listenerLimitError = null;
  try { game.voice.onState(() => {}); }
  catch (error) { listenerLimitError = error; }
  assert(listenerLimitError?.code === 'busy', 'listener growth was not bounded');
  stateListeners.forEach((unsubscribe) => unsubscribe());

  protocolPendingMode = true;
  const pendingProtocolRequests = Array.from({ length: 8 }, (_, index) => (
    game.events.emit('round-started', { round: index + 1 })
      .then(() => null, (error) => error)
  ));
  await new Promise((resolve) => setImmediate(resolve));
  assert(protocolPending.size === 8, 'game protocol pending requests were not retained for the test');
  let protocolBusyError = null;
  try { await game.events.emit('round-started', { round: 9 }); }
  catch (error) { protocolBusyError = error; }
  assert(protocolBusyError?.code === 'busy', 'game protocol pending request growth was not bounded');

  game.dispose();
  const pendingProtocolErrors = await Promise.all(pendingProtocolRequests);
  assert(pendingProtocolErrors.every((error) => error?.code === 'disposed'),
    'client disposal did not cancel game protocol requests as disposed');
  assert(protocolPending.size === 0, 'disposed game protocol requests remained in the host transport');
  assert(game.disposed, 'dispose did not update the client state');
  assert(voiceStopped === 0, 'SDK duplicated transport-owned voice cleanup');
  assert(controlBridgeStopped === 0, 'SDK duplicated transport-owned control cleanup');
  assert(disposed === 1, 'dispose did not release the injected transport');
  assert(avatarDisposed === 8, 'dispose did not release active avatar controllers');
  let disposedError = null;
  try { await game.voice.toggle(); }
  catch (error) { disposedError = error; }
  assert(disposedError?.code === 'disposed', 'calls after dispose did not fail predictably');

  let partialVoiceCleanup = 0;
  const optionalVoiceUnavailable = await window.NekoMiniGame.connect({
    id: 'no-voice-route',
    version: '1',
    requiredCapabilities: ['runtime', 'logging'],
    optionalCapabilities: ['voice-input'],
  }, {
    transport: {
      ...transport,
      startVoiceControlBridge: () => false,
      stopVoiceControlBridge: () => { partialVoiceCleanup += 1; },
      dispose() {},
    },
  });
  assert(!optionalVoiceUnavailable.capabilities.has('voice-input'),
    'failed optional voice transport remained granted');
  assert(partialVoiceCleanup === 1, 'partial optional voice bridge was not cleaned up');
  optionalVoiceUnavailable.dispose();

  let missingRequiredDisposed = 0;
  let requiredError = null;
  try {
    await window.NekoMiniGame.connect({
      id: 'missing-dialogue',
      version: '1',
      requiredCapabilities: ['dialogue', 'logging'],
    }, {
      transport: {
        logger,
        connectGame: transport.connectGame,
        dispose() { missingRequiredDisposed += 1; },
      },
    });
  } catch (error) {
    requiredError = error;
  }
  assert(requiredError?.code === 'capability_unavailable', 'missing required capability was not rejected');
  assert(missingRequiredDisposed === 1, 'missing required capability did not release the transport');

  let mandatoryError = null;
  try {
    await window.NekoMiniGame.connect({
      id: 'no-official-logger',
      version: '1',
      requiredCapabilities: ['runtime'],
    }, { transport });
  } catch (error) {
    mandatoryError = error;
  }
  assert(mandatoryError?.code === 'invalid_manifest', 'official logging was not mandatory');

  let quickLinesDependencyError = null;
  try {
    await window.NekoMiniGame.connect({
      id: 'quick-lines-without-dialogue',
      version: '1',
      requiredCapabilities: ['logging'],
      optionalCapabilities: ['quick-lines'],
    }, { transport });
  } catch (error) {
    quickLinesDependencyError = error;
  }
  assert(quickLinesDependencyError?.code === 'invalid_manifest',
    'quick-lines was accepted without the dialogue capability');

  let versionError = null;
  try {
    await window.NekoMiniGame.connect({
      id: 'future-game',
      version: '1',
      protocolVersion: '999',
    }, { transport });
  } catch (error) {
    versionError = error;
  }
  assert(versionError?.code === 'incompatible_version', 'incompatible protocol was not rejected');

  let unregisteredDisposed = 0;
  let unregisteredError = null;
  try {
    await window.NekoMiniGame.connect({
      id: 'unregistered-game',
      version: '1.0.0',
      requiredCapabilities: ['logging'],
    }, {
      transport: {
        connectGame: async () => ({
          accepted: false,
          code: 'game_unregistered',
          message: 'not installed',
        }),
        dispose() { unregisteredDisposed += 1; },
      },
    });
  } catch (error) {
    unregisteredError = error;
  }
  assert(unregisteredError?.code === 'game_unregistered',
    'an unregistered formal game was not rejected');
  assert(unregisteredDisposed === 1, 'rejected handshake did not release the transport');

  const developmentGame = await window.NekoMiniGame.connect({
    id: 'local-development-game',
    version: '0.0.1',
    requiredCapabilities: ['logging'],
  }, {
    transport: {
      logger,
      async connectGame(request) {
        return {
          accepted: true,
          protocolVersion: '1',
          hostVersion: 'test-development-host',
          registration: {
            mode: 'development',
            gameId: request.manifest.id,
            publisherId: '',
            version: request.manifest.version,
          },
          grantedCapabilities: ['logging'],
        };
      },
      dispose() {},
    },
  });
  assert(developmentGame.host.registration.mode === 'development',
    'host-approved development identity was not preserved');
  developmentGame.dispose();

  let hostProtocolError = null;
  try {
    await window.NekoMiniGame.connect({
      id: 'protocol-mismatch',
      version: '1.0.0',
      requiredCapabilities: ['logging'],
    }, {
      transport: {
        connectGame: async (request) => ({
          accepted: true,
          protocolVersion: '2',
          hostVersion: 'future-host',
          registration: {
            mode: 'registered',
            gameId: request.manifest.id,
            version: request.manifest.version,
          },
          grantedCapabilities: ['logging'],
        }),
        dispose() {},
      },
    });
  } catch (error) {
    hostProtocolError = error;
  }
  assert(hostProtocolError?.code === 'incompatible_version',
    'an incompatible host-selected protocol was not rejected');

  process.stdout.write('mini-game SDK runtime test passed\n');
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
