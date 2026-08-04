import { test, expect } from '@playwright/test';
import { gotoApp } from './helpers';

/**
 * The upload half of proof-of-payment, driven from a real browser.
 *
 * This **has** to be a browser test. Every other step is covered by `fees.e2e-spec` against the
 * service, but the upload is a **direct PUT from the page to object storage** — the one part of
 * the whole feature that depends on the bucket's CORS configuration. An integration test posts
 * a key the server already trusts and would pass happily even if no browser on earth could
 * complete the upload.
 *
 * It deliberately does not create invoices or payments: this tenant is the operator's own demo,
 * and a payment is immutable once written (correcting one means a reversal, not a delete). The
 * money path is proven in the integration suite where the tenant is disposable.
 */
test.describe('proof of payment — upload', () => {
  test('a file uploaded from the browser is scanned, promoted, and comes back as a key', async ({ page }) => {
    test.setTimeout(60_000);
    await gotoApp(page, '/fees');

    const result = await page.evaluate(async (b64: string) => {
      const csrf = document.cookie.match(/(?:^|;\s*)csrf=([^;]+)/)?.[1] ?? '';
      const json = (r: Response) => r.json();
      const post = (path: string, body: unknown) =>
        fetch(`/api/v1${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': decodeURIComponent(csrf) },
          credentials: 'include',
          body: JSON.stringify(body),
        }).then(json);

      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const file = new File([bytes], 'transfer.png', { type: 'image/png' });

      const presign = await post('/uploads', { filename: file.name, mimeType: file.type });
      if (!presign?.url) return { step: 'presign', detail: JSON.stringify(presign) };

      // THE step under test: a cross-origin PUT straight to storage from the page.
      let put: Response;
      try {
        put = await fetch(presign.url, { method: 'PUT', body: file, headers: { 'Content-Type': file.type } });
      } catch (e) {
        // A CORS rejection surfaces here as an opaque TypeError, so name it explicitly rather
        // than letting it read as "the network was down".
        return { step: 'PUT (likely CORS on the bucket)', detail: String(e) };
      }
      if (!put.ok) return { step: 'PUT', detail: `${put.status} ${put.statusText}` };

      const confirmed = await post('/uploads/confirm', { key: presign.key, mimeType: file.type });
      return { step: 'done', fileKey: confirmed?.fileKey, detail: JSON.stringify(confirmed) };
    }, PNG_1PX_BASE64);

    // Named so a failure says WHICH step broke — presign, the cross-origin PUT, or the scan.
    expect(result.step, `upload failed at: ${result.step} — ${result.detail}`).toBe('done');
    // Promoted out of quarantine into the tenant's own prefix: proof the virus scan passed and
    // the object was moved, not merely accepted.
    expect(result.fileKey).toMatch(/^uploads\/[0-9a-f-]{36}\//);
    expect(result.fileKey).not.toContain('quarantine/');
  });
});

/** Smallest valid PNG — real magic bytes, so the server's content check passes honestly. */
const PNG_1PX_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
