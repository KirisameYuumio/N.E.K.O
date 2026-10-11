/** Model-manager preview capability. One pending load, one failure; no request registry. */
(function () {
    'use strict';
    function canonicalUrl(value) {
        if (!value) return '';
        const url = new URL(value, window.location.href);
        return url.origin === window.location.origin ? url.href : '';
    }

    window.createVrmEmotionSource = function ({ getManager, getSelectedUrl, isLoading, loadModel }) {
        let pending = null;
        let failure = null;
        let disposed = false;

        function snapshot(modelUrl) {
            const manager = getManager();
            if (disposed) return { state: 'failed', errorCode: 'sourceUnavailable' };
            if (pending || isLoading()) return { state: 'loading', modelUrl };
            if (failure?.modelUrl === modelUrl && failure.loadToken === manager?._activeLoadToken) {
                return { state: 'failed', ...failure };
            }
            if (canonicalUrl(getSelectedUrl()) !== modelUrl
                || canonicalUrl(manager?.currentModel?.url) !== modelUrl
                || !manager?._isModelReadyForInteraction
                || manager._isDisposed || !manager.currentModel?.vrm) return null;
            const expressions = manager.expression.getExpressionList();
            return { state: 'ready', modelUrl, loadToken: manager._activeLoadToken, expressions: [...expressions] };
        }

        function request(info, force = false) {
            const modelUrl = canonicalUrl(info?.url);
            if (!modelUrl) return { state: 'failed', errorCode: 'invalidModel' };
            const current = snapshot(modelUrl);
            if (current?.state === 'loading' || disposed) return current;
            if (current && !force) return current;
            failure = null;
            const job = { modelUrl };
            pending = job;
            // A replaced client polls for its new selection; it never queues another load.
            Promise.resolve().then(() => loadModel(info)).then(result => {
                if (disposed || pending !== job) return;
                if (result?.error) throw new Error(result.error);
                const manager = getManager();
                if (canonicalUrl(getSelectedUrl()) !== modelUrl
                    || canonicalUrl(manager?.currentModel?.url) !== modelUrl || !manager?._isModelReadyForInteraction) {
                    throw new Error(window.t ? window.t('vrmEmotionManager.modelLoadFailed') : '所选模型未成功加载，请重试');
                }
            }).catch(error => {
                if (!disposed && pending === job) failure = {
                    modelUrl, loadToken: getManager()?._activeLoadToken,
                    error: error.message, errorCode: 'modelLoadFailed'
                };
            }).finally(() => { if (pending === job) pending = null; });
            return { state: 'loading', modelUrl };
        }

        function isCurrent(value) {
            if (!value || disposed) return false;
            const current = snapshot(value.modelUrl);
            return current?.state === 'ready' && current.loadToken === value.loadToken;
        }

        function preview(value, expression) {
            if (!isCurrent(value)) return false;
            const manager = getManager();
            if (expression !== 'neutral' && !manager.expression.getExpressionList().includes(expression)) return false;
            manager.expression.setBaseExpression(expression);
            return true;
        }

        function dispose() {
            disposed = true;
            pending = null;
            failure = null;
            window.removeEventListener('pagehide', dispose);
        }
        window.addEventListener('pagehide', dispose);
        return { request, isCurrent, preview, dispose };
    };
})();
