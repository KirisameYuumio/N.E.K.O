from __future__ import annotations

import pytest

from main_logic.core.game_speech_audio_cache import GameSpeechAudioCache


class _Clock:
    def __init__(self) -> None:
        self.now = 100.0

    def __call__(self) -> float:
        return self.now


def _capture(
    cache: GameSpeechAudioCache,
    owner: object,
    speech_id: str,
    cache_key: str,
    *chunks: bytes,
    signature: str = "voice-a",
) -> bool:
    assert cache.begin_capture(owner, speech_id, cache_key, signature)
    for chunk in chunks:
        assert cache.append_capture(owner, speech_id, chunk)
    return cache.complete_capture(owner, speech_id, signature)


@pytest.mark.unit
def test_completed_audio_is_immutable_and_lru_bounded() -> None:
    cache = GameSpeechAudioCache(max_entries=2, max_total_bytes=12, max_entry_bytes=8)
    owner = object()

    assert _capture(cache, owner, "s1", "one", b"a")
    assert _capture(cache, owner, "s2", "two", b"bb")
    assert cache.get("one") == (b"a",)
    assert _capture(cache, owner, "s3", "three", b"ccc")

    assert cache.get("two") is None
    assert cache.get("one") == (b"a",)
    assert cache.get("three") == (b"ccc",)
    assert cache.stats() == {
        "entries": 2,
        "entry_bytes": 4,
        "captures": 0,
        "capture_bytes": 0,
    }


@pytest.mark.unit
def test_completed_audio_expires_and_total_bytes_evict_oldest() -> None:
    clock = _Clock()
    cache = GameSpeechAudioCache(
        max_entries=4,
        max_total_bytes=5,
        max_entry_bytes=5,
        entry_ttl_seconds=10,
        clock=clock,
    )
    owner = object()

    assert _capture(cache, owner, "s1", "one", b"aaa")
    assert _capture(cache, owner, "s2", "two", b"bbb")
    assert cache.get("one") is None
    assert cache.get("two") == (b"bbb",)

    clock.now += 10
    assert cache.get("two") is None
    assert cache.stats()["entry_bytes"] == 0


@pytest.mark.unit
def test_capture_limits_signature_guard_and_release_paths() -> None:
    clock = _Clock()
    cache = GameSpeechAudioCache(
        max_entry_bytes=4,
        max_captures=2,
        max_capture_total_bytes=5,
        capture_ttl_seconds=10,
        clock=clock,
    )
    owner_a = object()
    owner_b = object()
    owner_c = object()

    assert cache.begin_capture(owner_a, "a", "key-a", "voice-a")
    assert cache.append_capture(owner_a, "a", b"aaa")
    assert cache.begin_capture(owner_b, "b", "key-b", "voice-b")
    assert not cache.begin_capture(owner_c, "c", "key-c", "voice-c")
    assert not cache.append_capture(owner_b, "b", b"bbb")
    assert cache.stats()["captures"] == 1
    assert not cache.complete_capture(owner_a, "a", "changed-voice")
    assert cache.get("key-a") is None

    assert cache.begin_capture(owner_a, "oversized", "large", "voice-a")
    assert not cache.append_capture(owner_a, "oversized", b"12345")
    assert cache.stats()["captures"] == 0

    assert cache.begin_capture(owner_a, "stale", "stale", "voice-a")
    clock.now += 10
    assert cache.stats()["captures"] == 0

    assert cache.begin_capture(owner_a, "release-a", "release-a", "voice-a")
    assert cache.begin_capture(owner_b, "release-b", "release-b", "voice-b")
    assert cache.discard_owner(owner_a) == 1
    assert cache.stats()["captures"] == 1
    cache.clear()
    assert cache.stats() == {
        "entries": 0,
        "entry_bytes": 0,
        "captures": 0,
        "capture_bytes": 0,
    }


@pytest.mark.unit
def test_unscoped_audio_is_discarded_when_capture_identity_is_ambiguous() -> None:
    cache = GameSpeechAudioCache(max_captures=3)
    owner = object()

    assert cache.begin_capture(owner, "one", "key-one", "voice")
    assert cache.begin_capture(owner, "two", "key-two", "voice")
    assert not cache.append_unscoped_capture(owner, "two", b"ambiguous")
    assert cache.stats()["captures"] == 0

    assert cache.begin_capture(owner, "only", "key-only", "voice")
    assert cache.append_unscoped_capture(owner, "legacy-worker-id", b"safe")
    assert cache.complete_capture(owner, "only", "voice")
    assert cache.get("key-only") == (b"safe",)
