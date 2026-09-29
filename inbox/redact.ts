/**
 * Mask what looks like a one-time code or an API key before text is stored or
 * shown. Applied to agent messages, pause requests and human notes alike.
 *
 * Secret replies never reach this: they travel in resume `variables`, which
 * Browserbase substitutes as the agent types and which are never stored here.
 */
export function redact(text: string): string {
  return text
    .replace(/\b(?:bb_live|bb_test|sk-[a-z]*)[-_A-Za-z0-9]{8,}/g, "[redacted key]")
    .replace(/\b\d{6,10}\b/g, "[redacted digits]");
}
