import json

import pytest

from nanobot.openui.data import TableAdapterConfig, capture_table


def test_adapter_projects_only_registered_fields_and_marks_partial_rows():
    table = capture_table(TableAdapterConfig(title="Tasks", columns={"energy": "Energy"}, max_rows=1),
                          tool_name="lookup", call_id="call-1", result=json.dumps({"records": [
                              {"id": "one", "energy": 0, "secret": "private"}, {"id": "two", "energy": 5412.5},
                          ]}))
    assert table.rows[0].values == {"energy": 0}
    assert len(table.rows) == 1 and table.total_rows == 2
    assert "private" not in table.model_dump_json()
    assert "energy" in table.descriptor()["columns"]


@pytest.mark.parametrize("record", [{"id": "one", "energy": {"nested": "private"}}, {"id": "one"}])
def test_adapter_rejects_unexpected_nested_or_missing_fields(record):
    with pytest.raises(ValueError):
        capture_table(TableAdapterConfig(title="Tasks", columns={"energy": "Energy"}),
                      tool_name="lookup", call_id="call-1", result=json.dumps({"records": [record]}))


def test_large_integer_cells_keep_exact_digits_in_browser_json():
    config = TableAdapterConfig(title="Exact totals", columns={"total": "Total"})
    table = capture_table(config, tool_name="lookup", call_id="exact",
                          result=json.dumps({"records": [{"id": "one", "total": 9007199254740993}]}))
    assert table.rows[0].values["total"] == "9007199254740993"


def test_chart_descriptors_expose_only_eligible_column_keys_without_values():
    config = TableAdapterConfig(title="Energy", columns={"name": "Name", "value": "Energy (kWh)", "mixed": "Mixed"})
    table = capture_table(config, tool_name="lookup", call_id="chart", result=json.dumps({"records": [
        {"id": "one", "name": "A", "value": 0, "mixed": 1},
        {"id": "two", "name": "B", "value": None, "mixed": "private-value"},
    ]}))
    descriptor = table.descriptor()
    assert descriptor["numeric_columns"] == ["value"]
    assert descriptor["row_count"] == descriptor["total_rows"] == 2
    assert descriptor["category_columns"] == ["name", "mixed"]
    assert "private-value" not in json.dumps(descriptor)


def test_sql_rows_project_available_allowed_fields_and_keep_duplicate_snapshot_rows_distinct():
    config = TableAdapterConfig(title="Query", result_format="sql_readonly", id_field=None,
                                columns={"type": "Type", "count": "Count", "device": "Device"}, max_rows=1)
    summary = capture_table(config, tool_name="readonly", call_id="summary", result=json.dumps({
        "ok": True, "rows": [{"type": "A", "count": 8, "secret": "private"}] * 2,
        "meta": {"truncated": True, "connection": "private"},
    }))
    assert summary.columns == {"type": "Type", "count": "Count"}
    assert summary.rows[0].values == {"type": "A", "count": 8}
    assert summary.total_rows == 2 and len(summary.rows) == 1 and summary.source_truncated
    assert summary.descriptor()["source_truncated"] is True
    assert "private" not in summary.model_dump_json()
    config.max_rows = 50
    detail = capture_table(config, tool_name="readonly", call_id="detail", result=json.dumps({
        "ok": True, "rows": [{"device": "A"}, {"device": "A"}], "meta": {"truncated": False},
    }))
    assert detail.columns == {"device": "Device"}
    assert [row.id for row in detail.rows] == ["row_1", "row_2"]
    assert detail.data_ref != summary.data_ref and not detail.source_truncated


@pytest.mark.parametrize("payload", [
    {"ok": False, "rows": [], "meta": {"truncated": False}},
    {"ok": True, "rows": [], "meta": {"truncated": "false"}},
    {"ok": True, "rows": [{"secret": "private"}], "meta": {"truncated": False}},
    {"ok": True, "rows": [{"count": 8}, {"device": "A"}], "meta": {"truncated": False}},
])
def test_sql_adapter_rejects_errors_unknown_completeness_and_inconsistent_or_unapproved_columns(payload):
    with pytest.raises(ValueError):
        capture_table(TableAdapterConfig(title="Query", result_format="sql_readonly", id_field=None,
                                         columns={"count": "Count", "device": "Device"}),
                      tool_name="readonly", call_id="rejected", result=json.dumps(payload))
