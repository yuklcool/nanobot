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
