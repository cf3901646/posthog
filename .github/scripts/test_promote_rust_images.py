import json
import subprocess

import pytest

import promote_rust_images as script

OLDER, NEWER = "a" * 40, "b" * 40
OLD_DIGEST, NEW_DIGEST = "sha256:" + "1" * 64, "sha256:" + "2" * 64
CAPTURE = "ghcr.io/posthog/posthog/capture"
FLAGS = "ghcr.io/posthog/posthog/feature-flags"


class Registry:
    def __init__(self) -> None:
        self.images = {f"{CAPTURE}@{OLD_DIGEST}": OLDER, f"{CAPTURE}@{NEW_DIGEST}": NEWER}
        self.tags: dict[str, str] = {}
        self.inspect_error = ""
        self.comparison: str | None = None
        self.readback: str | None = None
        self.promotions = 0

    def run(self, args: list[str], *, check: bool = False, **kwargs: object) -> subprocess.CompletedProcess[str]:
        output, error = "", ""
        if args[0] == "gh":
            if self.comparison == "error":
                raise subprocess.CalledProcessError(1, args, stderr="API request failed")
            current, candidate = args[2].rsplit("/", 1)[1].split("...")
            output = self.comparison or ("ahead" if current < candidate else "behind")
        elif args[3] == "create":
            target, source = args[-2:]
            self.tags[target] = source.split("@", 1)[1]
            self.promotions += 1
        elif "--format" in args:
            output = json.dumps(self.readback or self.tags[args[-1]])
        else:
            reference = args[-1]
            if reference.endswith(":master") and self.inspect_error:
                error = self.inspect_error
            else:
                source = reference
                if reference in self.tags:
                    source = reference.removesuffix(":master") + "@" + self.tags[reference]
                if source not in self.images:
                    error = f"{reference}: not found"
                else:
                    output = json.dumps({"annotations": {script.REVISION: self.images[source]}})
        result = subprocess.CompletedProcess(args, int(bool(error)), output, error)
        if check:
            result.check_returncode()
        return result


@pytest.fixture
def registry(monkeypatch: pytest.MonkeyPatch) -> Registry:
    registry = Registry()
    monkeypatch.setattr(script.subprocess, "run", registry.run)
    return registry


@pytest.mark.parametrize("order", [(OLDER, NEWER), (NEWER, OLDER), (NEWER, NEWER)])
def test_master_keeps_newest_revision(registry: Registry, order: tuple[str, str]) -> None:
    for candidate in order:
        digest = OLD_DIGEST if candidate == OLDER else NEW_DIGEST
        script.promote_images({"capture": digest}, candidate, "PostHog/posthog")
    assert registry.tags[f"{CAPTURE}:master"] == NEW_DIGEST
    assert registry.promotions == (2 if order == (OLDER, NEWER) else 1)


def test_older_selective_build_still_promotes_an_unrelated_image(registry: Registry) -> None:
    registry.images[f"{FLAGS}@{OLD_DIGEST}"] = OLDER
    script.promote_images({"capture": NEW_DIGEST}, NEWER, "PostHog/posthog")
    script.promote_images({"capture": OLD_DIGEST, "feature-flags": OLD_DIGEST}, OLDER, "PostHog/posthog")
    assert registry.tags == {f"{CAPTURE}:master": NEW_DIGEST, f"{FLAGS}:master": OLD_DIGEST}


@pytest.mark.parametrize("failure", ["registry", "comparison", "api", "metadata", "source"])
def test_unverifiable_revision_does_not_change_master(registry: Registry, failure: str) -> None:
    registry.tags[f"{CAPTURE}:master"] = OLD_DIGEST
    if failure == "registry":
        registry.inspect_error = "unauthorized: access denied"
    elif failure == "comparison":
        registry.comparison = "diverged"
    elif failure == "api":
        registry.comparison = "error"
    elif failure == "metadata":
        registry.images[f"{CAPTURE}@{OLD_DIGEST}"] = ""
    else:
        registry.images[f"{CAPTURE}@{NEW_DIGEST}"] = OLDER
    with pytest.raises((RuntimeError, ValueError, subprocess.CalledProcessError)):
        script.promote_images({"capture": NEW_DIGEST}, NEWER, "PostHog/posthog")
    assert registry.tags[f"{CAPTURE}:master"] == OLD_DIGEST
    assert registry.promotions == 0


def test_wrong_digest_after_promotion_fails(registry: Registry) -> None:
    registry.readback = OLD_DIGEST
    with pytest.raises(ValueError, match="Promoted digest"):
        script.promote_images({"capture": NEW_DIGEST}, NEWER, "PostHog/posthog")
