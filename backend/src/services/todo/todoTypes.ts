import type { Assignment, Task } from '@prisma/client';
import type { CsesMeta } from '../cses/csesService';

export interface TodoSummary {
  inbox: number;
  today: number;
  upcoming: number;
  backlog: number;
  completedToday: number;
}

export interface TodoDateGroup {
  dateKey: string;
  label: string;
  tasks: Task[];
  assignments: Assignment[];
}

export interface TodoTodayGroups {
  backlog: Task[];
  plan: Task[];
  potd: Task[];
  revisions: Task[];
  manual: Task[];
  personal: Task[];
  completed: Task[];
  assignments: Assignment[];
  cp31: Task[];
  cses: Task[];
}

export interface DailyChallengeMeta {
  potd: { enabled: boolean };
  cp31: {
    enabled: boolean;
    band: number | null;
    dailyCount: number;
    solvedInBand: number;
    bandSize: number;
    quotaDoneToday: boolean;
    extrasUsedToday: number;
    extrasCap: number;
    canOneMore: boolean;
    bandStatus: 'none' | 'active' | 'complete-awaiting-confirm';
    nextIndex: number | null;
    nextBand: number | null;
    skippedCount: number;
    solvedToday?: number;
    pendingCount?: number;
  };
  cses: CsesMeta | null;
}

export interface TodoResponse {
  timezone: string;
  todayKey: string;
  generatedAt: string;
  upcomingDays: number;
  summary: TodoSummary;
  inbox: Task[];
  today: TodoTodayGroups;
  upcoming: TodoDateGroup[];
  backlog: Task[];
  completed: TodoDateGroup[];
  dailyChallenges: DailyChallengeMeta;
}
