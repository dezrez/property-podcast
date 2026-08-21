/**
 * Logging helpers built around one rule: no credential, access token,
 * Marketplace purchase token or Authorization header ever reaches a log sink.
 *
 * Everything written to logs goes through `safeLog`, which allow-lists the
 * fields it will emit rather than trying to strip the dangerous ones. Deny-lists
 * fail open the first time Microsoft adds a field; allow-lists fail closed.
 */

/** Field names that must never be logged, regardless of nesting. */
const FORBIDDEN = new Set([
  'authorization',
  'access_token',
  'accesstoken',
  'client_secret',
  'clientsecret',
  'token',
  'purchasetoken',
  'purchase_token',
  'x-ms-marketplace-token',
  'id_token',
  'idtoken',
  'refresh_token',
  'secret',
  'password'
]);

export const REDACTED = '[redacted]';

/**
 * Recursively strips forbidden fields. Used as a backstop for objects we did
 * not construct ourselves, such as caught errors.
 */
export function redact(value, depth = 0) {
  if (depth > 6) return '[truncated]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return value;
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1));

  const out = {};
  for (const [key, v] of Object.entries(value)) {
    out[key] = FORBIDDEN.has(key.toLowerCase()) ? REDACTED : redact(v, depth + 1);
  }
  return out;
}

/**
 * Shortens an identifier so it is useful for correlation in a log without
 * being a usable credential or a full customer identifier.
 */
export function fingerprint(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  return `len:${value.length}`;
}

/**
 * Turns any thrown value into something safe and constant-shaped. Error
 * messages from fetch/JSON parsing can embed URLs containing tokens, so only
 * an allow-listed set of properties survives.
 */
export function safeError(err) {
  if (!err) return { kind: 'unknown' };
  if (err instanceof MarketplaceError) {
    return { kind: err.code, status: err.status ?? null };
  }
  if (err instanceof Error) {
    return { kind: err.name || 'Error' };
  }
  return { kind: 'unknown' };
}

/**
 * A structured error with a stable machine-readable code. Callers surface the
 * code, never the underlying provider message, so responses cannot disclose
 * credentials or token contents.
 */
export class MarketplaceError extends Error {
  constructor(code, { status = null, cause = undefined } = {}) {
    super(code);
    this.name = 'MarketplaceError';
    this.code = code;
    this.status = status;
    if (cause !== undefined) this.cause = cause;
  }
}

/**
 * Writes a structured line through the Functions context logger with redaction
 * applied. `context` is the Azure Functions invocation context.
 */
export function safeLog(context, level, message, fields = {}) {
  const line = { message, ...redact(fields) };
  const logger = context && typeof context[level] === 'function' ? context[level] : null;
  if (logger) logger(JSON.stringify(line));
}
