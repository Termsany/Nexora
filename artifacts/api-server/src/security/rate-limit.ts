type Bucket = { attempts: number[] };
const buckets = new Map<string, Bucket>();

function consume(key: string, limit: number, windowMs: number, now = Date.now()) {
  const bucket = buckets.get(key) ?? { attempts: [] };
  bucket.attempts = bucket.attempts.filter((time) => time > now - windowMs);
  if (bucket.attempts.length >= limit) return Math.max(1, Math.ceil((bucket.attempts[0]! + windowMs - now) / 1000));
  bucket.attempts.push(now); buckets.set(key, bucket); return 0;
}

export function checkLoginRate(ip: string, email: string) {
  const windowMs = 15 * 60 * 1000;
  const ipRetry = consume(`ip:${ip}`, 30, windowMs);
  const accountRetry = consume(`account:${email}`, 8, windowMs);
  return Math.max(ipRetry, accountRetry);
}

export function resetLoginRateForTests() { buckets.clear(); }
