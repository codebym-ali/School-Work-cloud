import { Controller, Get, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { IsIn, IsOptional, IsString } from 'class-validator';
import { Type } from 'class-transformer';
import { Roles } from '@common';
import { ReportsService } from './reports.service';

class ReportQuery {
  @IsOptional() @IsString() date?: string;
  @IsOptional() @IsString() studentId?: string;
  @IsOptional() @IsString() sectionId?: string;
  @IsOptional() @IsString() from?: string;
  @IsOptional() @IsString() to?: string;
  @IsOptional() @IsString() campusId?: string;
  @IsOptional() @IsString() examId?: string;
  @IsOptional() @Type(() => Number) minDays?: number;

  @IsOptional() @IsIn(['json', 'csv', 'pdf'])
  format?: 'json' | 'csv' | 'pdf';
}

type Row = Record<string, unknown>;
type ReportFormat = 'json' | 'csv' | 'pdf' | undefined;

/** The seven reports (blueprint §28, §24). Each supports `format=json|csv|pdf`. */
@Roles('OWNER_ADMIN', 'CAMPUS_ADMIN', 'ACCOUNTANT')
@Controller('reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get('daily-collection')
  async dailyCollection(@Query() q: ReportQuery, @Res() res: Response) {
    return this.render(res, q.format, 'Daily Collection', await this.reports.dailyCollection(q.date ?? today()));
  }

  @Get('fee-ledger')
  async feeLedger(@Query() q: ReportQuery, @Res() res: Response) {
    return this.render(res, q.format, 'Fee Ledger', await this.reports.feeLedger(q.studentId ?? ''));
  }

  @Get('attendance-register')
  async attendanceRegister(@Query() q: ReportQuery, @Res() res: Response) {
    return this.render(res, q.format, 'Attendance Register', await this.reports.attendanceRegister(q.sectionId ?? '', q.from ?? today(), q.to ?? today()));
  }

  @Get('class-strength')
  async classStrength(@Query() q: ReportQuery, @Res() res: Response) {
    return this.render(res, q.format, 'Class Strength', await this.reports.classStrength());
  }

  @Get('defaulters')
  async defaulters(@Query() q: ReportQuery, @Res() res: Response) {
    return this.render(res, q.format, 'Defaulters', await this.reports.defaulters(q.campusId, q.minDays ?? 0));
  }

  @Get('exam-summary')
  async examSummary(@Query() q: ReportQuery, @Res() res: Response) {
    return this.render(res, q.format, 'Exam Summary', await this.reports.examSummary(q.examId ?? ''));
  }

  @Get('sms-usage')
  async smsUsage(@Query() q: ReportQuery, @Res() res: Response) {
    return this.render(res, q.format, 'SMS Usage', await this.reports.smsUsage(q.from, q.to));
  }

  /**
   * Send rows as JSON (default), a CSV attachment, or a PDF attachment. Writes directly to
   * `res` (not a passthrough return) because Nest's reply treats a returned Buffer as an
   * object and JSON-serializes it (`{"type":"Buffer",…}`) — `res.send(buffer)` sends raw bytes.
   */
  private async render(res: Response, format: ReportFormat, title: string, rows: Row[]): Promise<void> {
    if (format === 'csv') {
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="${slug(title)}.csv"`);
      res.send(toCsv(rows));
      return;
    }
    if (format === 'pdf') {
      const buf = await this.reports.pdf(title, rows);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${slug(title)}.pdf"`);
      res.send(buf);
      return;
    }
    res.json(rows);
  }
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function slug(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function toCsv(rows: Row[]): string {
  if (rows.length === 0) return '';
  const headers = Object.keys(rows[0]);
  const escape = (v: unknown): string => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [headers.join(',')];
  for (const row of rows) lines.push(headers.map((h) => escape(row[h])).join(','));
  return lines.join('\n');
}
