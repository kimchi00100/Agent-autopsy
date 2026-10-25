import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { resolveDataDir } from './paths.js';
import { FileChange } from '../types.js';

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
 * Deterministically computes the SHA-256 hash of the exact file changes to be applied.
 * Normalizes file paths and replacements to prevent semantic drift.
 */
export function hashFileChanges(changes: FileChange[]): string {
  const sorted = [...changes].sort((a, b) => a.filePath.localeCompare(b.filePath));
  const normalized = sorted.map((c) => ({
    filePath: c.filePath.replace(/\\/g, '/'),
    replacements: (c.replacements || []).map((r) => ({
      search: r.search,
      replace: r.replace,
    })),
    newContent: c.newContent || null,
  }));
  return crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
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

/**
 * Signs a project's test command to prevent unauthorized direct database tampering.
 */
export function signTestCommand(projectId: string, testCommand: string): string {
  const secret = getInstallationSecretKey();
  return crypto.createHmac('sha256', secret).update(`testcmd:${projectId}:${testCommand}`).digest('hex');
}

/**
 * Verifies the cryptographic signature of a project's test command.
 */
export function verifyTestCommandSignature(
  projectId: string,
  testCommand: string,
  signature?: string
): boolean {
  if (!signature || typeof signature !== 'string') return false;
  const expected = signTestCommand(projectId, testCommand);
  try {
    const a = Buffer.from(signature, 'hex');
    const b = Buffer.from(expected, 'hex');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/**
 * Genesis block prev_hash for the audit_log hash chain.
 */
export const GENESIS_PREV_HASH = '0000000000000000000000000000000000000000000000000000000000000000';

/**
 * Computes deterministic SHA-256 hash of an audit log event payload.
 */
export function hashAuditPayload(payload: any): string {
  if (typeof payload === 'string') {
    return crypto.createHash('sha256').update(payload).digest('hex');
  }
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

/**
 * Computes HMAC-SHA256 entry_hash for an audit_log entry using the installation secret key.
 * Formats: prev_hash + 나머지 필드 (seq, created_at, kind, entity_type, entity_id, payload_hash).
 */
export function computeAuditEntryHash(
  secretKey: string,
  entry: {
    prev_hash: string;
    seq: number;
    created_at: string;
    kind: string;
    entity_type: string;
    entity_id: string;
    payload_hash: string;
  }
): string {
  const content = `${entry.prev_hash}:${entry.seq}:${entry.created_at}:${entry.kind}:${entry.entity_type}:${entry.entity_id}:${entry.payload_hash}`;
  return crypto.createHmac('sha256', secretKey).update(content).digest('hex');
}
