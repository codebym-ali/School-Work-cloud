import { payslipLines, type PayslipPdf } from './pdf.service';

const base: PayslipPdf = {
  schoolName: 'S', staffName: 'Ayesha', employeeCode: 'E1', period: 'September 2026',
  basic: 40000, allowances: 0, workingDays: 25, unpaidLeaveDays: 0, absentDays: 0,
  gross: 40000, attendanceDeduction: 0, otherDeductions: 0, netPay: 40000,
};

describe('payslipLines', () => {
  it('prints only the salary when nothing was deducted', () => {
    expect(payslipLines(base)).toEqual([['Monthly salary', 'Rs 40,000']]);
  });

  it('names unpaid leave and absence separately, with their days', () => {
    expect(payslipLines({ ...base, unpaidLeaveDays: 1, absentDays: 2 })).toEqual([
      ['Monthly salary', 'Rs 40,000'],
      ['Unpaid leave (1 day)', '- Rs 1,600'],
      ['Absence (2 days)', '- Rs 3,200'],
    ]);
  });

  it('shows allowance and fixed-deduction lines only for legacy structures that have them', () => {
    const lines = payslipLines({ ...base, allowances: 10000, otherDeductions: 2000 }).map(([l]) => l);
    expect(lines).toEqual(['Monthly salary', 'Allowances', 'Fixed deductions']);
  });
});
