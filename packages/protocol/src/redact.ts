/**
 * Redaction rules applied before anything leaves the device (logs, network events,
 * UI values) and again on the server before anything is logged or sent to the model.
 *
 * The rules are deliberately conservative: false positives cost a little debugging
 * context, false negatives leak secrets.
 */

export const REDACTED = '[REDACTED]';

/** Object keys / query parameter names whose values are always removed. */
export const SENSITIVE_KEY =
  /pass(word|wd|phrase)?|pwd|secret|token|auth|cookie|session|api[-_]?key|access[-_]?key|private[-_]?key|client[-_]?secret|credential|signature|sig$|otp|mfa|pin(code)?$|cvv|cvc|card[-_]?(number|no)|pan$|iban|ssn|social[-_]?security|bearer|jwt|refresh/i;

/** Header names that are never captured, even when header capture is enabled. */
export const SENSITIVE_HEADER = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token|x-csrf-token|x-xsrf-token)$/i;

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const EMAIL_ONE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const BEARER = /\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const CARD = /\b(?:\d[ -]?){13,19}\b/g;
/** Well-known credential formats, caught even when short (test keys, truncated output). */
const KNOWN_KEY = /\b(sk-ant-[A-Za-z0-9_-]{6,}|sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,})/g;
const LONG_SECRET = /\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{32,}\b/g;
const KEY_VALUE = new RegExp(
  `(["']?)(${SENSITIVE_KEY.source})\\1(\\s*[:=]\\s*)("[^"]*"|'[^']*'|[^\\s,;&}]+)`,
  'gi',
);

function luhn(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

export interface RedactOptions {
  /** Mask email addresses (default true). */
  emails?: boolean;
}

/** Redact secrets that appear inside free-form text (log lines, error messages). */
export function redactText(input: string, opts: RedactOptions = {}): string {
  let s = input;
  s = s.replace(JWT, '<jwt>');
  s = s.replace(KNOWN_KEY, '<secret>');
  s = s.replace(BEARER, (_m, scheme: string) => `${scheme} ${REDACTED}`);
  s = s.replace(KEY_VALUE, (_m, q: string, key: string, _inner: unknown, sep: string) => `${q}${key}${q}${sep}${REDACTED}`);
  s = s.replace(CARD, (m) => {
    const digits = m.replace(/\D/g, '');
    return digits.length >= 13 && digits.length <= 19 && luhn(digits) ? '<card>' : m;
  });
  s = s.replace(LONG_SECRET, '<secret>');
  if (opts.emails !== false) s = s.replace(EMAIL, '<email>');
  return s;
}

/**
 * Sanitize a URL: drop userinfo, redact sensitive query values, mask emails and
 * token-like path segments. Works without the WHATWG URL class (partial in RN).
 */
export function redactUrl(url: string): string {
  const m = /^([a-z][a-z0-9+.-]*:\/\/)?([^/?#]*)([^?#]*)(\?[^#]*)?(#.*)?$/i.exec(url);
  if (!m) return redactText(url);
  const scheme = m[1] ?? '';
  let authority = m[2] ?? '';
  const at = authority.lastIndexOf('@');
  if (at >= 0) authority = authority.slice(at + 1);
  const path = (m[3] ?? '')
    .split('/')
    .map((seg) => {
      let decoded = seg;
      try {
        decoded = decodeURIComponent(seg);
      } catch {
        // keep raw segment
      }
      if (EMAIL_ONE.test(decoded)) return '<email>';
      if (/^[A-Za-z0-9_-]{32,}$/.test(seg) && /\d/.test(seg) && /[A-Za-z]/.test(seg)) return '<id>';
      if (/^eyJ/.test(seg) && seg.length > 30) return '<jwt>';
      return seg;
    })
    .join('/');
  let query = m[4] ?? '';
  if (query) {
    query =
      '?' +
      query
        .slice(1)
        .split('&')
        .map((pair) => {
          const eq = pair.indexOf('=');
          const key = eq >= 0 ? pair.slice(0, eq) : pair;
          if (eq < 0) return pair;
          let decodedKey = key;
          try {
            decodedKey = decodeURIComponent(key);
          } catch {
            // keep raw key
          }
          if (SENSITIVE_KEY.test(decodedKey)) return `${key}=${REDACTED}`;
          return `${key}=${redactText(pair.slice(eq + 1))}`;
        })
        .join('&');
  }
  // Fragments often carry OAuth tokens (implicit flow); never keep them.
  const fragment = m[5] ? '#…' : '';
  return `${scheme}${authority}${path}${query}${fragment}`;
}

export interface RedactValueOptions extends RedactOptions {
  maxDepth?: number;
  maxString?: number;
  maxKeys?: number;
}

/** Deep-copy a JSON-like value, removing sensitive keys and secrets in strings. */
export function redactValue(value: unknown, opts: RedactValueOptions = {}, depth = 0): unknown {
  const maxDepth = opts.maxDepth ?? 6;
  const maxString = opts.maxString ?? 2_000;
  const maxKeys = opts.maxKeys ?? 50;
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    const s = redactText(value, opts);
    return s.length > maxString ? `${s.slice(0, maxString)}…(${s.length - maxString} more)` : s;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return `${value.toString()}n`;
  if (typeof value === 'function') return `[Function${value.name ? ` ${value.name}` : ''}]`;
  if (typeof value === 'symbol') return value.toString();
  if (depth >= maxDepth) return Array.isArray(value) ? `[Array(${value.length})]` : '[Object]';
  if (Array.isArray(value)) {
    const out = value.slice(0, maxKeys).map((v) => redactValue(v, opts, depth + 1));
    if (value.length > maxKeys) out.push(`…(${value.length - maxKeys} more)`);
    return out;
  }
  if (value instanceof Error) {
    return { name: value.name, message: redactText(value.message, opts) };
  }
  const out: Record<string, unknown> = {};
  let n = 0;
  for (const key of Object.keys(value as object)) {
    if (n++ >= maxKeys) {
      out['…'] = 'truncated';
      break;
    }
    out[key] = SENSITIVE_KEY.test(key) ? REDACTED : redactValue((value as Record<string, unknown>)[key], opts, depth + 1);
  }
  return out;
}

/** Redact a request/response body string. JSON bodies are redacted structurally. */
export function redactBody(body: string, maxBytes: number): string {
  const trimmed = body.trim();
  if ((trimmed.startsWith('{') || trimmed.startsWith('[')) && trimmed.length < 1_000_000) {
    try {
      const json = JSON.stringify(redactValue(JSON.parse(trimmed)));
      return json.length > maxBytes ? `${json.slice(0, maxBytes)}…` : json;
    } catch {
      // fall through to text redaction
    }
  }
  if (/^[^=&\s]+=[^&]*(&[^=&\s]+=[^&]*)*$/.test(trimmed)) {
    // application/x-www-form-urlencoded
    return redactUrl(`?${trimmed}`).slice(1).slice(0, maxBytes);
  }
  const s = redactText(trimmed);
  return s.length > maxBytes ? `${s.slice(0, maxBytes)}…` : s;
}
