import crypto from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(crypto.scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: crypto.ScryptOptions,
) => Promise<Buffer>;

/**
 * scrypt parameters. N=2^15 with r=8 costs roughly 32 MB and ~100 ms per hash
 * on the pilot host, which is a reasonable brute-force cost for an on-premises
 * console without pulling in a native dependency. `maxmem` must be raised
 * above Node's 32 MB default or scrypt refuses these parameters.
 */
const COST = 15;
const BLOCK_SIZE = 8;
const PARALLELISM = 1;
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;
const MAX_MEM = 128 * (1 << COST) * BLOCK_SIZE * 2;

/** Encodes as `scrypt$N$r$p$salt$hash`, so parameters can change without breaking old hashes. */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(SALT_LENGTH);
  const derived = await scrypt(password.normalize("NFKC"), salt, KEY_LENGTH, {
    N: 1 << COST, r: BLOCK_SIZE, p: PARALLELISM, maxmem: MAX_MEM,
  });
  return `scrypt$${COST}$${BLOCK_SIZE}$${PARALLELISM}$${salt.toString("base64")}$${derived.toString("base64")}`;
}

/**
 * Constant-time verification. Returns false rather than throwing for any
 * malformed stored value, so a corrupt row cannot turn into a 500 that
 * distinguishes it from a wrong password.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  try {
    const parts = stored.split("$");
    if (parts.length !== 6 || parts[0] !== "scrypt") return false;
    const cost = Number(parts[1]);
    const blockSize = Number(parts[2]);
    const parallelism = Number(parts[3]);
    if (!Number.isInteger(cost) || cost < 12 || cost > 20) return false;
    if (!Number.isInteger(blockSize) || blockSize < 1 || blockSize > 32) return false;
    if (!Number.isInteger(parallelism) || parallelism < 1 || parallelism > 16) return false;
    const salt = Buffer.from(parts[4]!, "base64");
    const expected = Buffer.from(parts[5]!, "base64");
    if (!salt.length || !expected.length) return false;
    const derived = await scrypt(password.normalize("NFKC"), salt, expected.length, {
      N: 1 << cost, r: blockSize, p: parallelism, maxmem: 128 * (1 << cost) * blockSize * 2,
    });
    return crypto.timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

/**
 * Burns roughly the same CPU as a real verification. Called when the email does
 * not exist so that login response time does not reveal which accounts are real.
 */
export async function fakeVerify(): Promise<void> {
  await scrypt("nexora-timing-equalizer", Buffer.alloc(SALT_LENGTH), KEY_LENGTH, {
    N: 1 << COST, r: BLOCK_SIZE, p: PARALLELISM, maxmem: MAX_MEM,
  });
}
