// Known-unsafe secret prefixes: repository fallback/dev defaults that must never
// reach a production process. `change-this` also covers the old JWT fallback
// `change-this-local-jwt-secret`; `nexora-local-password` covers the old DB one.
const unsafe = /^(change-this|changeme|development|dev-|local-|test-|example|password|passw0rd|secret|nexora-local-password|insecure)/i;

function assertStrongSecret(name: string, value: string, minLength: number): void {
  if (value.length === 0) throw new Error(`${name} is missing`);
  if (unsafe.test(value)) throw new Error(`${name} uses a known-unsafe development/repository default`);
  if (value.length < minLength) throw new Error(`${name} is too short for production (needs >= ${minLength} chars)`);
  if (/^(.)\1+$/.test(value)) throw new Error(`${name} is not sufficiently random`);
}

function databasePassword(): string {
  const url = process.env.DATABASE_URL ?? "";
  if (url.length === 0) return "";
  try {
    return decodeURIComponent(new URL(url).password);
  } catch {
    throw new Error("DATABASE_URL is not a valid connection URL");
  }
}

// Fail closed on unsafe production configuration. No secret values are logged.
// Development and staging are unaffected (NODE_ENV must be exactly "production"),
// so disposable local/dev credentials remain explicitly supported.
export function validateSecurityConfiguration() {
  if (process.env.NODE_ENV !== "production") return;

  for (const name of ["ADMIN_API_TOKEN", "ENROLLMENT_SECRET"]) {
    assertStrongSecret(name, process.env[name] ?? "", 32);
  }

  assertStrongSecret("JWT_SECRET", process.env.JWT_SECRET ?? "", 32);

  const dbPassword = databasePassword();
  if (dbPassword.length === 0) {
    throw new Error("DATABASE_URL is missing or carries no password in production");
  }
  assertStrongSecret("DATABASE_URL password", dbPassword, 16);
}
