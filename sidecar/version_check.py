"""
Runtime freshness check for the yt-dlp version floor.

Stdlib-only (no yt_dlp import) so this can run eagerly at sidecar startup
without paying yt_dlp's own import cost for users who never touch YouTube
import. Never blocks/crashes startup: any network or parsing failure is
swallowed and treated as "nothing to report".
"""

import json
import os
import time
import urllib.request
from datetime import datetime

# Keep in sync with the `yt-dlp>=` floor in requirements.txt, and with the
# identical constant in SPS's version_check.py — see MPS wiki
# conventions.md#10 ("yt-dlp version must always match across both
# projects"). Bump this whenever the floor is bumped.
MIN_YT_DLP_VERSION = "2026.7.4"

_CACHE_PATH = os.path.join(os.path.expanduser("~"), ".vps", "yt_dlp_check.json")
_CACHE_TTL_SECONDS = 24 * 3600
_STALE_THRESHOLD_DAYS = 21


def _calendar_date(version: str):
    # yt-dlp uses calendar versioning: YYYY.MM.DD[.postN]. Parsing the
    # version string directly avoids needing PyPI's per-file upload
    # timestamps for this comparison.
    parts = version.split(".")
    if len(parts) < 3:
        return None
    try:
        return datetime(int(parts[0]), int(parts[1]), int(parts[2]))
    except (ValueError, TypeError):
        return None


def check_yt_dlp_freshness() -> "str | None":
    """
    Best-effort: is the pinned floor (MIN_YT_DLP_VERSION) meaningfully
    behind the latest yt-dlp release on PyPI? Cached for a day so this
    only hits the network once per day. Returns an advisory string to
    surface to the app log, or None if there's nothing to report (or the
    check couldn't complete, e.g. offline).
    """
    now = time.time()
    cached_advisory = None
    try:
        with open(_CACHE_PATH, "r") as f:
            cache = json.load(f)
        cached_advisory = cache.get("advisory")
        if now - cache.get("checked_at", 0) < _CACHE_TTL_SECONDS:
            return cached_advisory
    except Exception:
        pass

    advisory = None
    try:
        with urllib.request.urlopen("https://pypi.org/pypi/yt-dlp/json", timeout=3) as resp:
            data = json.loads(resp.read())
        latest = data["info"]["version"]
        floor_date = _calendar_date(MIN_YT_DLP_VERSION)
        latest_date = _calendar_date(latest)
        if floor_date and latest_date and latest != MIN_YT_DLP_VERSION:
            days_behind = (latest_date - floor_date).days
            if days_behind >= _STALE_THRESHOLD_DAYS:
                advisory = (
                    f"yt-dlp freshness check: pinned floor {MIN_YT_DLP_VERSION} is "
                    f"{days_behind}d behind the latest PyPI release {latest}. "
                    "Consider bumping MIN_YT_DLP_VERSION + requirements.txt's yt-dlp "
                    "floor on both VPS and SPS (MPS wiki/conventions.md#10)."
                )
    except Exception:
        # Offline, PyPI unreachable, unexpected response shape, etc. — keep
        # whatever we last knew (possibly None) rather than erroring.
        return cached_advisory

    try:
        os.makedirs(os.path.dirname(_CACHE_PATH), exist_ok=True)
        with open(_CACHE_PATH, "w") as f:
            json.dump({"checked_at": now, "advisory": advisory}, f)
    except Exception:
        pass

    return advisory
