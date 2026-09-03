export class DeliveryError extends Error {
  code: string;
  retryable: boolean;
  retryAfterSeconds?: number;
  constructor(code: string, message: string, retryable: boolean, retryAfterSeconds?: number) { super(message); this.name = "DeliveryError"; this.code = code; this.retryable = retryable; this.retryAfterSeconds = retryAfterSeconds; }
}

export function sanitizedError(error: unknown) {
  if (error instanceof DeliveryError) return error;
  const code = error instanceof Error && error.name === "AbortError" ? "TIMEOUT" : "NETWORK_ERROR";
  return new DeliveryError(code, code === "TIMEOUT" ? "Delivery timed out" : "External service connection failed", true);
}
