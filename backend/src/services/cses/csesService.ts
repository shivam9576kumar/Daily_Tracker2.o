import type { Task } from '@prisma/client';
import prisma from '../../config/database';
import logger from '../../utils/logger';
import { NotFoundError, ValidationError } from '../../utils/error';
import { dateKeyInTz, taskScheduleForKey, todayKey } from '../../utils/dateKeys';
import { resolvePlatformValue } from '../../utils/platform';
import {
  decideEnsure,
  decideRestart,
  decideRetry,
  decideReturnPrompt,
  decideSkip,
  type CsesMessage,
  type CsesStatus,
} from './csesPolicy';

const SOURCE = 'cses';
const TYPE = 'cses';

// ── Public types ──

export interface CsesTopicCard {
  id: string;
  slug: string;
  title: string;
  order: number;
  total: number;
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
    id: string;
    slug: string;
    title: string;
    total: number;
    currentRun: number;
    solvedInRun: number;
    skippedInRun: number;
  };
  problemToday: null | { task: Task; position: number; total: number; parked: boolean };
  retryable: { taskId: string; title: string; position: number; url: string | null }[];
  returnPrompt: null | { gapDays: number; topicTitle: string | null; position: number | null; total: number | null };
  topics: CsesTopicCard[];
}

export type CsesMeta = Omit<CsesOverview, 'topics' | 'retryable'>;

export function toCsesMeta(o: CsesOverview): CsesMeta {
  const { topics: _topics, retryable: _retryable, ...meta } = o;
  return meta;
}

// ── Per-user serialization ──

const locks = new Map<string, Promise<unknown>>();

function locked<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(userId) ?? Promise.resolve();
  const next = prev.then(fn);
  const tail = next.then(() => undefined, () => undefined);
  locks.set(userId, tail);
  void tail.then(() => {
    if (locks.get(userId) === tail) locks.delete(userId);
  });
  return next;
}

// ── Lookups ──

type ActiveProblem = { id: string; topicId: string; order: number; title: string; url: string };

async function getTrack(userId: string) {
  return prisma.csesTrack.findUnique({ where: { userId } });
}

async function runFor(userId: string, topicId: string): Promise<number> {
  const row = await prisma.csesTopicRun.findUnique({ where: { userId_topicId: { userId, topicId } } });
  return row?.currentRun ?? 1;
}

async function activeProblemsOf(topicId: string): Promise<ActiveProblem[]> {
  return prisma.practiceProblem.findMany({
    where: { topicId, source: SOURCE, isActive: true },
    orderBy: { order: 'asc' },
    select: { id: true, topicId: true, order: true, title: true, url: true },
  });
}

async function requireTopic(topicId: unknown) {
  if (typeof topicId !== 'string') throw new ValidationError('topicId is required');
  const topic = await prisma.practiceTopic.findFirst({ where: { id: topicId, source: SOURCE, isActive: true } });
  if (!topic) throw new NotFoundError('CSES topic');
  return topic;
}

async function requireCsesTask(userId: string, taskId: string) {
  const task = await prisma.task.findFirst({
    where: { id: taskId, userId, taskType: TYPE },
    include: { practiceProblem: { select: { topicId: true, order: true, title: true, url: true } } },
  });
  if (!task || !task.practiceProblemId || task.practiceRun === null || !task.practiceProblem) {
    throw new NotFoundError('CSES problem');
  }
  return task;
}

/** Day-slot usage and the most recent resolution, from solve and skip timestamps only. */
async function resolutions(userId: string, tz: string, today: string) {
  const rows = await prisma.task.findMany({
    where: { userId, taskType: TYPE, OR: [{ completedAt: { not: null } }, { skippedAt: { not: null } }] },
    select: { completedAt: true, skippedAt: true },
  });
  let resolvedToday = false;
  let resolvedTodayKind: 'solved' | 'skipped' | null = null;
  let lastResolutionKey: string | null = null;
  for (const r of rows) {
    const events: [Date | null, 'solved' | 'skipped'][] = [
      [r.completedAt, 'solved'],
      [r.skippedAt, 'skipped'],
    ];
    for (const [at, kind] of events) {
      if (!at) continue;
      const key = dateKeyInTz(at, tz);
      if (lastResolutionKey === null || key > lastResolutionKey) lastResolutionKey = key;
      if (key === today) {
        resolvedToday = true;
        resolvedTodayKind = kind;
      }
    }
  }
  return { resolvedToday, resolvedTodayKind, lastResolutionKey };
}

async function currentActivityKey(
  userId: string,
  tz: string,
  track: { enabledAt: Date | null } | null,
  now: Date,
): Promise<string | null> {
  const { lastResolutionKey } = await resolutions(userId, tz, todayKey(tz, now));
  if (lastResolutionKey) return lastResolutionKey;
  return track?.enabledAt ? dateKeyInTz(track.enabledAt, tz) : null;
}

function scheduleFor(key: string | null, tz: string) {
  return key === null ? { scheduledDate: null, scheduledDateKey: null } : taskScheduleForKey(key, tz);
}

// ── Writes: reconcile the active topic with today's slot ──

async function serveRow(userId: string, p: ActiveProblem, run: number, today: string, tz: string) {
  const topic = await prisma.practiceTopic.findUnique({ where: { id: p.topicId }, select: { title: true } });
  try {
    await prisma.task.create({
      data: {
        userId,
        taskType: TYPE,
        status: 'pending',
        title: p.title,
        topic: topic?.title ?? 'CSES',
        difficulty: null,
        platform: resolvePlatformValue(p.url, 'cses'),
        problemUrl: p.url,
        practiceProblemId: p.id,
        practiceRun: run,
        ...taskScheduleForKey(today, tz),
      },
    });
  } catch (err: any) {
    // Another request served this problem first (unique user + problem + run). Harmless.
    if (err?.code !== 'P2002') throw err;
  }
}

async function reconcile(userId: string, tz: string, now: Date): Promise<void> {
  const today = todayKey(tz, now);
  const track = await getTrack(userId);
  if (!track?.enabled || !track.activeTopicId) return; // off or needs-topic: nothing served, nothing moved

  const topicId = track.activeTopicId;
  const run = await runFor(userId, topicId);
  const problems = await activeProblemsOf(topicId);
  const problemIds = problems.map((p) => p.id);

  // 1. Park strays: a pending CSES row with a key that is not in the active topic's current run.
  await prisma.task.updateMany({
    where: {
      userId,
      taskType: TYPE,
      status: 'pending',
      scheduledDateKey: { not: null },
      NOT: { AND: [{ practiceRun: run }, { practiceProblem: { is: { topicId, isActive: true } } }] },
    },
    data: { scheduledDate: null, scheduledDateKey: null },
  });

  // 2. Rows of the active topic's current run.
  const rows = await prisma.task.findMany({
    where: { userId, taskType: TYPE, practiceRun: run, practiceProblemId: { in: problemIds } },
    select: { id: true, practiceProblemId: true, status: true, scheduledDateKey: true },
  });
  const pendingRows = rows.filter((r) => r.status === 'pending');
  if (pendingRows.length > 1) {
    logger.warn('cses: several pending rows in one run; parking extras', { userId, topicId, count: pendingRows.length });
    await prisma.task.updateMany({
      where: { id: { in: pendingRows.slice(1).map((r) => r.id) } },
      data: { scheduledDate: null, scheduledDateKey: null },
    });
  }
  const pending = pendingRows[0] ?? null;
  const served = new Set(rows.map((r) => r.practiceProblemId));
  const nextUnserved = problems.find((p) => !served.has(p.id)) ?? null;

  const { resolvedToday } = await resolutions(userId, tz, today);
  const decision = decideEnsure({
    enabled: true,
    hasActiveTopic: true,
    pending: pending ? { scheduledDateKey: pending.scheduledDateKey } : null,
    resolvedToday,
    hasUnserved: nextUnserved !== null,
    today,
  });

  if (pending && decision.setPendingKey !== undefined) {
    await prisma.task.update({ where: { id: pending.id }, data: scheduleFor(decision.setPendingKey, tz) });
  }
  if (decision.serveNext && nextUnserved) {
    await serveRow(userId, nextUnserved, run, today, tz);
  }
}

// ── Read: compose the overview after reconcile ──

async function compose(userId: string, tz: string, now: Date, includeTopics: boolean): Promise<CsesOverview> {
  const today = todayKey(tz, now);
  const track = await getTrack(userId);
  const enabled = !!track?.enabled;
  const activeTopicId = track?.activeTopicId ?? null;

  const [topics, problems, rows, runs] = await Promise.all([
    prisma.practiceTopic.findMany({
      where: { source: SOURCE, isActive: true },
      orderBy: { order: 'asc' },
      select: { id: true, slug: true, title: true, order: true },
    }),
    prisma.practiceProblem.findMany({
      where: { source: SOURCE, isActive: true },
      orderBy: { order: 'asc' },
      select: { id: true, topicId: true, order: true, title: true, url: true },
    }),
    prisma.task.findMany({ where: { userId, taskType: TYPE } }),
    prisma.csesTopicRun.findMany({ where: { userId } }),
  ]);

  const { resolvedToday, resolvedTodayKind, lastResolutionKey } = await resolutions(userId, tz, today);

  const runByTopic = new Map(runs.map((r) => [r.topicId, r.currentRun] as const));
  const problemIndex = new Map(problems.map((p) => [p.id, p] as const));
  const problemsByTopic = new Map<string, ActiveProblem[]>();
  for (const p of problems) {
    const list = problemsByTopic.get(p.topicId) ?? [];
    list.push(p);
    problemsByTopic.set(p.topicId, list);
  }
  const rowsByTopic = new Map<string, Task[]>();
  for (const r of rows) {
    const p = r.practiceProblemId ? problemIndex.get(r.practiceProblemId) : undefined;
    if (!p) continue;
    const list = rowsByTopic.get(p.topicId) ?? [];
    list.push(r);
    rowsByTopic.set(p.topicId, list);
  }

  const countRun = (topicRows: Task[], run: number) => {
    const scoped = topicRows.filter((r) => r.practiceRun === run);
    return {
      solved: scoped.filter((r) => r.status === 'completed').length,
      skipped: scoped.filter((r) => r.status === 'skipped').length,
      pending: scoped.filter((r) => r.status === 'pending').length,
      served: new Set(scoped.map((r) => r.practiceProblemId)).size,
    };
  };

  const cards: CsesTopicCard[] = topics.map((t) => {
    const list = problemsByTopic.get(t.id) ?? [];
    const topicRows = rowsByTopic.get(t.id) ?? [];
    const total = list.length;
    const run = runByTopic.get(t.id) ?? 1;
    const current = countRun(topicRows, run);
    const first = run > 1 ? countRun(topicRows, 1) : null;
    const state: CsesTopicCard['state'] =
      current.served === 0
        ? 'fresh'
        : current.pending === 0 && current.served >= total
          ? 'complete'
          : 'in-progress';
    return {
      id: t.id,
      slug: t.slug,
      title: t.title,
      order: t.order,
      total,
      original: first ? { solved: first.solved, total } : null,
      current: { run, solved: current.solved, skipped: current.skipped, total },
      state,
    };
  });

  let activeTopic: CsesOverview['activeTopic'] = null;
  let problemToday: CsesOverview['problemToday'] = null;
  let retryable: CsesOverview['retryable'] = [];
  let pendingForDecision: { scheduledDateKey: string | null } | null = null;
  let hasUnserved = false;
  let pendingPosition: number | null = null;
  let activeTitle: string | null = null;
  let activeTotal: number | null = null;

  if (enabled && activeTopicId) {
    const topic = topics.find((t) => t.id === activeTopicId);
    if (topic) {
      const list = problemsByTopic.get(topic.id) ?? [];
      const run = runByTopic.get(topic.id) ?? 1;
      const topicRows = (rowsByTopic.get(topic.id) ?? []).filter((r) => r.practiceRun === run);
      const counts = countRun(topicRows, run);
      const pendingRow = topicRows.find((r) => r.status === 'pending') ?? null;
      const positionOf = (problemId: string | null) =>
        problemId ? problemIndex.get(problemId)?.order ?? null : null;

      activeTitle = topic.title;
      activeTotal = list.length;
      activeTopic = {
        id: topic.id,
        slug: topic.slug,
        title: topic.title,
        total: list.length,
        currentRun: run,
        solvedInRun: counts.solved,
        skippedInRun: counts.skipped,
      };
      hasUnserved = list.some((p) => !topicRows.some((r) => r.practiceProblemId === p.id));
      pendingForDecision = pendingRow ? { scheduledDateKey: pendingRow.scheduledDateKey } : null;

      if (pendingRow) {
        pendingPosition = positionOf(pendingRow.practiceProblemId);
        problemToday = {
          task: pendingRow,
          position: pendingPosition ?? 0,
          total: list.length,
          parked: pendingRow.scheduledDateKey === null,
        };
      }
      retryable = topicRows
        .filter((r) => r.status === 'skipped')
        .map((r) => ({
          taskId: r.id,
          title: r.title,
          position: positionOf(r.practiceProblemId) ?? 0,
          url: r.problemUrl,
        }))
        .sort((a, b) => a.position - b.position);
    }
  }

  const decision = decideEnsure({
    enabled,
    hasActiveTopic: !!activeTopic,
    pending: pendingForDecision,
    resolvedToday,
    hasUnserved,
    today,
  });

  const lastKey =
    lastResolutionKey ?? (track?.enabledAt ? dateKeyInTz(track.enabledAt, tz) : null);
  const prompt = decideReturnPrompt({
    enabled,
    hasActiveTopic: !!activeTopic,
    lastActivityKey: lastKey,
    ackKey: track?.promptAckKey ?? null,
    today,
  });

  return {
    enabled,
    status: decision.status,
    message: decision.message,
    resolvedTodayKind: resolvedToday ? resolvedTodayKind : null,
    activeTopic,
    problemToday,
    retryable,
    returnPrompt: prompt
      ? { gapDays: prompt.gapDays, topicTitle: activeTitle, position: pendingPosition, total: activeTotal }
      : null,
    topics: includeTopics ? cards : [],
  };
}

// ── Public API ──

export async function getCsesOverview(
  userId: string,
  tz: string,
  now: Date = new Date(),
  opts: { includeTopics: boolean } = { includeTopics: true },
): Promise<CsesOverview> {
  return locked(userId, async () => {
    await reconcile(userId, tz, now);
    return compose(userId, tz, now, opts.includeTopics);
  });
}

export async function setCsesEnabled(userId: string, enabled: boolean, tz: string, now: Date = new Date()) {
  if (typeof enabled !== 'boolean') throw new ValidationError('enabled must be true or false');
  return locked(userId, async () => {
    await prisma.csesTrack.upsert({
      where: { userId },
      create: { userId, enabled, enabledAt: enabled ? now : null },
      update: enabled ? { enabled: true, enabledAt: now } : { enabled: false },
    });
    if (!enabled) {
      // Park the waiting problem. Nothing is deleted and nothing is served.
      await prisma.task.updateMany({
        where: { userId, taskType: TYPE, status: 'pending', scheduledDateKey: { not: null } },
        data: { scheduledDate: null, scheduledDateKey: null },
      });
    }
    await reconcile(userId, tz, now);
    return compose(userId, tz, now, true);
  });
}

export async function selectCsesTopic(userId: string, topicId: unknown, tz: string, now: Date = new Date()) {
  return locked(userId, async () => {
    const topic = await requireTopic(topicId);
    const track = await getTrack(userId);
    if (!track?.enabled) throw new ValidationError('Turn on CSES Daily first.');

    if (track.activeTopicId && track.activeTopicId !== topic.id) {
      // One active topic at a time: park the waiting problem of the topic being left (R5).
      const oldRun = await runFor(userId, track.activeTopicId);
      await prisma.task.updateMany({
        where: {
          userId,
          taskType: TYPE,
          status: 'pending',
          scheduledDateKey: { not: null },
          practiceRun: oldRun,
          practiceProblem: { is: { topicId: track.activeTopicId } },
        },
        data: { scheduledDate: null, scheduledDateKey: null },
      });
    }

    const isTopicSwitch = track.activeTopicId !== null && track.activeTopicId !== topic.id;
    await prisma.csesTrack.update({
      where: { userId },
      data: {
        activeTopicId: topic.id,
        ...(isTopicSwitch ? { promptAckKey: await currentActivityKey(userId, tz, track, now) } : {}),
      },
    });
    await reconcile(userId, tz, now);
    return compose(userId, tz, now, true);
  });
}

export async function restartCsesTopic(userId: string, topicId: unknown, tz: string, now: Date = new Date()) {
  return locked(userId, async () => {
    const topic = await requireTopic(topicId);
    const track = await getTrack(userId);
    if (!track?.enabled) throw new ValidationError('Turn on CSES Daily first.');

    const run = await runFor(userId, topic.id);
    const pendingInRun = await prisma.task.count({
      where: {
        userId,
        taskType: TYPE,
        status: 'pending',
        practiceRun: run,
        practiceProblem: { is: { topicId: topic.id } },
      },
    });
    const verdict = decideRestart({ hasPendingInRun: pendingInRun > 0 });
    if (!verdict.ok) throw new ValidationError(verdict.reason);

    await prisma.csesTopicRun.upsert({
      where: { userId_topicId: { userId, topicId: topic.id } },
      create: { userId, topicId: topic.id, currentRun: 2 },
      update: { currentRun: { increment: 1 } },
    });
    await prisma.csesTrack.update({
      where: { userId },
      data: { activeTopicId: topic.id, promptAckKey: await currentActivityKey(userId, tz, track, now) },
    });
    await reconcile(userId, tz, now);
    return compose(userId, tz, now, true);
  });
}

export async function skipCsesProblem(userId: string, taskId: string, tz: string, now: Date = new Date()) {
  return locked(userId, async () => {
    await reconcile(userId, tz, now); // make sure today's problem is materialized before judging it
    const task = await requireCsesTask(userId, taskId);
    const verdict = decideSkip({
      status: task.status,
      scheduledDateKey: task.scheduledDateKey,
      today: todayKey(tz, now),
    });
    if (!verdict.ok) throw new ValidationError(verdict.reason);

    await prisma.task.update({
      where: { id: task.id },
      data: {
        status: 'skipped',
        isSkipped: true,
        skippedAt: now,
        scheduledDate: null,
        scheduledDateKey: null,
        isBacklog: false,
        backlogSince: null,
        isExpired: false,
      },
    });
    await reconcile(userId, tz, now);
    return compose(userId, tz, now, true);
  });
}

export async function retryCsesProblem(userId: string, taskId: string, tz: string, now: Date = new Date()) {
  return locked(userId, async () => {
    await reconcile(userId, tz, now); // today's fresh problem is materialized first, so the swap target is known
    const task = await requireCsesTask(userId, taskId);
    const topicId = task.practiceProblem!.topicId;
    const track = await getTrack(userId);
    const today = todayKey(tz, now);
    const { resolvedToday } = await resolutions(userId, tz, today);
    const currentRun = await runFor(userId, topicId);

    const pending =
      track?.activeTopicId === topicId
        ? await prisma.task.findFirst({
            where: {
              userId,
              taskType: TYPE,
              status: 'pending',
              practiceRun: currentRun,
              practiceProblem: { is: { topicId } },
            },
            include: { taskNotes: { select: { id: true }, take: 1 } },
          })
        : null;

    const verdict = decideRetry({
      enabled: !!track?.enabled,
      isActiveTopic: track?.activeTopicId === topicId,
      targetStatus: task.status,
      targetRun: task.practiceRun!,
      currentRun,
      resolvedToday,
      pendingInRun: pending ? { hasNotes: pending.taskNotes.length > 0 } : null,
    });
    if (!verdict.ok) throw new ValidationError(verdict.reason);

    await prisma.$transaction(async (tx) => {
      if (verdict.replacePending && pending) {
        // The untouched fresh problem returns to the unserved queue at its position.
        await tx.task.delete({ where: { id: pending.id } });
      }
      await tx.task.update({
        where: { id: task.id },
        data: { status: 'pending', isSkipped: false, skippedAt: null, ...taskScheduleForKey(today, tz) },
      });
    });
    await reconcile(userId, tz, now);
    return compose(userId, tz, now, true);
  });
}

export async function acknowledgeCsesReturn(userId: string, tz: string, now: Date = new Date()) {
  return locked(userId, async () => {
    const track = await getTrack(userId);
    if (!track) throw new ValidationError('CSES Daily is not set up yet.');
    await prisma.csesTrack.update({
      where: { userId },
      data: { promptAckKey: await currentActivityKey(userId, tz, track, now) },
    });
    return compose(userId, tz, now, true);
  });
}
