/** Whole-year age at `at` (default now) for a date of birth (blueprint §8 age-eligibility). */
export function computeAge(dob: Date, at: Date = new Date()): number {
  let age = at.getFullYear() - dob.getFullYear();
  const m = at.getMonth() - dob.getMonth();
  if (m < 0 || (m === 0 && at.getDate() < dob.getDate())) age--;
  return age;
}
