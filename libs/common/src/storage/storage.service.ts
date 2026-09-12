import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import {
  CopyObjectCommand,
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env.schema';

/**
 * Object storage (blueprint §22.6). One S3-compatible client for both Cloudflare R2
 * (production) and MinIO (local dev) — only endpoint/credentials differ. Server-
 * generated PDFs are put directly; user uploads use presigned PUT to a quarantine
 * prefix, are validated, then moved to the permanent prefix. Reads are 10-min
 * presigned GETs issued after an ownership check.
 */
@Injectable()
export class StorageService implements OnModuleInit {
  private readonly logger = new Logger(StorageService.name);
  private readonly client: S3Client;
  /**
   * A second client that differs from `client` only in its endpoint, used ONLY for signing URLs
   * the browser will call.
   *
   * ⚠️ Two clients rather than one because a presigned URL's signature covers the host — the URL
   * must be SIGNED for the host the browser will reach, and cannot be rewritten afterwards. When
   * storage is self-hosted, the API's own route to it (a container hostname) and the browser's
   * (a public HTTPS name) are necessarily different. When they are the same — R2, S3, local dev,
   * CI — this is the same configuration twice and costs nothing.
   */
  private readonly signingClient: S3Client;
  private readonly bucket: string;

  constructor(@Inject(ENV) env: Env) {
    this.bucket = env.S3_BUCKET;
    const common = {
      region: env.S3_REGION,
      credentials: { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY },
      forcePathStyle: env.S3_FORCE_PATH_STYLE,
    };
    this.client = new S3Client({ ...common, endpoint: env.S3_ENDPOINT });
    this.signingClient =
      env.S3_PUBLIC_ENDPOINT && env.S3_PUBLIC_ENDPOINT !== env.S3_ENDPOINT
        ? new S3Client({ ...common, endpoint: env.S3_PUBLIC_ENDPOINT })
        : this.client;
  }

  async onModuleInit(): Promise<void> {
    // Best-effort: create the bucket in dev (MinIO); no-op if it already exists (R2).
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch {
      try {
        await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
        this.logger.log(`Created bucket "${this.bucket}"`);
      } catch (e) {
        this.logger.warn(`Bucket "${this.bucket}" not present and could not be created: ${(e as Error).message}`);
      }
    }
  }

  async putObject(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }));
  }

  async getObjectBuffer(key: string): Promise<Buffer> {
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    return Buffer.from(await res.Body!.transformToByteArray());
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch {
      return false;
    }
  }

  /** Presigned PUT so the client uploads directly (10-min default). */
  presignPut(key: string, contentType: string, expiresIn = 600): Promise<string> {
    return getSignedUrl(this.signingClient, new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: contentType }), { expiresIn });
  }

  /** Presigned GET (10-min default), attachment disposition for non-images. */
  presignGet(key: string, expiresIn = 600, filename?: string): Promise<string> {
    const cmd = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ...(filename ? { ResponseContentDisposition: `attachment; filename="${filename}"` } : {}),
    });
    return getSignedUrl(this.signingClient, cmd, { expiresIn });
  }

  /** Move quarantine → permanent (copy then delete). */
  async move(fromKey: string, toKey: string): Promise<void> {
    await this.client.send(new CopyObjectCommand({ Bucket: this.bucket, CopySource: `${this.bucket}/${fromKey}`, Key: toKey }));
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: fromKey }));
  }

  /** Delete an object (e.g. purge an infected upload from quarantine, §22.6). */
  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}
