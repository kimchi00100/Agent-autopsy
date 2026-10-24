import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { resolveDataDir } from './paths.js';

let cachedSecretKey: string | null = null;

/**
 * Returns a persistent installation secret key used for HMAC signatures.
 * Automatically generated and securely stored in dataDir upon first use.
 */
export function getInstallationSecretKey(): string {
  if (cachedSecretKey) return cachedSecretKey;
  if (process.env.AUTOPSY_SIGNING_KEY && process.env.AUTOPSY_SIGNING_KEY.trim()) {
    cachedSecretKey = process.env.AUTOPSY_SIGNING_KEY.trim();
    return cachedSecretKey;
  }
  const dataDir = resolveDataDir();
  const keyPath = path.join(dataDir, '.auth_secret');
  try {
    if (fs.existsSync(keyPath)) {
      const existing = fs.readFileSync(keyPath, 'utf8').trim();
      if (existing.length >= 32) {
        cachedSecretKey = existing;
        return cachedSecretKey;
      }
    }
  } catch {}

  const newKey = crypto.randomBytes(32).toString('hex');
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(keyPath, newKey, { mode: 0o600 });
  } catch {}
  cachedSecretKey = newKey;
  return cachedSecretKey;
}

/**
 * Signs an approval payload with the installation secret key.
 */
export function signApprovalPayload(proposalId: string, patchHash: string, baseHeadSha: string): string {
  const secret = getInstallationSecretKey();
  return crypto.createHmac('sha256', secret).update(`${proposalId}:${patchHash}:${baseHeadSha}`).digest('hex');
}

/**
 * Verifies an approval signature against the installation secret key.
 */
export function verifyApprovalSignature(
  proposalId: string,
  patchHash: string,
  baseHeadSha: string,
  signature?: string
): boolean {
  if (!signature || typeof signature !== 'string') return false;
  const expected = signApprovalPayload(proposalId, patchHash, baseHeadSha);
  try {
    const a = Buffer.from(signature, 'hex');
    const b = Buffer.from(expected, 'hex');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
