"""Confirmed sidebar edits have durable receipts and never blindly replay."""

import pytest

from nanobot.openui.snapshots import UiConflictError, UiScope, UiSnapshot, UiSnapshotStore
from nanobot.webui.openui_rename import rename_operation
from nanobot.webui.sidebar_state import read_webui_sidebar_state, write_webui_sidebar_state


@pytest.fixture
def rename(tmp_path, monkeypatch):
    monkeypatch.setattr("nanobot.webui.sidebar_state.webui_sidebar_state_path", lambda: tmp_path / "sidebar.json")
    scope = UiScope(owner="webui", session_key="websocket:chat", generation="generation")
    store = UiSnapshotStore(tmp_path / "ui.sqlite3")
    store.create(scope, UiSnapshot(chat_id="chat", session_generation=scope.generation,
                                  turn_id="turn", block_id="block", library_hash="library"))
    store.advance(scope, "block", revision=1, expected_seq=0, status="complete")

    def call(operation, **kwargs):
        return rename_operation(store, scope, "block", revision=1, form_id="form-0", operation=operation,
                                title=kwargs.get("title"), operation_id=kwargs.get("operation_id"))

    return store, scope, call


def entry(snapshot):
    return snapshot.state["$renames"]["form-0"]


def test_review_confirm_replay_and_restart_receipt(rename):
    store, scope, call = rename
    before = read_webui_sidebar_state()
    before["pinned_keys"] = ["websocket:other"]
    before["title_overrides"] = {scope.session_key: "Before", "websocket:other": "Other"}
    write_webui_sidebar_state(before)
    prepared = entry(call("prepare", title="Project plan"))
    assert prepared["previous_title"] == "Before"
    assert read_webui_sidebar_state()["title_overrides"][scope.session_key] == "Before"
    operation = prepared["operation_id"]
    assert entry(call("confirm", operation_id=operation))["status"] == "applied"
    changed = read_webui_sidebar_state()
    assert changed["title_overrides"] == {scope.session_key: "Project plan", "websocket:other": "Other"}
    assert changed["pinned_keys"] == ["websocket:other"]
    call("confirm", operation_id=operation)
    assert read_webui_sidebar_state() == changed
    restarted = UiSnapshotStore(store.path)
    result = rename_operation(restarted, scope, "block", revision=1, form_id="form-0", operation="status",
                              title=None, operation_id=operation)
    assert entry(result) == entry(call("status", operation_id=operation))
    assert read_webui_sidebar_state() == changed


def test_conflict_and_revised_proposal_require_another_review(rename):
    _, scope, call = rename
    old = entry(call("prepare", title="Proposal"))
    changed = read_webui_sidebar_state()
    changed["title_overrides"][scope.session_key] = "Changed elsewhere"
    write_webui_sidebar_state(changed)
    assert entry(call("confirm", operation_id=old["operation_id"]))["status"] == "conflict"
    assert read_webui_sidebar_state()["title_overrides"][scope.session_key] == "Changed elsewhere"
    new = entry(call("prepare", title="Revised proposal"))
    assert new["previous_title"] == "Changed elsewhere"
    with pytest.raises(UiConflictError, match="STALE_OPERATION"):
        call("confirm", operation_id=old["operation_id"])
    assert entry(call("confirm", operation_id=new["operation_id"]))["status"] == "applied"


def test_lost_receipt_after_write_is_unknown_without_reexecution(rename, monkeypatch):
    _, scope, call = rename
    prepared = entry(call("prepare", title="Saved once"))
    from nanobot.webui.sidebar_state import rename_webui_sidebar_title

    def write_then_crash(*args):
        assert rename_webui_sidebar_title(*args)
        raise OSError("simulated crash after atomic write")

    monkeypatch.setattr("nanobot.webui.openui_rename.rename_webui_sidebar_title", write_then_crash)
    with pytest.raises(OSError):
        call("confirm", operation_id=prepared["operation_id"])
    assert read_webui_sidebar_state()["title_overrides"][scope.session_key] == "Saved once"
    assert entry(call("status", operation_id=prepared["operation_id"]))["status"] == "unknown"
    assert entry(call("confirm", operation_id=prepared["operation_id"]))["status"] == "unknown"
    with pytest.raises(UiConflictError, match="ACTION_ALREADY_SUBMITTED"):
        call("prepare", title="Do not overwrite")


def test_native_title_change_during_review_requires_reconfirmation(rename):
    store, scope, _ = rename
    prepared = rename_operation(store, scope, "block", revision=1, form_id="form-0", operation="prepare",
                                title="Proposed", operation_id=None, native_title="Original")
    result = rename_operation(store, scope, "block", revision=1, form_id="form-0", operation="confirm",
                              title=None, operation_id=entry(prepared)["operation_id"], native_title="Changed")
    assert entry(result)["status"] == "conflict"
    assert read_webui_sidebar_state()["title_overrides"] == {}
