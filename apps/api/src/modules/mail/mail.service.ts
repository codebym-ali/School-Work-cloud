import { Inject, Injectable, Logger } from '@nestjs/common';
import { createTransport, type Transporter } from 'nodemailer';
import { ENV, type Env } from '@common';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
  /** Set so a reply goes straight to the person the mail is about (e.g. the prospect). */
  replyTo?: string;
}

/**
 * Outbound email — a thin nodemailer wrapper configured from env (§34). If SMTP is not configured
 * (`SMTP_HOST`/`SMTP_USER`/`SMTP_PASS` unset) it NO-OPS: it logs the message instead of sending, so
 * dev/CI and an un-configured server still work and a missing mail config never breaks the user-facing
 * action that triggered it (e.g. capturing a lead). Credentials come from env only — never hard-coded.
 */
@Injectable()
export class MailerService {
  private readonly logger = new Logger(MailerService.name);
  private readonly transporter: Transporter | null;
  private readonly from: string;

  constructor(@Inject(ENV) env: Env) {
    if (env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS) {
      this.transporter = createTransport({
        host: env.SMTP_HOST,
        port: env.SMTP_PORT,
        secure: env.SMTP_SECURE, // true for 465, false for 587 (STARTTLS)
        auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
      });
      this.from = env.SMTP_FROM || env.SMTP_USER;
    } else {
      this.transporter = null;
      this.from = env.SMTP_FROM || 'no-reply@schoolworks.local';
      this.logger.warn('SMTP not configured — outbound email is DISABLED (messages are logged, not sent). Set SMTP_HOST/SMTP_USER/SMTP_PASS to enable.');
    }
  }

  /** Whether real delivery is configured. */
  get enabled(): boolean {
    return this.transporter !== null;
  }

  /** Send one email. Throws on transport failure so the caller can decide (fire-and-forget callers
   *  catch + log so the triggering action never fails on a mail hiccup). */
  async send(msg: MailMessage): Promise<void> {
    if (!this.transporter) {
      this.logger.warn(`[mail disabled] would send "${msg.subject}" → ${msg.to}`);
      return;
    }
    await this.transporter.sendMail({
      from: this.from,
      to: msg.to,
      subject: msg.subject,
      text: msg.text,
      html: msg.html,
      replyTo: msg.replyTo,
    });
    this.logger.log(`Sent "${msg.subject}" → ${msg.to}`);
  }
}
