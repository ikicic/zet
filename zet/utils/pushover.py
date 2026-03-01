import json
import logging
import os
import time
import urllib.request

logger = logging.getLogger(__name__)

PUSHOVER_API_URL = "https://api.pushover.net/1/messages.json"

_pushover_user = os.environ.get("PUSHOVER_USER", "")
_pushover_token = os.environ.get("PUSHOVER_TOKEN", "")


def send_notification(title: str, message: str) -> bool:
    """Send a Pushover notification. Returns True if sent, False otherwise.

    No-op if PUSHOVER_USER or PUSHOVER_TOKEN env vars are not set.
    """
    if not _pushover_user or not _pushover_token:
        return False

    payload = json.dumps({
        "token": _pushover_token,
        "user": _pushover_user,
        "title": title,
        "message": message,
    }).encode("utf-8")

    try:
        req = urllib.request.Request(
            PUSHOVER_API_URL,
            data=payload,
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            resp.read()
        logger.info(f"Pushover notification sent: {title}")
        return True
    except Exception as e:
        logger.error(f"Failed to send Pushover notification: {e}")
        return False


class RateLimitedNotifier:
    """Wraps send_notification with a cooldown period."""

    def __init__(self, cooldown: int = 8 * 3600):
        self.cooldown: int = cooldown
        self.last_sent_time: float = 0

    def try_send(self, title: str, message: str) -> bool:
        """Send a notification if enough time has passed since the last one.

        Logs every attempt. Returns True if the notification was actually sent.
        """
        now = time.time()
        elapsed = now - self.last_sent_time
        if elapsed < self.cooldown:
            logger.info(f"Pushover notification suppressed (cooldown): {title}")
            return False

        logger.info(f"Pushover notification attempt: {title}")
        sent = send_notification(title, message)
        if sent:
            self.last_sent_time = now
        return sent
