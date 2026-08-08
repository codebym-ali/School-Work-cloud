import { Controller, Get } from '@nestjs/common';
import { NotificationsService } from './notifications.service';

@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  /**
   * What changed for the caller.
   *
   * **No `@Roles` — and that is the gate, not an omission.** Like `/staff-attendance/mine` and
   * `/payslips/mine`, this is ownership-scoped rather than role-scoped: the service resolves the
   * caller's own staff profile and can only ever answer about them. A role list here would be
   * wrong in both directions — it would have to admit nearly everyone, and it would still not be
   * the thing keeping one person's notices away from another.
   *
   * Returns `{ items: [] }` for an account with no staff profile rather than 403, because the app
   * shell calls this on every page for every signed-in user.
   */
  @Get()
  list() {
    return this.notifications.forCaller();
  }
}
