# Login details — every entity (demo tenant)

**Tenant:** City Grammar School · host **demo.localhost** · **all credentials below verified live 2026-09-26**
(re-seeded clean via `pnpm db:seed-real -- --commit`; regenerate anytime — the seed rebuilds these).

> ⚠️ Login is **door-scoped**: each entity signs in at its **own app/port**. An owner at the staff
> door (or vice-versa) is rejected with a message identical to a wrong password — that's by design,
> not a bad credential. Use the right door below.

## Dev URLs / ports

| App | URL | Who signs in here |
|-----|-----|-------------------|
| **API** | `http://demo.localhost:4000/api/v1` | backend (prefix `/api/v1`) |
| **owner-web** | `http://demo.localhost:3005` | **Owner** (and the Ops deputy) |
| **staff-web** | `http://demo.localhost:3006` | **All staff** — campus admin, accountant, HR, admissions, ops, teachers |
| **student-web** | `http://demo.localhost:3003` | **Students** (reg-no + CNIC) |
| **superadmin-web** | `http://localhost:3004` | **Vendor console** (platform Super Admin) |
| landing / chooser | `http://localhost:3001` | marketing + door chooser |
| infra | Postgres `:5433` · Redis `:6381` · MinIO `:9002/9003` | docker |

---

## 1. Owner — sign in at **:3005**
| Role | Name | Email | Password |
|------|------|-------|----------|
| OWNER_ADMIN | School owner | `owner@demo.pk` | `Owner!Secret12` |

> On first sign-in the owner is prompted to enrol MFA. Until enrolled, everything works except the
> money/records-sensitive actions (reverse/waive/approve payroll, reveal full CNIC, change access).

## 2. Staff — sign in at **:3006**
| Role | Name | Email | Password |
|------|------|-------|----------|
| CAMPUS_ADMIN | Nadia Khan | `admin@demo.pk` | `Staff!Secret12` |
| ACCOUNTANT | Imran Malik | `accountant@demo.pk` | `Staff!Secret12` |
| HR_MANAGER (STAFF) | Sadia Sheikh | `hr@demo.pk` | `Staff!Secret12` |
| ADMISSION_CONTROLLER | Bilal Qureshi | `admissions@demo.pk` | `Staff!Secret12` |
| OPERATIONS_ADMIN (deputy) | Kamran Rashid | `ops@demo.pk` | `Staff!Secret12` |
| TEACHER | Ayesha Farooq | `teacher1@demo.pk` | `Staff!Secret12` |
| TEACHER | Usman Raza | `teacher2@demo.pk` | `Staff!Secret12` |
| TEACHER | Hira Ansari | `teacher3@demo.pk` | `Staff!Secret12` |
| TEACHER | Saad Baig | `teacher4@demo.pk` | `Staff!Secret12` |
| TEACHER | Maryam Javed | `teacher5@demo.pk` | `Staff!Secret12` |

> Accountant is mandatory-MFA (same as owner). Teachers get the mobile teacher shell (Home /
> Attendance / Week / More) and see only their assigned sections.

## 3. Students — sign in at **:3003** (Registration No + CNIC, no password)
| Name | Registration No | CNIC |
|------|-----------------|------|
| Ahmed Butt | `REG-2026-0001` | `3520110000001` |
| Fatima Chaudhry | `REG-2026-0002` | `3520110000012` |
| Hassan Qureshi | `REG-2026-0003` | `3520110000021` |

> Only these three students have a portal login. The portal is read-only (attendance, timetable,
> results, fees). Reg-no is the 4-digit `REG-2026-000N` form.

## 4. Vendor console (platform Super Admin) — sign in at **:3004**
| Role | Email | Password |
|------|-------|----------|
| SUPER_ADMIN | `admin@platform.pk` | `Admin!Secret12` |

> Cross-tenant vendor console (not a school user — lives in `platform_users`). Manages the fleet of
> tenants, billing, operators. No tenant subdomain — served at plain `localhost:3004`.

---

_Verified live 2026-09-26: all 12 logins return 200 at their door (owner-login, staff /login,
student portal, platform)._ Re-running `pnpm db:seed-real -- --commit` regenerates the tenant and
`SEED-CREDENTIALS.md`; the vendor operator (`admin@platform.pk`) is seeded by `pnpm db:seed` and
persists across tenant re-seeds.
