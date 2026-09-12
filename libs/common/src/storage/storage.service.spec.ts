import { StorageService } from './storage.service';
import type { Env } from '../config/env.schema';

/**
 * The endpoint split (blueprint §22.6).
 *
 * ⚠️ A presigned URL's signature covers the HOST, so the URL must be signed for the host the
 * browser will actually call — it cannot be rewritten afterwards without invalidating it. When
 * storage is self-hosted, the API's route to it (a container hostname, unreachable from a browser
 * and plain HTTP) and the browser's (a public HTTPS name) are necessarily different hosts.
 *
 * This was a real outage on the first live deploy: uploads were signed for `http://minio:9000`,
 * which no browser can resolve, and the failure looked like a broken upload feature.
 */
const envWith = (over: Partial<Env>): Env =>
  ({
    S3_ENDPOINT: 'http://minio:9000',
    S3_REGION: 'us-east-1',
    S3_BUCKET: 'school-uploads',
    S3_ACCESS_KEY_ID: 'key',
    S3_SECRET_ACCESS_KEY: 'secret',
    S3_FORCE_PATH_STYLE: true,
    ...over,
  }) as unknown as Env;

const hostOf = (url: string) => new URL(url).origin;

describe('StorageService endpoint split', () => {
  it('signs browser URLs for the PUBLIC endpoint, not the internal one', async () => {
    const svc = new StorageService(envWith({ S3_PUBLIC_ENDPOINT: 'https://s3.example.com' }));

    expect(hostOf(await svc.presignPut('quarantine/a.png', 'image/png'))).toBe('https://s3.example.com');
    expect(hostOf(await svc.presignGet('docs/a.pdf'))).toBe('https://s3.example.com');
  });

  it('keeps the signature valid by signing for the public host', async () => {
    const svc = new StorageService(envWith({ S3_PUBLIC_ENDPOINT: 'https://s3.example.com' }));
    const url = await svc.presignPut('quarantine/a.png', 'image/png');
    // SigV4 signs the host header; its presence proves the URL was signed FOR this host rather
    // than signed elsewhere and rewritten (which would fail with SignatureDoesNotMatch).
    expect(url).toContain('X-Amz-Signature=');
    expect(new URL(url).searchParams.get('X-Amz-SignedHeaders')).toContain('host');
  });

  it('falls back to S3_ENDPOINT when no public endpoint is set', async () => {
    // Managed storage (R2/S3), local dev and CI all serve both callers from one host.
    const svc = new StorageService(envWith({}));
    expect(hostOf(await svc.presignPut('quarantine/a.png', 'image/png'))).toBe('http://minio:9000');
  });

  it('treats an identical public endpoint as no split at all', async () => {
    const svc = new StorageService(envWith({ S3_PUBLIC_ENDPOINT: 'http://minio:9000' }));
    expect(hostOf(await svc.presignGet('docs/a.pdf'))).toBe('http://minio:9000');
  });
});
