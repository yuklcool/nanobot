"""Storage contracts needed before attaching OpenUI to a running gateway."""

from concurrent.futures import ThreadPoolExecutor

import pytest
from pydantic import ValidationError

from nanobot.openui.snapshots import UiConflictError, UiScope, UiSnapshot, UiSnapshotStore


@pytest.fixture
def scope():
    return UiScope(owner="local-host", session_key="websocket:task", generation="generation-1")


@pytest.fixture
def store(tmp_path, scope):
    store = UiSnapshotStore(tmp_path / "ui.sqlite3")
    store.create(scope, UiSnapshot(
        chat_id="task", session_generation=scope.generation, turn_id="turn-1",
        block_id="block-1", library_hash="nanobot-openui-poc-v1",
    ), state_keys=frozenset({"$period"}))
    return store


def finish(store, scope):
    return store.advance(scope, "block-1", revision=1, expected_seq=0,
                         delta='root = Panel([Text("Task 08")])', status="complete")


def test_restart_restores_source_and_independent_state_version(store, scope):
    finished = finish(store, scope)
    saved = store.save_state(scope, "block-1", revision=1, expected_state_version=0,
                             state={"$period": "30"})
    restored = UiSnapshotStore(store.path).read(scope, "block-1")
    assert restored == saved
    assert restored.source == finished.source
    assert restored.seq == finished.seq
    assert restored.state == {"$period": "30"}
    assert restored.state_version == 1
    with pytest.raises(UiConflictError):
        store.save_state(scope, "block-1", revision=1, expected_state_version=0,
                         state={"$period": "7"})
    with pytest.raises(UiConflictError):
        store.advance(scope, "block-1", revision=1, expected_seq=finished.seq, delta="late")


@pytest.mark.parametrize("field", ["owner", "session_key", "generation"])
def test_snapshot_isolated_by_trusted_scope(store, scope, field):
    other = UiScope.model_validate({**scope.model_dump(), field: "other"})
    with pytest.raises(KeyError):
        store.read(other, "block-1")


def test_concurrent_writers_cannot_silently_overwrite(store, scope):
    finish(store, scope)

    def save(value):
        try:
            return store.save_state(scope, "block-1", revision=1, expected_state_version=0,
                                    state={"$period": value}).state
        except UiConflictError:
            return None

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(save, ["7", "30"]))
    winners = [value for value in results if value is not None]
    assert len(winners) == 1
    assert store.read(scope, "block-1").state == winners[0]


def test_delete_survives_restart_and_rejects_delayed_generation(store, scope):
    original = store.read(scope, "block-1")
    store.delete_generation(scope)
    restarted = UiSnapshotStore(store.path)
    with pytest.raises(KeyError):
        restarted.read(scope, "block-1")
    with pytest.raises(UiConflictError):
        restarted.create(scope, original)
    new_scope = UiScope.model_validate({**scope.model_dump(), "generation": "generation-2"})
    restarted.create(new_scope, UiSnapshot.model_validate({
        **original.model_dump(), "session_generation": new_scope.generation,
    }))
    assert restarted.read(new_scope, "block-1").session_generation == "generation-2"


def test_limits_and_state_allowlist_leave_previous_snapshot_intact(store, scope):
    before = store.read(scope, "block-1")
    with pytest.raises(ValidationError):
        store.advance(scope, "block-1", revision=1, expected_seq=0, delta="界" * 50_000)
    assert store.read(scope, "block-1") == before
    finish(store, scope)
    for state in ({"secret": "token"}, {"$period": "x" * 17_000}, {"$period": float("nan")}):
        with pytest.raises(ValueError):
            store.save_state(scope, "block-1", revision=1, expected_state_version=0, state=state)
    assert store.read(scope, "block-1").state_version == 0


def test_future_schema_is_not_silently_rewritten(store, scope):
    import sqlite3

    with sqlite3.connect(store.path) as db:
        db.execute("PRAGMA user_version = 999")
    with pytest.raises(UiConflictError, match="unsupported"):
        UiSnapshotStore(store.path)
