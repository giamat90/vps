#!/usr/bin/env python3
"""
Downloads the Demucs pretrained weights for the default-quality model
(htdemucs) into vendor/demucs-models/, so build.py can bundle it into the
frozen sidecar. Without this, the installed app needs internet access on
first use to download ~84MB from Meta's servers into the user's cache dir —
the same class of bug as the ffmpeg-not-bundled issue.

htdemucs_ft (the "high quality" option) is NOT bundled here: it's an
additional 4x84MB, only used when the user opts into high_quality
processing. It still downloads on demand for that path — a known, narrower
gap.

Sigs/URLs are read from the installed demucs package itself (not hardcoded)
so this stays correct across demucs version bumps.

Safe to re-run — skips files that already exist.
Usage: python fetch_models.py
"""
import urllib.request
from pathlib import Path

import yaml
from demucs.pretrained import REMOTE_ROOT, _parse_remote_files

MODELS = ["htdemucs"]
DEST = Path(__file__).parent / "vendor" / "demucs-models"


def main():
    DEST.mkdir(parents=True, exist_ok=True)
    remote_files = _parse_remote_files(REMOTE_ROOT / "files.txt")

    needed_sigs = set()
    for name in MODELS:
        yaml_src = REMOTE_ROOT / f"{name}.yaml"
        bag = yaml.safe_load(yaml_src.read_text())
        needed_sigs.update(bag["models"])
        (DEST / f"{name}.yaml").write_bytes(yaml_src.read_bytes())
        print(f"Staged {name}.yaml (sigs: {bag['models']})")

    for sig in sorted(needed_sigs):
        url = remote_files[sig]
        filename = url.rsplit("/", 1)[-1]
        dest = DEST / filename
        if dest.exists():
            print(f"Already have {filename}, skipping")
            continue
        print(f"Downloading {filename} from {url} ...")
        urllib.request.urlretrieve(url, dest)

    print(f"Done. Vendor dir: {DEST}")


if __name__ == "__main__":
    main()
