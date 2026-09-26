import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM field encryption (blueprint §32, security audit 3.1). Replaces AWS KMS on this stack:
 * the 32-byte master key lives in a Coolify secret (ENCRYPTION_MASTER_KEY).
 *
 * Wire format (base64):  <version>.<iv>.<authTag>.<ciphertext>
 *   v1 — encrypted directly under the master key (legacy; still DECRYPTED for old rows).
 *   v2 — encrypted under a PER-SCOPE key = HKDF-SHA256(masterKey, salt=scopeId). The `scopeId` is
 *        the owner that ciphertext belongs to: a **schoolId** for tenant data (student CNIC, etc.),
 *        or the **platform operator's id** for vendor-side data (platform_users, which have no
 *        tenant). A leaked or mis-scoped read of one scope's ciphertext cannot be decrypted with
 *        another scope's derivation, and the master key alone no longer decrypts any field.
 *
 * `encrypt` always writes v2 and REQUIRES the scopeId. `decrypt` reads both: v2 needs the scopeId
 * to re-derive the key; v1 ignores it (master key), so pre-existing ciphertext keeps working until
 * the re-encryption migration (`scripts/reencrypt-fields-v2.ts`) rewrites it to v2.
 */
const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const KEY_LEN = 32;
const V1 = 'v1';
const V2 = 'v2';
/** HKDF `info` — domain-separates this derivation from any other use of the master key. */
const HKDF_INFO = Buffer.from('sw-field-encryption-v2');

export class FieldEncryption {
  private readonly masterKey: Buffer;
  /** Per-scope derived keys are pure functions of (masterKey, scopeId) — safe to memoise. */
  private readonly keyCache = new Map<string, Buffer>();

  constructor(masterKeyBase64: string) {
    const key = Buffer.from(masterKeyBase64, 'base64');
    if (key.length !== KEY_LEN) {
      throw new Error('ENCRYPTION_MASTER_KEY must decode to 32 bytes');
    }
    this.masterKey = key;
  }

  /** HKDF-SHA256(masterKey, salt=scopeId, info) → 32-byte per-scope key. */
  private scopeKey(scopeId: string): Buffer {
    if (!scopeId) throw new Error('FieldEncryption: scopeId is required for per-scope encryption');
    const cached = this.keyCache.get(scopeId);
    if (cached) return cached;
    const derived = Buffer.from(hkdfSync('sha256', this.masterKey, Buffer.from(scopeId), HKDF_INFO, KEY_LEN));
    this.keyCache.set(scopeId, derived);
    return derived;
  }

  /** Encrypt `plaintext` under the scope's derived key (always v2). */
  encrypt(plaintext: string, scopeId: string): string {
    const iv = randomBytes(IV_LEN);
    const cipher = createCipheriv(ALGO, this.scopeKey(scopeId), iv);
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [V2, iv.toString('base64'), tag.toString('base64'), ct.toString('base64')].join('.');
  }

  /**
   * Decrypt a wire value. `scopeId` is required to decrypt v2; it is ignored for legacy v1
   * (master-key) ciphertext, so old rows keep working until they are migrated to v2.
   */
  decrypt(wire: string, scopeId?: string): string {
    const [version, ivB64, tagB64, ctB64] = wire.split('.');
    let key: Buffer;
    if (version === V2) {
      if (!scopeId) throw new Error('FieldEncryption: scopeId is required to decrypt v2 ciphertext');
      key = this.scopeKey(scopeId);
    } else if (version === V1) {
      key = this.masterKey;
    } else {
      throw new Error(`Unsupported ciphertext version: ${version}`);
    }
    const decipher = createDecipheriv(ALGO, key, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf8');
  }
}
