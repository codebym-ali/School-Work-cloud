import { Injectable } from '@nestjs/common';
import PDFDocument from 'pdfkit';

export interface ReportCardPdf {
  schoolName: string;
  studentName: string;
  grNumber: string;
  className: string;
  termName: string;
  overallPercent: number;
  gradeLabel: string;
  sectionRank: number | null;
  subjects: Array<{ name: string; percent: number | 'ABS' }>;
}

export interface PayslipPdf {
  schoolName: string;
  staffName: string;
  employeeCode: string;
  period: string;
  /** The fixed monthly salary. */
  basic: number;
  /** Legacy structures only; the schools pay one fixed salary, so this is normally 0 and not printed. */
  allowances: number;
  workingDays: number | null;
  unpaidLeaveDays: number;
  /** Absent days that were DEDUCTED — 0 when the school does not deduct absence. */
  absentDays: number;
  gross: number;
  attendanceDeduction: number;
  otherDeductions: number;
  netPay: number;
}

export interface FeeReceiptPdf {
  schoolName: string;
  /** Gap-free per school — this is the number the family quotes back at the counter. */
  receiptNo: number;
  studentName: string;
  grNumber: string;
  className: string;
  /** The period the money is FOR, which is not the day it was paid. */
  period: string;
  paidOn: string;
  method: string;
  amountPaid: number;
  /** After this payment, so the family can see whether anything is still owed. */
  invoiceTotal: number;
  paidToDate: number;
  receivedBy: string;
  transactionRef: string | null;
}

export interface TablePdf {
  schoolName: string;
  title: string;
  generatedOn: string;
  columns: string[];
  rows: Array<Record<string, unknown>>;
}

/** Server-side PDF rendering (blueprint §11, §13). Returns a Buffer for upload. */
@Injectable()
export class PdfService {
  reportCard(d: ReportCardPdf): Promise<Buffer> {
    return build((doc) => {
      header(doc, d.schoolName, 'Report Card');
      doc.moveDown();
      kv(doc, 'Student', `${d.studentName} (GR ${d.grNumber})`);
      kv(doc, 'Class', d.className);
      kv(doc, 'Term', d.termName);
      doc.moveDown();
      doc.fontSize(12).text('Subjects', { underline: true }).moveDown(0.5);
      for (const s of d.subjects) doc.fontSize(11).text(`  ${s.name}: ${s.percent === 'ABS' ? 'ABS' : `${s.percent}%`}`);
      doc.moveDown();
      doc.fontSize(12).text(`Overall: ${d.overallPercent}%   Grade: ${d.gradeLabel}   Rank: ${d.sectionRank ?? '—'}`);
    });
  }

  payslip(d: PayslipPdf): Promise<Buffer> {
    return build((doc) => {
      header(doc, d.schoolName, 'Payslip');
      doc.moveDown();
      kv(doc, 'Staff', `${d.staffName} (${d.employeeCode})`);
      kv(doc, 'Period', d.period);
      doc.moveDown();
      for (const [label, value] of payslipLines(d)) kv(doc, label, value);
      doc.moveDown(0.5).fontSize(13).text(`Net pay: ${money(d.netPay)}`, { underline: true });
    });
  }

  /**
   * A fee receipt — the piece of paper a Pakistani school hands across the counter.
   *
   * It states the **receipt number** first because that is what a family quotes back when they
   * come to argue, and it is gap-free per school precisely so it can be cited. It also states
   * what is still owed after this payment: a receipt that shows only the amount received leaves
   * the payer to work out whether they are square, and they will assume they are.
   */
  feeReceipt(d: FeeReceiptPdf): Promise<Buffer> {
    return build((doc) => {
      header(doc, d.schoolName, `Fee Receipt #${d.receiptNo}`);
      doc.moveDown();
      kv(doc, 'Student', `${d.studentName} (GR ${d.grNumber})`);
      kv(doc, 'Class', d.className);
      kv(doc, 'Fee for', d.period);
      doc.moveDown(0.5);
      kv(doc, 'Received on', d.paidOn);
      kv(doc, 'Method', d.method);
      if (d.transactionRef) kv(doc, 'Reference', d.transactionRef);
      kv(doc, 'Received by', d.receivedBy);
      doc.moveDown(0.5);
      doc.fontSize(13).text(`Amount received: ${money(d.amountPaid)}`, { underline: true });
      doc.moveDown(0.5).fontSize(11);
      const outstanding = d.invoiceTotal - d.paidToDate;
      kv(doc, 'Invoice total', money(d.invoiceTotal));
      kv(doc, 'Paid to date', money(d.paidToDate));
      kv(doc, outstanding > 0 ? 'Still outstanding' : 'Balance', money(Math.max(outstanding, 0)));
      doc.moveDown();
      doc.fontSize(9).fillColor('#666666')
        .text('This receipt is issued against a payment recorded by the school office.', { align: 'center' })
        .fillColor('black');
    });
  }

  /** Generic tabular report → PDF (blueprint §28). Evenly-sized columns, header repeated
   *  on each page, cells ellipsized to their column width. Feeds the reports PDF export. */
  table(d: TablePdf): Promise<Buffer> {
    return build((doc) => {
      const cols = d.columns;
      const left = doc.page.margins.left;
      const usableW = doc.page.width - left - doc.page.margins.right;
      const colW = usableW / Math.max(cols.length, 1);
      const bottom = doc.page.height - doc.page.margins.bottom;

      const title = (): void => {
        header(doc, d.schoolName, d.title);
        doc.fontSize(9).fillColor('#666666').text(`Generated ${d.generatedOn}`, left, doc.y, { align: 'right', width: usableW });
        doc.fillColor('black').moveDown(0.5);
      };
      const headerRow = (): void => {
        const y = doc.y;
        doc.font('Helvetica-Bold').fontSize(9);
        cols.forEach((c, i) => doc.text(c, left + i * colW, y, { width: colW - 4, ellipsis: true }));
        doc.font('Helvetica');
        doc.moveTo(left, y + 13).lineTo(left + usableW, y + 13).strokeColor('#999999').stroke().strokeColor('black');
        doc.y = y + 17;
      };

      title();
      if (d.rows.length === 0) {
        doc.fontSize(11).text('No data.');
        return;
      }
      headerRow();

      doc.fontSize(9);
      for (const row of d.rows) {
        if (doc.y + 15 > bottom) {
          doc.addPage();
          title();
          headerRow();
          doc.fontSize(9);
        }
        const y = doc.y;
        cols.forEach((c, i) => {
          const v = row[c];
          doc.text(v == null ? '' : String(v), left + i * colW, y, { width: colW - 4, ellipsis: true });
        });
        doc.y = y + 15;
      }
    });
  }
}

function build(draw: (doc: PDFKit.PDFDocument) => void): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    draw(doc);
    doc.end();
  });
}

function header(doc: PDFKit.PDFDocument, school: string, title: string): void {
  doc.fontSize(18).text(school, { align: 'center' });
  doc.fontSize(14).text(title, { align: 'center' });
  doc.moveTo(50, doc.y + 6).lineTo(545, doc.y + 6).stroke();
  doc.moveDown();
}

function kv(doc: PDFKit.PDFDocument, key: string, value: string): void {
  doc.fontSize(11).text(`${key}: `, { continued: true }).font('Helvetica-Bold').text(value).font('Helvetica');
}

function money(n: number): string {
  return `Rs ${n.toLocaleString('en-PK')}`;
}

/**
 * The lines of a payslip, in order (Cash Payroll Plan, WS2.5). Pure, so the wording is testable without a PDF.
 *
 * Unpaid leave and absence are separate lines with their day counts: "Attendance deduction Rs 3,200" was a figure
 * a teacher could not check. Zero lines are left out, and allowance / fixed-deduction lines appear only for legacy
 * salary structures that have them.
 */
export function payslipLines(d: PayslipPdf): Array<[string, string]> {
  const rs = (n: number) => `Rs ${Math.round(n).toLocaleString('en-PK')}`;
  const perDay = d.workingDays ? d.basic / d.workingDays : 0;
  const days = (n: number) => `${n} day${n === 1 ? '' : 's'}`;
  const lines: Array<[string, string]> = [['Monthly salary', rs(d.basic)]];
  if (d.allowances > 0) lines.push(['Allowances', rs(d.allowances)]);
  if (d.unpaidLeaveDays > 0) lines.push([`Unpaid leave (${days(d.unpaidLeaveDays)})`, `- ${rs(d.unpaidLeaveDays * perDay)}`]);
  if (d.absentDays > 0) lines.push([`Absence (${days(d.absentDays)})`, `- ${rs(d.absentDays * perDay)}`]);
  if (d.otherDeductions > 0) lines.push(['Fixed deductions', `- ${rs(d.otherDeductions)}`]);
  return lines;
}
