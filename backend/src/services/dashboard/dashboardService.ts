import type { Task } from '@prisma/client';
import { taskRepository } from '../../repositories/taskRepository';
import prisma from '../../config/database';
import logger from '../../utils/logger';
import { streakService } from '../progress/streakService';
import { classesService } from '../classes/classesService';
import { ensurePotdTaskForUser } from '../potd/potdService';
import { computePotdStreak, type PotdStreakResult } from '../potd/potdStreakService';
import { ensureCp31TasksForUser, emptyCp31State, listSkippedCp31, toPublicCp31State, type Cp31State } from '../cp31/cp31Service';
import { computeCp31Streak, type Cp31StreakResult } from '../cp31/cp31StreakService';
import { todayKey, addDaysToKey } from '../../utils/dateKeys';
import { LIVE_TASK_WHERE, OPEN_BACKLOG_WHERE } from '../task/taskLifecycle';
import { reconcileOverdueForUser } from '../task/overdueReconciler';

/**
 * Runs an optional read/write and degrades to a fallback on failure.
 * Matches the existing try/catch-and-continue behavior for POTD/CP31/streaks.
 */
async function settle<T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    logger.warn(`dashboardService: ${label} failed, continuing`, { message: (err as Error)?.message });
    return fallback;
  }
}

/**
 * Dashboard service — aggregates all data for GET /api/dashboard/today
 * in a single call, avoiding 10+ separate API requests from the frontend.
 */
export const dashboardService = {
  async getDashboardData(userId: string, tz: string) {
    // PHASE 1 — writes, sequential, degrade on failure (unchanged semantics)
    const ensuredPotd = await settle('POTD ensure', () => ensurePotdTaskForUser(userId, tz), {
      enabled: true, taskId: null, potd: null, stale: false,
    });
    const cp31State = await settle('CP31 ensure', () => ensureCp31TasksForUser(userId, tz), emptyCp31State());
    await settle('overdue reconcile', () => reconcileOverdueForUser(userId, tz), 0);

    // PHASE 2 — reads, one concurrent batch
    const [
      todaysTasks,
      totalQuestions,
      user,
      activePlan,
      backlogCount,
      expiredCount,
      streaks,
      pendingAssignments,
      classesForWeek,
      potdStreak,
      cp31Streak,
      cp31Skipped,
    ] = await Promise.all([
      taskRepository.getTodaysTasks(userId, tz, ensuredPotd.potd?.dateKey ?? null),
      // Total unique problems actually solved (new tasks + potd + cp31 + cses, not revisions)
      prisma.task.count({
        where: { userId, taskType: { in: ['new', 'potd', 'cp31', 'cses'] }, status: 'completed' },
      }),
      prisma.user.findUnique({
        where: { id: userId },
        select: { coins: true },
      }),
      prisma.plan.findFirst({
        where: { userId, status: 'active' },
        select: { id: true, name: true },
      }),
      // Backlog: canonical open backlog count
      prisma.task.count({
        where: {
          AND: [
            { userId },
            LIVE_TASK_WHERE,
            OPEN_BACKLOG_WHERE,
          ],
        },
      }),
      // Expired: flagged expired (live plan or manual)
      prisma.task.count({
        where: {
          AND: [
            { userId, isExpired: true },
            LIVE_TASK_WHERE,
          ],
        },
      }),
      streakService.getStreaks(userId, tz),
      prisma.assignment.findMany({
        where: { userId, status: 'pending' },
        orderBy: { deadline: 'asc' },
      }),
      classesService.list(userId).catch(() => []),
      settle('POTD streak', () => computePotdStreak(userId, tz), null as PotdStreakResult | null),
      settle('CP31 streak', () => computeCp31Streak(userId, tz), null as Cp31StreakResult | null),
      settle('CP31 skipped', () => listSkippedCp31(userId, cp31State.band ?? undefined), [] as Task[]),
    ]);

    const pendingTasks = todaysTasks.filter((t) => t.status !== 'completed');
    const completedTasks = todaysTasks
      .filter((t) => t.status === 'completed')
      .sort((a, b) => (b.completedAt?.getTime() ?? 0) - (a.completedAt?.getTime() ?? 0)); // newest first

    const vibe = getVibe(pendingTasks.length, completedTasks.length, !!activePlan);

    // Color-code assignments by urgency (user-tz aware)
    const assignments = pendingAssignments.map((a) => ({
      ...a,
      urgency: getUrgency(a.deadline, tz),
    }));

    return {
      hasActivePlan: !!activePlan,
      activePlan: activePlan ?? null,
      statusOverview: {
        totalQuestions,
        streak: streaks.current,
        streakActiveToday: streaks.activeToday,
        backlog: backlogCount,
        expired: expiredCount,
        coins: user?.coins || 0,
      },
      vibe,
      pendingAssignments: assignments,
      todaysHitlist: {
        pending: pendingTasks,
        completed: completedTasks,
      },
      classes: classesForWeek,
      potdStreak,
      dailyChallenges: {
        potd: { enabled: ensuredPotd.enabled },
        // toPublicCp31State strips internal fields (servedNow, served, pendingTaskIds)
        // that must not appear in any public response. bandStatus is passed through
        // unmodified ('complete-awaiting-confirm'), consistent with todoService.
        cp31: { ...toPublicCp31State(cp31State), skippedCount: cp31Skipped.length },
      },
      cp31Streak,
    };
  },
};

function getVibe(
  pendingCount: number,
  completedCount: number,
  hasActivePlan: boolean = true,
) {
  if (pendingCount === 0) {
    if (completedCount === 0) {
      if (!hasActivePlan) {
        return { emoji: '🌱', message: 'No active plan. Generate a plan to get a daily hitlist.', intensity: 'none' as const };
      }
      return { emoji: '🎉', message: 'All clear! No tasks today. Enjoy your day!', intensity: 'none' as const };
    }
    return {
      emoji: '🏁',
      message: `All done for today — ${completedCount} solved. Nice work!`,
      intensity: 'none' as const,
    };
  }

  if (pendingCount >= 6) {
    return { emoji: '⚔️', message: 'Grind Day! Heavy load ahead. Stay focused!', intensity: 'high' as const };
  }
  if (pendingCount >= 3) {
    return { emoji: '💪', message: 'Solid day! A good mix of challenges awaits.', intensity: 'medium' as const };
  }
  return { emoji: '🌤️', message: 'Light day! Quick and easy. Keep the streak alive!', intensity: 'low' as const };
}

/**
 * Determine assignment urgency based on deadline in the user's timezone.
 *
 * Deadlines are date-only values stored at UTC midnight, so
 * toISOString().slice(0,10) faithfully extracts the calendar date.
 * We compare that against todayKey(tz) so the result is correct
 * regardless of where the server runs.
 */
function getUrgency(deadline: Date, tz: string): 'today' | 'tomorrow' | 'future' {
  // Deadline is a date-only value encoded at UTC midnight.
  const deadlineKey = deadline.toISOString().slice(0, 10);
  const today = todayKey(tz);
  const tomorrow = addDaysToKey(today, 1);

  if (deadlineKey <= today) return 'today';
  if (deadlineKey === tomorrow) return 'tomorrow';
  return 'future';
}
