/**
 * A single entry point for every HTTP function.
 *
 * Wraps the whole invocation, not just configuration loading. Anything that
 * escapes — a runtime failure, a body that cannot be read, a bug in a handler —
 * becomes a structured JSON 500 rather than an empty response from the
 * Functions host, which is unreadable without Application Insights.
 *
 * The response carries the error's *constructor name* only (`TypeError`,
 * `MarketplaceError`, …). Never a message, never a value: provider messages can
 * embed request bodies, and request bodies can contain credentials.
 */
import { MarketplaceError, safeError, safeLog } from './logging.js';
import { getRuntime, toHttpResponse } from './runtime.js';

/**
 * @param {string} name      log prefix, e.g. 'marketplace.resolve'
 * @param {(args: {request, context, runtime}) => Promise<{status, body}>} handler
 */
export function httpEntry(name, handler) {
  return async function entry(request, context) {
    try {
      let runtime;
      try {
        runtime = await getRuntime(context);
      } catch (err) {
        safeLog(context, 'error', `${name}.unavailable`, safeError(err));
        return toHttpResponse({
          status: 503,
          body: { error: err instanceof MarketplaceError ? err.code : 'not_configured' }
        });
      }

      return toHttpResponse(await handler({ request, context, runtime }));
    } catch (err) {
      safeLog(context, 'error', `${name}.unhandled`, safeError(err));
      return toHttpResponse({
        status: 500,
        body: { error: 'unhandled', kind: safeError(err).kind }
      });
    }
  };
}

/**
 * Reads a request body as text without letting a transport-level failure
 * escape as an unhandled rejection.
 */
export async function readBody(request) {
  try {
    const text = await request.text();
    return typeof text === 'string' ? text : '';
  } catch {
    throw new MarketplaceError('body_unreadable');
  }
}

/** Header access that tolerates either a Headers object or a plain object. */
export function header(request, name) {
  try {
    if (request && request.headers && typeof request.headers.get === 'function') {
      return request.headers.get(name);
    }
    if (request && request.headers && typeof request.headers === 'object') {
      return request.headers[name] ?? request.headers[name.toLowerCase()] ?? null;
    }
  } catch {
    /* fall through */
  }
  return null;
}
