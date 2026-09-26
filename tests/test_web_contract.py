"""The summary schema as the web UI sees it (web/src/api/types.ts) matches the Python one.

A light parse of the TypeScript source, not a compiler: it catches a field added, renamed
or removed on one side only, which is the usual way the two drift apart.
"""

import json
import re
from pathlib import Path

import pytest

from transcriber.summary_types import DEFAULT_REGISTRY, TYPES

WEB_SRC = Path(__file__).resolve().parent.parent / "web" / "src"
TYPES_TS = (WEB_SRC / "api" / "types.ts").read_text(encoding="utf-8")


def ts_interfaces() -> dict[str, dict[str, bool]]:
    """{interface: {field: optional}} for top-level fields of `export interface X {...}`
    and `interface X {...}`; nested object fields are skipped."""
    result = {}
    for name, body in re.findall(r"^(?:export )?interface (\w+) \{\n(.*?)^\}", TYPES_TS,
                                 re.M | re.S):
        fields = re.findall(r"^  (\w+)(\??):", body, re.M)
        result[name] = {field: bool(optional) for field, optional in fields}
    return result


def ts_details_by_type() -> dict[str, str]:
    """meeting_type → details interface, from the BuiltinSummary union."""
    return dict(re.findall(r"meeting_type: '(\w+)'; details: (\w+) \}", TYPES_TS))


# Enums the UI shows as plain strings, not as TS literal types.
FREE_TEXT_IN_TS = {"side"}


def schema_enums(schema) -> set[str]:
    found = set()
    if isinstance(schema, dict):
        found.update(v for v in schema.get("enum", []) if isinstance(v, str))
        if isinstance(schema.get("const"), str):
            found.add(schema["const"])
        for key, value in schema.items():
            if key not in FREE_TEXT_IN_TS:
                found |= schema_enums(value)
    elif isinstance(schema, list):
        for value in schema:
            found |= schema_enums(value)
    return found


def assert_same_fields(py_fields: list[str], ts_fields: dict[str, bool], where: str) -> None:
    required_ts = {f for f, optional in ts_fields.items() if not optional}
    assert set(py_fields) <= set(ts_fields), f"{where}: нет в types.ts: " \
        f"{sorted(set(py_fields) - set(ts_fields))}"
    assert required_ts <= set(py_fields), f"{where}: лишние в types.ts: " \
        f"{sorted(required_ts - set(py_fields))}"


def test_builtin_type_ids_match():
    ids = re.search(r"BUILTIN_TYPES: readonly BuiltinTypeId\[\] = \[(.*?)\]", TYPES_TS, re.S)
    assert ids and re.findall(r"'(\w+)'", ids.group(1)) == list(TYPES)
    assert set(ts_details_by_type()) == set(TYPES)


@pytest.mark.parametrize("type_id", list(TYPES))
def test_summary_fields_match(type_id):
    interfaces = ts_interfaces()
    schema = TYPES[type_id].model.model_json_schema()
    common = {**interfaces["SummaryCommon"], "meeting_type": False, "details": False}
    assert_same_fields(list(schema["properties"]), common, f"{type_id}: summary")

    details = ts_details_by_type()[type_id]
    for name, definition in schema["$defs"].items():
        # ClientParticipant, InterviewParticipant… are one Participant with an optional side.
        ts_name = name if name in interfaces else re.sub(r"^\w+(?=Participant$)", "", name)
        if name.endswith("Details"):
            ts_name = details
        if ts_name not in interfaces:
            continue  # inline object in TS (interview's assessment); its enums are checked
        assert_same_fields(list(definition["properties"]), interfaces[ts_name],
                           f"{type_id}: {name} ↔ {ts_name}")


@pytest.mark.parametrize("type_id", list(TYPES))
def test_enum_values_present_in_ts(type_id):
    schema = TYPES[type_id].model.model_json_schema()
    missing = {v for v in schema_enums(schema) if f"'{v}'" not in TYPES_TS}
    assert not missing, f"{type_id}: значений нет в types.ts: {sorted(missing)}"


@pytest.mark.parametrize("path", sorted((WEB_SRC / "dev" / "fixtures").glob("*.summary.json")),
                         ids=lambda p: p.name)
def test_dev_fixtures_are_valid_summaries(path):
    DEFAULT_REGISTRY.parse(json.loads(path.read_text(encoding="utf-8")))
