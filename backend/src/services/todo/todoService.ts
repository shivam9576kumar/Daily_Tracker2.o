import type { Assignment, Prisma, Task } from '@prisma/client';
import prisma from '../../config/database';
import logger from '../../utils/logger';
import { taskRepository } from '../../repositories/taskRepository';
import { ensurePotdTaskForUser } from '../potd/potdService';
import { cp31Service, toPublicCp31State } from '../cp31/cp31Service';
import {
  addDaysToKey,
  dateKeyInTz,
  todayKey,
  weekdayOfKey,
  zonedDayRangeUtc,
  zonedDayStartUtc,
} from '../../utils/dateKeys';
import type {
  DailyChallengeMeta,
  TodoDateGroup,
  TodoResponse,
  TodoTodayGroups,
} from './todoTypes';

const UPCOMING_DAYS_DEFAULT = 14;
const UPCOMING_DAYS_ALLOWED = [14, 30] as const;

export function normalizeUpcomingDays(raw: unknown): number {
  const n = parseInt(String(raw ?? ''), 10);
  return (UPCOMING_DAYS_ALLOWED as readonly number[]).includes(n)
    ? n
    : UPCOMING_DAYS_DEFAULT;
}

const COMPLETED_DAYS = 7;

const WEEKDAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

import {
  isOpenBacklogTask,
  LIVE_TASK_WHERE,
  OPEN_BACKLOG_WHERE,
} from '../task/taskLifecycle';
import { reconcileOverdueForUser } from '../task/overdueReconciler';

/** 'Today' | 'Tomorrow' | 'Yesterday' | weekday name — relative to the user's today key. */
function labelFor(dateKey: string, today: string): string {
  if (dateKey === today) return 'Today';
  if (dateKey === addDaysToKey(today, 1)) return 'Tomorrow';
  if (dateKey === addDaysToKey(today, -1)) return 'Yesterday';
  return WEEKDAY[weekdayOfKey(dateKey)];
}

/** Assignments are saved from a date-only input → UTC midnight. Read the key back the same way. */
function assignmentDateKey(a: Assignment): string {
  return a.deadline.toISOString().slice(0, 10);
}

function upsertGroup(map: Map<string, TodoDateGroup>, dateKey: string, today: string): TodoDateGroup {
  let g = map.get(dateKey);
  if (!g) {
    g = { dateKey, label: labelFor(dateKey, today), tasks: [], assignments: [] };
    map.set(dateKey, g);
  }
  return g;
}

function byTitle(a: { title: string }, b: { title: string }) {
  return a.title.localeCompare(b.title);
}

export const todoService = {
  async getTodo(
    userId: string,
    tz: string,
    upcomingDays: number = UPCOMING_DAYS_DEFAULT,
  ): Promise<TodoResponse> {
    const today = todayKey(tz);
    const upcomingEnd = addDaysToKey(today, upcomingDays);
    const completedStartKey = addDaysToKey(today, -(COMPLETED_DAYS - 1));
    const completedStart = zonedDayStartUtc(completedStartKey, tz);
    const { end: completedEnd } = zonedDayRangeUtc(today, tz);

    // ── 1. POTD & CP31 ensure ──
    let potdDateKey: string | null = null;
    let potdEnabled = true;
    try {
      const ensured = await ensurePotdTaskForUser(userId, tz);
      potdEnabled = ensured.enabled;
      potdDateKey = ensured.potd?.dateKey ?? null;
    } catch (err) {
      logger.warn('todoService: POTD ensure failed, continuing', { message: (err as Error)?.message });
    }

    const cp31State = await cp31Service.ensureCp31TasksForUser(userId, tz);
    const skippedTasks = await cp31Service.listSkippedCp31(userId, cp31State.band ?? undefined);

    // bandStatus is passed through unmodified: 'complete-awaiting-confirm' is
    // the real, correctly-named signal the ladder produces for a finished
    // band (buildState never produces a separate 'complete' value — verified
    // in Bug 5). A previous version remapped it to 'complete', which silently
    // diverged from Dashboard's response for the identical underlying state.
    //
    // nextIndex is also passed through unmodified: buildState already applies
    // the exact `(pending > 0 && !quotaDoneToday) ? null : nextIndex` rule
    // when constructing cp31State.nextIndex, so recomputing it here was
    // always a redundant no-op (confirmed in Bug 5 test section 9-H).
    //
    // toPublicCp31State strips internal fields (servedNow, served, pendingTaskIds)
    // that must not appear in any public response.
    const cp31Meta: DailyChallengeMeta['cp31'] = {
      ...toPublicCp31State(cp31State),
      skippedCount: skippedTasks.length,
    };

    // Self-healing: move overdue dated work to backlog before it is read. Idempotent.
    try {
      await reconcileOverdueForUser(userId, tz);
    } catch (err) {
      logger.warn('todoService: overdue reconcile failed, continuing', {
        message: (err as Error)?.message,
      });
    }

    // ── 2. Queries ──
    const [inboxRows, todayRows, upcomingRows, backlogRows, completedRows, assignments] = await Promise.all([
      prisma.task.findMany({
        where: { userId, taskType: 'personal', scheduledDateKey: null, status: 'pending' },
        orderBy: { createdAt: 'desc' },
      }),

      // Single source of truth for "today" — shared with Dashboard.
      taskRepository.getTodaysTasks(userId, tz),

      prisma.task.findMany({
        where: {
          AND: [
            {
              userId,
              status: 'pending',
              isBacklog: false,
              isExpired: false,
              scheduledDateKey: { gt: today, lte: upcomingEnd },
            },
            LIVE_TASK_WHERE,
          ],
        },
        orderBy: [{ scheduledDateKey: 'asc' }, { taskType: 'asc' }, { title: 'asc' }],
      }),

      prisma.task.findMany({
        where: {
          AND: [
            { userId },
            LIVE_TASK_WHERE,
            OPEN_BACKLOG_WHERE,
          ],
        },
        orderBy: [{ scheduledDateKey: 'asc' }, { title: 'asc' }],
      }),

      prisma.task.findMany({
        where: {
          AND: [
            {
              userId,
              status: 'completed',
              completedAt: { gte: completedStart, lt: completedEnd },
            },
            LIVE_TASK_WHERE,
          ],
        },
        orderBy: { completedAt: 'desc' },
      }),

      prisma.assignment.findMany({
        where: {
          userId,
          OR: [
            { status: 'pending' },
            { status: 'completed', completedAt: { gte: completedStart, lt: completedEnd } },
          ],
        },
        orderBy: { deadline: 'asc' },
      }),
    ]);

    // ── 3. Guarantee POTD is present in Today (UTC key may differ from local key) ──
    let todayTasks = todayRows;
    if (potdDateKey && !todayTasks.some((t) => t.potdDateKey === potdDateKey)) {
      const potdTask = await prisma.task.findFirst({
        where: { userId, potdDateKey, isExpired: false },
      });
      if (potdTask) todayTasks = [...todayTasks, potdTask];
    }

    // ── 4. Today groups ──
    const pending = todayTasks.filter((t) => t.status !== 'completed');
    const completedToday = todayTasks
      .filter((t) => t.status === 'completed')
      .sort((a, b) => (b.completedAt?.getTime() ?? 0) - (a.completedAt?.getTime() ?? 0));

    const backlogToday = pending.filter(isOpenBacklogTask);
    const regular = pending.filter((t) => !isOpenBacklogTask(t));

    const pendingAssignments = assignments.filter((a) => a.status === 'pending');
    const dueAssignments = pendingAssignments.filter((a) => assignmentDateKey(a) <= today);

    const todayGroups: TodoTodayGroups = {
      backlog: backlogToday,
      plan: regular.filter((t) => t.taskType === 'new' && t.planId !== null),
      potd: regular.filter((t) => t.taskType === 'potd'),
      revisions: regular.filter((t) => t.taskType === 'revision'),
      manual: regular.filter((t) => t.taskType === 'new' && t.planId === null),
      personal: regular.filter((t) => t.taskType === 'personal'),
      completed: completedToday,
      assignments: dueAssignments,
      cp31: regular.filter((t) => t.taskType === 'cp31'),
    };

    // ── 5. Upcoming groups ──
    const upcomingMap = new Map<string, TodoDateGroup>();
    for (const t of upcomingRows) upsertGroup(upcomingMap, t.scheduledDateKey!, today).tasks.push(t);
    for (const a of pendingAssignments) {
      const k = assignmentDateKey(a);
      if (k > today && k <= upcomingEnd) upsertGroup(upcomingMap, k, today).assignments.push(a);
    }
    const upcoming = [...upcomingMap.values()]
      .sort((a, b) => a.dateKey.localeCompare(b.dateKey))
      .map((g) => ({ ...g, tasks: g.tasks.sort(byTitle), assignments: g.assignments.sort(byTitle) }));

    // ── 6. Completed groups (user-local day of completedAt) ──
    const completedMap = new Map<string, TodoDateGroup>();
    for (const t of completedRows) {
      if (!t.completedAt) continue;
      const k = dateKeyInTz(t.completedAt, tz);
      if (k < completedStartKey || k > today) continue;
      upsertGroup(completedMap, k, today).tasks.push(t);
    }
    for (const a of assignments) {
      if (a.status !== 'completed' || !a.completedAt) continue;
      const k = dateKeyInTz(a.completedAt, tz);
      if (k < completedStartKey || k > today) continue;
      upsertGroup(completedMap, k, today).assignments.push(a);
    }
    const completed = [...completedMap.values()].sort((a, b) => b.dateKey.localeCompare(a.dateKey));

    // ── 7. Summary ──
    const upcomingCount = upcoming.reduce((n, g) => n + g.tasks.length + g.assignments.length, 0);

    return {
      timezone: tz,
      todayKey: today,
      generatedAt: new Date().toISOString(),
      upcomingDays,
      summary: {
        inbox: inboxRows.length,
        today: pending.length + dueAssignments.length,
        upcoming: upcomingCount,
        backlog: backlogRows.length,
        completedToday: completedToday.length,
      },
      inbox: inboxRows,
      today: todayGroups,
      upcoming,
      backlog: backlogRows,
      completed,
      dailyChallenges: {
        potd: { enabled: potdEnabled },
        cp31: cp31Meta,
      },
    };
  },
};
