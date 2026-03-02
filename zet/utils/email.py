import logging
import os
import smtplib
from email.message import EmailMessage

logger = logging.getLogger(__name__)

_smtp_host = os.environ.get("ZET_LIVE_SMTP_HOST", "")
_smtp_port = int(os.environ.get("ZET_LIVE_SMTP_PORT", "587"))
_smtp_user = os.environ.get("ZET_LIVE_SMTP_USER", "")
_smtp_pass = os.environ.get("ZET_LIVE_SMTP_PASS", "")
_feedback_email = os.environ.get("ZET_LIVE_FEEDBACK_EMAIL", "")


def send_feedback_email(subject: str, body: str) -> bool:
    """Send a feedback email. Returns True if sent, False otherwise.

    No-op if SMTP env vars are not configured.
    """
    if not _smtp_host or not _smtp_user or not _smtp_pass or not _feedback_email:
        return False

    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = _feedback_email
    msg["To"] = _feedback_email
    msg.set_content(body)

    try:
        with smtplib.SMTP(_smtp_host, _smtp_port, timeout=10) as server:
            server.starttls()
            server.login(_smtp_user, _smtp_pass)
            server.send_message(msg)
        logger.info(f"Feedback email sent: {subject}")
        return True
    except Exception as e:
        logger.error(f"Failed to send feedback email: {e}")
        return False
