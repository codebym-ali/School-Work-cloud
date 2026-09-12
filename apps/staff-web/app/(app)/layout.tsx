import AppLayout from '@school/app/layout';

/**
 * The school shell, told which door it is rendering in (Front-End Instance Separation Plan, Phase 4).
 *
 * This used to be a bare `export { default } from '@school/app/layout'` in BOTH apps, which is why
 * owner-web and staff-web rendered identically: the shell built its sidebar from the user's roles
 * alone and had no idea which app it was in. Naming the app lets the nav be intersected with what
 * this app actually mounts, so a link can never point at a route that does not exist here.
 */
export default function SchoolAppLayout({ children }: { children: React.ReactNode }) {
  return <AppLayout app="staff-web">{children}</AppLayout>;
}
