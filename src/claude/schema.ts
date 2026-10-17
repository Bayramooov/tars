/** Hard cap on the control action's `reason` (~25 tokens worst case). */
const REASON_MAX_LENGTH = 100;

/**
 * JSON Schema Claude Code enforces on the turn-end `StructuredOutput`. It must
 * stay a flat object — the API rejects top-level `oneOf`/`anyOf` — so "reason
 * is required on stop/skip" is enforced client-side by `parseControlAction`.
 */
export const CONTROL_ACTION_SCHEMA = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['stop', 'skip', 'heartbeat'],
      description:
        "What to do after this turn. 'stop' is valid only after a reply was delivered via telegram_send_message or telegram_reply_to_message — " +
        'plain text blocks are never shown to the user. ' +
        "'skip' means deliberately sending nothing (group chatter not addressed to you, or the user explicitly asked for no reply).",
    },
    reason: {
      type: 'string',
      maxLength: REASON_MAX_LENGTH,
      description:
        'Terse justification (≤10 words). ' +
        "REQUIRED non-empty when action is 'stop' or 'skip'. " +
        "Optional (may be omitted) when action is 'heartbeat'.",
    },
  },
  required: ['action'],
  additionalProperties: false,
} as const;
