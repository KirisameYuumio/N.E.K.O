import json
from copy import deepcopy
from pathlib import Path

import pytest
from jsonschema import Draft202012Validator


ROOT = Path(__file__).resolve().parents[2]
SCHEMA_PATH = ROOT / "static" / "game" / "sdk" / "neko-minigame-manifest.schema.json"


@pytest.fixture(scope="module")
def validator() -> Draft202012Validator:
    schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    Draft202012Validator.check_schema(schema)
    return Draft202012Validator(schema)


def manifest() -> dict:
    return {
        "id": "schema-test",
        "version": "1.0.0",
        "requiredCapabilities": ["logging", "runtime"],
        "contracts": {
            "events": {
                "score": {
                    "type": "object",
                    "properties": {
                        "goals": {"type": "integer", "minimum": 0},
                    },
                    "required": ["goals"],
                },
            },
        },
    }


def assert_invalid(validator: Draft202012Validator, value: dict) -> None:
    assert list(validator.iter_errors(value)), "manifest unexpectedly passed the machine schema"


def test_valid_runtime_contract_manifest_passes(validator: Draft202012Validator) -> None:
    validator.validate(manifest())


def test_array_contract_requires_items(validator: Draft202012Validator) -> None:
    value = manifest()
    value["contracts"]["events"]["score"] = {"type": "array"}
    assert_invalid(validator, value)


def test_contracts_and_host_context_require_runtime(validator: Draft202012Validator) -> None:
    contracts_without_runtime = manifest()
    contracts_without_runtime["requiredCapabilities"] = ["logging"]
    assert_invalid(validator, contracts_without_runtime)

    memory_without_runtime = {
        "id": "memory-test",
        "version": "1.0.0",
        "requiredCapabilities": ["logging", "memory"],
    }
    assert_invalid(validator, memory_without_runtime)


def test_contract_enum_values_match_declared_type(validator: Draft202012Validator) -> None:
    value = manifest()
    value["contracts"]["events"]["score"] = {
        "type": "integer",
        "enum": [1, "two"],
    }
    assert_invalid(validator, value)

    valid_value = deepcopy(value)
    valid_value["contracts"]["events"]["score"]["enum"] = [1, 2]
    validator.validate(valid_value)


def test_local_leaderboard_manifest_contract(validator: Draft202012Validator) -> None:
    value = {
        "id": "leaderboard-test",
        "version": "1.0.0",
        "requiredCapabilities": ["logging", "leaderboard-local"],
        "leaderboards": {
            "main": {
                "scoreField": "score",
                "order": "descending",
                "maxEntries": 20,
                "retention": "recent",
            },
        },
    }
    validator.validate(value)

    without_definitions = deepcopy(value)
    without_definitions.pop("leaderboards")
    assert_invalid(validator, without_definitions)

    without_capability = deepcopy(value)
    without_capability["requiredCapabilities"] = ["logging"]
    assert_invalid(validator, without_capability)


def test_server_leaderboard_requires_runtime(validator: Draft202012Validator) -> None:
    value = {
        "id": "server-leaderboard-test",
        "version": "1.0.0",
        "requiredCapabilities": ["logging", "leaderboard-server"],
        "leaderboards": {"main": {"scoreField": "score"}},
    }
    assert_invalid(validator, value)
    value["requiredCapabilities"].append("runtime")
    validator.validate(value)
