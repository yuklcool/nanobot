"""Form recovery, privacy and durable admission use the existing sidecar."""

import pytest
from pydantic import ValidationError

from nanobot.openui.actions import UiActionLedger
from nanobot.openui.forms import ConversationForm, FormField, form_followup, save_form
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


def test_numeric_date_fields_validate_and_retain_drafts_and_followup(form_store):
    store, scope = form_store
    form = ConversationForm.model_validate({"form_id": "form-0", "title": "Observation", "fields": [
        {"label": "Power", "type": "number", "min": 0, "max": 100, "persist": True},
        {"label": "Date", "type": "date", "persist": True},
    ], "values": ["1.250", "2028-02-29"]})
    block = save_form(store, scope, "block", revision=1, expected_state_version=0, form=form)
    retained = form_followup(block, "form-0").form
    assert retained is not None and retained.values == ["1.250", "2028-02-29"]
    assert retained.fields[0].max == 100 and retained.fields[1].type == "date"
    submitted = ConversationForm.model_validate({**form.model_dump(), "submit": True})
    assert submitted.content() == "Observation\nPower: 1.250\nDate: 2028-02-29"


@pytest.mark.parametrize("kind,value", [("number", "101"), ("number", "-1"), ("number", "0x10"),
                                       ("number", "1e999"), ("date", "2026-02-29"), ("date", "0000-01-01")])
def test_invalid_numeric_date_submission_is_rejected(kind, value):
    field = {"label": "Input", "type": kind, **({"min": 0, "max": 100} if kind == "number" else {})}
    with pytest.raises(ValidationError):
        ConversationForm.model_validate({"form_id": "form-0", "title": "Observation", "fields": [field],
                                        "values": [value], "submit": True})


def test_invalid_numeric_bounds_and_date_initial_are_rejected():
    for field in [{"label": "Power", "type": "number", "min": 10, "max": 1},
                  {"label": "Date", "type": "date", "min": 0},
                  {"label": "Date", "type": "date", "persist": True, "initial": "2026-02-29"}]:
        with pytest.raises(ValidationError):
            FormField.model_validate(field)


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


@pytest.mark.parametrize("submitted", [False, True])
def test_regeneration_cannot_erase_saved_form_or_submission(form_store, submitted):
    store, scope = form_store
    saved = save_form(store, scope, "block", revision=1, expected_state_version=0,
                      form=form(values=["Nanobot", "Private input" if submitted else "", "High"], submit=submitted))
    with pytest.raises(UiConflictError, match="UI_STATE_SAVED"):
        store.restart(scope, "block", revision=1)
    assert store.read(scope, "block") == saved


def test_submission_receipt_survives_restart_and_fences_duplicates(form_store):
    store, scope = form_store
    submitted = form(submit=True, values=["Nanobot", "PRIVATE-SUBMITTED-VALUE", "High"])
    prepared = save_form(store, scope, "block", revision=1, expected_state_version=0, form=submitted)
    entry = prepared.state["$forms"]["form-0"]
    assert entry["values"] == ["Nanobot", "", "High"]
    assert "PRIVATE-SUBMITTED-VALUE" not in prepared.model_dump_json()
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


def test_initial_answers_accept_retained_text_and_multiselect():
    assert FormField(label="Project", persist=True, initial="Existing").initial == "Existing"
    assert FormField(label="Scope", persist=True, type="checkbox", options=["API", "UI"], initial=["UI"]).initial == ["UI"]


@pytest.mark.parametrize("field", [
    {"label": "Private detail", "initial": "Do not retain"},
    {"label": "Project", "persist": True, "initial": ["Wrong type"]},
    {"label": "Scope", "persist": True, "type": "checkbox", "options": ["API", "UI"], "initial": ["Other"]},
    {"label": "Scope", "persist": True, "type": "checkbox", "options": ["API", "UI"], "initial": ["UI", "UI"]},
])
def test_initial_answers_reject_unconsented_or_invalid_values(field):
    with pytest.raises(ValidationError, match="INVALID_INITIAL_VALUE"):
        FormField.model_validate(field)


def test_followup_keeps_definition_and_latest_retained_values_without_reviving_initials(form_store):
    store, scope = form_store
    survey = questionnaire(fields=[
        {"label": "Scope", "type": "checkbox", "options": ["API", "Other"], "persist": True,
         "initial": ["API", "Other"]},
        {"label": "Other detail", "when": {"field": 0, "value": "Other"}, "persist": True,
         "initial": "OLD-INITIAL"},
        {"label": "Private comment", "required": False},
    ], values=[["API"], "WITHDRAWN", "PRIVATE-ANSWER"])
    saved = save_form(store, scope, "block", revision=1, expected_state_version=0, form=survey)
    retained = form_followup(UiSnapshotStore(store.path).read(scope, "block"), "form-0")
    assert retained.form.title == survey.title
    assert retained.form.fields[0].options == ["API", "Other"]
    assert retained.form.fields[1].when == survey.fields[1].when
    assert not retained.form.fields[2].required
    assert retained.form.values == [["API"], "", ""]
    assert all(field.initial is None for field in retained.form.fields)
    for secret in ["OLD-INITIAL", "WITHDRAWN", "PRIVATE-ANSWER"]:
        assert secret not in retained.model_dump_json()
    assert "PRIVATE-ANSWER" not in saved.model_dump_json()
