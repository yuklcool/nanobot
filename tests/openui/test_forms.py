"""Form recovery, privacy and durable admission use the existing sidecar."""

import pytest
from pydantic import ValidationError

from nanobot.openui.actions import UiActionLedger
from nanobot.openui.forms import ConversationForm, save_form
from nanobot.openui.snapshots import UiConflictError, UiScope, UiSnapshot, UiSnapshotStore


@pytest.fixture
def form_store(tmp_path):
    store = UiSnapshotStore(tmp_path / "forms.sqlite3")
    scope = UiScope(owner="webui", session_key="websocket:chat", generation="generation")
    store.create(scope, UiSnapshot(chat_id="chat", session_generation="generation", turn_id="turn",
                                  block_id="block", library_hash="test"), state_keys=frozenset({"$question", "$forms"}))
    store.advance(scope, "block", revision=1, expected_seq=0, delta="root = Panel([])", status="complete")
    return store, scope


def form(**updates):
    return ConversationForm.model_validate({
        "form_id": "form-0", "title": "Project", "fields": [
            {"label": "Name", "persist": True}, {"label": "Private detail"},
            {"label": "Priority", "options": ["Normal", "High"], "persist": True},
        ], "values": ["Nanobot", "", "High"], **updates,
    })


def test_draft_restore_preserves_other_state_and_omits_unmarked_values(form_store):
    store, scope = form_store
    store.save_state(scope, "block", revision=1, expected_state_version=0, state={"$question": "Existing draft"})
    saved = save_form(store, scope, "block", revision=1, expected_state_version=1, form=form())
    restored = UiSnapshotStore(store.path).read(scope, "block")
    assert restored == saved
    assert restored.state["$question"] == "Existing draft"
    assert restored.state["$forms"]["form-0"]["values"] == ["Nanobot", "", "High"]
    with pytest.raises(ValidationError):
        form(values=["Nanobot", "do not save", "High"])
    with pytest.raises(ValidationError):
        form(submit=True, values=["Nanobot", "Private", "Invalid option"])
    with pytest.raises(ValidationError):
        form(submit=True, values=["", "Private", "High"])
    with pytest.raises(UiConflictError):
        save_form(store, scope, "block", revision=1, expected_state_version=0, form=form(values=["Changed", "", "High"]))
    foreign = scope.model_copy(update={"generation": "foreign"})
    with pytest.raises(KeyError):
        save_form(store, foreign, "block", revision=1, expected_state_version=0, form=form())


def test_submission_receipt_survives_restart_and_fences_duplicates(form_store):
    store, scope = form_store
    submitted = form(submit=True, values=["Nanobot", "Private detail", "High"])
    prepared = save_form(store, scope, "block", revision=1, expected_state_version=0, form=submitted)
    entry = prepared.state["$forms"]["form-0"]
    assert entry["values"] == ["Nanobot", "", "High"]
    assert "Private detail" not in prepared.model_dump_json()
    replay = save_form(store, scope, "block", revision=1, expected_state_version=0, form=submitted)
    assert replay == prepared
    ledger = UiActionLedger(store)
    args = {"request_id": entry["request_id"], "block_id": "block", "revision": 1,
            "content": submitted.content(), "form_id": "form-0"}
    assert ledger.reserve(scope, **args) == "new"
    restarted = UiSnapshotStore(store.path)
    assert restarted.read(scope, "block").state["$forms"]["form-0"]["status"] == "unknown"
    assert UiActionLedger(restarted).reserve(scope, **args) == "unknown"
    ledger.accept(scope, entry["request_id"], block_id="block", revision=1, form_id="form-0")
    assert restarted.read(scope, "block").state["$forms"]["form-0"]["status"] == "submitted"
    assert UiActionLedger(restarted).reserve(scope, **args) == "accepted"
    with pytest.raises(UiConflictError):
        save_form(store, scope, "block", revision=1, expected_state_version=3,
                  form=form(submit=True, values=["Changed", "Private detail", "High"]))
    with pytest.raises(UiConflictError):
        ledger.reserve(scope, **{**args, "request_id": "new-request"})
