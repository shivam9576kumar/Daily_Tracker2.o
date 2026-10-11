export const RETURN_PROMPT_GAP_DAYS = 7;

export type CsesStatus = 'off' | 'needs-topic' | 'active' | 'topic-complete';

export type CsesMessage =
  | 'off'
  | 'needs-topic'
  | 'in-progress'      // today's problem is ready (also the carry-over "take your time" state)
  | 'parked-waiting'   // the problem is waiting until today's slot is free
  | 'done-today'       // today's slot is used (solved or skipped)
  | 'topic-complete';

export type Verdict = { ok: true } | { ok: false; reason: string };

// ── Ensure (serve / carry / park) ──

export interface EnsureInput {
  enabled: boolean;
  hasActiveTopic: boolean;
  /** The pending row of the active topic's current run, or null. */
  pending: null | { scheduledDateKey: string | null };
  resolvedToday: boolean;
  hasUnserved: boolean;
  today: string;
}

export interface EnsureDecision {
  status: CsesStatus;
  message: CsesMessage;
  /** undefined = no write. A string sets the key. null parks the row. */
  setPendingKey?: string | null;
  serveNext: boolean;
  topicComplete: boolean;
}

export function decideEnsure(i: EnsureInput): EnsureDecision {
  if (!i.enabled) {
    return { status: 'off', message: 'off', serveNext: false, topicComplete: false };
  }
  if (!i.hasActiveTopic) {
    return { status: 'needs-topic', message: 'needs-topic', serveNext: false, topicComplete: false };
  }

  const freeToday = !i.resolvedToday;

  if (i.pending) {
    const desired = freeToday ? i.today : null;
    const write = i.pending.scheduledDateKey !== desired;
    return {
      status: 'active',
      message: freeToday ? 'in-progress' : 'parked-waiting',
      setPendingKey: write ? desired : undefined,
      serveNext: false,
      topicComplete: false,
    };
  }

  if (!i.hasUnserved) {
    return { status: 'topic-complete', message: 'topic-complete', serveNext: false, topicComplete: true };
  }
  if (i.resolvedToday) {
    return { status: 'active', message: 'done-today', serveNext: false, topicComplete: false };
  }
  return { status: 'active', message: 'in-progress', serveNext: true, topicComplete: false };
}

// ── Solve / skip ──

export interface DayActionInput {
  status: string;
  scheduledDateKey: string | null;
  today: string;
}

export function decideSolve(i: DayActionInput): Verdict {
  if (i.status === 'completed') return { ok: true }; // rating / re-rating
  if (i.status === 'pending' && i.scheduledDateKey === i.today) return { ok: true };
  if (i.status === 'pending') {
    return { ok: false, reason: 'This problem is waiting for its turn. You can solve it on its day.' };
  }
  return { ok: false, reason: 'Skipped problems come back through Retry.' };
}

export function decideSkip(i: DayActionInput): Verdict {
  if (i.status === 'pending' && i.scheduledDateKey === i.today) return { ok: true };
  return { ok: false, reason: "Skip is available on today's problem." };
}

// ── Retry (swap rule, R7) ──

export interface RetryInput {
  enabled: boolean;
  isActiveTopic: boolean;
  targetStatus: string;
  targetRun: number;
  currentRun: number;
  resolvedToday: boolean;
  pendingInRun: null | { hasNotes: boolean };
}

export type RetryVerdict = { ok: true; replacePending: boolean } | { ok: false; reason: string };

export function decideRetry(i: RetryInput): RetryVerdict {
  if (!i.enabled) return { ok: false, reason: 'Turn on CSES Daily first.' };
  if (!i.isActiveTopic) return { ok: false, reason: 'Switch to this topic before retrying its problems.' };
  if (i.targetStatus !== 'skipped') return { ok: false, reason: 'Only skipped problems can be retried.' };
  if (i.targetRun !== i.currentRun) {
    return { ok: false, reason: 'This skip belongs to an earlier run. Retry works on the current run.' };
  }
  if (i.resolvedToday) {
    return { ok: false, reason: "You've already done today's problem. Retry opens tomorrow." };
  }
  if (i.pendingInRun?.hasNotes) {
    return { ok: false, reason: "Today's problem has notes. Solve or skip it first." };
  }
  return { ok: true, replacePending: i.pendingInRun !== null };
}

// ── Restart (R6) ──

export function decideRestart(i: { hasPendingInRun: boolean }): Verdict {
  return i.hasPendingInRun
    ? { ok: false, reason: 'Finish or skip the waiting problem in this topic before restarting.' }
    : { ok: true };
}

// ── Welcome-back prompt (R9) ──

export interface PromptInput {
  enabled: boolean;
  hasActiveTopic: boolean;
  lastActivityKey: string | null;
  ackKey: string | null;
  today: string;
}

export function daysBetweenKeys(from: string, to: string): number {
  return (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
}

export function decideReturnPrompt(i: PromptInput): { gapDays: number } | null {
  if (!i.enabled || !i.hasActiveTopic || !i.lastActivityKey) return null;
  const gapDays = daysBetweenKeys(i.lastActivityKey, i.today);
  if (gapDays < RETURN_PROMPT_GAP_DAYS) return null;
  if (i.ackKey === i.lastActivityKey) return null;
  return { gapDays };
}

// ── Undo (R8): a CSES solve returns to the Retry list ──

export const CSES_UNDO_PATCH = {
  status: 'skipped',
  isSkipped: true,
  skippedAt: null,
  completedAt: null,
  rating: null,
  scheduledDate: null,
  scheduledDateKey: null,
  isBacklog: false,
  backlogSince: null,
  isExpired: false,
} as const;
