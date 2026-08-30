const fs = require('fs');
const path = require('path');
const vm = require('vm');

function assert(condition, message) {
  if (!condition) throw new Error(message);
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

function abortError() {
  const error = new Error('aborted');
  error.name = 'AbortError';
  return error;
}

function createTransport({ server = false, shared = null } = {}) {
  const values = shared?.values || new Map();
  const lockTails = shared?.lockTails || new Map();
  const pending = new Set();
  const pendingLocks = new Set();
  const serverCalls = [];
  let storagePending = false;
  let storagePendingOperation = '';
  let lockPending = false;
  let runtimeState = { sessionId: 'leaderboard-session', characterName: 'Yui' };

  function pendingRequest(options = {}) {
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject };
      pending.add(entry);
      const abort = () => {
        pending.delete(entry);
        reject(abortError());
      };
      if (options.signal?.aborted) abort();
      else options.signal?.addEventListener('abort', abort, { once: true });
    });
  }

  const transport = {
    logger: logger(),
    configureLogger() {},
    connectGame(request) {
      return {
        accepted: true,
        protocolVersion: '1',
        hostVersion: 'leaderboard-test-host',
        registration: {
          mode: 'registered',
          gameId: request.manifest.id,
          publisherId: 'test',
          version: request.manifest.version,
        },
        grantedCapabilities: [
          ...request.manifest.requiredCapabilities,
          ...request.manifest.optionalCapabilities,
        ],
      };
    },
    requestGameStorage(operation, payload, options = {}) {
      if (storagePending || storagePendingOperation === operation) return pendingRequest(options);
      if (operation === 'get') {
        return Promise.resolve(values.has(payload.key)
          ? { ok: true, found: true, value: values.get(payload.key) }
          : { ok: true, found: false });
      }
      if (operation === 'set') values.set(payload.key, payload.value);
      if (operation === 'delete') values.delete(payload.key);
      return Promise.resolve({ ok: true });
    },
    async runGameStorageExclusive(lockName, callback, options = {}) {
      if (lockPending) {
        return new Promise((resolve, reject) => {
          const entry = { resolve, reject };
          pendingLocks.add(entry);
          const abort = () => {
            pendingLocks.delete(entry);
            reject(abortError());
          };
          if (options.signal?.aborted) abort();
          else options.signal?.addEventListener('abort', abort, { once: true });
        });
      }
      const previous = lockTails.get(lockName) || Promise.resolve();
      let release;
      const gate = new Promise((resolve) => { release = resolve; });
      const tail = previous.catch(() => {}).then(() => gate);
      lockTails.set(lockName, tail);
      await previous.catch(() => {});
      try { return await callback(); }
      finally {
        release();
        if (lockTails.get(lockName) === tail) lockTails.delete(lockName);
      }
    },
    getRuntimeState() { return runtimeState; },
    applyRuntimeState(state) { runtimeState = { ...runtimeState, ...state }; return runtimeState; },
    resetRuntime() { return runtimeState; },
    async start() {
      return { ok: true, state: { game_route_active: true, session_id: runtimeState.sessionId } };
    },
    async end() { return { ok: true, state: { session_id: runtimeState.sessionId } }; },
    async heartbeat() { return { ok: true, active: true }; },
    async drain() { return { ok: true, outputs: [] }; },
    dispose() {},
  };
  if (server) {
    transport.submitServerLeaderboard = async (payload) => {
      serverCalls.push({ operation: 'submit', payload });
      return { ok: true, rank: 1 };
    };
    transport.listServerLeaderboard = async (payload) => {
      serverCalls.push({ operation: 'list', payload });
      return { ok: true, entries: [] };
    };
    transport.getServerLeaderboardBest = async (payload) => {
      serverCalls.push({ operation: 'best', payload });
      return { ok: true, entry: null };
    };
  }
  return {
    transport,
    values,
    pending,
    pendingLocks,
    serverCalls,
    setStoragePending(value) { storagePending = value; },
    setStoragePendingOperation(value) { storagePendingOperation = String(value || ''); },
    setLockPending(value) { lockPending = value; },
  };
}

function manifest(capabilities) {
  return {
    id: 'leaderboard-test',
    version: '1.0.0',
    requiredCapabilities: ['logging', ...capabilities],
    leaderboards: {
      main: {
        scoreField: 'score',
        order: 'descending',
        maxEntries: 3,
        retention: 'recent',
      },
      bulk: {
        scoreField: 'score',
        order: 'descending',
        maxEntries: 64,
        retention: 'recent',
      },
    },
  };
}

async function main() {
  global.window = { console: { error() {} } };
  const sourcePath = path.resolve(__dirname, '../../static/game/sdk/neko-minigame-sdk.js');
  vm.runInThisContext(fs.readFileSync(sourcePath, 'utf8'), { filename: sourcePath });

  const localHost = createTransport();
  const game = await window.NekoMiniGame.connect(manifest(['leaderboard-local']), {
    transport: localHost.transport,
  });
  for (const score of [10, 30, 20, 40]) {
    await game.leaderboard.local.submit('main', { score, mode: 'duel' });
  }
  const ranked = await game.leaderboard.local.list('main', { sort: 'rank', limit: 10 });
  assert(ranked.data.entries.map((entry) => entry.score).join(',') === '40,30,20',
    'local leaderboard did not rank and bound retained entries');
  const recent = await game.leaderboard.local.list('main', { sort: 'recent', limit: 10 });

  // `query` is shared with the server board, where it is forwarded to the host.
  // The local board has no matching semantics anywhere in the public surface,
  // so accepting and dropping it would hand back an unfiltered page that looks
  // filtered. It must be rejected instead.
  let localQueryError = null;
  try { await game.leaderboard.local.list('main', { query: { player: 'a' } }); }
  catch (error) { localQueryError = error; }
  assert(localQueryError?.code === 'invalid_request',
    'the local leaderboard silently accepted a query it does not implement');
  assert(recent.data.entries.map((entry) => entry.score).join(',') === '40,20,30',
    'local leaderboard did not preserve recent ordering');
  const best = await game.leaderboard.local.getBest('main');
  assert(best.data.entry.score === 40, 'local leaderboard best entry was incorrect');

  // A board trimmed to exactly its byte budget must still be listable. `list`
  // restates the same entries under a different wrapper -- {boardId, entries,
  // totalEntries, limit, offset, hasMore} instead of {version, entries} -- and
  // used to measure that wrapper against the state's own budget. A board whose
  // per-entry size parks the trimmed state within the wrapper's overhead of the
  // cap therefore became permanently unlistable, for every user of that game,
  // because entry size is a property of the game and not of the run.
  // The clone every entry passes through forbids `prototype`/`constructor` as
  // property names, so a board declared on one used to connect fine and then
  // reject every submission; omitting the property instead yields a non-finite
  // score. Reject the board at manifest time instead of at every submit.
  for (const reservedScoreField of ['prototype', 'constructor']) {
    const reservedManifest = manifest(['leaderboard-local']);
    reservedManifest.leaderboards = {
      main: {
        scoreField: reservedScoreField,
        order: 'descending',
        maxEntries: 3,
        retention: 'recent',
      },
    };
    let reservedError = null;
    try {
      await window.NekoMiniGame.connect(reservedManifest, {
        transport: createTransport().transport,
      });
    } catch (error) { reservedError = error; }
    assert(reservedError?.code === 'invalid_manifest',
      `a board declared with scoreField "${reservedScoreField}" connected but can never accept a submission`);
  }

  const bulkHost = createTransport();
  const bulkEntries = [];
  for (let index = 0; index < 64; index += 1) {
    bulkEntries.push({
      id: `entry-${String(index).padStart(4, '0')}`,
      submittedAt: 1700000000000 + index,
      score: index,
      data: { score: index, pad: '' },
    });
  }
  let padBudget = 65536 - JSON.stringify({ version: 1, entries: bulkEntries }).length;
  for (let index = 0; index < bulkEntries.length; index += 1) {
    const share = Math.floor(padBudget / (bulkEntries.length - index));
    bulkEntries[index].data.pad = 'x'.repeat(share);
    padBudget -= share;
  }
  const bulkState = { version: 1, entries: bulkEntries };
  assert(JSON.stringify(bulkState).length === 65536,
    'the full-board fixture was not sized to the exact state byte budget');
  bulkHost.values.set('leaderboards/bulk', bulkState);
  const bulkGame = await window.NekoMiniGame.connect(manifest(['leaderboard-local']), {
    transport: bulkHost.transport,
  });
  const bulkList = await bulkGame.leaderboard.local.list('bulk', { sort: 'rank', limit: 64 });
  assert(bulkList.data.entries.length === 64,
    'a local board sitting at its exact byte budget could not be listed');
  bulkGame.dispose();

  const shared = { values: new Map(), lockTails: new Map() };
  const firstClientHost = createTransport({ shared });
  const secondClientHost = createTransport({ shared });
  const firstClient = await window.NekoMiniGame.connect(manifest(['leaderboard-local']), {
    transport: firstClientHost.transport,
  });
  const secondClient = await window.NekoMiniGame.connect(manifest(['leaderboard-local']), {
    transport: secondClientHost.transport,
  });
  await Promise.all([
    firstClient.leaderboard.local.submit('main', { score: 11, source: 'first' }),
    secondClient.leaderboard.local.submit('main', { score: 22, source: 'second' }),
  ]);
  const crossClient = await firstClient.leaderboard.local.list('main', { sort: 'rank', limit: 10 });
  assert(crossClient.data.entries.map((entry) => entry.score).join(',') === '22,11',
    'cross-client local leaderboard submissions overwrote the same storage snapshot');
  assert(shared.lockTails.size === 0, 'cross-client leaderboard lock remained resident after mutation');
  firstClient.dispose();
  secondClient.dispose();

  const lockWaitHost = createTransport();
  lockWaitHost.setLockPending(true);
  const lockWaitClient = await window.NekoMiniGame.connect(manifest(['leaderboard-local']), {
    transport: lockWaitHost.transport,
  });
  const waitingMutation = lockWaitClient.leaderboard.local.submit('main', { score: 33 })
    .then(() => null, (error) => error);
  await new Promise((resolve) => setImmediate(resolve));
  assert(lockWaitHost.pendingLocks.size === 1 && lockWaitClient.leaderboard.local.pendingCount === 1,
    'waiting local leaderboard lock was not registered as pending SDK work');
  lockWaitClient.dispose();
  const disposedLockError = await waitingMutation;
  assert(disposedLockError?.code === 'disposed',
    'client disposal did not cancel a pending local leaderboard lock');
  assert(lockWaitHost.pendingLocks.size === 0,
    'disposed local leaderboard lock remained resident in the host');

  const timeoutHost = createTransport();
  timeoutHost.setStoragePendingOperation('set');
  const timeoutClient = await window.NekoMiniGame.connect(manifest(['leaderboard-local']), {
    transport: timeoutHost.transport,
  });
  const timedOutMutation = timeoutClient.leaderboard.local.submit(
    'main',
    { score: 44 },
    { timeoutMs: 250 },
  ).then(() => null, (error) => error);
  await new Promise((resolve) => setImmediate(resolve));
  assert(timeoutHost.pending.size === 1,
    'timed local leaderboard mutation did not enter its nested storage request');
  const timeoutError = await timedOutMutation;
  assert(timeoutError?.code === 'timeout',
    'local leaderboard mutation did not report its managed timeout');
  assert(timeoutHost.pending.size === 0,
    'timed-out local leaderboard mutation left its nested storage request resident');
  assert(!timeoutHost.values.has('leaderboards/main'),
    'timed-out local leaderboard mutation committed a late storage write');
  assert(timeoutClient.leaderboard.local.pendingCount === 0,
    'timed-out local leaderboard mutation left SDK pending state resident');
  timeoutHost.setStoragePendingOperation('');
  const recoveredMutation = await timeoutClient.leaderboard.local.submit('main', { score: 45 });
  assert(recoveredMutation.data.entry.score === 45,
    'local leaderboard could not mutate after a timed-out nested storage request');
  timeoutClient.dispose();

  let clearError = null;
  try { await game.leaderboard.local.clear('main'); }
  catch (error) { clearError = error; }
  assert(clearError?.code === 'invalid_request', 'local leaderboard clear did not require confirmation');

  localHost.setStoragePending(true);
  const pendingReads = Array.from({ length: 4 }, () => (
    game.leaderboard.local.list('main').then(() => null, (error) => error)
  ));
  await new Promise((resolve) => setImmediate(resolve));
  let busyError = null;
  try { await game.leaderboard.local.list('main'); }
  catch (error) { busyError = error; }
  assert(busyError?.code === 'busy', 'local leaderboard pending requests were not bounded');
  game.dispose();
  const disposedErrors = await Promise.all(pendingReads);
  assert(disposedErrors.every((error) => error?.code === 'disposed'),
    'local leaderboard dispose did not release pending requests');
  assert(localHost.pending.size === 0, 'local leaderboard host requests remained resident');

  const unavailableHost = createTransport();
  const unavailable = await window.NekoMiniGame.connect({
    ...manifest(['runtime', 'leaderboard-local']),
    optionalCapabilities: ['leaderboard-server'],
  }, { transport: unavailableHost.transport });
  assert(!unavailable.capabilities.has('leaderboard-server'),
    'server leaderboard was granted without a server transport');
  unavailable.dispose();

  const serverHost = createTransport({ server: true });
  const serverGame = await window.NekoMiniGame.connect(
    manifest(['runtime', 'leaderboard-server']),
    { transport: serverHost.transport },
  );
  let earlySubmitError = null;
  try { await serverGame.leaderboard.server.submit('main', { score: 9 }); }
  catch (error) { earlySubmitError = error; }
  assert(earlySubmitError?.code === 'session_invalid',
    'server leaderboard accepted a score before runtime end');
  await serverGame.runtime.start({ mode: 'duel' });
  await serverGame.runtime.end({ score: 9 });
  await serverGame.leaderboard.server.submit('main', { score: 9, mode: 'duel' });
  await serverGame.leaderboard.server.list('main', { limit: 10 });
  await serverGame.leaderboard.server.getMyBest('main', { mode: 'duel' });
  assert(serverHost.serverCalls.map((call) => call.operation).join(',') === 'submit,list,best',
    'server leaderboard facade did not use its reserved transport methods');
  assert(serverHost.serverCalls[0].payload.session_id === 'leaderboard-session',
    'server leaderboard submit did not inject the trusted runtime session');
  serverGame.dispose();

  process.stdout.write('mini-game leaderboard runtime test passed\n');
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
