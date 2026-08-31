const unsafe = /^(change-this|development|password|secret|nexora-local-password)/i;

export function validateSecurityConfiguration() {
  if (process.env.NODE_ENV !== "production") return;
  for (const name of ["ADMIN_API_TOKEN", "ENROLLMENT_SECRET"]) {
    const value = process.env[name] ?? "";
    if (value.length < 32 || unsafe.test(value)) throw new Error(`${name} is missing or uses an unsafe production default`);
  }
}
