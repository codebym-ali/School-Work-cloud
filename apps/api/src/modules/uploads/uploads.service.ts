import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { AppError, ClamAvService, ErrorCodes, StorageService, TenantContext } from '@common';

const ALLOWED: Record<string, { ext: string; magic?: number[] }> = {
  'image/jpeg': { ext: 'jpg', magic: [0xff, 0xd8, 0xff] },
  'image/png': { ext: 'png', magic: [0x89, 0x50, 0x4e, 0x47] },
  'application/pdf': { ext: 'pdf', magic: [0x25, 0x50, 0x44, 0x46] },
  'text/csv': { ext: 'csv' }, // text — no reliable magic signature
};

/**
 * Upload pipeline (blueprint §22.6): client requests a presigned PUT to a quarantine
 * prefix, uploads directly, then confirms — the server validates magic bytes vs the
 * declared MIME (allowlist), then moves the object to the permanent prefix.
 *
 * On confirm: magic-byte + MIME validation, then a ClamAV scan (when enabled) before
 * the object is promoted out of quarantine. An infected file is deleted and rejected.
 */
@Injectable()
export class UploadsService {
  private readonly logger = new Logger(UploadsService.name);

  constructor(
    private readonly storage: StorageService,
    private readonly ctx: TenantContext,
    private readonly clamav: ClamAvService,
  ) {}

  private get sid(): string {
    return this.ctx.requireSchoolId();
  }

  async requestUpload(filename: string, mimeType: string) {
    const spec = ALLOWED[mimeType];
    if (!spec) throw new AppError(ErrorCodes.VALIDATION_FAILED, HttpStatus.UNPROCESSABLE_ENTITY, `MIME type ${mimeType} not allowed`);
    const safe = filename.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 60) || `file.${spec.ext}`;
    const key = `quarantine/${this.sid}/${randomUUID()}-${safe}`;
    const url = await this.storage.presignPut(key, mimeType);
    return { key, url, method: 'PUT', expiresInSeconds: 600, maxBytes: 10 * 1024 * 1024 };
  }

  async confirmUpload(key: string, mimeType: string) {
    if (!key.startsWith(`quarantine/${this.sid}/`)) {
      throw new AppError(ErrorCodes.FORBIDDEN, HttpStatus.FORBIDDEN, 'Key is not in your quarantine prefix');
    }
    const spec = ALLOWED[mimeType];
    if (!spec) throw new AppError(ErrorCodes.VALIDATION_FAILED, HttpStatus.UNPROCESSABLE_ENTITY, `MIME type ${mimeType} not allowed`);
    if (!(await this.storage.exists(key))) {
      throw new AppError(ErrorCodes.NOT_FOUND, HttpStatus.NOT_FOUND, 'Uploaded object not found (was it PUT?)');
    }

    // Fetch the object once; reuse for magic-byte validation and the AV scan.
    const buffer = await this.storage.getObjectBuffer(key);

    // Validate magic bytes against the declared MIME (allowlist), when applicable.
    if (spec.magic) {
      const ok = spec.magic.every((b, i) => buffer[i] === b);
      if (!ok) throw new AppError(ErrorCodes.VALIDATION_FAILED, HttpStatus.UNPROCESSABLE_ENTITY, 'File content does not match its declared type');
    }

    // Virus scan before promotion out of quarantine (§22.6). Skipped when CLAMAV_ENABLED=false.
    if (this.clamav.enabled) {
      const { clean, signature } = await this.clamav.scan(buffer);
      if (!clean) {
        await this.storage.delete(key).catch(() => undefined); // best-effort quarantine cleanup
        this.logger.warn(`Rejected infected upload ${key} (${signature ?? 'unknown'}) for school ${this.sid}`);
        throw new AppError(
          ErrorCodes.FILE_INFECTED,
          HttpStatus.UNPROCESSABLE_ENTITY,
          'File failed the virus scan and was rejected',
        );
      }
    }

    const fileKey = key.replace(`quarantine/${this.sid}/`, `uploads/${this.sid}/`);
    await this.storage.move(key, fileKey);
    return { fileKey };
  }
}
