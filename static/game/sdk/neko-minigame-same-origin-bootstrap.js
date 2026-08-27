/**
 * Trusted page-host bootstrap for the first-phase same-origin mini-game host.
 *
 * Load this before any game bundle. The N.E.K.O page host supplies reviewed
 * registrations (from its server registry or an explicit local-development
 * configuration); this helper installs the bounded one-shot handoff and then
 * loads the internal adapter. Game code receives only the resulting factory.
 */
(() => {
  'use strict';

  const REGISTRATION_LIMIT = 64;
  const CAPABILITY_LIMIT = 32;
  const DEFAULT_ADAPTER_URL = '/static/game/sdk/neko-minigame-same-origin-host.js';
  let bootstrapPromise = null;

  function normalizeRegistrations(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return Object.freeze({});
    const result = {};
    for (const [rawKey, rawRegistration] of Object.entries(value)) {
      if (Object.keys(result).length >= REGISTRATION_LIMIT) break;
      if (!rawRegistration || typeof rawRegistration !== 'object' || Array.isArray(rawRegistration)) continue;
      const gameId = String(rawRegistration.gameId || '').trim();
      const version = String(rawRegistration.version || '').trim();
      const mode = String(rawRegistration.mode || '').trim();
      if (
        !gameId
        || gameId !== String(rawKey || '').trim()
        || gameId.length > 128
        || !version
        || version.length > 64
        || !['registered', 'development'].includes(mode)
      ) continue;
      const allowedCapabilities = Object.freeze([
        ...new Set(
          (Array.isArray(rawRegistration.allowedCapabilities)
            ? rawRegistration.allowedCapabilities
            : [])
            .map((name) => String(name || '').trim())
            .filter((name) => Boolean(name) && name.length <= 64),
        ),
      ].slice(0, CAPABILITY_LIMIT));
      const rawProviders = rawRegistration.capabilityProviders;
      const capabilityProviders = Object.freeze({
        quickLines: typeof rawProviders?.quickLines === 'function'
          ? rawProviders.quickLines
          : null,
      });
      result[gameId] = Object.freeze({
        mode,
        gameId,
        publisherId: String(rawRegistration.publisherId || '').trim().slice(0, 128),
        version,
        allowedCapabilities,
        capabilityProviders,
      });
    }
    return Object.freeze(result);
  }

  function loadAdapterScript(adapterUrl, documentImpl) {
    return new Promise((resolve, reject) => {
      if (!documentImpl?.createElement || !documentImpl?.head?.appendChild) {
        reject(new Error('MINIGAME_HOST_DOCUMENT_UNAVAILABLE'));
        return;
      }
      const script = documentImpl.createElement('script');
      script.src = adapterUrl;
      script.async = false;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error('MINIGAME_HOST_ADAPTER_LOAD_FAILED'));
      documentImpl.head.appendChild(script);
    });
  }

  window.bootstrapNekoMiniGameSameOriginHost = function bootstrapNekoMiniGameSameOriginHost(
    options = {},
  ) {
    if (bootstrapPromise) return bootstrapPromise;
    const registrations = normalizeRegistrations(options.registrations);
    const adapterUrl = String(options.adapterUrl || DEFAULT_ADAPTER_URL);
    const loadAdapter = typeof options.loadAdapter === 'function'
      ? options.loadAdapter
      : () => loadAdapterScript(adapterUrl, options.documentImpl || window.document);
    bootstrapPromise = (async () => {
      window.__NEKO_MINIGAME_HOST_LAUNCH_REGISTRY__ = registrations;
      try {
        await loadAdapter(adapterUrl);
        if (typeof window.createNekoMiniGameSameOriginHost !== 'function') {
          throw new Error('MINIGAME_HOST_ADAPTER_FACTORY_MISSING');
        }
        return window.createNekoMiniGameSameOriginHost;
      } finally {
        try { delete window.__NEKO_MINIGAME_HOST_LAUNCH_REGISTRY__; }
        catch (_) { window.__NEKO_MINIGAME_HOST_LAUNCH_REGISTRY__ = undefined; }
        window.bootstrapNekoMiniGameSameOriginHost = undefined;
      }
    })();
    return bootstrapPromise;
  };
})();
