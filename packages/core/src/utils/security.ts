import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { resolveDataDir } from './paths.js';
import { FileChange, ReproductionLock } from '../types.js';

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

/**
 * Fixed list of fields included in the repair proposal row HMAC signature.
 * Prevents unauthorized SQLite modification of critical fields (code changes, verification status, timestamps, project affiliation).
 */
export const PROPOSAL_SIGNATURE_FIELDS = [
  'id',
  'incident_id',
  'project_id',
  'file_changes_json',
  'verification_status',
  'created_at',
] as const;

export interface ProposalSignaturePayload {
  id: string;
  incident_id: string;
  project_id: string;
  file_changes_json: string;
  verification_status: string;
  created_at: string;
}

/**
 * Computes deterministic HMAC-SHA256 signature for a repair proposal row.
 * Format: id::incident_id::project_id::file_changes_json::verification_status::created_at
 * Delimiter: "::"
 */
export function computeProposalRowSignature(
  secretKey: string,
  fields: ProposalSignaturePayload
): string {
  const payload = [
    fields.id,
    fields.incident_id,
    fields.project_id,
    fields.file_changes_json,
    fields.verification_status,
    fields.created_at,
  ].join('::');
  return crypto.createHmac('sha256', secretKey).update(payload).digest('hex');
}

/**
 * Verifies a proposal row HMAC signature against a secret key using timing-safe comparison.
 */
export function verifyProposalRowSignature(
  secretKey: string,
  fields: ProposalSignaturePayload,
  signature?: string | null
): boolean {
  if (!signature || typeof signature !== 'string') return false;
  const expected = computeProposalRowSignature(secretKey, fields);
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
 * Fixed list of fields included in the incident row HMAC signature.
 * Identity fields: id, project_id, user_report_text, created_at.
 */
export const INCIDENT_SIGNATURE_FIELDS = [
  'id',
  'project_id',
  'user_report_text',
  'created_at',
] as const;

export interface IncidentSignaturePayload {
  id: string;
  project_id: string;
  user_report_text: string;
  created_at: string;
}

/**
 * Computes deterministic HMAC-SHA256 signature for an incident row.
 * Format: id::project_id::user_report_text::created_at
 * Delimiter: "::"
 */
export function computeIncidentRowSignature(
  secretKey: string,
  fields: IncidentSignaturePayload
): string {
  const payload = [
    fields.id,
    fields.project_id,
    fields.user_report_text || '',
    fields.created_at,
  ].join('::');
  return crypto.createHmac('sha256', secretKey).update(payload).digest('hex');
}

/**
 * Verifies an incident row HMAC signature against a secret key using timing-safe comparison.
 */
export function verifyIncidentRowSignature(
  secretKey: string,
  fields: IncidentSignaturePayload,
  signature?: string | null
): boolean {
  if (!signature || typeof signature !== 'string') return false;
  const expected = computeIncidentRowSignature(secretKey, fields);
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
 * Computes deterministic SHA-256 hash of file content after normalizing CRLF line endings to LF.
 */
export function computeNormalizedContentHash(content: string): string {
  const normalized = content.replace(/\r\n/g, '\n');
  return crypto.createHash('sha256').update(normalized, 'utf8').digest('hex');
}

/**
 * Computes deterministic HMAC-SHA256 signature for a reproduction test lock.
 * Payload: testFilePath::contentHash::lockedAt::baselineVerdict::assertFlipVerdict::preFlipFilePath::preFlipContentHash::historyHash
 */
export function computeReproductionLockSignature(
  secretKey: string,
  lock: {
    testFilePath: string;
    contentHash: string;
    lockedAt: string;
    baselineVerdict?: string;
    assertFlipVerdict?: string;
    preFlipFilePath?: string;
    preFlipContentHash?: string;
    history?: any[];
  }
): string {
  const historyHash =
    lock.history && lock.history.length > 0
      ? crypto.createHash('sha256').update(JSON.stringify(lock.history)).digest('hex')
      : '';

  const payload = [
    lock.testFilePath.replace(/\\/g, '/'),
    lock.contentHash,
    lock.lockedAt,
    lock.baselineVerdict || '',
    lock.assertFlipVerdict || '',
    lock.preFlipFilePath ? lock.preFlipFilePath.replace(/\\/g, '/') : '',
    lock.preFlipContentHash || '',
    historyHash,
  ].join('::');
  return crypto.createHmac('sha256', secretKey).update(payload).digest('hex');
}

/**
 * Verifies the cryptographic HMAC signature of a reproduction lock.
 */
export function verifyReproductionLockSignature(
  secretKey: string,
  lock: ReproductionLock
): boolean {
  if (!lock || !lock.signature || typeof lock.signature !== 'string') return false;
  const expected = computeReproductionLockSignature(secretKey, lock);
  try {
    const a = Buffer.from(lock.signature, 'hex');
    const b = Buffer.from(expected, 'hex');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}


