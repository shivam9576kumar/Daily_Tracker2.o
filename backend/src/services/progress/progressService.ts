import prisma from '../../config/database';
import { ACTIVITY_WHERE } from './activityWhere';
import { streakService } from './streakService';
import { heatmapService } from './heatmapService';
import { topicProgressService } from './topicProgressService';
import type { ProgressScope } from './progressTypes';

export const progressService = {
  async getStats(userId: string, tz: string) {
    const [totalSolved, revisionsDone, pendingRevisions, user, streaks] = await Promise.all([
      prisma.task.count({ where: { userId, taskType: { in: ['new', 'potd', 'cp31', 'cses'] }, status: 'completed' } }),
      prisma.task.count({ where: { userId, taskType: 'revision', status: 'completed' } }),
      prisma.task.count({
        where: { userId, taskType: 'revision', status: { in: ['pending', 'backlog'] } },
      }),
      prisma.user.findUnique({ where: { id: userId }, select: { coins: true } }),
      streakService.getStreaks(userId, tz),
    ]);

    return {
      totalSolved,
      revisionsDone,
      pendingRevisions,
      coins: user?.coins ?? 0,
      currentStreak: streaks.current,
      bestStreak: streaks.best,
      activeToday: streaks.activeToday,
      activeDays: streaks.activeDays,
    };
  },

  async getRecentActivity(userId: string, limit = 10) {
    const take = Math.min(50, Math.max(1, limit));
    return prisma.task.findMany({
      where: { userId, ...ACTIVITY_WHERE },
      orderBy: { completedAt: 'desc' },
      take,
      select: {
        id: true,
        title: true,
        topic: true,
        difficulty: true,
        taskType: true,
        rating: true,
        revisionNumber: true,
        completedAt: true,
        problemUrl: true,
      },
    });
  },

  /** One call for the whole Progress page. */
  async getOverview(userId: string, tz: string, scope: ProgressScope | 'auto', months: number) {
    const [stats, heatmap, topics, activity] = await Promise.all([
      this.getStats(userId, tz),
      heatmapService.getHeatmap(userId, tz, months),
      topicProgressService.getTopicProgress(userId, scope),
      this.getRecentActivity(userId, 10),
    ]);
    return { stats, heatmap, topics, activity, generatedAt: new Date().toISOString() };
  },
};
