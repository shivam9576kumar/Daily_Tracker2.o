import prisma from '../../config/database';
import { taskRepository } from '../../repositories/taskRepository';
import { NotFoundError, ValidationError } from '../../utils/error';
import { calculateCompletedTaskCoins, applyCoinRefund } from '../../config/rewards';
import { invalidateUserCache } from '../../middleware/authMiddleware';
import { resolveTimeZone, taskScheduleFromInput, todayKey } from '../../utils/dateKeys';
import { isOverdueLifecycleTask } from './taskLifecycle';
import { resolvePlatformValue } from '../../utils/platform';

/**
 * Notes are stored exclusively in the `Note` model, accessible via `/api/tasks/:id/notes`.
 * `Task` rows do not carry a notes payload.
 */

export function resolvePlatformForUpdate(
  patch: { problemUrl?: string; platform?: string },
  existing: { problemUrl: string | null; platform: string | null },
): string {
  if (patch.problemUrl !== undefined) {
    // URL changed or was set → URL wins, same rule as create.
    return resolvePlatformValue(patch.problemUrl, patch.platform || existing.platform);
  }
  // URL unchanged: respect explicit override if provided, else keep existing.
  return patch.platform ?? existing.platform ?? 'custom';
}

const DIFFICULTIES = ['easy', 'medium', 'hard'];
const TASK_TYPES = ['new'];

export interface CreateTaskInput {
  title: string;
  topic: string;
  difficulty?: string;
  platform?: string;
  problemUrl?: string;
  taskType?: string;
  scheduledDate: string;
  planId?: string;
}

/**
 * Validates an optional text field from an UPDATE request.
 *  - undefined  → field not sent → returns undefined (no change)
 *  - non-string → ValidationError
 *  - blank      → ValidationError (never silently ignored)
 *  - too long   → ValidationError
 */
export function validateOptionalText(
  value: unknown,
  field: string,
  maxLength?: number,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new ValidationError(`${field} must be text`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new ValidationError(`${field} cannot be empty`);
  }
  if (maxLength !== undefined && trimmed.length > maxLength) {
    throw new ValidationError(`${field} must be ${maxLength} characters or fewer`);
  }
  return trimmed;
}

/**
 * Core task service — CRUD operations and validation.
 */
export const taskService = {
  async getTodaysTasks(userId: string, tz?: string) {
    return taskRepository.getTodaysTasks(userId, tz);
  },

  async getTaskById(taskId: string, userId: string) {
    const task = await taskRepository.getTaskById(taskId, userId);
    if (!task) throw new NotFoundError('Task');
    return {
      ...task,
      isPlanArchived: task.plan?.status === 'archived',
    };
  },

  async getAllTasks(
    userId: string,
    filters?: {
      status?: string;
      topic?: string;
      taskType?: string;
      planId?: string;
    }
  ) {
    return taskRepository.getAllTasks(userId, filters);
  },

  async createTask(userId: string, data: CreateTaskInput, tz?: string) {
    // ─── Validation ───
    if (!data.title || !data.title.trim()) {
      throw new ValidationError('Title is required');
    }

    if (data.title.length > 200) {
      throw new ValidationError('Title must be under 200 characters');
    }

    if (!data.topic || !data.topic.trim()) {
      throw new ValidationError('Topic is required');
    }

    if (data.difficulty && !DIFFICULTIES.includes(data.difficulty)) {
      throw new ValidationError(
        `difficulty must be one of: ${DIFFICULTIES.join(', ')}`
      );
    }

    const RESERVED_TASK_TYPES = ['potd', 'revision', 'personal', 'cp31'];
    if (data.taskType && RESERVED_TASK_TYPES.includes(data.taskType)) {
      throw new ValidationError('This task type is created automatically and cannot be added manually.');
    }

    if (data.taskType && !TASK_TYPES.includes(data.taskType)) {
      throw new ValidationError(
        `taskType must be one of: ${TASK_TYPES.join(', ')}`
      );
    }

    const effectiveTz = resolveTimeZone(tz);
    const schedule = taskScheduleFromInput(data.scheduledDate, effectiveTz);
    const today = todayKey(effectiveTz);
    const taskType = data.taskType || 'new';
    const isOverdue = isOverdueLifecycleTask({ taskType, scheduledDateKey: schedule.scheduledDateKey }, today);

    if (data.problemUrl && !/^https?:\/\//i.test(data.problemUrl)) {
      throw new ValidationError('problemUrl must start with http:// or https://');
    }

    return taskRepository.createTask({
      user: { connect: { id: userId } },
      title: data.title.trim(),
      topic: data.topic.trim(),
      difficulty: data.difficulty || 'medium',
      platform: resolvePlatformValue(data.problemUrl, data.platform || 'custom'),
      problemUrl: data.problemUrl?.trim() || null,
      taskType,
      status: isOverdue ? 'backlog' : 'pending',
      isBacklog: isOverdue,
      backlogSince: isOverdue ? new Date() : null,
      isExpired: false,
      scheduledDate: schedule.scheduledDate,
      scheduledDateKey: schedule.scheduledDateKey,
      ...(data.planId ? { plan: { connect: { id: data.planId } } } : {}),
    });
  },

  async updateTask(
    taskId: string,
    userId: string,
    data: {
      title?: string;
      topic?: string;
      difficulty?: string;
      platform?: string;
      problemUrl?: string;
      scheduledDate?: string;
    },
    tz?: string
  ) {
    const existing = await this.getTaskById(taskId, userId);
    if (existing.taskType === 'cp31') {
      throw new ValidationError('CP31 problems are managed by the ladder and can’t be edited');
    }

    const title = validateOptionalText(data.title, 'Title', 200);
    const topic = validateOptionalText(data.topic, 'Topic');

    if (data.difficulty && !DIFFICULTIES.includes(data.difficulty)) {
      throw new ValidationError(
        `difficulty must be one of: ${DIFFICULTIES.join(', ')}`
      );
    }

    const effectiveTz = resolveTimeZone(tz);
    const schedule =
      data.scheduledDate !== undefined
        ? taskScheduleFromInput(data.scheduledDate, effectiveTz)
        : undefined;

    let lifecyclePatch: {
      status?: string;
      isBacklog?: boolean;
      backlogSince?: Date | null;
      isExpired?: boolean;
    } = {};

    if (schedule && existing.status !== 'completed') {
      const today = todayKey(effectiveTz);
      const isOverdue = isOverdueLifecycleTask(
        { taskType: existing.taskType, scheduledDateKey: schedule.scheduledDateKey },
        today
      );

      if (isOverdue) {
        lifecyclePatch = {
          status: 'backlog',
          isBacklog: true,
          backlogSince:
            existing.status === 'backlog' && existing.scheduledDateKey === schedule.scheduledDateKey
              ? existing.backlogSince ?? new Date()
              : new Date(),
          isExpired: false,
        };
      } else {
        lifecyclePatch = {
          status: 'pending',
          isBacklog: false,
          backlogSince: null,
          isExpired: false,
        };
      }
    }

    if (schedule && existing.taskType === 'revision') {
      await prisma.revision.updateMany({
        where: { revisionTaskId: taskId },
        data: { scheduledDate: schedule.scheduledDate },
      });
    }

    const hasPlatformChange = data.platform !== undefined || data.problemUrl !== undefined;
    const resolvedPlatform = hasPlatformChange
      ? resolvePlatformForUpdate(
          { problemUrl: data.problemUrl, platform: data.platform },
          { problemUrl: existing.problemUrl, platform: existing.platform }
        )
      : undefined;

    return taskRepository.updateTask(taskId, {
      ...(title !== undefined && { title }),
      ...(topic !== undefined && { topic }),
      ...(data.difficulty && { difficulty: data.difficulty }),
      ...(resolvedPlatform !== undefined && { platform: resolvedPlatform }),
      ...(data.problemUrl !== undefined && {
        problemUrl: data.problemUrl?.trim() || null,
      }),
      ...(schedule && {
        scheduledDate: schedule.scheduledDate,
        scheduledDateKey: schedule.scheduledDateKey,
      }),
      ...lifecyclePatch,
    });
  },

  /**
   * Delete a task. If it (or, for a parent, any of its completed revisions) was solved,
   * refund those coins so users.coins always equals "sum of what is currently solved".
   */
  async deleteTask(taskId: string, userId: string) {
    const task = await this.getTaskById(taskId, userId);
    if (task.taskType === 'cp31') {
      throw new ValidationError('CP31 problems are managed by the ladder — use Skip instead of Delete');
    }

    await prisma.$transaction(async (tx) => {
      let refund =
        task.status === 'completed' && task.taskType !== 'personal'
          ? calculateCompletedTaskCoins(task.taskType, task.rating)
          : 0;

      if (task.taskType === 'new') {
        const doneRevs = await tx.task.count({
          where: {
            parentTaskId: taskId,
            taskType: 'revision',
            status: 'completed',
          },
        });

        refund += doneRevs * calculateCompletedTaskCoins('revision');

        await tx.task.deleteMany({
          where: {
            parentTaskId: taskId,
            taskType: 'revision',
          },
        });

        await tx.revision.deleteMany({
          where: {
            parentTaskId: taskId,
          },
        });
      } else if (task.taskType === 'revision') {
        await tx.revision.deleteMany({
          where: {
            revisionTaskId: taskId,
          },
        });
      } else if (task.taskType === 'potd' && task.potdDateKey) {
        await tx.potdDismissal.upsert({
          where: {
            userId_dateKey: {
              userId,
              dateKey: task.potdDateKey,
            },
          },
          create: {
            userId,
            dateKey: task.potdDateKey,
          },
          update: {},
        });
      }

      // Explicit policy for ALL task types that may have recurrence
      // children (currently only 'personal'): unlink, never cascade-delete.
      await tx.task.updateMany({
        where: { recurrenceParentId: taskId },
        data: { recurrenceParentId: null },
      });

      await tx.task.delete({
        where: { id: taskId },
      });

      if (refund > 0) {
        const user = await tx.user.findUnique({
          where: { id: userId },
          select: { coins: true },
        });

        await tx.user.update({
          where: { id: userId },
          data: {
            coins: applyCoinRefund(user?.coins ?? 0, refund, {
              userId,
              taskId,
              reason: 'deleteTask',
            }),
          },
        });
      }
    });

    invalidateUserCache(userId);

    return { ok: true };
  },

  /** BUG 10: bulk-clear pending/backlog revision tasks. Completed stay (their coins stay). Pending earned 0 coins → no refund. */
  async clearPendingRevisions(userId: string) {
    return prisma.$transaction(async (tx) => {
      const victims = await tx.task.findMany({
        where: { userId, taskType: 'revision', status: { in: ['pending', 'backlog'] } },
        select: { id: true },
      });
      const ids = victims.map((v) => v.id);
      if (ids.length === 0) return { cleared: 0 };
      await tx.revision.deleteMany({ where: { revisionTaskId: { in: ids } } });
      await tx.task.deleteMany({ where: { id: { in: ids } } });
      return { cleared: ids.length };
    });
  },
};
