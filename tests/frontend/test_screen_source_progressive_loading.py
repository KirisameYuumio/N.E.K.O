from pathlib import Path

import pytest
from playwright.sync_api import Page


ROOT = Path(__file__).resolve().parents[2]
APP_SCREEN = ROOT / "static" / "app" / "app-screen.js"
DESKTOP_CAPTURE_PROVIDER = ROOT / "static" / "app" / "desktop-capture-provider.js"


def _install_screen_source_harness(
    page: Page,
    *,
    thumbnail_timeout_ms: int = 15_000,
    source_enumeration_may_prompt: bool = False,
    initial_storage: dict[str, str] | None = None,
) -> None:
    page.set_content(
        '<div id="live2d-popup-screen" '
        'style="display:flex;opacity:1"></div>'
    )
    page.evaluate(
        """(options) => {
            const storedValues = new Map(Object.entries(options.initialStorage));
            Object.defineProperty(window, 'localStorage', {
                configurable: true,
                value: {
                    getItem(key) {
                        return storedValues.has(key) ? storedValues.get(key) : null;
                    },
                    setItem(key, value) {
                        storedValues.set(key, String(value));
                    },
                    removeItem(key) {
                        storedValues.delete(key);
                    },
                },
            });
            window.__storedValues = storedValues;
            window.appState = { selectedScreenSourceId: null };
            window.appConst = {
                SCREEN_SOURCE_THUMBNAIL_TIMEOUT: options.thumbnailTimeoutMs,
            };
            window.appUtils = { isMobile: () => false };
            window.safeT = (_key, fallback) => fallback;
            window.t = (key, options = {}) => {
                if (key === 'app.screenSource.loading') return 'Loading...';
                if (key === 'app.screenSource.screenLabel') {
                    return `Screen ${options.index}`;
                }
                if (key === 'app.screenSource.titleFilterPlaceholder') {
                    return 'Filter window titles';
                }
                if (key === 'app.screenSource.titleFilterAriaLabel') {
                    return 'Filter windows by title';
                }
                if (key === 'app.screenSource.noWindowMatches') {
                    return 'No matching windows';
                }
                return key;
            };
            window.showStatusToast = () => {};
            window.__captureCalls = [];
            window.__metadataThumbnailReads = 0;
            window.__thumbnailResolve = null;
            const thumbnailPromise = new Promise((resolve) => {
                window.__thumbnailResolve = resolve;
            });
            const emptyMetadataThumbnail = {
                isEmpty() { return true; },
                toDataURL() {
                    window.__metadataThumbnailReads += 1;
                    return '';
                },
            };
            window.__metadataSources = [
                { id: 'screen:1', name: 'Entire Screen', display_id: '1', thumbnail: emptyMetadataThumbnail },
                { id: 'window:2', name: 'Editor', display_id: '', thumbnail: emptyMetadataThumbnail },
            ];
            window.__selectedSourceCalls = [];
            window.__desktopProvider = {
                sourceEnumerationMayPrompt: options.sourceEnumerationMayPrompt,
                getSources(options) {
                    window.__captureCalls.push(options);
                    if (options.thumbnailSize.width === 0) {
                        return Promise.resolve(window.__metadataSources);
                    }
                    return thumbnailPromise;
                },
                setSelectedSource(sourceId) {
                    window.__selectedSourceCalls.push(sourceId);
                    return Promise.resolve();
                },
            };
            window.electronDesktopCapturer = window.__desktopProvider;
        }""",
        {
            "thumbnailTimeoutMs": thumbnail_timeout_ms,
            "sourceEnumerationMayPrompt": source_enumeration_may_prompt,
            "initialStorage": initial_storage or {},
        },
    )
    page.add_script_tag(path=str(DESKTOP_CAPTURE_PROVIDER))
    page.add_script_tag(path=str(APP_SCREEN))


@pytest.mark.frontend
def test_screen_source_names_render_before_cached_thumbnails(page: Page) -> None:
    _install_screen_source_harness(page)

    rendered = page.evaluate(
        """async () => window.renderFloatingScreenSourceList(
            document.getElementById('live2d-popup-screen')
        )"""
    )
    assert rendered is True
    page.wait_for_function("window.__captureCalls.length === 2")

    before_thumbnails = page.evaluate(
        """() => ({
            labels: Array.from(document.querySelectorAll('.screen-source-option span'))
                .map((node) => node.textContent),
            loadingCount: document.querySelectorAll(
                '.screen-source-thumbnail-loading'
            ).length,
            imageCount: document.querySelectorAll(
                '.screen-source-thumbnail-ready img'
            ).length,
            metadataThumbnailReads: window.__metadataThumbnailReads,
            calls: window.__captureCalls,
        })"""
    )
    assert before_thumbnails == {
        "labels": ["Screen 1", "Editor"],
        "loadingCount": 2,
        "imageCount": 0,
        "metadataThumbnailReads": 0,
        "calls": [
            {
                "types": ["window", "screen"],
                "thumbnailSize": {"width": 0, "height": 0},
            },
            {
                "types": ["window", "screen"],
                "thumbnailSize": {"width": 160, "height": 100},
                "thumbnailCache": True,
            },
        ],
    }

    page.evaluate(
        """() => window.__thumbnailResolve([
            {
                id: 'screen:1',
                name: 'Entire Screen',
                display_id: '1',
                thumbnail: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
            },
            {
                id: 'window:2',
                name: 'Editor',
                display_id: '',
                thumbnail: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
            },
            {
                id: 'window:stale',
                name: 'Closed Window',
                display_id: '',
                thumbnail: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
            },
        ])"""
    )
    page.wait_for_function(
        "document.querySelectorAll('.screen-source-thumbnail-ready img').length === 2"
    )

    after_thumbnails = page.evaluate(
        """() => ({
            optionCount: document.querySelectorAll('.screen-source-option').length,
            loadingCount: document.querySelectorAll(
                '.screen-source-thumbnail-loading'
            ).length,
            imageCount: document.querySelectorAll(
                '.screen-source-thumbnail-ready img'
            ).length,
        })"""
    )
    assert after_thumbnails == {
        "optionCount": 2,
        "loadingCount": 0,
        "imageCount": 2,
    }


@pytest.mark.frontend
def test_screen_source_hung_thumbnail_request_falls_back_after_timeout(
    page: Page,
) -> None:
    _install_screen_source_harness(page, thumbnail_timeout_ms=25)

    rendered = page.evaluate(
        """async () => window.renderFloatingScreenSourceList(
            document.getElementById('live2d-popup-screen')
        )"""
    )
    assert rendered is True
    page.wait_for_function(
        "document.querySelectorAll('.screen-source-thumbnail-fallback').length === 2"
    )

    state = page.evaluate(
        """() => ({
            calls: window.__captureCalls,
            loadingCount: document.querySelectorAll(
                '.screen-source-thumbnail-loading'
            ).length,
            fallbackCount: document.querySelectorAll(
                '.screen-source-thumbnail-fallback'
            ).length,
        })"""
    )
    assert state == {
        "calls": [
            {
                "types": ["window", "screen"],
                "thumbnailSize": {"width": 0, "height": 0},
            },
            {
                "types": ["window", "screen"],
                "thumbnailSize": {"width": 160, "height": 100},
                "thumbnailCache": True,
            },
        ],
        "loadingCount": 0,
        "fallbackCount": 2,
    }


@pytest.mark.frontend
def test_window_title_filter_is_local_and_keeps_screens_visible(page: Page) -> None:
    _install_screen_source_harness(page, source_enumeration_may_prompt=True)
    page.evaluate(
        """() => {
            window.__metadataSources.push({
                id: 'window:3',
                name: 'Browser Preview',
                display_id: '',
                thumbnail: null,
            });
        }"""
    )

    assert page.evaluate(
        """async () => window.renderFloatingScreenSourceList(
            document.getElementById('live2d-popup-screen')
        )"""
    ) is True

    result = page.evaluate(
        """() => {
            const input = document.querySelector('.screen-source-title-filter');
            input.value = '  EDIT  ';
            input.dispatchEvent(new Event('input', { bubbles: true }));
            const filtered = Object.fromEntries(
                Array.from(document.querySelectorAll('.screen-source-option'))
                    .map((option) => [option.dataset.sourceName, option.hidden])
            );
            const editorDisplay = getComputedStyle(document.querySelector(
                '.screen-source-option[data-source-id="window:2"]'
            )).display;
            const browserDisplay = getComputedStyle(document.querySelector(
                '.screen-source-option[data-source-id="window:3"]'
            )).display;
            input.value = 'missing title';
            input.dispatchEvent(new Event('input', { bubbles: true }));
            return {
                filtered,
                editorDisplay,
                browserDisplay,
                filterBeforeScreens: Boolean(
                    input.compareDocumentPosition(document.querySelector(
                        '.screen-source-screen-label'
                    )) & Node.DOCUMENT_POSITION_FOLLOWING
                ),
                screenHiddenAfterNoMatch: document.querySelector(
                    '.screen-source-option[data-source-id="screen:1"]'
                ).hidden,
                noMatchHidden: document.querySelector(
                    '.screen-source-no-window-matches'
                ).hidden,
                filterPlaceholderI18n: input.getAttribute(
                    'data-i18n-placeholder'
                ),
                filterAriaI18n: input.getAttribute('data-i18n-aria'),
                noMatchI18n: document.querySelector(
                    '.screen-source-no-window-matches'
                ).getAttribute('data-i18n'),
                captureCalls: window.__captureCalls,
            };
        }"""
    )
    assert result == {
        "filtered": {
            "Entire Screen": False,
            "Editor": False,
            "Browser Preview": True,
        },
        "editorDisplay": "flex",
        "browserDisplay": "none",
        "filterBeforeScreens": True,
        "screenHiddenAfterNoMatch": False,
        "noMatchHidden": False,
        "filterPlaceholderI18n": "app.screenSource.titleFilterPlaceholder",
        "filterAriaI18n": "app.screenSource.titleFilterAriaLabel",
        "noMatchI18n": "app.screenSource.noWindowMatches",
        "captureCalls": [
            {
                "types": ["window", "screen"],
                "thumbnailSize": {"width": 0, "height": 0},
            }
        ],
    }


@pytest.mark.frontend
def test_remembered_title_restores_only_one_normalized_exact_match(
    page: Page,
) -> None:
    _install_screen_source_harness(
        page,
        source_enumeration_may_prompt=True,
        initial_storage={
            "screenSourceTitleMatchEnabled": "true",
            "selectedScreenWindowTitle": "EDITOR",
            "selectedScreenSourceId": "window:stale",
        },
    )
    page.evaluate(
        """() => {
            window.__metadataSources[1].id = 'window:new';
            window.__metadataSources[1].name = '  Editor  ';
        }"""
    )

    assert page.evaluate(
        """async () => window.renderFloatingScreenSourceList(
            document.getElementById('live2d-popup-screen')
        )"""
    ) is True

    result = page.evaluate(
        """() => ({
            selectedId: window.appState.selectedScreenSourceId,
            storedId: window.__storedValues.get('selectedScreenSourceId'),
            rememberedTitle: window.__storedValues.get('selectedScreenWindowTitle'),
            selectedSourceCalls: window.__selectedSourceCalls,
            selectedOptions: Array.from(document.querySelectorAll(
                '.screen-source-option.selected'
            )).map((option) => option.dataset.sourceId),
        })"""
    )
    assert result == {
        "selectedId": "window:new",
        "storedId": "window:new",
        "rememberedTitle": "EDITOR",
        "selectedSourceCalls": ["window:stale", "window:new"],
        "selectedOptions": ["window:new"],
    }


@pytest.mark.frontend
def test_remembered_title_normalizes_unicode_composition(page: Page) -> None:
    _install_screen_source_harness(
        page,
        source_enumeration_may_prompt=True,
        initial_storage={
            "screenSourceTitleMatchEnabled": "true",
            "selectedScreenWindowTitle": "Caf\u00e9",
            "selectedScreenSourceId": "window:stale",
        },
    )
    page.evaluate(
        """() => {
            window.__metadataSources[1].id = 'window:unicode';
            window.__metadataSources[1].name = 'Cafe\u0301';
        }"""
    )

    assert page.evaluate(
        """async () => window.renderFloatingScreenSourceList(
            document.getElementById('live2d-popup-screen')
        )"""
    ) is True
    assert page.evaluate("window.appState.selectedScreenSourceId") == (
        "window:unicode"
    )


@pytest.mark.frontend
def test_remembered_title_does_not_guess_between_duplicate_windows(
    page: Page,
) -> None:
    _install_screen_source_harness(
        page,
        source_enumeration_may_prompt=True,
        initial_storage={
            "screenSourceTitleMatchEnabled": "true",
            "selectedScreenWindowTitle": "Editor",
            "selectedScreenSourceId": "window:stale",
        },
    )
    page.evaluate(
        """() => {
            window.__metadataSources.push({
                id: 'window:3',
                name: ' editor ',
                display_id: '',
                thumbnail: null,
            });
        }"""
    )

    assert page.evaluate(
        """async () => window.renderFloatingScreenSourceList(
            document.getElementById('live2d-popup-screen')
        )"""
    ) is True

    result = page.evaluate(
        """() => ({
            selectedId: window.appState.selectedScreenSourceId,
            hasStoredId: window.__storedValues.has('selectedScreenSourceId'),
            rememberedTitle: window.__storedValues.get('selectedScreenWindowTitle'),
            selectedSourceCalls: window.__selectedSourceCalls,
        })"""
    )
    assert result == {
        "selectedId": None,
        "hasStoredId": False,
        "rememberedTitle": "Editor",
        "selectedSourceCalls": ["window:stale", None],
    }


@pytest.mark.frontend
def test_current_session_selection_survives_later_duplicate_title(
    page: Page,
) -> None:
    _install_screen_source_harness(page, source_enumeration_may_prompt=True)
    assert page.evaluate(
        """async () => window.renderFloatingScreenSourceList(
            document.getElementById('live2d-popup-screen')
        )"""
    ) is True

    result = page.evaluate(
        """async () => {
            document.querySelector(
                '.screen-source-option[data-source-id="window:2"]'
            ).click();
            await new Promise((resolve) => setTimeout(resolve, 0));
            window.setScreenSourceTitleMatchEnabled(true);
            window.__metadataSources.push({
                id: 'window:duplicate',
                name: ' editor ',
                display_id: '',
                thumbnail: null,
            });
            await window.renderFloatingScreenSourceList(
                document.getElementById('live2d-popup-screen')
            );
            return {
                selectedId: window.appState.selectedScreenSourceId,
                storedId: window.__storedValues.get('selectedScreenSourceId'),
                selectedOptions: Array.from(document.querySelectorAll(
                    '.screen-source-option.selected'
                )).map((option) => option.dataset.sourceId),
            };
        }"""
    )
    assert result == {
        "selectedId": "window:2",
        "storedId": "window:2",
        "selectedOptions": ["window:2"],
    }


@pytest.mark.frontend
def test_capture_resolution_restores_once_then_reuses_session_trust(
    page: Page,
) -> None:
    _install_screen_source_harness(
        page,
        initial_storage={
            "screenSourceTitleMatchEnabled": "true",
            "selectedScreenWindowTitle": "Editor",
            "selectedScreenSourceId": "window:stale",
        },
    )
    page.evaluate(
        """() => {
            window.__metadataSources[1].id = 'window:current';
        }"""
    )

    result = page.evaluate(
        """async () => {
            const first = await window.appScreen
                .reconcileRememberedWindowSourceForCapture(
                    window.__desktopProvider
                );
            const second = await window.appScreen
                .reconcileRememberedWindowSourceForCapture(
                    window.__desktopProvider
                );
            return {
                firstStatus: first.status,
                secondStatus: second.status,
                selectedId: window.appState.selectedScreenSourceId,
                captureCalls: window.__captureCalls,
            };
        }"""
    )
    assert result == {
        "firstStatus": "matched",
        "secondStatus": "trusted-current",
        "selectedId": "window:current",
        "captureCalls": [
            {
                "types": ["window", "screen"],
                "thumbnailSize": {"width": 0, "height": 0},
            }
        ],
    }


@pytest.mark.frontend
def test_prompt_required_remembered_window_blocks_only_automatic_capture(
    page: Page,
) -> None:
    _install_screen_source_harness(
        page,
        source_enumeration_may_prompt=True,
        initial_storage={
            "screenSourceTitleMatchEnabled": "true",
            "selectedScreenWindowTitle": "Editor",
            "selectedScreenSourceId": "window:stale",
        },
    )

    result = page.evaluate(
        """async () => {
            const resolution = await window.appScreen
                .reconcileRememberedWindowSourceForCapture(
                    window.__desktopProvider,
                    { forceValidation: true }
                );
            return {
                status: resolution.status,
                hadRememberedTitle: resolution.hadRememberedTitle,
                blocksAutomatic: window.appScreen
                    .rememberedWindowResolutionBlocksAutomaticCapture(resolution),
                needsManualSelection: window.appScreen
                    .rememberedWindowResolutionNeedsSelection(resolution),
                captureCalls: window.__captureCalls,
            };
        }"""
    )
    assert result == {
        "status": "prompt-required",
        "hadRememberedTitle": True,
        "blocksAutomatic": True,
        "needsManualSelection": False,
        "captureCalls": [],
    }


@pytest.mark.frontend
def test_required_remembered_window_stream_does_not_fall_back_after_source_closes(
    page: Page,
) -> None:
    _install_screen_source_harness(
        page,
        initial_storage={
            "screenSourceTitleMatchEnabled": "true",
            "selectedScreenWindowTitle": "Editor",
            "selectedScreenSourceId": "window:2",
        },
    )

    result = page.evaluate(
        """async () => {
            const initial = await window.appScreen
                .reconcileRememberedWindowSourceForCapture(
                    window.__desktopProvider,
                    { forceValidation: true }
                );
            window.__metadataSources = window.__metadataSources.filter(
                (source) => source.id !== 'window:2'
            );
            window.__thumbnailResolve(window.__metadataSources);
            window.__cachedTrackStopped = false;
            const endedTrack = {
                readyState: 'ended',
                stop() { window.__cachedTrackStopped = true; },
            };
            window.appState.screenCaptureStream = {
                active: true,
                getTracks: () => [endedTrack],
                getVideoTracks: () => [endedTrack],
            };
            let getUserMediaCalls = 0;
            Object.defineProperty(navigator, 'mediaDevices', {
                configurable: true,
                value: {
                    getUserMedia() {
                        getUserMediaCalls += 1;
                        throw new Error('must not capture a fallback screen');
                    },
                },
            });

            const stream = await window.appScreen.acquireOrReuseCachedStream({
                allowPrompt: false,
                requiredSourceId: initial.sourceId,
            });
            return {
                initialStatus: initial.status,
                streamIsNull: stream === null,
                selectedId: window.appState.selectedScreenSourceId,
                cachedTrackStopped: window.__cachedTrackStopped,
                getUserMediaCalls,
                captureCalls: window.__captureCalls,
            };
        }"""
    )
    assert result == {
        "initialStatus": "matched",
        "streamIsNull": True,
        "selectedId": None,
        "cachedTrackStopped": True,
        "getUserMediaCalls": 0,
        "captureCalls": [
            {
                "types": ["window", "screen"],
                "thumbnailSize": {"width": 0, "height": 0},
            },
            {
                "types": ["window", "screen"],
                "thumbnailSize": {"width": 1, "height": 1},
            },
        ],
    }


@pytest.mark.frontend
def test_derived_remembered_window_constraint_returns_reselection_after_source_closes(
    page: Page,
) -> None:
    _install_screen_source_harness(
        page,
        initial_storage={
            "screenSourceTitleMatchEnabled": "true",
            "selectedScreenWindowTitle": "Editor",
            "selectedScreenSourceId": "window:2",
        },
    )

    result = page.evaluate(
        """async () => {
            const initial = await window.appScreen
                .reconcileRememberedWindowSourceForCapture(
                    window.__desktopProvider,
                    { forceValidation: true }
                );
            window.__metadataSources = window.__metadataSources.filter(
                (source) => source.id !== 'window:2'
            );
            window.__thumbnailResolve(window.__metadataSources);
            let getUserMediaCalls = 0;
            let getDisplayMediaCalls = 0;
            Object.defineProperty(navigator, 'mediaDevices', {
                configurable: true,
                value: {
                    getUserMedia() {
                        getUserMediaCalls += 1;
                        throw new Error('must not capture a fallback screen');
                    },
                    getDisplayMedia() {
                        getDisplayMediaCalls += 1;
                        throw new Error('must not open a fallback picker');
                    },
                },
            });

            const stream = await window.appScreen.acquireOrReuseCachedStream({
                allowPrompt: true,
            });
            return {
                initialStatus: initial.status,
                rememberedWindowUnavailable: Boolean(
                    stream && stream.rememberedWindowUnavailable
                ),
                selectedId: window.appState.selectedScreenSourceId,
                getUserMediaCalls,
                getDisplayMediaCalls,
                captureCalls: window.__captureCalls,
            };
        }"""
    )
    assert result == {
        "initialStatus": "matched",
        "rememberedWindowUnavailable": True,
        "selectedId": None,
        "getUserMediaCalls": 0,
        "getDisplayMediaCalls": 0,
        "captureCalls": [
            {
                "types": ["window", "screen"],
                "thumbnailSize": {"width": 0, "height": 0},
            },
            {
                "types": ["window", "screen"],
                "thumbnailSize": {"width": 1, "height": 1},
            },
        ],
    }


@pytest.mark.frontend
def test_capture_resolution_releases_cached_stream_when_title_restores_new_id(
    page: Page,
) -> None:
    _install_screen_source_harness(
        page,
        initial_storage={
            "screenSourceTitleMatchEnabled": "true",
            "selectedScreenWindowTitle": "Editor",
            "selectedScreenSourceId": "window:stale",
        },
    )
    page.evaluate(
        """() => {
            window.__metadataSources[1].id = 'window:current';
            window.__cachedTrackStopped = false;
            const track = {
                readyState: 'live',
                stop() { window.__cachedTrackStopped = true; },
            };
            window.appState.screenCaptureStream = {
                active: true,
                getTracks: () => [track],
                getVideoTracks: () => [track],
            };
            window.appState.screenCaptureStreamLastUsed = Date.now();
        }"""
    )

    result = page.evaluate(
        """async () => {
            const resolution = await window.appScreen
                .reconcileRememberedWindowSourceForCapture(
                    window.__desktopProvider
                );
            return {
                status: resolution.status,
                selectedId: window.appState.selectedScreenSourceId,
                streamReleased: window.appState.screenCaptureStream === null,
                trackStopped: window.__cachedTrackStopped,
            };
        }"""
    )
    assert result == {
        "status": "matched",
        "selectedId": "window:current",
        "streamReleased": True,
        "trackStopped": True,
    }


@pytest.mark.frontend
def test_forced_capture_resolution_revalidates_trusted_recreated_window(
    page: Page,
) -> None:
    _install_screen_source_harness(
        page,
        initial_storage={
            "screenSourceTitleMatchEnabled": "true",
            "selectedScreenWindowTitle": "Editor",
            "selectedScreenSourceId": "window:2",
        },
    )

    result = page.evaluate(
        """async () => {
            const first = await window.appScreen
                .reconcileRememberedWindowSourceForCapture(
                    window.__desktopProvider
                );
            window.__metadataSources[1].id = 'window:recreated';
            const second = await window.appScreen
                .reconcileRememberedWindowSourceForCapture(
                    window.__desktopProvider,
                    { forceValidation: true }
                );
            return {
                firstStatus: first.status,
                secondStatus: second.status,
                selectedId: window.appState.selectedScreenSourceId,
                captureCalls: window.__captureCalls.length,
            };
        }"""
    )
    assert result == {
        "firstStatus": "matched",
        "secondStatus": "matched",
        "selectedId": "window:recreated",
        "captureCalls": 2,
    }


@pytest.mark.frontend
def test_forced_capture_resolution_keeps_trusted_window_after_title_change(
    page: Page,
) -> None:
    _install_screen_source_harness(
        page,
        initial_storage={
            "screenSourceTitleMatchEnabled": "true",
            "selectedScreenWindowTitle": "Editor",
            "selectedScreenSourceId": "window:2",
        },
    )

    result = page.evaluate(
        """async () => {
            const first = await window.appScreen
                .reconcileRememberedWindowSourceForCapture(
                    window.__desktopProvider
                );
            window.__metadataSources[1].name = 'Editor - document.txt';
            const second = await window.appScreen
                .reconcileRememberedWindowSourceForCapture(
                    window.__desktopProvider,
                    { forceValidation: true }
                );
            return {
                firstStatus: first.status,
                secondStatus: second.status,
                selectedId: window.appState.selectedScreenSourceId,
                rememberedTitle: window.__storedValues.get(
                    'selectedScreenWindowTitle'
                ),
                needsSelection: window.appScreen
                    .rememberedWindowResolutionNeedsSelection(second),
            };
        }"""
    )
    assert result == {
        "firstStatus": "matched",
        "secondStatus": "retitled-trusted-current",
        "selectedId": "window:2",
        "rememberedTitle": "Editor - document.txt",
        "needsSelection": False,
    }


@pytest.mark.frontend
def test_remembered_title_wins_when_an_old_source_id_is_reused(page: Page) -> None:
    _install_screen_source_harness(
        page,
        source_enumeration_may_prompt=True,
        initial_storage={
            "screenSourceTitleMatchEnabled": "true",
            "selectedScreenWindowTitle": "Browser Preview",
            "selectedScreenSourceId": "window:2",
        },
    )
    page.evaluate(
        """() => {
            window.__metadataSources.push({
                id: 'window:new-browser',
                name: 'Browser Preview',
                display_id: '',
                thumbnail: null,
            });
        }"""
    )

    assert page.evaluate(
        """async () => window.renderFloatingScreenSourceList(
            document.getElementById('live2d-popup-screen')
        )"""
    ) is True

    assert page.evaluate("window.appState.selectedScreenSourceId") == (
        "window:new-browser"
    )
    assert page.evaluate("window.__selectedSourceCalls") == [
        "window:2",
        "window:new-browser",
    ]


@pytest.mark.frontend
def test_window_selection_and_toggle_bound_the_remembered_title(page: Page) -> None:
    _install_screen_source_harness(page, source_enumeration_may_prompt=True)
    assert page.evaluate(
        """async () => window.renderFloatingScreenSourceList(
            document.getElementById('live2d-popup-screen')
        )"""
    ) is True

    result = page.evaluate(
        """async () => {
            document.querySelector(
                '.screen-source-option[data-source-id="window:2"]'
            ).click();
            await new Promise((resolve) => setTimeout(resolve, 0));
            const hasTitleBeforeEnable = window.__storedValues.has(
                'selectedScreenWindowTitle'
            );
            window.setScreenSourceTitleMatchEnabled(true);
            const rememberedAfterEnable = window.__storedValues.get(
                'selectedScreenWindowTitle'
            );
            document.querySelector(
                '.screen-source-option[data-source-id="screen:1"]'
            ).click();
            await new Promise((resolve) => setTimeout(resolve, 0));
            const hasTitleAfterScreen = window.__storedValues.has(
                'selectedScreenWindowTitle'
            );
            document.querySelector(
                '.screen-source-option[data-source-id="window:2"]'
            ).click();
            await new Promise((resolve) => setTimeout(resolve, 0));
            const rememberedAfterWindow = window.__storedValues.get(
                'selectedScreenWindowTitle'
            );
            window.setScreenSourceTitleMatchEnabled(false);
            return {
                hasTitleBeforeEnable,
                rememberedAfterEnable,
                hasTitleAfterScreen,
                rememberedAfterWindow,
                enabledAfterDisable: window.isScreenSourceTitleMatchEnabled(),
                hasRememberedTitleAfterDisable: window.__storedValues.has(
                    'selectedScreenWindowTitle'
                ),
            };
        }"""
    )
    assert result == {
        "hasTitleBeforeEnable": False,
        "rememberedAfterEnable": "Editor",
        "hasTitleAfterScreen": False,
        "rememberedAfterWindow": "Editor",
        "enabledAfterDisable": False,
        "hasRememberedTitleAfterDisable": False,
    }


@pytest.mark.frontend
def test_screen_source_prompt_provider_skips_thumbnail_reenumeration(
    page: Page,
) -> None:
    _install_screen_source_harness(page, source_enumeration_may_prompt=True)

    rendered = page.evaluate(
        """async () => window.renderFloatingScreenSourceList(
            document.getElementById('live2d-popup-screen')
        )"""
    )
    assert rendered is True

    state = page.evaluate(
        """() => ({
            calls: window.__captureCalls,
            metadataThumbnailReads: window.__metadataThumbnailReads,
            loadingCount: document.querySelectorAll(
                '.screen-source-thumbnail-loading'
            ).length,
            fallbackCount: document.querySelectorAll(
                '.screen-source-thumbnail-fallback'
            ).length,
        })"""
    )
    assert state == {
        "calls": [
            {
                "types": ["window", "screen"],
                "thumbnailSize": {"width": 0, "height": 0},
            }
        ],
        "metadataThumbnailReads": 0,
        "loadingCount": 0,
        "fallbackCount": 2,
    }
