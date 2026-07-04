import { Injectable, Logger } from '@nestjs/common';
import * as argon2 from 'argon2';
import { createHash } from 'node:crypto';

/**
 * Password hashing + breach check (blueprint §22.3): argon2id (64MB, 3 iters),
 * and a HaveIBeenPwned k-anonymity range check on set/change that soft-fails
 * (logs and allows) if the HIBP API is unreachable.
 */
@Injectable()
export class PasswordService {
  private readonly logger = new Logger(PasswordService.name);

  private static readonly OPTS: argon2.Options = {
    type: argon2.argon2id,
    memoryCost: 65536, // 64 MB
    timeCost: 3,
  };

  hash(plain: string): Promise<string> {
    return argon2.hash(plain, PasswordService.OPTS);
  }

  async verify(hash: string, plain: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, plain);
    } catch {
      return false;
    }
  }

  /** Returns true if the password appears in a known breach corpus (soft-fail => false). */
  async isPwned(plain: string): Promise<boolean> {
    const sha1 = createHash('sha1').update(plain).digest('hex').toUpperCase();
    const prefix = sha1.slice(0, 5);
    const suffix = sha1.slice(5);
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2000);
      const resp = await fetch(`https://api.pwnedpasswords.com/range/${prefix}`, {
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!resp.ok) return false;
      const body = await resp.text();
      return body.split('\n').some((line) => line.split(':')[0].trim() === suffix);
    } catch {
      this.logger.warn('HIBP check unavailable — allowing password (soft-fail per §22.3)');
      return false;
    }
  }
}
