// Re-export everything from the shared package. Frontend convenience
// types that are purely UI-side (and not cross-boundary) live below
// the re-export line.

import {
  Difficulty,
  Platform,
  Rating,
  TaskStatus,
  TaskType,
  Recurrence,
  RECURRENCE_VALUES,
  REVISION_RULES,
  BACKLOG_EXPIRY_DAYS,
  DSA_TOPICS,
  type Assignment,
  type ClassSchedule,
  type Note,
  type Plan,
  type Revision,
  type Task,
  type User,
  type UserProfile,
  type CreateAssignmentInput,
  type CreateNoteInput,
  type CreatePlanInput,
  type CreateTaskInput,
  type GeneratePlanInput,
  type ParsedPlanInput,
  type TopicAllocation,
  type UpdateAssignmentInput,
  type UpdateNoteInput,
  type UpdateTaskInput,
  type TaskWithRevisions,
  type ProgressSummary,
  type StreakInfo,
  type DSATopic,
} from '@dsa-planner/shared';

export {
  // Enums
  Difficulty,
  Platform,
  Rating,
  TaskStatus,
  TaskType,
  Recurrence,
  RECURRENCE_VALUES,
  // Constants
  REVISION_RULES,
  BACKLOG_EXPIRY_DAYS,
  DSA_TOPICS,
  // Domain types
  type Assignment,
  type ClassSchedule,
  type Note,
  type Plan,
  type Revision,
  type Task,
  type User,
  type UserProfile,
  // Type aliases already used in shared
  type CreateAssignmentInput,
  type CreateNoteInput,
  type CreatePlanInput,
  type CreateTaskInput,
  type GeneratePlanInput,
  type ParsedPlanInput,
  type TopicAllocation,
  type UpdateAssignmentInput,
  type UpdateNoteInput,
  type UpdateTaskInput,
  type TaskWithRevisions,
  type ProgressSummary,
  type StreakInfo,
  type DSATopic,
};

// UI-shape aliases that combine shared primitives into view-specific
// shapes (kept here because they are not part of any API contract).
export type { TaskMutationResult } from './taskMutationResult';

export interface StatusOverview {
  totalQuestions: number;
  streak: number;
  streakActiveToday?: boolean;
  backlog: number;
  expired: number;
  coins: number;
}

export interface Vibe {
  emoji: string;
  message: string;
  intensity: 'none' | 'low' | 'medium' | 'high';
}

export type AssignmentUrgency = 'today' | 'tomorrow' | 'future';



export interface CreateAssignmentPayload {
  title: string;
  description?: string;
  deadline: string; // ISO or yyyy-mm-dd
}

export interface ClassRow {
  id: string;
  userId?: string;
  dayOfWeek: number;
  subject: string;
  startTime: string; // "HH:MM"
  endTime: string;
  location: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface PotdStreak {
  enabled?: boolean;
  currentStreak: number;
  longestStreak: number;
  totalSolved: number;
  lastSolvedDateKey: string | null;
  solvedToday: boolean;
}

export interface DailyChallengeSettings {
  potdEnabled: boolean;
  cp31Enabled: boolean;
  cp31Band: number | null;
  cp31DailyCount: number;
  availableBands: { band: number; count: number }[];
}

export interface DailyChallengeSettingsPatch {
  potdEnabled?: boolean;
  cp31Enabled?: boolean;
  cp31Band?: number | null;
  cp31DailyCount?: number;
}

export interface DailyChallengeSettingsResponse {
  settings: DailyChallengeSettings;
  changes: {
    potdUnsolvedRemoved: number;
    cp31PendingParked: number;
    cp31PendingRemoved?: number;
  };
  /** Immediately-materialized CP31 state after a band-enable/switch. null when CP31 is off. */
  cp31State: DailyChallengeMeta['cp31'] | null;
}

export interface TodoDailyChallenges {
  potd: { enabled: boolean };
}

export interface Cp31StreakResult {
  enabled: boolean;
  currentStreak: number;
  longestStreak: number;
  lastSolvedDateKey: string | null;
  solvedToday: boolean;
  totalSolved: number;
}

export interface DashboardData {
  hasActivePlan?: boolean;
  activePlan?: { id: string; name: string } | null;
  statusOverview: StatusOverview;
  vibe: Vibe;
  pendingAssignments: Assignment[];
  todaysHitlist: {
    pending: Task[];
    completed: Task[];
  };
  classes: ClassRow[];
  potdStreak?: PotdStreak | null;
  cp31Streak?: Cp31StreakResult | null;
  dailyChallenges?: DailyChallengeMeta;
}

export interface CreateTaskPayload {
  title: string;
  topic: string;
  difficulty: Difficulty;
  platform: string;
  problemUrl?: string;
  scheduledDate: string;
}

export interface ApiResponse<T> {
  success: boolean;
  data: T;
}

export interface AppNotification {
  id: string;
  userId: string;
  type: 'backlog' | 'expired' | 'revision' | 'system';
  title: string;
  message: string;
  metadata?: Record<string, unknown> | null;
  readAt: string | null;
  createdAt: string;
}

export type PlanSource = 'neetcode150' | 'coderarmy' | 'striver' | 'strivera2z';
export type PlanPace = 'relaxed' | 'moderate' | 'intensive' | 'custom';

export interface BusyDayInput {
  date: string;
  reason?: string;
  loadReduction: number;
}

export interface ScheduledQuestion {
  title: string;
  topic: string;
  difficulty: Difficulty;
  platform?: string;
  problemUrl?: string;
  question?: {
    id?: string;
    title: string;
    topic: string;
    difficulty: Difficulty;
    platform?: string;
    problemUrl?: string;
  };
  load?: number;
}

export interface DaySchedule {
  date: string;
  dayOfWeek: number;
  capacityLoad: number;
  usedLoad: number;
  isWeekend: boolean;
  isBufferDay: boolean;
  busyReason?: string;
  questions: ScheduledQuestion[];
}

export interface PlanPreviewData {
  valid: boolean;
  warnings: string[];
  errors: string[];
  summary: {
    source: string;
    totalQuestions: number;
    totalLoad: number;
    durationDays: number;
    startDate: string;
    endDate: string;
    weekdayLoad: number;
    weekendLoad: number;
    estimatedQuestionsPerDay: number;
  };
  days: DaySchedule[];
}

export type ScheduleMode = 'balanced' | 'sequential';

export interface TopicQuota {
  topic: string;
  count: number;
  all?: boolean;
}

export interface AIDraft {
  source: PlanSource | null;
  startDate: string | null;
  durationDays: number | null;
  pace: PlanPace | null;
  weekdayLoad: number | null;
  weekendLoad: number | null;
  topicQuotas: TopicQuota[] | null;
  focusTopics: string[] | null;
  avoidTopics: string[] | null;
  busyDays: BusyDayInput[] | null;
  bufferDay: number | null;
  scheduleMode?: ScheduleMode | null;
}

export type AIIntent =
  | 'general_chat'
  | 'plan_building'
  | 'request_preview'
  | 'request_commit'
  | 'off_topic';

export type AIAction = 'none' | 'show_draft' | 'offer_preview';

export interface AIChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface AIConversationRequest {
  messages: AIChatMessage[];
  draft: AIDraft;
  timezone?: string;
}

export interface AIConversationResponse {
  reply: string;
  intent: AIIntent;
  action: AIAction;
  draft: AIDraft;
  missingFields: string[];
  done: boolean;
  confidence: 'high' | 'low';
  warnings: string[];
  assumptions: string[];
}

export interface GeneratePlanPayload {
  name?: string;
  source: PlanSource;
  startDate: string;
  durationDays: number;
  pace: PlanPace;
  weekdayLoad: number;
  weekendLoad: number;
  topicQuotas?: TopicQuota[];
  focusTopics?: string[];
  avoidTopics?: string[];
  busyDays?: BusyDayInput[];
  bufferDay?: number;
  archiveExisting?: boolean;
  scheduleMode?: ScheduleMode;
}



export interface ArchivedPlan extends Plan {
  progress: { total: number; solved: number; revPending: number };
}

export interface ActivePlanResponse {
  plan: Plan | null;
  tasks: Task[];       // the active plan's problems only (never revisions)
  revisions: Task[];   // ALL revision tasks, any source, not expired, dated on/after origin
  origin: string;      // ISO — Roadmap week 1 starts here (min of plan start, today)
  originKey?: string;
}

export interface ParsedPlanSettings {
  source: PlanSource;
  durationDays: number;
  pace: PlanPace;
  weekdayLoad: number;
  weekendLoad: number;
  focusTopics: string[];
  avoidTopics: string[];
  busyDays: BusyDayInput[];
  bufferDay: number;
}

export interface HeatmapDay {
  date: string;
  count: number;
}

export interface HeatmapMonth {
  key: string;
  year: number;
  month: number;
  label: string;
  daysInMonth: number;
  firstWeekday: number;
  weeks: number;
  activeDays: number;
  totalCount: number;
  badge: 'full-month' | null;
  days: HeatmapDay[];
}

export interface HeatmapData {
  tz: string;
  from: string;
  to: string;
  weekStart: 0;
  months: HeatmapMonth[];
  summary: { totalCount: number; activeDays: number; bestDay: HeatmapDay | null };
}

export interface ProgressStats {
  totalSolved: number;
  revisionsDone: number;
  pendingRevisions: number;
  coins: number;
  currentStreak: number;
  bestStreak: number;
  activeToday: boolean;
  activeDays: number;
}

export interface TopicProgressItem {
  topic: string;
  total: number;
  solved: number;
  percent: number;
}

export interface DifficultyBucket {
  solved: number;
  total: number;
}

export interface TopicProgressData {
  scope: 'plan' | 'all';
  hasActivePlan: boolean;
  planId: string | null;
  planName: string | null;
  topics: TopicProgressItem[];
  difficulty: { easy: DifficultyBucket; medium: DifficultyBucket; hard: DifficultyBucket };
  totals: DifficultyBucket;
}

export interface ActivityItem {
  id: string;
  title: string;
  topic: string;
  difficulty: string | null;
  taskType: 'new' | 'revision' | 'potd';
  rating: string | null;
  revisionNumber: number;
  completedAt: string;
  problemUrl: string | null;
}

export interface ProgressOverview {
  stats: ProgressStats;
  heatmap: HeatmapData;
  topics: TopicProgressData;
  activity: ActivityItem[];
  generatedAt: string;
}

// ─── Todo (Part 2) ───
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
    canOneMore?: boolean;
    bandStatus: 'none' | 'active' | 'complete-awaiting-confirm';
    nextIndex?: number | null;
    nextBand?: number | null;
    skippedCount: number;
  };
  cses: CsesMeta | null;
}

export type TodoData = TodoResponse;

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

export type CsesStatus = 'off' | 'needs-topic' | 'active' | 'topic-complete';
export type CsesMessage =
  | 'off' | 'needs-topic' | 'in-progress' | 'parked-waiting' | 'done-today' | 'topic-complete';

export interface CsesTopicCard {
  id: string; slug: string; title: string; order: number; total: number;
  original: null | { solved: number; total: number };
  current: null | { run: number; solved: number; skipped: number; total: number };
  state: 'fresh' | 'in-progress' | 'complete';
}

export interface CsesOverview {
  enabled: boolean;
  status: CsesStatus;
  message: CsesMessage;
  resolvedTodayKind: 'solved' | 'skipped' | null;
  activeTopic: null | {
    id: string; slug: string; title: string; total: number;
    currentRun: number; solvedInRun: number; skippedInRun: number;
  };
  problemToday: null | { task: Task; position: number; total: number; parked: boolean };
  retryable: { taskId: string; title: string; position: number; url: string | null }[];
  returnPrompt: null | { gapDays: number; topicTitle: string | null; position: number | null; total: number | null };
  topics: CsesTopicCard[];
}

export type CsesMeta = Omit<CsesOverview, 'topics' | 'retryable'>;

