import os
import re
import sys
import json
import subprocess

REVISION = "org.opencontainers.image.revision"


def image_revision(reference: str, *, allow_missing: bool = False) -> str | None:
    result = subprocess.run(
        ["docker", "buildx", "imagetools", "inspect", "--raw", reference],
        capture_output=True,
        text=True,
        timeout=30,
    )
    if result.returncode:
        if allow_missing and any(error in result.stderr.lower() for error in ("manifest unknown", ": not found")):
            return None
        raise RuntimeError(f"Cannot inspect {reference}: {result.stderr}")
    manifest = json.loads(result.stdout)
    annotations = manifest.get("annotations") if isinstance(manifest, dict) else None
    revision = annotations.get(REVISION) if isinstance(annotations, dict) else None
    if not isinstance(revision, str) or not re.fullmatch(r"[0-9a-f]{40}", revision):
        raise ValueError(f"Missing or invalid source revision on {reference}")
    return revision


def promote_images(digests: object, candidate: str, repository: str) -> None:
    if not re.fullmatch(r"[0-9a-f]{40}", candidate):
        raise ValueError("Invalid candidate revision")
    if not isinstance(digests, dict) or not all(
        isinstance(image, str)
        and re.fullmatch(r"[a-z0-9][a-z0-9_-]*", image)
        and isinstance(digest, str)
        and re.fullmatch(r"sha256:[0-9a-f]{64}", digest)
        for image, digest in digests.items()
    ):
        raise ValueError("Invalid build digests")

    for image, digest in digests.items():
        name = f"ghcr.io/posthog/posthog/{image}"
        source, target = f"{name}@{digest}", f"{name}:master"
        if image_revision(source) != candidate:
            raise ValueError(f"Build revision does not match {candidate} on {source}")
        current = image_revision(target, allow_missing=True)
        if current == candidate:
            sys.stdout.write(f"{target} already has revision {candidate}\n")
            continue
        if current is not None:
            comparison = subprocess.run(
                ["gh", "api", f"repos/{repository}/compare/{current}...{candidate}", "--jq", ".status"],
                check=True,
                capture_output=True,
                text=True,
                timeout=30,
            ).stdout.strip()
            if comparison == "behind":
                sys.stdout.write(f"Skipping {source}: {target} is newer\n")
                continue
            if comparison != "ahead":
                raise ValueError(f"Cannot advance {target}: commit comparison is {comparison!r}")
        subprocess.run(
            ["docker", "buildx", "imagetools", "create", "--prefer-index=false", "--tag", target, source],
            check=True,
            timeout=60,
        )
        observed = subprocess.run(
            ["docker", "buildx", "imagetools", "inspect", "--format", "{{json .Manifest.Digest}}", target],
            check=True,
            capture_output=True,
            text=True,
            timeout=30,
        )
        if json.loads(observed.stdout) != digest:
            raise ValueError(f"Promoted digest does not match {source}")
        sys.stdout.write(f"Promoted {target} to {candidate} at {digest}\n")


if __name__ == "__main__":
    promote_images(json.loads(os.environ["DIGESTS"]), os.environ["GITHUB_SHA"], os.environ["GITHUB_REPOSITORY"])
