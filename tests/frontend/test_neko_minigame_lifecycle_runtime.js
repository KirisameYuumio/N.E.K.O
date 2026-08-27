const fs = require('fs');
const path = require('path');
const vm = require('vm');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createEnvironment() {
  let nextTimerId = 0;
  const intervals = new Map();
  const documentListeners = new Map();
  const windowListeners = new Map();
  const consoleErrors = [];
  const documentImpl = {
    visibilityState: 'visible',
    hidden: false,
    addEventListener(type, handler) {
      let handlers = documentListeners.get(type);
      if (!handlers) {
        handlers = new Set();
        documentListeners.set(type, handlers);
      }
      handlers.add(handler);
    },
    removeEventListener(type, handler) {
      const handlers = documentListeners.get(type);
      handlers?.delete(handler);
      if (!handlers?.size) documentListeners.delete(type);
    },
    dispatch(type) {
      for (const handler of Array.from(documentListeners.get(type) || [])) handler();
    },
  };
  const windowImpl = {
    console: { error(...args) { consoleErrors.push(args); } },
    AbortController,
    setInterval(handler, intervalMs) {
      nextTimerId += 1;
      intervals.set(nextTimerId, { handler, intervalMs });
      return nextTimerId;
    },
    clearInterval(timerId) { intervals.delete(timerId); },
    addEventListener(type, handler) {
      let handlers = windowListeners.get(type);
      if (!handlers) {
        handlers = new Set();
        windowListeners.set(type, handlers);
      }
      handlers.add(handler);
    },
    removeEventListener(type, handler) {
      const handlers = windowListeners.get(type);
      handlers?.delete(handler);
      if (!handlers?.size) windowListeners.delete(type);
    },
    dispatch(type) {
      for (const handler of Array.from(windowListeners.get(type) || [])) handler({ type });
    },
  };
  return {
    windowImpl, documentImpl, intervals, documentListeners, windowListeners, consoleErrors,
  };
}

function logger() {
  return {
    log() {}, info() {}, warn() {}, error() {},
    async enable() { return { ok: true }; },
    async enableAfterRouteStart() { return { ok: true }; },
    async flush() { return { ok: true }; },
    reset() {},
  };
}

async function main() {
  global.window = { console: { error() {} } };
  const sourcePath = path.resolve(__dirname, '../../static/game/sdk/neko-minigame-sdk.js');
  vm.runInThisContext(fs.readFileSync(sourcePath, 'utf8'), { filename: sourcePath });

  const environment = createEnvironment();
  let sessionNumber = 1;
  let runtimeState = { sessionId: 'session-1', characterName: '' };
  let heartbeatCalls = 0;
  let drainCalls = 0;
  let disposed = 0;
  const outputs = [
    { type: 'game_external_input', text: 'hello' },
    { type: 'game_llm_result', result: { line: 'hi', metadata: { source: 'host' } } },
  ];
  const transport = {
    logger: logger(),
    connectGame(request) {
      return {
        accepted: true,
        protocolVersion: '1',
        hostVersion: 'lifecycle-test-host',
        registration: {
          mode: 'registered',
          gameId: request.manifest.id,
          version: request.manifest.version,
        },
        grantedCapabilities: [
          ...request.manifest.requiredCapabilities,
          ...request.manifest.optionalCapabilities,
        ],
      };
    },
    configureLogger() {},
    resetRuntime({ newSession }) {
      if (newSession) {
        sessionNumber += 1;
        runtimeState = { sessionId: `session-${sessionNumber}`, characterName: '' };
      } else {
        runtimeState = { ...runtimeState, characterName: '' };
      }
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
    async start(payload) {
      return { ok: true, state: { game_route_active: true, lanlan_name: 'Yui' }, payload };
    },
    async heartbeat(payload) {
      heartbeatCalls += 1;
      return { ok: true, active: true, payload };
    },
    async drain(payload) {
      drainCalls += 1;
      this.lastDrainPayload = payload;
      return { ok: true, outputs: drainCalls === 1 ? outputs : [], payload };
    },
    async end(payload) { return { ok: true, payload }; },
    dispose() { disposed += 1; },
  };

  const game = await window.NekoMiniGame.connect({
    id: 'lifecycle-test',
    version: '1.0.0',
    requiredCapabilities: ['runtime', 'logging'],
  }, {
    transport,
    windowImpl: environment.windowImpl,
    documentImpl: environment.documentImpl,
  });

  assert(game.runtime.state === 'idle', 'runtime did not start idle');
  assert(game.runtime.session.id === 'session-1', 'initial host session was not exposed');
  assert(typeof game.events?.on === 'function', 'public event subscription API is missing');
  assert(typeof game.runtime.configure === 'function', 'managed lifecycle configuration is missing');
  let unsupportedEventError = null;
  try { game.events.on('third-party-custom-event', () => {}); }
  catch (error) { unsupportedEventError = error; }
  assert(unsupportedEventError?.code === 'invalid_event',
    'unregistered event types must not grow the listener registry');

  game.runtime.configure({ heartbeat: false, outputs: false, pageExit: false });
  assert(!environment.windowListeners.has('pagehide')
    && !environment.windowListeners.has('beforeunload'),
    'pageExit=false must be accepted without installing page-exit listeners');

  let nestedMutationBlocked = false;
  game.events.on('runtime-output', (event) => {
    if (!event.payload.result) return;
    event.payload.result.metadata.source = 'listener-mutated';
    nestedMutationBlocked = event.payload.result.metadata.source === 'host';
  });
  const envelopes = [];
  const unsubscribeOutput = game.events.on('runtime-output', (event) => envelopes.push(event));
  const stateEvents = [];
  game.events.on('runtime-state', (event) => stateEvents.push(event));
  game.events.on('runtime-state', (event) => (
    event.payload.current === 'running'
      ? Promise.reject(new Error('async listener failed'))
      : undefined
  ));
  game.runtime.configure({
    payload: () => ({ score: 1 }),
    heartbeat: { intervalMs: 2500, timeoutMs: 4500 },
    outputs: { intervalMs: 700, timeoutMs: 8000, limit: 50 },
    pageExit: true,
  });

  const resetState = game.runtime.reset({ newSession: true });
  assert(resetState.id === 'session-2', 'runtime reset did not rotate the host session');
  const started = await game.runtime.start({ mode: 'default' });
  assert(started.ok && started.data.ok, 'runtime start response was not normalized');
  assert(game.runtime.state === 'running', 'successful runtime start did not enter running');
  assert(game.runtime.session.characterName === 'Yui', 'host route state was not applied');
  assert(environment.intervals.size === 2, 'heartbeat and output polling did not have two bounded timers');
  assert(environment.documentListeners.get('visibilitychange')?.size === 1,
    'managed lifecycle did not own exactly one visibility listener');
  assert(environment.windowListeners.get('pagehide')?.size === 1,
    'managed lifecycle did not own exactly one pagehide listener');
  assert(environment.windowListeners.get('beforeunload')?.size === 1,
    'managed lifecycle did not own exactly one beforeunload listener');
  await Promise.resolve();
  await Promise.resolve();
  assert(environment.consoleErrors.some((args) => (
    String(args[0]).includes('runtime-state listener failed')
      && args[1]?.message === 'async listener failed'
  )), 'fire-and-forget runtime listener rejection was not observed');

  await game.runtime.pulse(true);
  await game.runtime.pollOutputs();
  assert(heartbeatCalls >= 1, 'manual heartbeat did not use the host transport');
  assert(transport.lastDrainPayload?.limit === 50,
    'runtime drain did not delegate its bounded output limit to the host');
  assert(envelopes.length === 2, 'runtime outputs were not delivered as events');
  assert(envelopes[0].type === 'runtime-output', 'runtime output event type is invalid');
  assert(envelopes[0].sequence > 0, 'runtime event sequence was not assigned');
  assert(envelopes[1].sequence === envelopes[0].sequence + 1,
    'runtime event sequence did not increase');
  assert(envelopes[0].sessionId === 'session-2', 'runtime event lost session ownership');
  assert(envelopes[0].payload.text === 'hello', 'runtime event payload was not preserved');
  assert(Object.isFrozen(envelopes[0]), 'runtime event envelope must be immutable');
  assert(Object.isFrozen(envelopes[1].payload)
    && Object.isFrozen(envelopes[1].payload.result)
    && Object.isFrozen(envelopes[1].payload.result.metadata),
  'runtime event payload must be recursively immutable');
  assert(nestedMutationBlocked && envelopes[1].payload.result.metadata.source === 'host',
    'one runtime event listener mutated nested payload observed by another listener');

  let activeResetError = null;
  try { game.runtime.reset({ newSession: true }); }
  catch (error) { activeResetError = error; }
  assert(activeResetError?.code === 'invalid_state' && game.runtime.state === 'running',
    'runtime reset abandoned an active host route instead of requiring runtime.end()');

  const heartbeatBeforeVisibility = heartbeatCalls;
  environment.documentImpl.visibilityState = 'hidden';
  environment.documentImpl.hidden = true;
  environment.documentImpl.dispatch('visibilitychange');
  await Promise.resolve();
  await Promise.resolve();
  assert(heartbeatCalls > heartbeatBeforeVisibility,
    'visibility change did not force a managed heartbeat');

  unsubscribeOutput();
  const ended = await game.runtime.end({ reason: 'completed' });
  assert(ended.ok && ended.data.ok, 'runtime end response was not normalized');
  assert(game.runtime.state === 'ended', 'runtime end did not enter ended');
  assert(environment.intervals.size === 0, 'runtime end did not release lifecycle timers');
  assert(!environment.documentListeners.has('visibilitychange'),
    'runtime end did not release the visibility listener');
  assert(!environment.windowListeners.has('pagehide') && !environment.windowListeners.has('beforeunload'),
    'runtime end did not release page-exit listeners');
  assert(stateEvents.some((event) => event.payload.current === 'running'),
    'runtime state transitions were not emitted');

  let reentrantDisposeError = null;
  game.events.on('runtime-state', (event) => {
    if (event.payload.current !== 'disposed') return;
    try { game.runtime.pollOutputs(); }
    catch (error) { reentrantDisposeError = error; }
  });
  game.dispose();
  assert(disposed === 1, 'runtime client did not release the transport');
  assert(reentrantDisposeError?.code === 'disposed',
    'a synchronous dispose listener could reopen a host request during cleanup');

  const inactiveEnvironment = createEnvironment();
  const inactiveTransport = {
    ...transport,
    logger: logger(),
    resetRuntime() { return { sessionId: 'inactive-session', characterName: '' }; },
    getRuntimeState() { return { sessionId: 'inactive-session', characterName: '' }; },
    applyRuntimeState() { return { sessionId: 'inactive-session', characterName: '' }; },
    async heartbeat() { return { ok: true, active: false, reason: 'route-gone' }; },
    async drain() { return { ok: true, outputs: [] }; },
    dispose() {},
  };
  const inactiveGame = await window.NekoMiniGame.connect({
    id: 'lifecycle-inactive',
    version: '1.0.0',
    requiredCapabilities: ['runtime', 'logging'],
  }, {
    transport: inactiveTransport,
    windowImpl: inactiveEnvironment.windowImpl,
    documentImpl: inactiveEnvironment.documentImpl,
  });
  inactiveGame.runtime.configure({
    heartbeat: { intervalMs: 2500, timeoutMs: 4500 },
    outputs: { intervalMs: 700, timeoutMs: 8000 },
    pageExit: true,
  });
  await inactiveGame.runtime.start({});
  assert(inactiveEnvironment.intervals.size === 2,
    'inactive lifecycle fixture did not start both monitoring timers');
  await inactiveGame.runtime.pulse(true);
  assert(inactiveGame.runtime.state === 'inactive' && inactiveEnvironment.intervals.size === 0,
    'inactive heartbeat did not stop heartbeat and output monitoring together');
  assert(inactiveEnvironment.windowListeners.size === 0
    && inactiveEnvironment.documentListeners.size === 0,
  'inactive heartbeat left lifecycle listeners resident');
  inactiveGame.dispose();

  const failedEndEnvironment = createEnvironment();
  let rejectEnd = true;
  const failedEndTransport = {
    ...transport,
    logger: logger(),
    resetRuntime() { return { sessionId: 'failed-end-session', characterName: '' }; },
    getRuntimeState() { return { sessionId: 'failed-end-session', characterName: '' }; },
    applyRuntimeState() { return { sessionId: 'failed-end-session', characterName: '' }; },
    async heartbeat() { return { ok: true, active: true }; },
    async drain() { return { ok: true, outputs: [] }; },
    async end() {
      if (rejectEnd) throw Object.assign(new Error('network failed'), { code: 'request_failed' });
      return { ok: true };
    },
    dispose() {},
  };
  const failedEndGame = await window.NekoMiniGame.connect({
    id: 'lifecycle-failed-end',
    version: '1.0.0',
    requiredCapabilities: ['runtime', 'logging'],
  }, {
    transport: failedEndTransport,
    windowImpl: failedEndEnvironment.windowImpl,
    documentImpl: failedEndEnvironment.documentImpl,
  });
  failedEndGame.runtime.configure({
    heartbeat: { intervalMs: 2500, timeoutMs: 4500 },
    outputs: { intervalMs: 700, timeoutMs: 8000 },
    pageExit: false,
  });
  await failedEndGame.runtime.start({});
  let failedEndError = null;
  try { await failedEndGame.runtime.end({}); }
  catch (error) { failedEndError = error; }
  assert(failedEndError?.code === 'request_failed'
    && failedEndGame.runtime.state === 'degraded'
    && failedEndEnvironment.intervals.size === 2,
  'failed runtime end was treated as ended instead of retryable and monitored');
  rejectEnd = false;
  await failedEndGame.runtime.end({});
  assert(failedEndGame.runtime.state === 'ended' && failedEndEnvironment.intervals.size === 0,
    'retrying a failed runtime end did not close the route lifecycle');
  failedEndGame.dispose();

  const cancellationEnvironment = createEnvironment();
  const blockedHeartbeat = deferred();
  let heartbeatAborted = false;
  const cancellationTransport = {
    ...transport,
    logger: logger(),
    resetRuntime() { return { sessionId: 'cancel-session', characterName: '' }; },
    getRuntimeState() { return { sessionId: 'cancel-session', characterName: '' }; },
    applyRuntimeState() { return { sessionId: 'cancel-session', characterName: '' }; },
    heartbeat(_payload, options = {}) {
      options.signal?.addEventListener('abort', () => {
        heartbeatAborted = true;
        blockedHeartbeat.reject(Object.assign(new Error('aborted'), { code: 'cancelled' }));
      }, { once: true });
      return blockedHeartbeat.promise;
    },
    async drain() { return { ok: true, outputs: [] }; },
    dispose() {},
  };
  const cancellationGame = await window.NekoMiniGame.connect({
    id: 'lifecycle-cancel',
    version: '1.0.0',
    requiredCapabilities: ['runtime', 'logging'],
  }, {
    transport: cancellationTransport,
    windowImpl: cancellationEnvironment.windowImpl,
    documentImpl: cancellationEnvironment.documentImpl,
  });
  cancellationGame.runtime.configure({
    payload: () => ({}),
    heartbeat: { intervalMs: 2500, timeoutMs: 4500 },
    outputs: { intervalMs: 700, timeoutMs: 8000 },
  });
  await cancellationGame.runtime.start({});
  await Promise.resolve();
  cancellationGame.dispose();
  await Promise.resolve();
  assert(heartbeatAborted, 'dispose did not abort an in-flight managed heartbeat');
  assert(cancellationEnvironment.intervals.size === 0,
    'dispose did not release managed lifecycle timers');
  assert(!cancellationEnvironment.documentListeners.has('visibilitychange'),
    'dispose did not release managed lifecycle listeners');

  const transitionEnvironment = createEnvironment();
  const blockedTransitionStart = deferred();
  const blockedTransitionEnd = deferred();
  let transitionStartAborted = false;
  const transitionTransport = {
    ...transport,
    logger: logger(),
    resetRuntime() { return { sessionId: 'transition-session', characterName: '' }; },
    getRuntimeState() { return { sessionId: 'transition-session', characterName: '' }; },
    applyRuntimeState() { return { sessionId: 'transition-session', characterName: '' }; },
    start(_payload, options = {}) {
      options.signal?.addEventListener('abort', () => {
        transitionStartAborted = true;
        blockedTransitionStart.reject(Object.assign(new Error('aborted'), { code: 'cancelled' }));
      }, { once: true });
      return blockedTransitionStart.promise;
    },
    end() { return blockedTransitionEnd.promise; },
    async heartbeat() { return { ok: true, active: true }; },
    async drain() { return { ok: true, outputs: [] }; },
    dispose() {},
  };
  const transitionGame = await window.NekoMiniGame.connect({
    id: 'lifecycle-transition',
    version: '1.0.0',
    requiredCapabilities: ['runtime', 'logging'],
  }, {
    transport: transitionTransport,
    windowImpl: transitionEnvironment.windowImpl,
    documentImpl: transitionEnvironment.documentImpl,
  });
  transitionGame.runtime.configure({
    payload: () => ({}),
    heartbeat: false,
    outputs: { intervalMs: 700, timeoutMs: 8000 },
    pageExit: false,
  });
  const supersededStart = transitionGame.runtime.start({}).catch((error) => error);
  await Promise.resolve();
  const transitionEnd = transitionGame.runtime.end({});
  const supersededStartError = await supersededStart;
  await Promise.resolve();
  assert(transitionStartAborted && supersededStartError.code === 'cancelled',
    'ending did not cancel the in-flight start request');
  assert(transitionGame.runtime.state === 'ending',
    'cancelled start completion overwrote the newer ending state');
  assert(transitionEnvironment.intervals.size === 0,
    'cancelled start completion restarted runtime monitoring');
  blockedTransitionEnd.resolve({ ok: true });
  await transitionEnd;
  assert(transitionGame.runtime.state === 'ended' && transitionEnvironment.intervals.size === 0,
    'runtime end left monitoring resident after superseding start');
  transitionGame.dispose();

  const staleSuccessEnvironment = createEnvironment();
  const blockedStaleStart = deferred();
  const blockedStaleEnd = deferred();
  const staleSuccessTransport = {
    ...transport,
    logger: logger(),
    resetRuntime() { return { sessionId: 'stale-success', characterName: '' }; },
    getRuntimeState() { return { sessionId: 'stale-success', characterName: '' }; },
    applyRuntimeState() { return { sessionId: 'stale-success', characterName: 'stale' }; },
    start() { return blockedStaleStart.promise; },
    end() { return blockedStaleEnd.promise; },
    async heartbeat() { return { ok: true, active: true }; },
    async drain() { return { ok: true, outputs: [] }; },
    dispose() {},
  };
  const staleSuccessGame = await window.NekoMiniGame.connect({
    id: 'lifecycle-stale-success',
    version: '1.0.0',
    requiredCapabilities: ['runtime', 'logging'],
  }, {
    transport: staleSuccessTransport,
    windowImpl: staleSuccessEnvironment.windowImpl,
    documentImpl: staleSuccessEnvironment.documentImpl,
  });
  staleSuccessGame.runtime.configure({
    heartbeat: false,
    outputs: { intervalMs: 700, timeoutMs: 8000 },
  });
  const staleStart = staleSuccessGame.runtime.start({});
  await Promise.resolve();
  const staleEnd = staleSuccessGame.runtime.end({});
  blockedStaleStart.resolve({ ok: true, state: { game_route_active: true, lanlan_name: 'stale' } });
  await staleStart;
  assert(staleSuccessGame.runtime.state === 'ending' && staleSuccessEnvironment.intervals.size === 0,
    'stale successful start completion replaced the newer lifecycle state');
  blockedStaleEnd.resolve({ ok: true });
  await staleEnd;
  assert(staleSuccessGame.runtime.state === 'ended' && staleSuccessEnvironment.intervals.size === 0,
    'stale successful start completion left monitoring resident after end');
  staleSuccessGame.dispose();

  const exitEnvironment = createEnvironment();
  let exitEndCalls = 0;
  let exitDisposed = 0;
  let exitPreserved = false;
  const exitTransport = {
    ...transport,
    logger: logger(),
    resetRuntime() { return { sessionId: 'exit-session', characterName: '' }; },
    getRuntimeState() { return { sessionId: 'exit-session', characterName: '' }; },
    applyRuntimeState() { return { sessionId: 'exit-session', characterName: '' }; },
    async heartbeat() { return { ok: true, active: true }; },
    async drain() { return { ok: true, outputs: [] }; },
    async end(payload, options = {}) {
      exitEndCalls += 1;
      assert(payload.reason === 'pagehide', 'page-exit payload factory was not used');
      assert(options.useBeacon === true, 'page exit did not request beacon delivery');
      return { ok: true };
    },
    dispose(options = {}) {
      exitDisposed += 1;
      exitPreserved = options.preservePendingOperations?.includes('route_end') === true;
    },
  };
  const exitGame = await window.NekoMiniGame.connect({
    id: 'lifecycle-page-exit',
    version: '1.0.0',
    requiredCapabilities: ['runtime', 'logging'],
  }, {
    transport: exitTransport,
    windowImpl: exitEnvironment.windowImpl,
    documentImpl: exitEnvironment.documentImpl,
  });
  const pageExitEvents = [];
  exitGame.events.on('page-exit', (event) => pageExitEvents.push(event));
  exitGame.runtime.configure({
    payload: () => ({}),
    heartbeat: { intervalMs: 2500, timeoutMs: 4500 },
    outputs: { intervalMs: 700, timeoutMs: 8000 },
    pageExit: {
      payload: ({ type }) => ({ reason: type }),
    },
  });
  assert(exitEnvironment.windowListeners.get('pagehide')?.size === 1,
    'page-exit lifecycle was not installed before runtime start');
  await exitGame.runtime.start({});
  exitEnvironment.windowImpl.dispatch('pagehide');
  exitEnvironment.windowImpl.dispatch('beforeunload');
  await Promise.resolve();
  await Promise.resolve();
  assert(pageExitEvents.length === 1, 'page exit was not emitted exactly once');
  assert(exitEndCalls === 1, 'page exit did not end the runtime exactly once');
  assert(exitDisposed === 1 && exitPreserved, 'page exit did not preserve route-end during disposal');
  assert(exitGame.disposed, 'page exit did not dispose the SDK client');
  assert(exitEnvironment.intervals.size === 0 && exitEnvironment.windowListeners.size === 0,
    'page exit left managed timers or listeners resident');

  const startingExitEnvironment = createEnvironment();
  const blockedStart = deferred();
  let startAborted = false;
  let startingExitEndCalls = 0;
  const startingExitTransport = {
    ...transport,
    logger: logger(),
    resetRuntime() { return { sessionId: 'starting-exit', characterName: '' }; },
    getRuntimeState() { return { sessionId: 'starting-exit', characterName: '' }; },
    applyRuntimeState() { return { sessionId: 'starting-exit', characterName: '' }; },
    start(_payload, options = {}) {
      options.signal?.addEventListener('abort', () => {
        startAborted = true;
        blockedStart.reject(Object.assign(new Error('aborted'), { code: 'cancelled' }));
      }, { once: true });
      return blockedStart.promise;
    },
    async end() {
      startingExitEndCalls += 1;
      return { ok: true };
    },
    dispose() {},
  };
  const startingExitGame = await window.NekoMiniGame.connect({
    id: 'lifecycle-starting-exit',
    version: '1.0.0',
    requiredCapabilities: ['runtime', 'logging'],
  }, {
    transport: startingExitTransport,
    windowImpl: startingExitEnvironment.windowImpl,
    documentImpl: startingExitEnvironment.documentImpl,
  });
  startingExitGame.runtime.configure({
    payload: () => ({ reason: 'starting-exit' }),
    heartbeat: false,
    outputs: false,
    pageExit: true,
  });
  const rejectedStart = startingExitGame.runtime.start({}).catch((error) => error);
  await Promise.resolve();
  startingExitEnvironment.windowImpl.dispatch('pagehide');
  const startError = await rejectedStart;
  await Promise.resolve();
  assert(startAborted && startError.code === 'cancelled',
    'page exit did not cancel an in-flight runtime start');
  assert(startingExitEndCalls === 1 && startingExitGame.disposed,
    'page exit during runtime start did not end and dispose exactly once');
  assert(startingExitEnvironment.windowListeners.size === 0,
    'page exit during runtime start left listeners resident');

  const routeTruthEnvironment = createEnvironment();
  let routeStartMode = 'reject';
  let routeStartCalls = 0;
  let dialogueCalls = 0;
  let quickLineCalls = 0;
  let speechCalls = 0;
  let speechMirrorCalls = 0;
  let memorySubmitCalls = 0;
  const routeTruthTransport = {
    ...transport,
    logger: logger(),
    resetRuntime() { return { sessionId: 'route-truth-session', characterName: 'Yui' }; },
    getRuntimeState() { return { sessionId: 'route-truth-session', characterName: 'Yui' }; },
    applyRuntimeState() { return { sessionId: 'route-truth-session', characterName: 'Yui' }; },
    async start() {
      routeStartCalls += 1;
      if (routeStartMode === 'throw') throw Object.assign(new Error('start failed'), { code: 'network_error' });
      if (routeStartMode === 'inactive') {
        return { ok: true, state: { game_route_active: false, session_id: 'route-truth-session' } };
      }
      return routeStartMode === 'active'
        ? { ok: true, state: { game_route_active: true, session_id: 'route-truth-session', lanlan_name: 'Yui' } }
        : { ok: false, reason: 'start-rejected' };
    },
    async end() { return { ok: false, reason: 'end-rejected' }; },
    async heartbeat() { return { ok: true, active: true }; },
    async drain() { return { ok: true, outputs: [] }; },
    async requestDialogue() { dialogueCalls += 1; return { ok: true, line: 'route active' }; },
    async getQuickLines() { quickLineCalls += 1; return { ok: true, lines: {} }; },
    async configureGameMemoryConsent() { return { ok: true }; },
    async submitGameMemory() { memorySubmitCalls += 1; return { ok: true, accepted: true }; },
    startSpeechOutputBridge() { return true; },
    stopSpeechOutputBridge() {},
    async preloadSpeechOutput() { return { ok: true, results: [] }; },
    async requestSpeechOutput() {
      speechCalls += 1;
      return { ok: true, speech_id: 'route-truth-speech' };
    },
    async mirrorSpeechOutput() { speechMirrorCalls += 1; return { ok: true, mirrored: true }; },
    dispose() {},
  };
  const routeTruthGame = await window.NekoMiniGame.connect({
    id: 'lifecycle-route-truth',
    version: '1.0.0',
    requiredCapabilities: ['runtime', 'logging', 'dialogue', 'quick-lines', 'speech-output', 'memory'],
  }, {
    transport: routeTruthTransport,
    windowImpl: routeTruthEnvironment.windowImpl,
    documentImpl: routeTruthEnvironment.documentImpl,
  });
  await routeTruthGame.memory.configureConsent(true);
  await routeTruthGame.runtime.start({});
  const activeOnlyCalls = [
    () => routeTruthGame.dialogue.request({ event: 'after-rejected-start' }),
    () => routeTruthGame.dialogue.quickLines({ kind: 'goal' }),
    () => routeTruthGame.speech.speak({ text: 'after rejected start' }),
    () => routeTruthGame.speech.mirror({ text: 'after rejected start' }),
    () => routeTruthGame.memory.submit({ summary: 'after rejected start' }),
  ];
  for (const invoke of activeOnlyCalls) {
    let routeError = null;
    try { await invoke(); } catch (error) { routeError = error; }
    assert(routeError?.code === 'invalid_state',
      'a rejected runtime start permitted an active-route capability');
  }
  assert(dialogueCalls === 0 && quickLineCalls === 0 && speechCalls === 0
    && speechMirrorCalls === 0 && memorySubmitCalls === 0,
  'a rejected runtime start reached an active-route transport');

  routeStartMode = 'throw';
  let failedStartError = null;
  try { await routeTruthGame.runtime.start({}); } catch (error) { failedStartError = error; }
  assert(failedStartError?.code === 'network_error', 'failed start did not preserve its transport error');
  for (const invoke of activeOnlyCalls) {
    let routeError = null;
    try { await invoke(); } catch (error) { routeError = error; }
    assert(routeError?.code === 'invalid_state',
      'a failed runtime start permitted an active-route capability');
  }

  routeStartMode = 'active';
  await routeTruthGame.runtime.start({});
  await routeTruthGame.runtime.end({});
  assert(routeTruthGame.runtime.state === 'degraded',
    'a rejected runtime end did not remain retryable');
  await routeTruthGame.dialogue.request({ event: 'after-rejected-end' });
  await routeTruthGame.dialogue.quickLines({ kind: 'goal' });
  await routeTruthGame.speech.speak({ text: 'after rejected end' });
  await routeTruthGame.speech.mirror({ text: 'after rejected end' });
  await routeTruthGame.memory.submit({ summary: 'after rejected end' });
  assert(dialogueCalls === 1 && quickLineCalls === 1 && speechCalls === 1
    && speechMirrorCalls === 1 && memorySubmitCalls === 1,
    'a failed runtime end discarded a route that may still be active');
  const startsBeforeInvalidRetry = routeStartCalls;
  let establishedStartError = null;
  try { await routeTruthGame.runtime.start({}); } catch (error) { establishedStartError = error; }
  assert(establishedStartError?.code === 'invalid_state'
    && routeStartCalls === startsBeforeInvalidRetry,
  'a failed-end established route permitted a second start');
  routeTruthGame.dispose();

  const inactiveStartEnvironment = createEnvironment();
  routeStartMode = 'inactive';
  const inactiveStartGame = await window.NekoMiniGame.connect({
    id: 'lifecycle-route-inactive-start',
    version: '1.0.0',
    requiredCapabilities: ['runtime', 'logging', 'dialogue'],
  }, {
    transport: routeTruthTransport,
    windowImpl: inactiveStartEnvironment.windowImpl,
    documentImpl: inactiveStartEnvironment.documentImpl,
  });
  await inactiveStartGame.runtime.start({});
  assert(inactiveStartGame.runtime.state === 'inactive',
    'an inactive successful start response entered running');
  let inactiveDialogueError = null;
  try { await inactiveStartGame.dialogue.request({ event: 'inactive-start' }); }
  catch (error) { inactiveDialogueError = error; }
  assert(inactiveDialogueError?.code === 'invalid_state',
    'an inactive successful start response established a route');
  inactiveStartGame.dispose();

  process.stdout.write('mini-game lifecycle runtime test passed\n');
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
