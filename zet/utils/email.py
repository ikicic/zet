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
_feedback_file = os.environ.get("ZET_LIVE_FEEDBACK_FILE", "")


def send_feedback_email(subject: str, body: str) -> bool:
    """Send feedback, or append it to the configured local test file.

    Returns False if delivery fails or SMTP env vars are not configured.
    ZET_LIVE_FEEDBACK_FILE takes precedence over SMTP when set.
    """
    if _feedback_file:
        try:
            with open(_feedback_file, "a", encoding="utf-8") as file:
                file.write(f"Subject: {subject}\n\n{body}\n\n")
            return True
        except OSError:
            logger.exception("Failed to write feedback file")
            return False

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
