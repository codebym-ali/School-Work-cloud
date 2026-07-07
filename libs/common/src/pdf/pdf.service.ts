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

export interface CertificatePdf {
  schoolName: string;
  studentName: string;
  grNumber: string;
  type: string;
  issuedOn: string;
  body: string;
}

export interface PayslipPdf {
  schoolName: string;
  staffName: string;
  employeeCode: string;
  period: string;
  gross: number;
  attendanceDeduction: number;
  otherDeductions: number;
  netPay: number;
}

/** Server-side PDF rendering (blueprint §11, §13, §15). Returns a Buffer for upload. */
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

  certificate(d: CertificatePdf): Promise<Buffer> {
    return build((doc) => {
      header(doc, d.schoolName, prettyType(d.type));
      doc.moveDown(2);
      doc.fontSize(12).text(d.body, { align: 'left' });
      doc.moveDown(2);
      kv(doc, 'Student', `${d.studentName} (GR ${d.grNumber})`);
      kv(doc, 'Issued on', d.issuedOn);
    });
  }

  payslip(d: PayslipPdf): Promise<Buffer> {
    return build((doc) => {
      header(doc, d.schoolName, 'Payslip');
      doc.moveDown();
      kv(doc, 'Staff', `${d.staffName} (${d.employeeCode})`);
      kv(doc, 'Period', d.period);
      doc.moveDown();
      kv(doc, 'Gross', money(d.gross));
      kv(doc, 'Attendance deduction', money(d.attendanceDeduction));
      kv(doc, 'Other deductions', money(d.otherDeductions));
      doc.moveDown(0.5).fontSize(13).text(`Net pay: ${money(d.netPay)}`, { underline: true });
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
function prettyType(t: string): string {
  return t.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
