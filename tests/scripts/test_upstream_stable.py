"""Exercise clean/conflicting upstream upgrades against real temporary Git repositories."""

from pathlib import Path

import pytest

from scripts.upstream_stable import ancestor, assess, git, release_tag, render_report


def commit(repo: Path, filename: str, text: str) -> str:
    (repo / filename).write_text(text, encoding="utf-8")
    git(repo, "add", filename)
    git(repo, "commit", "-m", text.strip())
    return git(repo, "rev-parse", "HEAD").strip()


@pytest.fixture
def history(tmp_path):
    repo = tmp_path / "repo"
    repo.mkdir()
    git(repo, "init", "-b", "develop")
    git(repo, "config", "user.name", "Upgrade test")
    git(repo, "config", "user.email", "upgrade-test@example.invalid")
    baseline = commit(repo, "shared.txt", "base\n")
    git(repo, "update-ref", "refs/remotes/origin/stable", baseline)
    git(repo, "update-ref", "refs/upstream-check/tags/v0.4.0", baseline)
    return repo, baseline


def target(repo: Path, baseline: str, filename: str) -> str:
    git(repo, "checkout", "--detach", baseline)
    sha = commit(repo, filename, "upstream\n")
    git(repo, "update-ref", "refs/upstream-check/tags/v0.4.1", sha)
    git(repo, "checkout", "develop")
    return sha


def test_clean_trial_merge_exports_an_exact_self_contained_candidate(history, tmp_path):
    repo, baseline = history
    develop = commit(repo, "custom.txt", "custom\n")
    git(repo, "update-ref", "refs/remotes/origin/develop", develop)
    upstream = target(repo, baseline, "upstream.txt")
    (repo / "custom.txt").write_text("unsaved local work\n", encoding="utf-8")
    report = assess(repo, "v0.4.1", tmp_path / "report")
    candidate = report["candidate_sha"]
    assert report["status"] == "mergeable" and report["conflicts"] == []
    assert ancestor(repo, develop, candidate) and ancestor(repo, upstream, candidate)
    assert git(repo, "rev-parse", "HEAD").strip() == develop
    assert git(repo, "rev-parse", "refs/remotes/origin/stable").strip() == baseline
    assert (repo / "custom.txt").read_text() == "unsaved local work\n"
    restored = tmp_path / "restored"
    restored.mkdir()
    git(restored, "init")
    git(restored, "fetch", str(tmp_path / "report/candidate.bundle"), "refs/heads/codex/upstream-stable-candidate")
    assert git(restored, "rev-parse", "FETCH_HEAD").strip() == candidate
    assert git(restored, "show", f"{candidate}:custom.txt") == "custom\n"
    assert git(restored, "show", f"{candidate}:upstream.txt") == "upstream\n"


def test_conflicts_are_reported_without_changing_develop_or_exporting_a_candidate(history, tmp_path):
    repo, baseline = history
    develop = commit(repo, "shared.txt", "custom\n")
    git(repo, "update-ref", "refs/remotes/origin/develop", develop)
    target(repo, baseline, "shared.txt")
    output = tmp_path / "report"
    report = assess(repo, "v0.4.1", output)
    assert report["status"] == "conflicts" and report["candidate_sha"] == ""
    assert report["conflicts"] == report["overlapping_paths"] == ["shared.txt"]
    assert (output / "merge.log").read_text()
    assert not (output / "candidate.bundle").exists()
    assert git(repo, "rev-parse", "refs/heads/develop").strip() == develop
    assert (repo / "shared.txt").read_text() == "custom\n"
    assert "shared.txt" in render_report(report)


def test_trial_merge_uses_shared_official_baseline_when_stable_was_updated_first(history, tmp_path):
    repo, baseline = history
    develop = commit(repo, "shared.txt", "custom\n")
    git(repo, "update-ref", "refs/remotes/origin/develop", develop)
    upstream = target(repo, baseline, "shared.txt")
    git(repo, "update-ref", "refs/remotes/origin/stable", upstream)
    report = assess(repo, "v0.4.1", tmp_path / "report")
    assert report["status"] == "conflicts"
    assert report["conflicts"] == report["overlapping_paths"] == ["shared.txt"]
    assert report["baseline_tag"] == "v0.4.0" and report["baseline_sha"] == baseline
    assert report["stable_tag"] == "v0.4.1" and report["stable_sha"] == upstream
    assert git(repo, "rev-parse", "HEAD").strip() == develop


def test_already_integrated_stable_needs_no_new_merge(history, tmp_path):
    repo, baseline = history
    git(repo, "update-ref", "refs/remotes/origin/develop", baseline)
    report = assess(repo, "v0.4.0", tmp_path / "report")
    assert report["status"] == "up_to_date" and report["candidate_sha"] == ""
    assert report["baseline_tag"] == "v0.4.0" and report["stable_sha"] == baseline


def test_baseline_must_be_an_official_tag(history, tmp_path):
    repo, _ = history
    custom = commit(repo, "custom.txt", "custom\n")
    git(repo, "update-ref", "refs/remotes/origin/stable", custom)
    git(repo, "update-ref", "refs/remotes/origin/develop", custom)
    with pytest.raises(ValueError, match="stable does not match"):
        assess(repo, "v0.4.0", tmp_path / "report")


@pytest.mark.parametrize("payload", [
    {"tag_name": "v0.4.2rc1", "draft": False, "prerelease": True},
    {"tag_name": "v0.4.2", "draft": True, "prerelease": False},
    {"tag_name": "--upload-pack=bad", "draft": False, "prerelease": False},
    {"tag_name": "v0.4.2"},
])
def test_release_metadata_cannot_select_a_preview_or_option_like_ref(payload):
    with pytest.raises(ValueError):
        release_tag(payload)


def test_published_final_release_selects_its_validated_tag():
    assert release_tag({"tag_name": "v0.4.1", "draft": False, "prerelease": False}) == "v0.4.1"
