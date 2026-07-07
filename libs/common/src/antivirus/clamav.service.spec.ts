import { ClamAvService, type ScanResult } from './clamav.service';
import type { Env } from '../config/env.schema';

const envWith = (over: Partial<Env>): Env =>
  ({ CLAMAV_ENABLED: false, CLAMAV_HOST: 'localhost', CLAMAV_PORT: 3310, ...over }) as unknown as Env;

describe('ClamAvService.parseResponse', () => {
  it('reads a clean stream reply', () => {
    const r: ScanResult = ClamAvService.parseResponse('stream: OK\0');
    expect(r).toEqual({ clean: true });
  });

  it('reads an infected stream reply and extracts the signature', () => {
    const r = ClamAvService.parseResponse('stream: Eicar-Test-Signature FOUND\0');
    expect(r.clean).toBe(false);
    expect(r.signature).toBe('Eicar-Test-Signature');
  });

  it('tolerates whitespace/newlines around the reply', () => {
    expect(ClamAvService.parseResponse(' stream: OK \n').clean).toBe(true);
  });

  it('throws on an ERROR or unexpected reply', () => {
    expect(() => ClamAvService.parseResponse('stream: INSTREAM size limit exceeded ERROR')).toThrow();
    expect(() => ClamAvService.parseResponse('')).toThrow();
  });
});

describe('ClamAvService config', () => {
  it('is disabled by default (dev/test)', () => {
    expect(new ClamAvService(envWith({})).enabled).toBe(false);
  });

  it('reflects CLAMAV_ENABLED', () => {
    expect(new ClamAvService(envWith({ CLAMAV_ENABLED: true })).enabled).toBe(true);
  });
});
