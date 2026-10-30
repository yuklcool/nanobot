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


def questionnaire(**updates):
    return ConversationForm.model_validate({
        "form_id": "form-0", "title": "Employee survey", "presentation": "questionnaire",
        "description": "Answers are sent to this conversation.", "fields": [
            {"label": "Considering a new job?", "type": "radio", "options": ["Yes", "No"]},
            {"label": "Reasons", "type": "checkbox", "options": ["Pay", "Workload", "Other"],
             "when": {"field": 0, "value": "Yes"}},
            {"label": "Other reason", "when": {"field": 1, "value": "Other"}},
            {"label": "Comment", "required": False},
        ], "values": ["Yes", ["Other", "Pay"], "Relocation", ""], "submit": True, **updates,
    })


def test_questionnaire_multiselect_order_and_conditional_answers():
    survey = questionnaire()
    assert survey.values == ["Yes", ["Pay", "Other"], "Relocation", ""]
    assert survey.content() == "Employee survey\nConsidering a new job?: Yes\nReasons: Pay, Other\nOther reason: Relocation\nComment: "
    hidden = questionnaire(values=["No", ["Other"], "Must not send", ""])
    assert hidden.values == ["No", [], "", ""]
    assert hidden.content() == "Employee survey\nConsidering a new job?: No\nComment: "
    without_other = questionnaire(values=["Yes", ["Pay"], "Must not send", ""])
    assert without_other.values == ["Yes", ["Pay"], "", ""]
    assert "Other reason" not in without_other.content()


@pytest.mark.parametrize("values", [
    ["Yes", [], "", ""], ["Yes", ["Other"], "  ", ""], ["Yes", ["Unknown"], "", ""],
    ["Yes", ["Pay", "Pay"], "", ""], ["Yes", "Pay", "", ""], [["Yes"], ["Pay"], "", ""],
])
def test_questionnaire_rejects_missing_required_or_invalid_choice_values(values):
    with pytest.raises(ValidationError):
        questionnaire(values=values)


@pytest.mark.parametrize("condition", [{"field": 1, "value": "Other"}, {"field": 0, "value": "Unknown"}])
def test_questionnaire_conditions_must_reference_an_earlier_option(condition):
    with pytest.raises(ValidationError):
        questionnaire(fields=[
            {"label": "First", "type": "radio", "options": ["Yes", "No"]},
            {"label": "Reason", "when": condition},
        ], values=["Yes", "Reason"])


def test_multiselect_draft_restore_and_personal_submission_receipt(form_store):
    store, scope = form_store
    survey = questionnaire()
    fields = [field.model_copy(update={"persist": True}) for field in survey.fields]
    draft = questionnaire(fields=fields, submit=False)
    saved = save_form(store, scope, "block", revision=1, expected_state_version=0, form=draft)
    restored = UiSnapshotStore(store.path).read(scope, "block")
    assert restored.state["$forms"]["form-0"]["values"] == ["Yes", ["Pay", "Other"], "Relocation", ""]
    with pytest.raises(UiConflictError, match="FORM_CHANGED"):
        save_form(store, scope, "block", revision=1, expected_state_version=saved.state_version,
                  form=questionnaire(fields=fields, description="Changed description"))
    # A second form uses the default memory-only policy for personal answers.
    receipt = save_form(store, scope, "block", revision=1, expected_state_version=saved.state_version,
                        form=questionnaire(form_id="form-1"))
    assert receipt.state["$forms"]["form-1"]["values"] == ["", [], "", ""]
    assert "Relocation" not in str(receipt.state["$forms"]["form-1"])


def test_questionnaire_rejects_submission_above_message_limit():
    with pytest.raises(ValidationError, match="FORM_TOO_LONG"):
        questionnaire(fields=[{"label": f"Question {index}"} for index in range(12)], values=["x" * 400] * 12)
