"use strict";

// This endpoint returns delivery metadata, never the email body or OTP.
async function lookupDelivery(messageId, { fetchImpl = fetch, apiKey = process.env.BREVO_API_KEY } = {}) {
  if (!apiKey) throw new Error("Brevo delivery checks are not configured.");
  if (typeof messageId !== "string" || !messageId || messageId.length > 300) throw new Error("A provider message ID is required.");
  const url = new URL("https://api.brevo.com/v3/smtp/statistics/events");
  url.searchParams.set("messageId", messageId);
  url.searchParams.set("limit", "100");
  url.searchParams.set("days", "90");
  const response = await fetchImpl(url, { headers: { "api-key": apiKey, accept: "application/json" }, signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(response.status === 429
    ? "Brevo is limiting delivery checks. Please wait before trying again."
    : "Brevo delivery information is unavailable. Check the transactional logs in Brevo.");
  const body = await response.json().catch(() => null);
  if (!body || !Array.isArray(body.events)) throw new Error("Brevo returned an unexpected delivery response. Please try again later.");
  const events = body.events.filter(row => row.messageId === messageId).map(row => ({
    event: String(row.event || "unknown").slice(0, 40),
    date: row.date || null,
    reason: String(row.reason || "").replace(/[\w.+-]+@[\w.-]+/g, "[email]").slice(0, 500),
  })).slice(0, 100);
  const delivered = events.some(row => ["delivered", "opened", "uniqueopened", "clicks", "clicked"].includes(row.event.toLowerCase()));
  const rejected = events.some(row => ["blocked", "hardbounce", "softbounce", "error", "invalid", "invalidemail"].includes(row.event.toLowerCase().replace(/[_-]/g, "")));
  return {
    status: delivered ? "delivered" : rejected ? "rejected" : "awaiting_confirmation",
    message: delivered
      ? "The recipient mail server accepted this email. Check Inbox, Spam, and other folders; this does not confirm Inbox placement."
      : rejected ? "The email provider reported a delivery problem. Review the event details and sender authentication in Brevo."
        : "No delivery confirmation is available yet. Provider acceptance alone does not confirm delivery.",
    events,
  };
}

module.exports = { lookupDelivery };
