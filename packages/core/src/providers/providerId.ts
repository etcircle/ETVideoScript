/**
 * The one place a provider shorthand becomes a canonical `<kind>.<name>` id.
 *
 * Two things depend on getting this identical everywhere:
 *
 *   • EXECUTION resolves the adapter by canonical id (`runProvider` → registry), and
 *   • SPEND ATTRIBUTION groups ledger rows by the provider string they were written with.
 *
 * When a route wrote the request body's shorthand (`xai`) while the engine wrote the canonical
 * id (`tts.xai`), one request's lifecycle split across two provider names: a cap on the
 * canonical id never saw the group, and — once `providerEstimatedSpend` began validating fired
 * rows — the same requestId carrying both names is a hard ledger-corrupt error. So the
 * canonicalisation itself is a core primitive, not a per-callsite expression.
 *
 * FAIL CLOSED on a non-string id. The previous per-callsite copies were `id.includes('.')`
 * expressions, which an ARRAY silently survives (`Array.prototype.includes` exists, and
 * `` `tts.${['xai']}` `` stringifies to `tts.xai`) — so a repeated query param or a malformed
 * JSON body was quietly accepted as a provider, and `['a','b']` became the nonsense id
 * `tts.a,b`. A malformed provider is a bad request, and it must be answerable as one before any
 * paid work or ledger write happens.
 */
export class ProviderIdError extends Error {
  readonly code = 'invalid_provider_id';
  readonly received: unknown;
  constructor(message: string, received: unknown) {
    super(message);
    this.name = 'ProviderIdError';
    this.received = received;
  }
}

function describeType(value: unknown): string {
  if (Array.isArray(value)) return 'an array';
  if (value === null) return 'null';
  return `a ${typeof value}`;
}

/**
 * A short, NEVER-THROWING rendering of the offending value for the error message.
 *
 * Building the error must not be able to fail: `JSON.stringify` throws on a BigInt, on a cyclic
 * object, and on any value whose `toJSON` throws — which would replace the typed ProviderIdError
 * a caller is catching (→ 400) with a native TypeError (→ 500) for the same bad request.
 */
function safePreview(value: unknown): string {
  try {
    const json = JSON.stringify(value);
    if (typeof json === 'string') return json.length > 120 ? `${json.slice(0, 119)}…` : json;
  } catch { /* fall through to String() */ }
  try {
    const text = String(value);
    return text.length > 120 ? `${text.slice(0, 119)}…` : text;
  } catch { return '(unprintable value)'; }
}

/**
 * The ONLY definition of "no provider was specified".
 *
 * Exported because callers used to encode it themselves as `provider || 'mock'` or
 * `if (!provider) …`, and truthiness is the wrong test: `false` and `0` are malformed inputs,
 * not omissions, and silently fell through to the configured default — which may be a PAID
 * provider. Ask this, or just hand the raw value to {@link canonicalProviderId}.
 */
export function isAbsentProviderId(id: unknown): id is undefined | null | '' {
  return id === undefined || id === null || id === '';
}

/**
 * Canonicalise a provider reference for `kind`.
 *
 * - absent (`undefined` / `null` / `''`) ⇒ `undefined` (caller falls back to the configured
 *   default provider for the kind — an omitted provider is not an error);
 * - a string already carrying a `.` is returned untouched (it is already `<kind>.<name>`, and a
 *   cross-kind id is the caller's business to reject, not this function's);
 * - any other string is prefixed with `${kind}.`;
 * - anything else — INCLUDING the falsy non-strings `false` and `0` — throws
 *   {@link ProviderIdError}. Deciding "absent" is this function's job precisely so a caller
 *   cannot get it wrong with `||`.
 */
export function canonicalProviderId(kind: string, id?: unknown): string | undefined {
  if (isAbsentProviderId(id)) return undefined;
  if (typeof id !== 'string') {
    throw new ProviderIdError(`Provider must be a string id, received ${describeType(id)}: ${safePreview(id)}`, id);
  }
  return id.includes('.') ? id : `${kind}.${id}`;
}
