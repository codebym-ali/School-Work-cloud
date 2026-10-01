import { Controller, Get, HttpStatus, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { IsDateString, IsIn, IsInt, IsOptional, IsString, IsUUID, MaxLength, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { AppError, ErrorCodes, Roles } from '@common';
import { ReportsService } from './reports.service';

/**
 * ⚠️ Ids are validated as UUIDs and dates as dates. They were plain strings, so a missing or mistyped id
 * reached Prisma as `''` and came back as a 500 — which the Reports screen, whose id boxes were free text,
 * made the common case.
 */
class LookupQuery {
  @IsOptional() @IsString() @MaxLength(60) q?: string;
  @IsOptional() @IsUUID() campusId?: string;
}

/** A report that cannot run without a parameter says which, instead of failing further down. */
function required(value: string | undefined, label: string): string {
  if (!value) throw new AppError(ErrorCodes.VALIDATION_FAILED, HttpStatus.BAD_REQUEST, `Choose a ${label} to run this report`);
  return value;
}

class ReportQuery {
  @IsOptional() @IsDateString() date?: string;
  @IsOptional() @IsUUID() studentId?: string;
  @IsOptional() @IsUUID() sectionId?: string;
  @IsOptional() @IsDateString() from?: string;
  @IsOptional() @IsDateString() to?: string;
  @IsOptional() @IsUUID() campusId?: string;
  @IsOptional() @IsUUID() examId?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) minDays?: number;

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
    return this.render(res, q.format, 'Daily Collection', await this.reports.dailyCollection(q.date ?? today(), q.campusId));
  }

  @Get('fee-ledger')
  async feeLedger(@Query() q: ReportQuery, @Res() res: Response) {
    return this.render(res, q.format, 'Fee Ledger', await this.reports.feeLedger(required(q.studentId, 'student'), q.campusId));
  }

  @Get('attendance-register')
  async attendanceRegister(@Query() q: ReportQuery, @Res() res: Response) {
    return this.render(res, q.format, 'Attendance Register', await this.reports.attendanceRegister(required(q.sectionId, 'section'), q.from ?? today(), q.to ?? today(), q.campusId));
  }

  @Get('class-strength')
  async classStrength(@Query() q: ReportQuery, @Res() res: Response) {
    return this.render(res, q.format, 'Class Strength', await this.reports.classStrength(q.campusId));
  }

  @Get('defaulters')
  async defaulters(@Query() q: ReportQuery, @Res() res: Response) {
    return this.render(res, q.format, 'Defaulters', await this.reports.defaulters(q.campusId, q.minDays ?? 0));
  }

  @Get('exam-summary')
  async examSummary(@Query() q: ReportQuery, @Res() res: Response) {
    return this.render(res, q.format, 'Exam Summary', await this.reports.examSummary(required(q.examId, 'exam'), q.campusId));
  }

  /**
   * Pickers for the Reports screen (GAP-09), so nobody types a UUID.
   *
   * ⚠️ Under the REPORTS roles on purpose. The general `/students`, `/sections` and `/exams` routes do not
   * admit ACCOUNTANT — so a picker built on them would work for the owner and silently show nothing to the
   * accountant, who runs the fee ledger more than anyone. Campus-scoped like the reports themselves.
   */
  @Get('lookups/students')
  lookupStudents(@Query() q: LookupQuery) {
    return this.reports.lookupStudents(q.q ?? '', q.campusId);
  }

  @Get('lookups/sections')
  lookupSections(@Query() q: LookupQuery) {
    return this.reports.lookupSections(q.campusId);
  }

  @Get('lookups/exams')
  lookupExams(@Query() q: LookupQuery) {
    return this.reports.lookupExams(q.campusId);
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
      res.send(toCsv(rows.map(fileRow)));
      return;
    }
    if (format === 'pdf') {
      // A printed page is read by a person: "GR number", not `grNumber`. (CSV keeps the field names — a
      // spreadsheet someone has built on top of an export must not break because a heading was reworded.)
      const buf = await this.reports.pdf(title, rows.map(fileRow).map(readableKeys));
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

/**
 * Values as a file should carry them.
 *
 * ⚠️ A `Date` went through `String()` and came out as "Mon Aug 10 2026 05:00:00 GMT+0500 (Pakistan Standard
 * Time)" — in the server's zone, unsortable, and wrong by a day for anyone west of it. A date-only value
 * (midnight UTC: due dates, register days) is written YYYY-MM-DD; a moment (a receipt's paidAt) as ISO 8601.
 */
function fileRow(row: Row): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(row)) {
    out[k] = v instanceof Date
      ? (v.getUTCHours() === 0 && v.getUTCMinutes() === 0 && v.getUTCSeconds() === 0 ? v.toISOString().slice(0, 10) : v.toISOString().slice(0, 16).replace('T', ' ') + ' UTC')
      : v;
  }
  return out;
}

const PDF_HEADING: Record<string, string> = { grNumber: 'GR no.', receiptNo: 'Receipt no.', transactionRef: 'Reference', activeStudents: 'Students', marksObtained: 'Marks', totalMarks: 'Out of', amountPaid: 'Amount', paidAt: 'Paid at', dueDate: 'Due', oldestDue: 'Oldest due', name: 'Student' };
function readableKeys(row: Row): Row {
  return Object.fromEntries(Object.entries(row).map(([k, v]) => [PDF_HEADING[k] ?? k.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase()), v]));
}

function slug(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function toCsv(rows: Row[]): string {
  if (rows.length === 0) return '';
  const headers = Object.keys(rows[0]);
  const escape = (v: unknown): string => {
    let s = v == null ? '' : String(v);
    // CSV formula-injection guard (OWASP): a cell beginning with = + - @ (or a leading tab/CR) is executed as
    // a formula by Excel/Sheets on open — a crafted student/class name could exfiltrate or run a command.
    // Prefix such a cell with a single quote so it renders as literal text and never evaluates.
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [headers.join(',')];
  for (const row of rows) lines.push(headers.map((h) => escape(row[h])).join(','));
  return lines.join('\n');
}
