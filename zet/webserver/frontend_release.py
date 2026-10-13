"""Cache the deployed frontend release for WebSocket announcements."""

import json
import logging
import os
from pathlib import Path
import re
import threading
import time


DEFAULT_RELEASE_FILE = Path(__file__).resolve().parents[2] / 'web/BUILD/version.json'
RELEASE_CACHE_SECONDS = 30
logger = logging.getLogger(__name__)
_cache_lock = threading.Lock()
_cached_path: str | None = None
_cached_message: str | None = None
_cached_until = 0.0


def release_message() -> str | None:
    global _cached_path, _cached_message, _cached_until
    path = os.environ.get('ZET_FRONTEND_RELEASE_FILE', str(DEFAULT_RELEASE_FILE))
    # Serialize refreshes so simultaneous connections only cause one disk read.
    # Cache failures too, avoiding repeated reads/logs during a bad deployment.
    with _cache_lock:
        if path != _cached_path or time.monotonic() >= _cached_until:
            message = _read_release(path)
            if message is not None and message != _cached_message:
                logger.info('New frontend version: %s', json.loads(message)['version'])
            _cached_message = message
            _cached_path = path
            _cached_until = time.monotonic() + RELEASE_CACHE_SECONDS
        return _cached_message


def _read_release(path: str) -> str | None:
    try:
        with open(path, encoding='utf-8') as source:
            release = json.loads(source.read(4096))
        if not isinstance(release, dict):
            raise ValueError('expected a release object')
        version = release.get('version')
        if not isinstance(version, str) or not re.fullmatch(r'[a-f0-9]{20}', version):
            raise ValueError('invalid frontend version')
    except FileNotFoundError:
        return None  # No frontend build yet, e.g. local development.
    except (OSError, ValueError) as error:
        logger.warning('Cannot read frontend release %s: %s', path, error)
        return None
    return json.dumps({'type': 'app-version', 'version': version},
                      separators=(',', ':'))
