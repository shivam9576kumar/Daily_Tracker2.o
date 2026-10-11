import prisma from '../config/database';
import { Prisma } from '@prisma/client';
import {
  assertDateKey,
  dateKeyInTz,
  resolveTimeZone,
  todayKey,
  zonedDayRangeUtc,
  addDaysToKey,
} from '../utils/dateKeys';
import {
  LIVE_TASK_WHERE,
  DATED_BACKLOG_TYPE_WHERE,
  OPEN_BACKLOG_WHERE,
} from '../services/task/taskLifecycle';

const STATUS_PRIORITY: Record<string, number> = {
  backlog: 0,
  pending: 1,
  completed: 2,
  skipped: 3,
  expired: 4,
};

const DIFFICULTY_PRIORITY: Record<string, number> = {
  hard: 0,
  medium: 1,
  easy: 2,
};

const TASK_TYPE_PRIORITY: Record<string, number> = {
  cp31: 0,
  new: 1,
  potd: 2,
  revision: 3,
  personal: 4,
};

function statusRank(status: string): number {
  return STATUS_PRIORITY[status] ?? 99;
}

function difficultyRank(difficulty: string | null): number {
  return difficulty !== null
    ? (DIFFICULTY_PRIORITY[difficulty] ?? 99)
    : 99;
}

function taskTypeRank(taskType: string): number {
  return TASK_TYPE_PRIORITY[taskType] ?? 99;
}

/**
 * Deterministic display order for a user's "today" task list.
 * Backlog items surface first (need attention), then pending,
 * then completed/skipped/expired at the bottom.
 * Within equal status, task type and difficulty (hard first) break ties.
 *
 * This replaces the previous `orderBy: [{ status: 'asc' }, ...]`
 * which sorted alphabetically and did not match its own comment.
 */
export function sortTodaysTasks<
  T extends {
    status: string;
    taskType: string;
    difficulty: string | null;
    scheduledDate: Date | null;
  },
>(tasks: T[]): T[] {
  return [...tasks].sort((a, b) => {
    const statusDiff = statusRank(a.status) - statusRank(b.status);
    if (statusDiff !== 0) return statusDiff;

    const typeDiff = taskTypeRank(a.taskType) - taskTypeRank(b.taskType);
    if (typeDiff !== 0) return typeDiff;

    const diffDiff = difficultyRank(a.difficulty) - difficultyRank(b.difficulty);
    if (diffDiff !== 0) return diffDiff;

    const aTime = a.scheduledDate?.getTime() ?? 0;
    const bTime = b.scheduledDate?.getTime() ?? 0;
    return aTime - bTime;
  });
}

/**
 * Task Repository — data access layer for the tasks table.
 * All database queries for tasks go through here.
 */
export const taskRepository = {
  /**
   * Get today's tasks plus any backlog tasks in the user's timezone.
   *
   * Today's hitlist = three things:
   *   1. anything scheduled today (any status)
   *   2. open backlog (overdue, not expired, not solved)
   *   3. anything SOLVED TODAY — by completedAt — regardless of when it was scheduled.
   *      Without (3) a backlog item vanishes the moment you solve it. (3) also makes
   *      "Completed Today" clear itself at midnight: the window simply moves.
   *
   * Uses half-open [start, end) range produced by zonedDayRangeUtc for exact wall-clock day coverage.
   */
  async getTodaysTasks(userId: string, tz?: string, potdDateKey?: string | null) {
    const userTz = resolveTimeZone(tz);
    const currentKey = todayKey(userTz);
    const { start, end } = zonedDayRangeUtc(currentKey, userTz);

    const todayOr: Prisma.TaskWhereInput[] = [
      { scheduledDateKey: currentKey },

      // Legacy rows: empty/null key, but genuine dated DSA task whose instant falls on user's local day.
      // Excludes intentional undated tasks: personal inbox and parked/skipped cp31.
      {
        AND: [
          {
            OR: [
              { scheduledDateKey: '' },
              { scheduledDateKey: null },
            ],
          },
          { taskType: { notIn: ['personal', 'cp31', 'cses'] } },
          { scheduledDate: { gte: start, lt: end } },
        ],
      },

      OPEN_BACKLOG_WHERE,

      { status: 'completed', completedAt: { gte: start, lt: end } },
    ];

    if (potdDateKey) {
      todayOr.push({ taskType: 'potd', potdDateKey });
    }

    const rows = await prisma.task.findMany({
      where: {
        userId,
        isExpired: false,
        AND: [
          { OR: todayOr },
          LIVE_TASK_WHERE,
        ],
      },
      orderBy: { scheduledDate: 'asc' },
    });

    return sortTodaysTasks(rows);
  },

  /**
   * Get a single task by ID, ensuring it belongs to the user.
   * Notes are stored exclusively in the `Note` model, accessible via `/api/tasks/:id/notes`.
   * `Task` rows do not carry a notes payload.
   */
  async getTaskById(taskId: string, userId: string) {
    return prisma.task.findFirst({
      where: { id: taskId, userId },
      include: {
        revisions: {
          where: { taskType: 'revision' },
          orderBy: { revisionNumber: 'asc' },
        },
        parentTask: true,
        taskNotes: {
          orderBy: { updatedAt: 'desc' },
          take: 1,
        },
        plan: { select: { id: true, name: true, status: true } },
      },
    });
  },

  /**
   * Create a new task.
   */
  async createTask(data: Prisma.TaskCreateInput) {
    return prisma.task.create({ data });
  },

  /**
   * Update a task.
   */
  async updateTask(taskId: string, data: Prisma.TaskUpdateInput) {
    return prisma.task.update({
      where: { id: taskId },
      data,
    });
  },

  /**
   * Delete a task.
   */
  async deleteTask(taskId: string) {
    return prisma.task.delete({ where: { id: taskId } });
  },

  /**
   * Get all tasks for a user.
   */
  async getAllTasks(userId: string, filters?: {
    status?: string;
    topic?: string;
    taskType?: string;
    planId?: string;
  }) {
    const where: Prisma.TaskWhereInput = { userId };

    if (filters?.status) where.status = filters.status;
    if (filters?.topic) where.topic = filters.topic;
    if (filters?.taskType) where.taskType = filters.taskType;
    if (filters?.planId) where.planId = filters.planId;

    return prisma.task.findMany({
      where,
      orderBy: { scheduledDate: 'asc' },
    });
  },

  /**
   * Count tasks by status for a user.
   */
  async countByStatus(userId: string) {
    const counts = await prisma.task.groupBy({
      by: ['status'],
      where: { userId },
      _count: { id: true },
    });

    const result: Record<string, number> = {
      pending: 0,
      completed: 0,
      backlog: 0,
      expired: 0,
    };

    for (const row of counts) {
      result[row.status] = row._count.id;
    }

    return result;
  },

  /**
   * Get completed tasks count by date for heatmap.
   */
  async getCompletionsByDate(userId: string, startDate: Date, endDate: Date) {
    return prisma.task.groupBy({
      by: ['completedAt'],
      where: {
        userId,
        status: 'completed',
        completedAt: {
          gte: startDate,
          lte: endDate,
        },
      },
      _count: { id: true },
    });
  },

  /**
   * Find pending tasks that are overdue (scheduled before today in the user's timezone).
   * Used by the backlog cron job.
   */
  async findOverduePendingTasks(userId?: string, tz?: string) {
    if (userId && tz) {
      const userTz = resolveTimeZone(tz);
      const today = todayKey(userTz);

      return prisma.task.findMany({
        where: {
          AND: [
            { userId },
            LIVE_TASK_WHERE,
            DATED_BACKLOG_TYPE_WHERE,
            {
              status: 'pending',
              isBacklog: false,
              isExpired: false,
              completedAt: null,
              scheduledDateKey: { lt: today },
            },
          ],
        },
      });
    }

    const candidates = await prisma.task.findMany({
      where: {
        AND: [
          LIVE_TASK_WHERE,
          DATED_BACKLOG_TYPE_WHERE,
          {
            status: 'pending',
            isBacklog: false,
            isExpired: false,
            completedAt: null,
          },
        ],
      },
      include: {
        user: { select: { timezone: true } },
      },
    });

    return candidates.filter((t) => {
      if (!t.scheduledDateKey) return false;
      const userTz = resolveTimeZone(t.user.timezone);
      return t.scheduledDateKey < todayKey(userTz);
    });
  },

  /**
   * Find backlog tasks that have been in backlog for over N calendar days in user timezone.
   * Used by the expiry cron job.
   */
  async findExpiredBacklogTasks(
    userIdOrDays: string | number,
    tzOrDays?: string | number,
    maybeExpiryDays?: number
  ) {
    if (typeof userIdOrDays === 'string') {
      const userId = userIdOrDays;
      const tz = typeof tzOrDays === 'string' ? tzOrDays : resolveTimeZone();
      const expiryDays = maybeExpiryDays ?? 7;
      const userTz = resolveTimeZone(tz);
      const today = todayKey(userTz);

      const candidates = await prisma.task.findMany({
        where: {
          AND: [
            { userId },
            LIVE_TASK_WHERE,
            OPEN_BACKLOG_WHERE,
          ],
        },
      });

      return candidates.filter((t) => {
        if (!t.backlogSince) return false;
        const backlogDay = dateKeyInTz(t.backlogSince, userTz);
        const expiresOn = addDaysToKey(backlogDay, expiryDays);
        return expiresOn <= today;
      });
    }

    const expiryDays = Number(userIdOrDays);
    const candidates = await prisma.task.findMany({
      where: {
        AND: [
          LIVE_TASK_WHERE,
          OPEN_BACKLOG_WHERE,
        ],
      },
      include: {
        user: { select: { timezone: true } },
      },
    });

    return candidates.filter((t) => {
      if (!t.backlogSince) return false;
      const userTz = resolveTimeZone(t.user.timezone);
      const backlogDay = dateKeyInTz(t.backlogSince, userTz);
      const expiresOn = addDaysToKey(backlogDay, expiryDays);
      return expiresOn <= todayKey(userTz);
    });
  },

  /**
   * Get revision progress summary for a parent task.
   */
  async getRevisionProgress(parentTaskId: string) {
    const total = await prisma.revision.count({
      where: { parentTaskId },
    });

    const completed = await prisma.revision.count({
      where: {
        parentTaskId,
        status: 'completed',
      },
    });

    const pending = await prisma.revision.count({
      where: {
        parentTaskId,
        status: {
          not: 'completed',
        },
      },
    });

    return {
      total,
      completed,
      pending,
    };
  },

  /**
   * Get revision tasks for a parent task.
   */
  async getRevisionsByParentId(parentTaskId: string) {
    return prisma.task.findMany({
      where: { parentTaskId },
      orderBy: { revisionNumber: 'asc' },
    });
  },

  /**
   * Delete all pending revision tasks for a parent task.
   */
  async deletePendingRevisions(parentTaskId: string) {
    return prisma.task.deleteMany({
      where: {
        parentTaskId,
        taskType: 'revision',
        status: 'pending',
      },
    });
  },
};

