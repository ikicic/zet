import json
import logging
import os
import threading
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
    """Wraps send_notification with a cooldown period.

    When aggregate=False (default), messages during cooldown are suppressed.
    When aggregate=True, messages during cooldown are buffered and sent as a
    single combined notification when the cooldown expires.
    """

    def __init__(self, cooldown: int = 8 * 3600, aggregate: bool = True):
        self.cooldown: int = cooldown
        self.aggregate: bool = aggregate
        self.last_sent_time: float = 0
        self._lock = threading.Lock()
        self._pending: list[str] = []
        self._timer: threading.Timer | None = None

    def try_send(self, title: str, message: str) -> bool:
        """Send a notification if enough time has passed since the last one.

        Logs every attempt. Returns True if the notification was actually sent
        (or scheduled for aggregation).
        """
        if not self.aggregate:
            return self._try_send_simple(title, message)
        return self._try_send_aggregate(title, message)

    def _try_send_simple(self, title: str, message: str) -> bool:
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

    def _try_send_aggregate(self, title: str, message: str) -> bool:
        with self._lock:
            now = time.time()
            elapsed = now - self.last_sent_time
            if elapsed >= self.cooldown:
                # Cooldown expired: collect pending + this message, send now.
                messages = self._pending + [message]
                self._pending = []
                if self._timer is not None:
                    self._timer.cancel()
                    self._timer = None
                self.last_sent_time = now
            else:
                # Cooldown active: buffer and schedule flush.
                self._pending.append(message)
                if self._timer is None:
                    remaining = self.cooldown - elapsed + 1
                    self._timer = threading.Timer(
                        remaining, self._flush_pending, args=(title,))
                    self._timer.daemon = True
                    self._timer.start()
                return True

        # Send outside the lock to avoid blocking.
        combined = _combine_messages(title, messages)
        send_notification(combined[0], combined[1])
        return True

    def _flush_pending(self, title: str):
        with self._lock:
            messages = self._pending
            self._pending = []
            self._timer = None
            self.last_sent_time = time.time()

        if messages:
            combined = _combine_messages(title, messages)
            send_notification(combined[0], combined[1])


def _combine_messages(
    title: str, messages: list[str]
) -> tuple[str, str]:
    if len(messages) == 1:
        return title, messages[0]
    titled = f"{title} ({len(messages)})"
    body = "\n---\n".join(messages)
    if len(body) > 1000:
        body = body[:997] + "..."
    return titled, body
