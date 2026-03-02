import { useState } from "react";
import { getHttpUrl } from "./url";
import "./Feedback.css";

export function FeedbackForm() {
  const [message, setMessage] = useState("");
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [status, setStatus] = useState<{
    type: "success" | "error";
    text: string;
  } | null>(null);

  const handleSubmit = async () => {
    if (!message.trim() || submitting) return;

    setSubmitting(true);
    setStatus(null);

    const body: { message: string; email?: string } = {
      message: message.trim(),
    };
    if (email.trim()) {
      body.email = email.trim();
    }

    try {
      const response = await fetch(getHttpUrl("api/feedback"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await response.json();

      if (response.ok) {
        setStatus({ type: "success", text: data.message || "Hvala na poruci!" });
        setMessage("");
        setEmail("");
      } else {
        setStatus({
          type: "error",
          text: data.error || "Greška pri slanju.",
        });
      }
    } catch {
      setStatus({ type: "error", text: "Greška pri slanju." });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="feedback-form">
      <h4>Povratna informacija</h4>
      {status && (
        <div className={`feedback-status feedback-status-${status.type}`}>
          {status.text}
        </div>
      )}
      <textarea
        className="feedback-textarea"
        placeholder="Vaša poruka..."
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        maxLength={1000}
        disabled={submitting}
      />
      <input
        className="feedback-email"
        type="email"
        placeholder="E-mail (ako želite odgovor)"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        maxLength={100}
        disabled={submitting}
      />
      <div className="feedback-footer">
        <span className="feedback-char-count">{message.length}/1000</span>
        <button
          className="feedback-submit"
          onClick={handleSubmit}
          disabled={!message.trim() || submitting}
        >
          {submitting ? "Slanje..." : "Pošalji"}
        </button>
      </div>
    </div>
  );
}
