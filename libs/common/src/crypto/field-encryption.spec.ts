import { createCipheriv, randomBytes } from 'node:crypto';
import { FieldEncryption } from './field-encryption';

/**
 * Per-tenant field encryption (§32, audit 3.1). These pin the two properties the change exists for:
 * a tenant's ciphertext is only decryptable with THAT tenant's derivation, and legacy v1 ciphertext
 * (master key) still decrypts so a re-encryption migration can run without downtime.
 */
describe('FieldEncryption (per-tenant, §32 / audit 3.1)', () => {
  const MASTER = Buffer.alloc(32, 7).toString('base64');
  const enc = new FieldEncryption(MASTER);
  const A = '11111111-1111-1111-1111-111111111111';
  const B = '22222222-2222-2222-2222-222222222222';

  it('rejects a master key that is not 32 bytes', () => {
    expect(() => new FieldEncryption(Buffer.alloc(16).toString('base64'))).toThrow(/32 bytes/);
  });

  it('round-trips under the same tenant and writes a v2 wire', () => {
    const wire = enc.encrypt('JHSK5FORWARDSECRET', A);
    expect(wire.startsWith('v2.')).toBe(true);
    expect(enc.decrypt(wire, A)).toBe('JHSK5FORWARDSECRET');
  });

  it('requires a scopeId to encrypt and to decrypt v2', () => {
    expect(() => enc.encrypt('x', '')).toThrow(/scopeId is required/);
    const wire = enc.encrypt('secret', A);
    expect(() => enc.decrypt(wire)).toThrow(/scopeId is required/);
  });

  it('CANNOT decrypt one tenant\'s ciphertext with another tenant\'s key (isolation)', () => {
    const wire = enc.encrypt('tenant-A-only', A);
    // GCM auth-tag verification fails under B's derived key → throws, never returns plaintext.
    expect(() => enc.decrypt(wire, B)).toThrow();
    expect(enc.decrypt(wire, A)).toBe('tenant-A-only');
  });

  it('produces distinct ciphertext per tenant for the same plaintext', () => {
    const a = enc.encrypt('same', A);
    const b = enc.encrypt('same', B);
    expect(a).not.toBe(b);
  });

  it('still decrypts legacy v1 (master-key) ciphertext, schoolId irrelevant', () => {
    // Build a v1 wire exactly as the previous implementation would have.
    const master = Buffer.from(MASTER, 'base64');
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', master, iv);
    const ct = Buffer.concat([c.update('legacy-value', 'utf8'), c.final()]);
    const v1 = ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), ct.toString('base64')].join('.');

    expect(enc.decrypt(v1)).toBe('legacy-value'); // no schoolId needed
    expect(enc.decrypt(v1, A)).toBe('legacy-value'); // schoolId ignored for v1
  });

  it('rejects an unknown version', () => {
    expect(() => enc.decrypt('v9.a.b.c', A)).toThrow(/Unsupported ciphertext version/);
  });
});
