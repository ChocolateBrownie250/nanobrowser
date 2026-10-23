// Errors of provider calls, ported from the current Nanobrowser's src/background/llm/errors.ts, with what retries and
// overflow detection need.
import { APICallError, LoadAPIKeyError, RetryError } from 'ai';

/** The last underlying error of a `RetryError`, or the error itself. */
export function unwrapError(error: unknown): unknown {
  if (RetryError.isInstance(error) && error.lastError !== undefined) return error.lastError;
  return error;
}

export function getApiCallStatusCode(error: unknown): number | undefined {
  const unwrapped = unwrapError(error);
  return APICallError.isInstance(unwrapped) ? unwrapped.statusCode : undefined;
}

export function getApiCallResponseBody(error: unknown): string | undefined {
  const unwrapped = unwrapError(error);
  return APICallError.isInstance(unwrapped) ? unwrapped.responseBody : undefined;
}

export function isMissingApiKeyError(error: unknown): boolean {
  return LoadAPIKeyError.isInstance(unwrapError(error));
}

/** What the user sees when a provider has no key: the SDK's own text names Anthropic and an environment variable. */
export const NO_API_KEY = 'No API key is set for this provider.';

/**
 * The reason a JSON error body gives, whichever shape the vendor uses: `{ error: { message } }` (Anthropic, OpenAI),
 * Z.ai's `{ code, msg, success }` envelope, or a bare `{ message }`. Undefined for a body that is not JSON or has none.
 */
export function bodyReason(body: string | undefined): string | undefined {
  if (!body) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return undefined;
  }
  const o = (json && typeof json === 'object' ? json : {}) as { error?: unknown; msg?: unknown; message?: unknown };
  const nested = o.error && typeof o.error === 'object' ? (o.error as { message?: unknown }).message : o.error;
  for (const value of [nested, o.msg, o.message]) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

/** The error's message with its response body, for overflow matching and for the user. */
export function errorText(error: unknown): string {
  const unwrapped = unwrapError(error);
  if (isMissingApiKeyError(unwrapped)) return NO_API_KEY;
  const message = (unwrapped instanceof Error ? unwrapped.message : String(unwrapped)).trim();
  const body = getApiCallResponseBody(unwrapped)?.trim();
  if (!body) return message;
  // The SDK reads only `error.message`: a body in another shape (Z.ai's `msg`) is read here, so the reason is not lost
  // behind raw JSON and an empty message does not leave a leading space.
  const reason = bodyReason(body);
  return [message, reason && !message.includes(reason) ? reason : '', message.includes(body) ? '' : body]
    .filter(Boolean)
    .join(' ');
}

/** The model did not answer in time: nothing arrived for the allowed time. Retryable like a network failure. */
export class ModelTimeoutError extends TypeError {
  constructor(seconds: number, started: boolean) {
    super(
      started
        ? `The model stopped answering: nothing arrived for ${seconds} seconds.`
        : `The model did not answer within ${seconds} seconds.`,
    );
    this.name = 'ModelTimeoutError';
  }
}

/**
 * A 429 that is not a rate limit: the account has no balance, quota or package left, or its usage limit is reached
 * (Z.ai's 1113, 1308, 1309 and 1310, OpenAI's insufficient_quota). Waiting a few seconds cannot fix it, so it is not
 * retried; a per-minute quota that says when to try again is still a rate limit.
 */
export function isQuotaExhausted(error: unknown): boolean {
  const unwrapped = unwrapError(error);
  if (!APICallError.isInstance(unwrapped) || unwrapped.statusCode !== 429) return false;
  const text = errorText(unwrapped);
  if (
    /insufficient[ _](balance|quota|funds|credits?)|resource package|usage limit|"code"\s*:\s*"?(1113|1308|1309|1310)\b/i.test(
      text,
    )
  ) {
    return true;
  }
  return /exceeded your current quota/i.test(text) && !/per ?minute|retry in|try again in/i.test(text);
}

/** Rate limits, server errors and network failures are retried; other client errors, and a spent quota, are not. */
export function isRetryable(error: unknown): boolean {
  const unwrapped = unwrapError(error);
  if (unwrapped instanceof Error && unwrapped.name === 'AbortError') return false;
  if (APICallError.isInstance(unwrapped)) {
    const status = unwrapped.statusCode;
    if (status === undefined) return unwrapped.isRetryable;
    if (status === 429) return !isQuotaExhausted(unwrapped);
    return status === 408 || status === 409 || status >= 500;
  }
  // fetch rejects with a TypeError on network failures.
  return unwrapped instanceof TypeError;
}

/** The delay a `Retry-After` (seconds or a date) or `retry-after-ms` header asks for, in milliseconds. */
export function retryAfterMs(error: unknown, now = Date.now()): number | undefined {
  const unwrapped = unwrapError(error);
  if (!APICallError.isInstance(unwrapped)) return undefined;
  const headers = unwrapped.responseHeaders ?? {};
  const get = (name: string) => Object.entries(headers).find(([k]) => k.toLowerCase() === name)?.[1];
  const ms = Number(get('retry-after-ms'));
  if (Number.isFinite(ms) && ms >= 0) return ms;
  const value = get('retry-after');
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

/** A refused request from a local server's CORS or origin check: no status, or 403 with no body. */
export function isOriginRefused(error: unknown): boolean {
  const unwrapped = unwrapError(error);
  if (unwrapped instanceof TypeError) return true;
  return getApiCallStatusCode(unwrapped) === 403;
}

/** A time limit joined to an optional caller's signal: the signal ends at whichever comes first. */
export interface Deadline {
  signal: AbortSignal;
  /** The limit ran out (rather than the caller's signal ending the request). */
  timedOut: () => boolean;
  /** Stops the clock; call it when the request is over. */
  done: () => void;
}

export function withDeadline(ms: number, caller?: AbortSignal): Deadline {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException(`No answer within ${Math.round(ms / 1000)} seconds`, 'TimeoutError'));
  }, ms);
  const onCaller = () => controller.abort(caller?.reason);
  if (caller?.aborted) onCaller();
  else caller?.addEventListener('abort', onCaller, { once: true });
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    done: () => {
      clearTimeout(timer);
      caller?.removeEventListener('abort', onCaller);
    },
  };
}
