import { randomUUID } from 'node:crypto';
import { Prisma, type Task } from '@prisma/client';
import prisma from '../../config/database';
import { env } from '../../config/env';
import {
  dateKeyInTz,
  todayKey,
  addDaysToKey,
  maxKey,
  nextOccurrenceKey,
  taskScheduleForKey,
  type Recurrence,
} from '../../utils/dateKeys';
import { NotFoundError, ValidationError } from '../../utils/error';
import { invalidateUserCache } from '../../middleware/authMiddleware';
import { resolvePlatformValue } from '../../utils/platform';
import { getUndoLifecyclePatch } from './taskLifecycle';
import { CSES_UNDO_PATCH, decideSolve } from '../cses/csesPolicy';

import {
  COIN_REWARDS,
  calculateRatingBonus,
  applyCoinRefund,
} from '../../config/rewards';
import logger from '../../utils/logger';
import { TX_OPTIONS } from '../../config/transaction';

export interface TaskMutationResult {
  task: Task;
  coinsDelta: number;
}

export function makeMutationResult<T extends object>(task: T, coinsDelta: number): TaskMutationResult & T {
  return new Proxy({ task, coinsDelta } as any, {
    get(target, prop, receiver) {
      if (prop in target) {
        return Reflect.get(target, prop, receiver);
      }
      return Reflect.get(task, prop);
    },
  });
}

export type Rating = 'easy' | 'medium' | 'hard';

const RATINGS = ['easy', 'medium', 'hard'] as const;

const REVISION_INTERVALS: Record<Rating, readonly number[]> = {
  easy:   [14, 28],
  medium: [1, 3, 7, 14],
  hard:   [1, 3, 7, 14, 28],
};

function parseRating(value: unknown): Rating {
  if (typeof value === 'string' && (RATINGS as readonly string[]).includes(value as Rating)) return value as Rating;
  throw new ValidationError(`rating must be one of: ${RATINGS.join(', ')}`);
}

function bonusFor(rating: string | null | undefined): number {
  return calculateRatingBonus(rating);
}

type ParentTask = Pick<Task, 'id' | 'planId' | 'title' | 'topic' | 'difficulty' | 'platform' | 'problemUrl'>;

/**
 * OPTION B (product decision): re-rating PRESERVES completed revisions.
 * Their coins stay; their history stays on the roadmap. Only pending/backlog
 * revisions are replaced, and numbering CONTINUES from completed work
 * (kills BUG 23 duplicate-numbering without deleting history).
 *
 * Count rule:
 *   targetTotal  = REVISION_INTERVALS[rating].length
 *   nextPosition = max(count of completed revisions, max existing revisionNumber)
 *   create       = (targetTotal - nextPosition) new pending revisions at
 *                  positions nextPosition+1..targetTotal
 *   if nextPosition >= targetTotal → create nothing.
 *
 * BUG 12: baseKey = max(solve-day, today) so re-rating an old solve never
 * schedules revisions in the past.
 *
 * Returns void — NO refund is ever owed here (nothing completed is deleted;
 * pending revisions earned 0 coins).
 */
async function regenerateRevisions(
  tx: Prisma.TransactionClient,
  userId: string,
  parent: ParentTask,
  anchor: Date,
  rating: Rating,
  tz: string = env.DEFAULT_TIMEZONE,
): Promise<void> {
  // 1. Wipe ONLY unfinished revisions
  await tx.revision.deleteMany({
    where: { parentTaskId: parent.id, status: { in: ['pending', 'backlog'] } },
  });
  await tx.task.deleteMany({
    where: { parentTaskId: parent.id, taskType: 'revision', status: { in: ['pending', 'backlog'] } },
  });

  // 2. Positions already OCCUPIED by surviving child rows.
  //    completed = fulfilled work.
  //    expired   = lapsed slot, still shown on the roadmap.
  //    Both keep their revision number. Pending/backlog rows were deleted in step 1.
  const survivors = await tx.task.findMany({
    where: {
      parentTaskId: parent.id,
      taskType: 'revision',
      status: { in: ['completed', 'expired'] },
    },
    select: { revisionNumber: true, status: true },
  });
  const completedCount = survivors.filter((r) => r.status === 'completed').length;
  const highestOccupied = survivors.reduce((m, r) => Math.max(m, r.revisionNumber), 0);
  const nextPosition = Math.max(completedCount, highestOccupied);

  const intervals = REVISION_INTERVALS[rating];
  const targetTotal = intervals.length;
  const createCount = Math.max(0, targetTotal - nextPosition);
  if (createCount === 0) return; // completed work already satisfies the plan

  // 3. BUG 12 clamp: never schedule in the past
  const solvedKey = dateKeyInTz(anchor, tz);
  const baseKey = maxKey(solvedKey, todayKey(tz));

  // 4. Create the shortfall with CONTINUED numbering
  const ids = Array.from({ length: createCount }, () => randomUUID());

  const schedules = Array.from({ length: createCount }, (_, i) => {
    const position = nextPosition + 1 + i;
    const days = intervals[position - 1];
    const revisionKey = addDaysToKey(baseKey, days);
    return {
      position,
      schedule: taskScheduleForKey(revisionKey, tz),
    };
  });

  await tx.task.createMany({
    data: schedules.map(({ position, schedule }, i) => ({
      id: ids[i],
      userId,
      planId: parent.planId,
      parentTaskId: parent.id,
      title: parent.title,
      topic: parent.topic,
      difficulty: parent.difficulty,
      platform: resolvePlatformValue(parent.problemUrl, parent.platform),
      problemUrl: parent.problemUrl,
      taskType: 'revision',
      status: 'pending',
      scheduledDate: schedule.scheduledDate,
      scheduledDateKey: schedule.scheduledDateKey,
      revisionNumber: position,
    })),
  });

  await tx.revision.createMany({
    data: schedules.map(({ position, schedule }, i) => ({
      parentTaskId: parent.id,
      revisionTaskId: ids[i],
      revisionNumber: position,
      scheduledDate: schedule.scheduledDate,
      status: 'pending',
    })),
  });
}

export const taskCompletionService = {
  /**
   * Solve (and optionally rate) a task. Serves POST /complete (rating optional) and POST /rate (rating required).
   *  - first solve  → +10 coins
   *  - rating given → bonus delta (new − previous), revisions regenerated (never duplicated)
   *  - anchor is the solved-on calendar day x in the user's timezone.
   */
  async completeTask(userId: string, taskId: string, ratingInput?: unknown, tz: string = env.DEFAULT_TIMEZONE, now: Date = new Date()) {
    const rating = ratingInput === undefined || ratingInput === null || ratingInput === '' ? undefined : parseRating(ratingInput);

    const task = await prisma.task.findFirst({ where: { id: taskId, userId } });
    if (!task) throw new NotFoundError('Task');
    if (task.taskType === 'cses' && task.status !== 'completed') {
      const verdict = decideSolve({
        status: task.status,
        scheduledDateKey: task.scheduledDateKey,
        today: todayKey(tz, now),
      });
      if (!verdict.ok) throw new ValidationError(verdict.reason);
    }
    // DECISION: revision tasks are marked done, never rated (rating one would spawn revisions of revisions).
    if (rating && task.taskType === 'revision') throw new ValidationError('Revision tasks are marked done, not rated');

    if (task.taskType === 'personal') {
      if (rating) throw new ValidationError('Personal tasks cannot be rated');
    }

    if (task.taskType !== 'personal' && task.recurrence) {
      // Data hygiene: recurrence must never exist on DSA tasks.
      throw new ValidationError('Only personal tasks can repeat');
    }

    const isFirstSolve = task.status !== 'completed';
    const nextRating: Rating | null = rating ?? (task.rating as Rating | null) ?? null;
    const coinDelta =
      task.taskType === 'personal'
        ? 0
        : (isFirstSolve ? COIN_REWARDS.solve : 0) +
          (rating ? bonusFor(rating) - bonusFor(task.rating) : 0);

    const txStarted = Date.now();
    const result = await prisma.$transaction(async (tx) => {
      const updated = await tx.task.update({
        where: { id: taskId },
        data: {
          status: 'completed',
          rating: nextRating,
          completedAt: isFirstSolve ? now : (task.completedAt ?? now),   // re-rating must not move "completed today"
          originalSolveDate: task.originalSolveDate ?? now,
          isBacklog: false,
          backlogSince: null,
          isExpired: false,
          skippedAt: null,
        },
      });

      // Repeat: personal-only. Spawn next occurrence on FIRST completion.
      if (
        task.taskType === 'personal' &&
        task.recurrence &&
        task.scheduledDateKey &&
        isFirstSolve
      ) {
        const baseKey = maxKey(task.scheduledDateKey, todayKey(tz)); // never spawn in the past
        const nextKey = nextOccurrenceKey(baseKey, task.recurrence as Recurrence);

        const schedule = taskScheduleForKey(nextKey, tz);

        await tx.task.create({
          data: {
            userId,
            recurrenceParentId: task.id,          // recurrence chain link
            title: task.title,
            topic: 'Personal',
            taskType: 'personal',
            status: 'pending',
            recurrence: task.recurrence,
            dueTime: task.dueTime,
            durationMin: task.durationMin,
            scheduledDate: schedule.scheduledDate,
            scheduledDateKey: schedule.scheduledDateKey,
          },
        });
      }

      if (task.taskType === 'revision') {
        await tx.revision.updateMany({
          where: { revisionTaskId: taskId, status: { not: 'completed' } },
          data: { status: 'completed', completedAt: now },
        });
      }

      if (isFirstSolve || coinDelta !== 0) {
        if (coinDelta > 0) {
          await tx.user.update({
            where: { id: userId },
            data: { coins: { increment: coinDelta } },
          });
        } else if (coinDelta < 0) {
          const user = await tx.user.findUnique({ where: { id: userId }, select: { coins: true } });
          await tx.user.update({
            where: { id: userId },
            data: {
              coins: applyCoinRefund(user?.coins ?? 0, -coinDelta, {
                userId,
                taskId,
                reason: 'completeTask',
              }),
            },
          });
        }
      }

      if (rating) {
        // DECISION: anchor revisions on the SOLVE date, not the plan's scheduledDate, so a backlog task
        // solved late never gets revisions in the past.
        const solvedOn = updated.originalSolveDate ?? updated.completedAt ?? now;
        await regenerateRevisions(tx, userId, updated, solvedOn, rating, tz);
      }

      return updated;
    }, TX_OPTIONS);
    const txElapsed = Date.now() - txStarted;
    if (txElapsed > 3_000) {
      logger.warn('slow task transaction', { op: 'completeTask', taskId, elapsedMs: txElapsed });
    }
    invalidateUserCache(userId);
    return makeMutationResult(result, coinDelta);
  },

  /**
   * Un-rate: remove the revision plan, KEEP the solve.
   *  - rating cleared (null)
   *  - all child revisions deleted (pending, backlog, completed)
   *  - status stays 'completed', completedAt unchanged
   *  - bonus coins + completed revision coins refunded (base solve coins kept)
   */
  async unrateTask(userId: string, taskId: string) {
    const task = await prisma.task.findFirst({ where: { id: taskId, userId } });
    if (!task) throw new NotFoundError('Task');

    const txStarted = Date.now();
    const result = await prisma.$transaction(async (tx) => {
      // Step 1: Count completed revisions BEFORE deleting them
      const doneRevs = await tx.task.count({
        where: { parentTaskId: taskId, taskType: 'revision', status: 'completed' },
      });

      // Step 2: Compute total refund = ratingBonus(task.rating) + (doneRevs * 10)
      // Parent remains solved, so COIN_REWARDS.solve (10) is NOT refunded.
      const bonusRefund = bonusFor(task.rating);
      const revRefund = doneRevs * COIN_REWARDS.revision;
      const totalRefund = bonusRefund + revRefund;

      // Step 3: Delete Revision records
      await tx.revision.deleteMany({ where: { parentTaskId: taskId } });

      // Step 4: Delete revision tasks
      await tx.task.deleteMany({ where: { parentTaskId: taskId, taskType: 'revision' } });

      // Step 5: Update parent
      const updated = await tx.task.update({
        where: { id: taskId },
        data: { rating: null },
      });

      // Step 6: Apply coin decrement
      if (totalRefund > 0) {
        const user = await tx.user.findUnique({ where: { id: userId }, select: { coins: true } });
        if (user) {
          await tx.user.update({
            where: { id: userId },
            data: {
              coins: applyCoinRefund(user.coins, totalRefund, {
                userId,
                taskId,
                reason: 'unrateTask',
              }),
            },
          });
        }
      }
      return { updated, totalRefund };
    }, TX_OPTIONS);
    const txElapsed = Date.now() - txStarted;
    if (txElapsed > 3_000) {
      logger.warn('slow task transaction', { op: 'unrateTask', taskId, elapsedMs: txElapsed });
    }
    invalidateUserCache(userId);
    return makeMutationResult(result.updated, result.totalRefund === 0 ? 0 : -result.totalRefund);
  },

  /**
   * Undo solve: full revert according to lifecycle policy.
   *  - Isolated in a Serializable Prisma transaction with P2034 retry loop for concurrency safety.
   *  - Reads state inside transaction; if already undone, returns task with no duplicate refund.
   *  - Clears rating, completedAt, originalSolveDate.
   *  - Restores overdue ordinary tasks immediately to backlog (backlogSince = now).
   *  - CP31: active band → pending Today; inactive/disabled band → parked (null keys).
   *  - POTD: preserves challenge identity and potdDateKey.
   *  - Already pending/backlog → no-op (return unchanged, no refunds).
   *  - Skipped/expired → reject.
   *  - Refunds base + bonus + completed child revision coins on first undo only.
   */
  async undoTask(userId: string, taskId: string, tz: string = env.DEFAULT_TIMEZONE) {
    const maxRetries = 5;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const txStarted = Date.now();
        const result = await prisma.$transaction(
          async (tx) => {
            const task = await tx.task.findFirst({ where: { id: taskId, userId } });
            if (!task) throw new NotFoundError('Task');

            if (task.status === 'pending' || task.status === 'backlog') {
              return { updated: task, totalRefund: 0 };
            }

            if (task.status === 'skipped') {
              throw new ValidationError('Skipped tasks cannot be undone. Use the Retry endpoint instead.');
            }

            if (task.status === 'expired') {
              throw new ValidationError('Expired tasks cannot be undone.');
            }

            if (task.status !== 'completed') {
              throw new ValidationError('Task is not completed');
            }

            const now = new Date();
            const user = await tx.user.findUnique({
              where: { id: userId },
              select: { cp31Enabled: true, cp31Band: true, coins: true },
            });

            const patch = getUndoLifecyclePatch(task, tz, now, {
              cp31Enabled: user?.cp31Enabled ?? false,
              cp31Band: user?.cp31Band ?? null,
            });

            const isRevision = task.taskType === 'revision';
            let totalRefund = 0;

            if (!isRevision) {
              if (task.taskType === 'personal') {
                if (task.recurrence) {
                  await tx.task.deleteMany({
                    where: {
                      userId,
                      recurrenceParentId: taskId,
                      taskType: 'personal',
                      status: 'pending',
                    },
                  });
                }
              } else {
                totalRefund += COIN_REWARDS.solve + bonusFor(task.rating);

                const doneRevs = await tx.task.count({
                  where: { parentTaskId: taskId, taskType: 'revision', status: 'completed' },
                });
                totalRefund += doneRevs * COIN_REWARDS.revision;

                await tx.revision.deleteMany({ where: { parentTaskId: taskId } });
                await tx.task.deleteMany({ where: { parentTaskId: taskId, taskType: 'revision' } });
              }
            } else {
              totalRefund += COIN_REWARDS.revision;

              await tx.revision.updateMany({
                where: { revisionTaskId: taskId },
                data: { status: 'pending', completedAt: null },
              });
            }

            const updated = await tx.task.update({
              where: { id: taskId },
              data: task.taskType === 'cses' ? { ...CSES_UNDO_PATCH } : patch,
            });

            if (totalRefund > 0 && user) {
              await tx.user.update({
                where: { id: userId },
                data: {
                  coins: applyCoinRefund(user.coins, totalRefund, {
                    userId,
                    taskId,
                    reason: 'undoTask',
                  }),
                },
              });
            }

            return { updated, totalRefund };
          },
          {
            isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
            ...TX_OPTIONS,
          },
        );
        const txElapsed = Date.now() - txStarted;
        if (txElapsed > 3_000) {
          logger.warn('slow task transaction', { op: 'undoTask', taskId, elapsedMs: txElapsed });
        }

        invalidateUserCache(userId);
        return makeMutationResult(result.updated, result.totalRefund === 0 ? 0 : -result.totalRefund);
      } catch (err: any) {
        if (err?.code === 'P2034' && attempt < maxRetries - 1) {
          continue;
        }
        throw err;
      }
    }
    throw new Error('undoTask failed after max retries');
  },

  /** Backward-compatible helper aliases */
  async rateTask(taskId: string, userId: string, rating: string, tz: string = env.DEFAULT_TIMEZONE) {
    return this.completeTask(userId, taskId, rating, tz);
  },
};
