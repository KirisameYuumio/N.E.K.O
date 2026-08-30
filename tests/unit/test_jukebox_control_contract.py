import asyncio
import json
import shutil
import textwrap
import types
from dataclasses import dataclass, field
from pathlib import Path

import pytest

from tests.node_harness import run_node_script


ROOT = Path(__file__).resolve().parents[2]
APP_WEBSOCKET_PATH = ROOT / "static" / "app" / "app-websocket.js"


class _FakePushSocket:
    def __init__(self):
        self.events = []

    def send_json(self, event, flags=None):
        self.events.append(json.loads(json.dumps(event)))


@dataclass
class _WebSocket:
    payloads: list = field(default_factory=list)

    async def send_json(self, payload):
        self.payloads.append(payload)


@dataclass
class _Manager:
    websocket: _WebSocket


@pytest.mark.asyncio
async def test_jukebox_event_bus_delivers_canonical_command_to_one_session(monkeypatch):
    """Drive the real event-bus handler instead of reading its source.

    A changed payload shape or a delivery to the wrong websocket fails here;
    reformatting the handler does not.
    """
    from app import main_server
    from app.main_server import character_runtime

    target = _Manager(_WebSocket())
    bystander = _Manager(_WebSocket())
    monkeypatch.setattr(
        character_runtime,
        "_get_session_manager",
        lambda name: target if name == "cat" else None,
    )
    monkeypatch.setattr(
        character_runtime,
        "_iter_session_managers",
        lambda: iter([("cat", target), ("dog", bystander)]),
    )

    await main_server._handle_agent_event(
        {
            "event_type": "jukebox_control",
            "lanlan_name": "cat",
            "action": "  PLAY  ",
            "query": "桃园",
            "value": 50,
            "mode": "random",
            "source": "jukebox_controller",
            # Legacy aliases the wire contract deliberately drops.
            "song": "legacy-song",
            "volume": 11,
            "delta": 7,
        }
    )

    assert target.websocket.payloads == [
        {
            "type": "jukebox_control",
            "command": {
                "action": "play",
                "query": "桃园",
                "value": 50,
                "mode": "random",
            },
            "source": "jukebox_controller",
        }
    ]
    # Jukebox control mutates one local playback runtime: it must never fan out.
    assert bystander.websocket.payloads == []


@pytest.mark.asyncio
async def test_jukebox_event_bus_drops_control_without_target_session(monkeypatch):
    from app import main_server
    from app.main_server import character_runtime

    bystander = _Manager(_WebSocket())
    monkeypatch.setattr(character_runtime, "_get_session_manager", lambda _name: None)
    monkeypatch.setattr(
        character_runtime,
        "_iter_session_managers",
        lambda: iter([("dog", bystander)]),
    )

    await main_server._handle_agent_event(
        {
            "event_type": "jukebox_control",
            "lanlan_name": "",
            "action": "next",
        }
    )

    assert bystander.websocket.payloads == []


def _websocket_jukebox_handler_source() -> str:
    """Cut the real handler (and the queue it serializes on) out of the bundle."""
    source = APP_WEBSOCKET_PATH.read_text(encoding="utf-8")
    queue_decl = "let _jukeboxControlQueue = Promise.resolve();"
    assert queue_decl in source, "jukebox control queue declaration moved"
    handler_start = "    function handleJukeboxControlResponse(response) {"
    handler_end = "    function readNewUserIcebreakerStore() {"
    assert handler_start in source and handler_end in source
    handler = handler_start + source.split(handler_start, 1)[1].split(handler_end, 1)[0]
    return queue_decl + "\n" + handler


def _run_node(script: str):
    node_path = shutil.which("node")
    if not node_path:
        pytest.skip("node is not installed; skipping jukebox control harness test")
    return run_node_script(
        node_path,
        script,
        cwd=str(ROOT),
        capture_output=True,
        text=True,
        check=False,
        timeout=60,
    )


def test_jukebox_websocket_handler_forwards_canonical_command_and_serializes():
    """Run the real handler under node.

    Pins what the old substring assertions could not: the exact command object
    handed to ``executeControl``, and that a second command waits for the first
    to settle instead of racing it.
    """
    harness = (
        textwrap.dedent(
            """
            const emit = console.log;
            const window = { Jukebox: null };
            globalThis.window = window;
            """
        )
        + _websocket_jukebox_handler_source()
        + textwrap.dedent(
            """
            (async () => {
              const seen = [];
              const order = [];
              let releaseFirst;
              const firstGate = new Promise(resolve => { releaseFirst = resolve; });
              let call = 0;
              window.Jukebox = {
                executeControl: (command) => {
                  seen.push(command);
                  call += 1;
                  if (call === 1) {
                    order.push('first-start');
                    return firstGate.then(() => { order.push('first-end'); });
                  }
                  order.push('second-start');
                  return Promise.reject(new Error('boom'));
                }
              };

              handleJukeboxControlResponse({
                type: 'jukebox_control',
                command: { action: 'play', query: 'peach', value: 50, mode: 'random',
                           song: 'legacy', name: 'legacy', volume: 9, delta: 3 },
                source: 'jukebox_controller'
              });
              handleJukeboxControlResponse({
                type: 'jukebox_control',
                command: { action: 'next' }
              });

              await new Promise(resolve => setTimeout(resolve, 20));
              const startedEarly = order.includes('second-start');
              releaseFirst();
              await new Promise(resolve => setTimeout(resolve, 20));

              // A rejected command must not wedge the queue for the next one.
              window.Jukebox.executeControl = (command) => {
                seen.push(command);
                order.push('third-start');
                return Promise.resolve();
              };
              handleJukeboxControlResponse({ command: { action: 'stop' } });
              await new Promise(resolve => setTimeout(resolve, 20));

              emit(JSON.stringify({ seen, order, startedEarly }));
            })();
            """
        )
    )
    result = _run_node(harness)
    assert result.returncode == 0, result.stderr
    payload = json.loads(result.stdout.strip().splitlines()[-1])

    assert payload["seen"][0] == {
        "action": "play",
        "query": "peach",
        "value": 50,
        "mode": "random",
        "headless": True,
    }
    # An absent value/mode stays absent on the wire (JS undefined), never a
    # legacy alias: the handler forwards only the canonical four plus headless.
    assert payload["seen"][1] == {"action": "next", "query": "", "headless": True}
    for command in payload["seen"]:
        assert set(command) <= {"action", "query", "value", "mode", "headless"}
    # Serialized, not concurrent: the second command starts only after the
    # first settles, and a rejection does not wedge the queue.
    assert payload["startedEarly"] is False
    assert payload["order"] == [
        "first-start",
        "first-end",
        "second-start",
        "third-start",
    ]


def test_jukebox_plugin_normalizes_and_rejects_actions():
    """Exercise the plugin's own validation and the part it actually pushes."""
    from plugin.plugins.jukebox_controller import JukeboxControllerPlugin
    from plugin.sdk.plugin import Err

    plugin = JukeboxControllerPlugin.__new__(JukeboxControllerPlugin)
    pushed = []
    plugin.ctx = types.SimpleNamespace(
        push_message=lambda **kwargs: pushed.append(kwargs),
        _current_lanlan="cat",
    )

    result = asyncio.run(
        plugin.control_jukebox(action="  PLAY  ", query="  桃源  ", mode=" RANDOM ")
    )
    assert result.value["action"] == "play"
    assert result.value["query"] == "桃源"
    assert result.value["mode"] == "random"
    assert pushed[0]["parts"] == [
        {
            "type": "ui_action",
            "action": "jukebox_control",
            "jukebox_action": "play",
            "query": "桃源",
            "value": None,
            "mode": "random",
        }
    ]
    assert pushed[0]["visibility"] == ["chat"]
    assert pushed[0]["ai_behavior"] == "blind"
    # The command is scoped to the character it was invoked for.
    assert pushed[0]["target_lanlan"] == "cat"

    for unsupported in ("skip", "shuffle", "", "pause "):
        rejected = asyncio.run(plugin.control_jukebox(action=unsupported))
        assert isinstance(rejected, Err), unsupported
    # A rejected action must not reach the frontend at all.
    assert len(pushed) == 1


def test_jukebox_proactive_bridge_uses_canonical_control_keys(monkeypatch):
    from plugin.server.messaging import proactive_bridge

    if proactive_bridge.zmq is None:
        monkeypatch.setattr(proactive_bridge, "zmq", types.SimpleNamespace(NOBLOCK=1))

    push = _FakePushSocket()
    proactive_bridge.ProactiveBridge()._dispatch(
        {
            "plugin_id": "jukebox_controller",
            "time": "now",
            "metadata": {"query": "metadata-query", "song": "legacy-metadata-song"},
            "visibility": ["chat"],
            "ai_behavior": "blind",
            "parts": [
                {
                    "type": "ui_action",
                    "action": "jukebox_control",
                    "jukebox_action": "play",
                    "control": "stop",
                    "command": "next",
                    "query": "桃园",
                    "value": 50,
                    "mode": "random",
                    "song": "legacy-song",
                }
            ],
        },
        push,
    )

    assert push.events == [
        {
            "event_type": "jukebox_control",
            "lanlan_name": None,
            "action": "play",
            "query": "桃园",
            "value": 50,
            "mode": "random",
            "source": "jukebox_controller",
            "timestamp": "now",
        }
    ]

    metadata_only_push = _FakePushSocket()
    proactive_bridge.ProactiveBridge()._dispatch(
        {
            "plugin_id": "jukebox_controller",
            "time": "now",
            "metadata": {"query": "metadata-query"},
            "visibility": ["chat"],
            "ai_behavior": "blind",
            "parts": [
                {
                    "type": "ui_action",
                    "action": "jukebox_control",
                    "jukebox_action": "play",
                }
            ],
        },
        metadata_only_push,
    )

    assert metadata_only_push.events[0]["query"] is None
    assert metadata_only_push.events[0]["value"] is None
    assert metadata_only_push.events[0]["mode"] is None

    legacy_push = _FakePushSocket()
    proactive_bridge.ProactiveBridge()._dispatch(
        {
            "plugin_id": "jukebox_controller",
            "time": "now",
            "metadata": {"query": "metadata-query", "song": "legacy-metadata-song"},
            "visibility": ["chat"],
            "ai_behavior": "blind",
            "parts": [
                {
                    "type": "ui_action",
                    "action": "jukebox_control",
                    "control": "play",
                    "command": "next",
                    "song": "legacy-song",
                }
            ],
        },
        legacy_push,
    )

    assert legacy_push.events == []
