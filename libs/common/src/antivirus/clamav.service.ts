import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { connect } from 'node:net';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env.schema';
import { AppError } from '../errors/app.error';
import { ErrorCodes } from '../errors/error-codes';

export interface ScanResult {
  clean: boolean;
  /** Signature name when a threat is found (e.g. `Eicar-Test-Signature`). */
  signature?: string;
}

/**
 * Antivirus scanning via clamd's INSTREAM protocol (blueprint §22.6).
 *
 * Opt-in: with `CLAMAV_ENABLED=false` (dev/test/CI default) `scan()` is skipped by
 * callers via `enabled`. When enabled, the buffer is streamed to clamd over TCP; a
 * connection/scan failure throws (fail-closed) so a suspect file is never waved
 * through when the scanner is down.
 */
@Injectable()
export class ClamAvService {
  private readonly logger = new Logger(ClamAvService.name);
  readonly enabled: boolean;
  private readonly host: string;
  private readonly port: number;

  constructor(@Inject(ENV) env: Env) {
    this.enabled = env.CLAMAV_ENABLED;
    this.host = env.CLAMAV_HOST;
    this.port = env.CLAMAV_PORT;
  }

  /**
   * Parse a clamd INSTREAM reply. Pure + exported for tests.
   *   "stream: OK"                      → clean
   *   "stream: Eicar-Test-Signature FOUND" → infected
   *   "... ERROR"                        → throws
   */
  static parseResponse(raw: string): ScanResult {
    const line = raw.replace(/\0/g, '').trim();
    if (line.endsWith('FOUND')) {
      const sig = line.replace(/^stream:\s*/, '').replace(/\s*FOUND$/, '');
      return { clean: false, signature: sig };
    }
    if (line.endsWith('OK')) return { clean: true };
    throw new Error(`Unexpected clamd response: ${line || '(empty)'}`);
  }

  /** Stream `data` to clamd and report whether it is clean. Throws (fail-closed) on any transport error. */
  async scan(data: Buffer): Promise<ScanResult> {
    const raw = await this.instream(data).catch((err: Error) => {
      this.logger.error(`clamd scan failed (${this.host}:${this.port}): ${err.message}`);
      throw new AppError(
        ErrorCodes.VIRUS_SCAN_UNAVAILABLE,
        HttpStatus.SERVICE_UNAVAILABLE,
        'Virus scanner unavailable — upload rejected',
      );
    });
    return ClamAvService.parseResponse(raw);
  }

  /** Low-level INSTREAM exchange: zINSTREAM\0, length-prefixed chunks, terminating zero-length chunk. */
  private instream(data: Buffer): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket = connect({ host: this.host, port: this.port });
      const chunks: Buffer[] = [];
      socket.setTimeout(15_000);
      socket.on('error', reject);
      socket.on('timeout', () => socket.destroy(new Error('clamd timeout')));
      socket.on('data', (d) => chunks.push(d));
      socket.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      socket.on('connect', () => {
        socket.write('zINSTREAM\0');
        const CHUNK = 64 * 1024;
        for (let i = 0; i < data.length; i += CHUNK) {
          const slice = data.subarray(i, i + CHUNK);
          const size = Buffer.alloc(4);
          size.writeUInt32BE(slice.length, 0);
          socket.write(size);
          socket.write(slice);
        }
        socket.write(Buffer.from([0, 0, 0, 0])); // zero-length chunk ends the stream
      });
    });
  }
}
