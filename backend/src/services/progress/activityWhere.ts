import { Prisma } from '@prisma/client';

/**
 * THE single definition of "activity" for heatmap + streaks.
 * New problems AND revisions count. Assignments never appear here (separate table).
 */
export const ACTIVITY_WHERE: Prisma.TaskWhereInput = {
  status: 'completed',
  completedAt: { not: null },
  taskType: { in: ['new', 'revision', 'potd', 'cp31', 'cses'] },
};
