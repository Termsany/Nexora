# Session Security

Console sessions are server-side records. A 32-byte random identifier is sent only in an `HttpOnly` cookie; only its SHA-256 hash is stored. Sessions have a 12-hour absolute lifetime, a 30-minute idle timeout, server-side revocation, and are invalidated on logout or user suspension. Production cookies are Secure and use SameSite protection.

Mutating browser requests require a strict configured Origin plus a signed double-submit CSRF token. Agent and administrative bearer-token requests are not subject to browser CSRF checks. Session APIs expose metadata only and never return raw identifiers.

The frontend stores no password, session identifier, administrative token, Agent credential, or enrollment token in browser storage.
