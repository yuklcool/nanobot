"""Report an official stable-tag trial merge without updating repository branches."""

from __future__ import annotations

import argparse
import html
import json
import os
import re
import subprocess
from pathlib import Path


def stable_version(tag: str) -> tuple[int, ...]:
    if not re.fullmatch(r"v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)", tag):
        raise ValueError("Expected an official stable tag in vX.Y.Z format")
    return tuple(int(part) for part in tag[1:].split("."))


def release_tag(payload: object) -> str:
    if (not isinstance(payload, dict) or payload.get("draft") is not False
            or payload.get("prerelease") is not False or not isinstance(payload.get("tag_name"), str)):
        raise ValueError("Expected a published, non-prerelease GitHub release")
    tag = payload["tag_name"]
    stable_version(tag)
    return tag


def git(repo: Path, *args: str) -> str:
    return subprocess.run(["git", *args], cwd=repo, check=True, capture_output=True,
                          text=True, encoding="utf-8", timeout=120).stdout


def ancestor(repo: Path, older: str, newer: str) -> bool:
    result = subprocess.run(["git", "merge-base", "--is-ancestor", older, newer], cwd=repo,
                            check=False, capture_output=True, text=True, timeout=120)
    if result.returncode not in (0, 1):
        raise RuntimeError(f"Cannot compare Git ancestry: {result.stderr.strip()}")
    return result.returncode == 0


def assess(repo: Path, tag: str, output: Path) -> dict:
    """Inputs are fetched into origin/* and refs/upstream-check/tags/* by CI."""
    target_version = stable_version(tag)
    output.mkdir(parents=True, exist_ok=False)
    develop = git(repo, "rev-parse", "--verify", "refs/remotes/origin/develop^{commit}").strip()
    stable = git(repo, "rev-parse", "--verify", "refs/remotes/origin/stable^{commit}").strip()
    prefix = "refs/upstream-check/tags/"
    official = {}
    for ref in git(repo, "for-each-ref", "--format=%(refname)", prefix).splitlines():
        name = ref.removeprefix(prefix)
        if re.fullmatch(r"v[0-9]+\.[0-9]+\.[0-9]+", name):
            stable_version(name)
            official[name] = git(repo, "rev-parse", "--verify", f"{ref}^{{commit}}").strip()
    baseline_tags = [name for name, sha in official.items() if sha == stable]
    if not baseline_tags:
        raise ValueError("stable does not match an official final tag; review the baseline before upgrading")
    stable_tag = max(baseline_tags, key=stable_version)
    if tag not in official:
        raise ValueError("Published release tag was not fetched from the official repository")
    upstream = official[tag]
    if target_version < stable_version(stable_tag):
        raise ValueError("Latest release is older than the configured stable baseline; refusing a downgrade")
    if not ancestor(repo, stable, upstream):
        raise ValueError("the target must descend from the verified stable baseline")
    integrated_tags = [name for name, sha in official.items()
                       if ancestor(repo, sha, stable) and ancestor(repo, sha, develop)]
    if not integrated_tags:
        raise ValueError("develop and stable have no shared official stable baseline")
    baseline = max(integrated_tags, key=stable_version)
    baseline_sha = official[baseline]
    custom_paths = set(git(repo, "diff", "--name-only", "-z", baseline_sha, develop).split("\0")) - {""}
    upstream_paths = set(git(repo, "diff", "--name-only", "-z", baseline_sha, upstream).split("\0")) - {""}
    report = {
        "schema_version": 1, "develop_sha": develop, "stable_sha": stable, "baseline_tag": baseline,
        "baseline_sha": baseline_sha, "stable_tag": stable_tag,
        "target_tag": tag, "upstream_sha": upstream, "status": "up_to_date", "candidate_sha": "",
        "upstream_changed_paths": sorted(upstream_paths), "overlapping_paths": sorted(custom_paths & upstream_paths),
        "conflicts": [],
    }
    if ancestor(repo, upstream, develop):
        return report
    worktree = output / "candidate"
    git(repo, "worktree", "add", "--detach", str(worktree), develop)
    merge = subprocess.run(["git", "-c", "user.name=Nanobot upgrade check", "-c",
                            "user.email=upgrade-check@users.noreply.github.com", "merge", "--no-commit",
                            "--no-ff", "--no-edit", upstream], cwd=worktree, check=False,
                           capture_output=True, text=True, encoding="utf-8", timeout=120)
    (output / "merge.log").write_text(merge.stdout + merge.stderr, encoding="utf-8")
    conflicts = git(worktree, "diff", "--name-only", "--diff-filter=U", "-z").split("\0")
    report["conflicts"] = sorted(path for path in conflicts if path)
    if merge.returncode:
        if not report["conflicts"]:
            raise RuntimeError("Trial merge failed without file conflicts; inspect merge.log")
        report["status"] = "conflicts"
        return report
    git(worktree, "-c", "user.name=Nanobot upgrade check", "-c", "user.email=upgrade-check@users.noreply.github.com",
        "commit", "--no-gpg-sign", "-m", f"Trial merge official {tag} into develop")
    candidate = git(worktree, "rev-parse", "HEAD").strip()
    git(worktree, "update-ref", "refs/heads/codex/upstream-stable-candidate", candidate)
    git(worktree, "bundle", "create", str(output / "candidate.bundle"), "refs/heads/codex/upstream-stable-candidate")
    report.update(status="mergeable", candidate_sha=candidate)
    return report


def render_report(report: dict) -> str:
    lines = ["# Upstream stable compatibility", "",
             f"- Official target: `{report['target_tag']}` (`{report['upstream_sha']}`)",
             f"- Verified stable branch: `{report['stable_tag']}` (`{report['stable_sha']}`)",
             f"- Shared official baseline: `{report['baseline_tag']}` (`{report['baseline_sha']}`)",
             f"- Project develop: `{report['develop_sha']}`", f"- Trial merge: **{report['status']}**",
             f"- Candidate: `{report['candidate_sha'] or 'none'}`", "",
             "This report does not update branches, deploy, publish, or establish real business acceptance.", ""]
    for title, key in (("Files changed on both sides", "overlapping_paths"), ("Merge conflicts", "conflicts")):
        lines += [f"## {title}", ""]
        lines += [f"- <code>{html.escape(path)}</code>" for path in report[key]] or ["None."]
        lines.append("")
    lines += ["A clean merge still requires the OpenUI regression jobs to pass. Conflicts block those jobs;",
              "resolve them in a reviewed feature branch before rerunning acceptance.", ""]
    return "\n".join(lines)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--release", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    tag = release_tag(json.loads(args.release.read_text(encoding="utf-8")))
    report = assess(Path.cwd(), tag, args.output.resolve())
    (args.output / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    summary = render_report(report)
    (args.output / "report.md").write_text(summary, encoding="utf-8")
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with Path(os.environ["GITHUB_STEP_SUMMARY"]).open("a", encoding="utf-8") as stream:
            stream.write(summary)
    if os.environ.get("GITHUB_OUTPUT"):
        with Path(os.environ["GITHUB_OUTPUT"]).open("a", encoding="utf-8") as stream:
            stream.write(f"status={report['status']}\ncandidate_sha={report['candidate_sha']}\n")


if __name__ == "__main__":
    main()
