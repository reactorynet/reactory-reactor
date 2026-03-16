import * as crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;
const PREFIX = 'enc:';

/**
 * Derives a 32-byte key from the configured credential encryption key.
 */
function deriveKey(): Buffer {
  const raw = process.env.REACTORY_CREDENTIAL_KEY;
  if (!raw) {
    throw new Error('REACTORY_CREDENTIAL_KEY environment variable is not set');
  }
  return crypto.createHash('sha256').update(raw).digest();
}

/**
 * Encrypts a plaintext credential string using AES-256-GCM.
 * Returns a string in the format `enc:{iv}:{authTag}:{ciphertext}` (base64 encoded).
 */
export function encryptCredential(plaintext: string): string {
  const key = deriveKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()] as any);
  const authTag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString('base64')}:${authTag.toString('base64')}:${encrypted.toString('base64')}`;
}

/**
 * Decrypts a credential string produced by `encryptCredential`.
 */
export function decryptCredential(ciphertext: string): string {
  if (!ciphertext.startsWith(PREFIX)) {
    return ciphertext; // not encrypted, return as-is
  }
  const key = deriveKey();
  const parts = ciphertext.slice(PREFIX.length).split(':');
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted credential format');
  }
  const [ivB64, tagB64, dataB64] = parts;
  const iv = Buffer.from(ivB64, 'base64');
  const authTag = Buffer.from(tagB64, 'base64');
  const encrypted = Buffer.from(dataB64, 'base64');

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return decipher.update(encrypted) + decipher.final('utf8');
}

/**
 * Encrypts all string values in a credentials object.
 * Non-string values are passed through unchanged.
 */
export function encryptCredentials(credentials: Record<string, any>): Record<string, any> {
  const result: Record<string, any> = {};
  for (const [key, value] of Object.entries(credentials)) {
    result[key] = typeof value === 'string' && value.length > 0
      ? encryptCredential(value)
      : value;
  }
  return result;
}

/**
 * Decrypts all encrypted string values in a credentials object.
 */
export function decryptCredentials(credentials: Record<string, any>): Record<string, any> {
  const result: Record<string, any> = {};
  for (const [key, value] of Object.entries(credentials)) {
    result[key] = typeof value === 'string' && value.startsWith(PREFIX)
      ? decryptCredential(value)
      : value;
  }
  return result;
}

/**
 * Redacts encrypted credential values for safe display (e.g., in GraphQL responses).
 * Returns the same object shape with encrypted values replaced by '••••••••'.
 */
export function redactCredentials(credentials: Record<string, any>): Record<string, any> {
  const result: Record<string, any> = {};
  for (const [key, value] of Object.entries(credentials)) {
    if (typeof value === 'string' && value.startsWith(PREFIX)) {
      result[key] = '••••••••';
    } else if (key.toLowerCase().includes('key') || key.toLowerCase().includes('secret') || key.toLowerCase().includes('token')) {
      result[key] = '••••••••';
    } else {
      result[key] = value;
    }
  }
  return result;
}
