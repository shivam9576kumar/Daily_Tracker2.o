import prisma from '../../config/database';
import { todayKey } from '../../utils/dateKeys';
import { DATED_BACKLOG_TYPE_WHERE, LIVE_TASK_WHERE } from './taskLifecycle';

/**
 * Moves ONE user's overdue dated work to backlog.
 *
 * Safe to call on every Today / Todo / Dashboard load:
 *  - idempotent: rows already in backlog are not matched again
 *  - user-scoped: touches only this user's rows
 *  - guarded: a row completed or rescheduled after it was read is not changed
 *
 * Eligibility is defined ONLY by DATED_BACKLOG_TYPE_WHERE + LIVE_TASK_WHERE
 * (new | revision | personal with a real scheduling key; live-plan visibility).
 * CP31, POTD and undated Inbox tasks are never matched.
 *
 * Does not send notifications; the scheduled backlog cron still does.
 * Does not touch Revision rows: backlog is a Task-only state (Bug 2 mapping).
 *
 * Returns the number of tasks moved.
 */
export async function reconcileOverdueForUser(
  userId: string,
  tz: string,
  now: Date = new Date(),
): Promise<number> {
  const today = todayKey(tz, now);

  const result = await prisma.task.updateMany({
    where: {
      AND: [
        { userId },
        DATED_BACKLOG_TYPE_WHERE,
        LIVE_TASK_WHERE,
        {
          status: 'pending',
          isBacklog: false,
          isExpired: false,
          completedAt: null,
          scheduledDateKey: { lt: today },
        },
      ],
    },
    data: {
      status: 'backlog',
      isBacklog: true,
      backlogSince: now,
      isExpired: false,
    },
  });

  return result.count;
}
