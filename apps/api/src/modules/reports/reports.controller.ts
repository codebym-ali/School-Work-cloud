import { Controller, Get, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { IsIn, IsOptional, IsString } from 'class-validator';
import { Type } from 'class-transformer';
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

  @IsOptional() @IsIn(['json', 'csv'])
  format?: 'json' | 'csv';
}

type Row = Record<string, unknown>;

/** The seven reports (blueprint §28, §24). Each supports `format=json|csv` (pdf deferred). */
@Controller('reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get('daily-collection')
  async dailyCollection(@Query() q: ReportQuery, @Res({ passthrough: true }) res: Response) {
    return render(res, q.format, await this.reports.dailyCollection(q.date ?? today()));
  }

  @Get('fee-ledger')
  async feeLedger(@Query() q: ReportQuery, @Res({ passthrough: true }) res: Response) {
    return render(res, q.format, await this.reports.feeLedger(q.studentId ?? ''));
  }

  @Get('attendance-register')
  async attendanceRegister(@Query() q: ReportQuery, @Res({ passthrough: true }) res: Response) {
    return render(res, q.format, await this.reports.attendanceRegister(q.sectionId ?? '', q.from ?? today(), q.to ?? today()));
  }

  @Get('class-strength')
  async classStrength(@Query() q: ReportQuery, @Res({ passthrough: true }) res: Response) {
    return render(res, q.format, await this.reports.classStrength());
  }

  @Get('defaulters')
  async defaulters(@Query() q: ReportQuery, @Res({ passthrough: true }) res: Response) {
    return render(res, q.format, await this.reports.defaulters(q.campusId, q.minDays ?? 0));
  }

  @Get('exam-summary')
  async examSummary(@Query() q: ReportQuery, @Res({ passthrough: true }) res: Response) {
    return render(res, q.format, await this.reports.examSummary(q.examId ?? ''));
  }

  @Get('sms-usage')
  async smsUsage(@Query() q: ReportQuery, @Res({ passthrough: true }) res: Response) {
    return render(res, q.format, await this.reports.smsUsage(q.from, q.to));
  }
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Render rows as JSON (default) or a CSV attachment. */
function render(res: Response, format: 'json' | 'csv' | undefined, rows: Row[]): Row[] | string {
  if (format === 'csv') {
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="report.csv"');
    return toCsv(rows);
  }
  return rows;
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
