/**
 * Official mini-game -> host voice-session control bridge.
 *
 * Mini-games may request the existing N.E.K.O microphone session to start or
 * stop, but they never own microphone capture themselves. The host page keeps
 * ownership of MicLease, provider routing, teardown, and the actual micButton
 * flow; this module only carries bounded same-origin control messages.
 */
(function () {
    'use strict';

    var CHANNEL_NAME = 'neko_game_voice_control_channel';
    var STORAGE_KEY = 'neko_game_voice_control_message';
    var STATE_POLL_INTERVAL_MS = 250;
    var COMMAND_TIMEOUT_MS = 12000;
    var senderId = 'host-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 9);
    var S = window.appState;
    var disposed = false;
    var commandInFlight = false;
    var stateTimer = null;
    var lastStateFingerprint = '';
    var storageHandler = null;
    var gameWindowStateHandler = null;
    var transcriptionStateHandler = null;
    var voiceTranscriptHandler = null;
    var channel = null;

    if (!S) {
        console.warn('[GameVoiceControl] appState unavailable; host bridge not started');
        return;
    }

    function currentRoute() {
        return {
            active: S.gameRouteActive === true,
            gameType: String(S.gameRouteGameType || ''),
            sessionId: String(S.gameRouteSessionId || '')
        };
    }

    function currentVoiceState(extra) {
        var route = currentRoute();
        var micButton = document.getElementById('micButton');
        var active = S.isRecording === true;
        var starting = !active && (S.voiceStartPending === true || window.isMicStarting === true);
        var transcriptionMode = String(S.gameVoiceTranscriptionMode || 'unavailable');
        var transcriptionProvider = String(S.gameVoiceTranscriptionProvider || '');
        var transcriptionReady = active && S.gameVoiceTranscriptionReady === true;
        var transcriptionReason = String(S.gameVoiceTranscriptionReason || '');
        if ((active || starting) && transcriptionMode === 'unavailable' && S.voiceInputRouteBlocked !== true) {
            transcriptionMode = 'backend_pending';
            transcriptionProvider = '';
            transcriptionReady = false;
            transcriptionReason = 'route_resolving';
        }
        if (!route.active || (!active && !starting)) {
            transcriptionMode = 'unavailable';
            transcriptionProvider = '';
            transcriptionReady = false;
            transcriptionReason = route.active ? 'voice_inactive' : 'route_inactive';
        }
        return Object.assign({
            type: 'game_voice_control_state',
            sender_id: senderId,
            timestamp: Date.now(),
            available: route.active && !!micButton && typeof window.stopMicCapture === 'function',
            route_active: route.active,
            game_type: route.gameType,
            session_id: route.sessionId,
            active: active,
            starting: starting,
            muted: S.isMicMuted === true,
            busy: commandInFlight,
            capture_owner: 'host',
            transcription_mode: transcriptionMode,
            provider: transcriptionProvider,
            ready: transcriptionReady,
            transcription_reason: transcriptionReason
        }, extra || {});
    }

    function postMessage(payload, ephemeral) {
        if (disposed) return false;
        if (channel) {
            try {
                channel.postMessage(payload);
                return true;
            } catch (error) {
                console.warn('[GameVoiceControl] BroadcastChannel post failed; falling back:', error);
                try { channel.close(); } catch (_) { /* unusable channel */ }
                channel = null;
            }
        }
        try {
            var serialized = JSON.stringify(Object.assign({
                storage_nonce: Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
            }, payload || {}));
            localStorage.setItem(STORAGE_KEY, serialized);
            if (ephemeral) {
                localStorage.removeItem(STORAGE_KEY);
                return true;
            }
            setTimeout(function () {
                try {
                    if (localStorage.getItem(STORAGE_KEY) === serialized) {
                        localStorage.removeItem(STORAGE_KEY);
                    }
                } catch (_) {}
            }, 0);
            return true;
        } catch (error) {
            console.warn('[GameVoiceControl] state transport unavailable:', error);
            return false;
        }
    }

    function broadcastState(extra, force) {
        var state = currentVoiceState(extra);
        var fingerprint = JSON.stringify([
            state.available,
            state.route_active,
            state.game_type,
            state.session_id,
            state.active,
            state.starting,
            state.muted,
            state.busy,
            state.capture_owner,
            state.transcription_mode,
            state.provider,
            state.ready,
            state.transcription_reason,
            state.ok,
            state.reason,
            state.request_id
        ]);
        if (!force && fingerprint === lastStateFingerprint) return state;
        lastStateFingerprint = fingerprint;
        postMessage(state);
        return state;
    }

    function routeMatches(request) {
        var route = currentRoute();
        if (!route.active) return false;
        if (String(request.game_type || '') !== route.gameType) return false;
        var requestedSessionId = String(request.session_id || '');
        return !requestedSessionId || !route.sessionId || requestedSessionId === route.sessionId;
    }

    function voiceStartSettled() {
        return S.isRecording === true || (
            S.voiceStartPending !== true
            && window.isMicStarting !== true
            && !document.getElementById('micButton')?.classList.contains('active')
        );
    }

    function voiceStopSettled() {
        return S.isRecording !== true
            && S.voiceStartPending !== true
            && window.isMicStarting !== true;
    }

    async function waitFor(predicate, timeoutMs) {
        var deadline = Date.now() + timeoutMs;
        while (!disposed && Date.now() < deadline) {
            if (predicate()) return true;
            await new Promise(function (resolve) { setTimeout(resolve, 50); });
        }
        return predicate();
    }

    async function startOfficialVoiceSession() {
        if (S.isRecording === true) return true;
        if (S.voiceStartPending === true || window.isMicStarting === true) {
            await waitFor(voiceStartSettled, COMMAND_TIMEOUT_MS);
            return S.isRecording === true;
        }
        var micButton = document.getElementById('micButton');
        if (!micButton || micButton.disabled) return false;
        micButton.click();
        await waitFor(voiceStartSettled, COMMAND_TIMEOUT_MS);
        return S.isRecording === true;
    }

    async function stopOfficialVoiceSession() {
        if (voiceStopSettled()) return true;
        if (typeof window.stopMicCapture !== 'function') return false;
        await Promise.resolve(window.stopMicCapture());
        await waitFor(voiceStopSettled, COMMAND_TIMEOUT_MS);
        return voiceStopSettled();
    }

    async function handleRequest(request) {
        if (disposed || !request || request.type !== 'game_voice_control_request') return;
        if (request.sender_id === senderId) return;
        var action = String(request.action || 'query');
        var requestId = String(request.request_id || '');
        if (!['query', 'start', 'stop', 'toggle'].includes(action)) return;

        if (!routeMatches(request)) {
            broadcastState({ ok: false, reason: 'route_mismatch', request_id: requestId }, true);
            return;
        }
        if (action === 'query') {
            broadcastState({ ok: true, reason: 'state', request_id: requestId }, true);
            return;
        }
        if (commandInFlight) {
            broadcastState({ ok: false, reason: 'busy', request_id: requestId }, true);
            return;
        }

        commandInFlight = true;
        broadcastState({ ok: true, reason: 'working', request_id: requestId }, true);
        try {
            var effectiveAction = action === 'toggle'
                ? ((S.isRecording === true || S.voiceStartPending === true || window.isMicStarting === true) ? 'stop' : 'start')
                : action;
            var ok = effectiveAction === 'start'
                ? await startOfficialVoiceSession()
                : await stopOfficialVoiceSession();
            broadcastState({
                ok: ok,
                reason: ok ? (effectiveAction === 'start' ? 'started' : 'stopped') : (effectiveAction + '_failed'),
                request_id: requestId
            }, true);
        } catch (error) {
            console.warn('[GameVoiceControl] host command failed:', error);
            broadcastState({ ok: false, reason: 'command_failed', request_id: requestId }, true);
        } finally {
            commandInFlight = false;
            broadcastState({}, true);
        }
    }

    function acceptMessage(message) {
        void handleRequest(message);
    }

    try {
        if (typeof BroadcastChannel === 'function') {
            channel = new BroadcastChannel(CHANNEL_NAME);
            channel.onmessage = function (event) { acceptMessage(event && event.data); };
        }
    } catch (error) {
        channel = null;
        console.warn('[GameVoiceControl] BroadcastChannel unavailable; using localStorage fallback:', error);
    }

    // Always listen to the fallback path. Different Electron webviews can
    // disagree about BroadcastChannel availability during reload; listening
    // on both sides keeps that partial-failure case usable without posting the
    // same command twice.
    storageHandler = function (event) {
        if (!event || event.key !== STORAGE_KEY || !event.newValue) return;
        try { acceptMessage(JSON.parse(event.newValue)); }
        catch (_) {}
    };
    window.addEventListener('storage', storageHandler);

    // app-websocket's reconnect reconciliation dispatches this event from an
    // authoritative /api/game/route/active read. Mirror it into appState so a
    // host page reloaded after the game opened can still accept voice control.
    gameWindowStateHandler = function (event) {
        var detail = event && event.detail ? event.detail : {};
        var action = String(detail.action || '');
        var incomingSessionId = String(detail.sessionId || '');
        if (action === 'opened') {
            S.gameRouteActive = true;
            S.gameRouteGameType = String(detail.gameType || '');
            S.gameRouteLanlanName = String(detail.lanlanName || '');
            S.gameRouteSessionId = incomingSessionId;
        } else if (action === 'closed') {
            var currentSessionId = String(S.gameRouteSessionId || '');
            if (incomingSessionId && currentSessionId && incomingSessionId !== currentSessionId) return;
            S.gameRouteActive = false;
            S.gameRouteGameType = '';
            S.gameRouteLanlanName = '';
            S.gameRouteSessionId = '';
        } else {
            return;
        }
        broadcastState({}, true);
    };
    window.addEventListener('neko-game-window-state-change', gameWindowStateHandler);

    transcriptionStateHandler = function () {
        broadcastState({}, true);
    };
    window.addEventListener(
        'neko-game-voice-transcription-state-change',
        transcriptionStateHandler
    );

    // app-websocket emits this only for a non-empty final transcript. Relay
    // the normalized host result to the active game session; games never see
    // provider responses or microphone audio through this bridge.
    voiceTranscriptHandler = function (event) {
        var route = currentRoute();
        var detail = event && event.detail ? event.detail : {};
        var transcript = String(detail.text || '').trim();
        if (!route.active || !transcript) return;
        postMessage({
            type: 'game_voice_transcript',
            sender_id: senderId,
            timestamp: Date.now(),
            game_type: route.gameType,
            session_id: route.sessionId,
            request_id: String(detail.requestId || ''),
            source: String(detail.source || 'voice'),
            text: transcript
        }, true);
    };
    window.addEventListener('neko:user-voice-content-received', voiceTranscriptHandler);

    function dispose() {
        if (disposed) return;
        disposed = true;
        if (stateTimer) {
            clearInterval(stateTimer);
            stateTimer = null;
        }
        if (storageHandler) {
            window.removeEventListener('storage', storageHandler);
            storageHandler = null;
        }
        if (gameWindowStateHandler) {
            window.removeEventListener('neko-game-window-state-change', gameWindowStateHandler);
            gameWindowStateHandler = null;
        }
        if (transcriptionStateHandler) {
            window.removeEventListener(
                'neko-game-voice-transcription-state-change',
                transcriptionStateHandler
            );
            transcriptionStateHandler = null;
        }
        if (voiceTranscriptHandler) {
            window.removeEventListener('neko:user-voice-content-received', voiceTranscriptHandler);
            voiceTranscriptHandler = null;
        }
        if (channel) {
            channel.onmessage = null;
            try { channel.close(); } catch (_) {}
            channel = null;
        }
        window.removeEventListener('pagehide', dispose);
        window.removeEventListener('beforeunload', dispose);
    }

    stateTimer = setInterval(function () { broadcastState({}, false); }, STATE_POLL_INTERVAL_MS);
    window.addEventListener('pagehide', dispose);
    window.addEventListener('beforeunload', dispose);
    broadcastState({}, true);
})();
