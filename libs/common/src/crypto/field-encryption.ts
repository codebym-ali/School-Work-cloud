import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM field encryption (blueprint §32). Replaces AWS KMS on this stack:
 * the 32-byte master key lives in a Coolify secret (ENCRYPTION_MASTER_KEY).
 *
 * Wire format (base64):  v1.<iv>.<authTag>.<ciphertext>
 * The version prefix lets us rotate the algorithm/key without ambiguity.
 *
 * NOTE (§32): the blueprint scopes data keys per tenant via KMS. On R2/Coolify we
 * start with one master key; per-tenant subkeys (HKDF over schoolId) are a
 * follow-up before storing production PII — tracked, not silently skipped.
 */
const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const VERSION = 'v1';

export class FieldEncryption {
  private readonly key: Buffer;

  constructor(masterKeyBase64: string) {
    const key = Buffer.from(masterKeyBase64, 'base64');
    if (key.length !== 32) {
      throw new Error('ENCRYPTION_MASTER_KEY must decode to 32 bytes');
    }
    this.key = key;
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(IV_LEN);
    const cipher = createCipheriv(ALGO, this.key, iv);
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [VERSION, iv.toString('base64'), tag.toString('base64'), ct.toString('base64')].join('.');
  }

  decrypt(wire: string): string {
    const [version, ivB64, tagB64, ctB64] = wire.split('.');
    if (version !== VERSION) throw new Error(`Unsupported ciphertext version: ${version}`);
    const decipher = createDecipheriv(ALGO, this.key, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString(
      'utf8',
    );
  }
}
