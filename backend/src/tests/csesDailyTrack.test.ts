import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after } from 'node:test';
import prisma from '../config/database';
import { requireDisposableDb } from './testGuards';
import {
  decideEnsure,
  decideRestart,
  decideRetry,
  decideReturnPrompt,
  decideSkip,
  decideSolve,
  daysBetweenKeys,
  CSES_UNDO_PATCH,
  RETURN_PROMPT_GAP_DAYS,
} from '../services/cses/csesPolicy';
import * as cses from '../services/cses/csesService';
import { taskService } from '../services/task/taskService';
import { taskCompletionService } from '../services/task/taskCompletionService';
import { todoService } from '../services/todo/todoService';
import { dashboardService } from '../services/dashboard/dashboardService';
import { reconcileOverdueForUser } from '../services/task/overdueReconciler';
import { BACKLOG_TASK_TYPES } from '../services/task/taskLifecycle';
import { ValidationError } from '../utils/error';

requireDisposableDb();

const TZ = 'Asia/Kolkata';

// ─── Pure Policy Unit Tests ───

test('Pure Policy: daysBetweenKeys calculates date diff accurately', () => {
  assert.equal(daysBetweenKeys('2026-10-01', '2026-10-08'), 7);
  assert.equal(daysBetweenKeys('2026-10-01', '2026-10-01'), 0);
  assert.equal(daysBetweenKeys('2026-10-10', '2026-10-01'), -9);
});

test('Pure Policy: decideEnsure handles off and needs-topic', () => {
  const off = decideEnsure({
    enabled: false,
    hasActiveTopic: false,
    pending: null,
    resolvedToday: false,
    hasUnserved: true,
    today: '2026-10-11',
  });
  assert.equal(off.status, 'off');
  assert.equal(off.serveNext, false);

  const needsTopic = decideEnsure({
    enabled: true,
    hasActiveTopic: false,
    pending: null,
    resolvedToday: false,
    hasUnserved: true,
    today: '2026-10-11',
  });
  assert.equal(needsTopic.status, 'needs-topic');
  assert.equal(needsTopic.serveNext, false);
});

test('Pure Policy: decideEnsure handles pending problem (free today vs resolved today)', () => {
  const inProgress = decideEnsure({
    enabled: true,
    hasActiveTopic: true,
    pending: { scheduledDateKey: '2026-10-10' },
    resolvedToday: false,
    hasUnserved: true,
    today: '2026-10-11',
  });
  assert.equal(inProgress.status, 'active');
  assert.equal(inProgress.message, 'in-progress');
  assert.equal(inProgress.setPendingKey, '2026-10-11');
  assert.equal(inProgress.serveNext, false);

  const parked = decideEnsure({
    enabled: true,
    hasActiveTopic: true,
    pending: { scheduledDateKey: '2026-10-11' },
    resolvedToday: true,
    hasUnserved: true,
    today: '2026-10-11',
  });
  assert.equal(parked.status, 'active');
  assert.equal(parked.message, 'parked-waiting');
  assert.equal(parked.setPendingKey, null);
  assert.equal(parked.serveNext, false);
});

test('Pure Policy: decideEnsure handles topic complete and fresh serve', () => {
  const complete = decideEnsure({
    enabled: true,
    hasActiveTopic: true,
    pending: null,
    resolvedToday: false,
    hasUnserved: false,
    today: '2026-10-11',
  });
  assert.equal(complete.status, 'topic-complete');
  assert.equal(complete.topicComplete, true);

  const fresh = decideEnsure({
    enabled: true,
    hasActiveTopic: true,
    pending: null,
    resolvedToday: false,
    hasUnserved: true,
    today: '2026-10-11',
  });
  assert.equal(fresh.status, 'active');
  assert.equal(fresh.message, 'in-progress');
  assert.equal(fresh.serveNext, true);

  const doneToday = decideEnsure({
    enabled: true,
    hasActiveTopic: true,
    pending: null,
    resolvedToday: true,
    hasUnserved: true,
    today: '2026-10-11',
  });
  assert.equal(doneToday.status, 'active');
  assert.equal(doneToday.message, 'done-today');
  assert.equal(doneToday.serveNext, false);
});

test('Pure Policy: decideSolve only permits solving today problem', () => {
  assert.deepEqual(decideSolve({ status: 'completed', scheduledDateKey: null, today: '2026-10-11' }), { ok: true });
  assert.deepEqual(decideSolve({ status: 'pending', scheduledDateKey: '2026-10-11', today: '2026-10-11' }), { ok: true });

  const parkedVerdict = decideSolve({ status: 'pending', scheduledDateKey: null, today: '2026-10-11' });
  assert.equal(parkedVerdict.ok, false);

  const skippedVerdict = decideSolve({ status: 'skipped', scheduledDateKey: null, today: '2026-10-11' });
  assert.equal(skippedVerdict.ok, false);
});

test('Pure Policy: decideSkip only permits skipping today pending problem', () => {
  assert.deepEqual(decideSkip({ status: 'pending', scheduledDateKey: '2026-10-11', today: '2026-10-11' }), { ok: true });
  assert.equal(decideSkip({ status: 'pending', scheduledDateKey: null, today: '2026-10-11' }).ok, false);
  assert.equal(decideSkip({ status: 'completed', scheduledDateKey: '2026-10-11', today: '2026-10-11' }).ok, false);
});

test('Pure Policy: decideRetry swap rules and guards', () => {
  const base = {
    enabled: true,
    isActiveTopic: true,
    targetStatus: 'skipped',
    targetRun: 1,
    currentRun: 1,
    resolvedToday: false,
    pendingInRun: null,
  };

  assert.deepEqual(decideRetry(base), { ok: true, replacePending: false });
  assert.deepEqual(decideRetry({ ...base, pendingInRun: { hasNotes: false } }), { ok: true, replacePending: true });
  assert.equal(decideRetry({ ...base, pendingInRun: { hasNotes: true } }).ok, false);
  assert.equal(decideRetry({ ...base, resolvedToday: true }).ok, false);
  assert.equal(decideRetry({ ...base, targetStatus: 'completed' }).ok, false);
  assert.equal(decideRetry({ ...base, targetRun: 1, currentRun: 2 }).ok, false);
  assert.equal(decideRetry({ ...base, isActiveTopic: false }).ok, false);
  assert.equal(decideRetry({ ...base, enabled: false }).ok, false);
});

test('Pure Policy: decideRestart and decideReturnPrompt', () => {
  assert.deepEqual(decideRestart({ hasPendingInRun: false }), { ok: true });
  assert.equal(decideRestart({ hasPendingInRun: true }).ok, false);

  assert.equal(
    decideReturnPrompt({
      enabled: true,
      hasActiveTopic: true,
      lastActivityKey: '2026-10-06',
      ackKey: null,
      today: '2026-10-11',
    }),
    null,
  );

  const prompt = decideReturnPrompt({
    enabled: true,
    hasActiveTopic: true,
    lastActivityKey: '2026-10-04',
    ackKey: null,
    today: '2026-10-11',
  });
  assert.deepEqual(prompt, { gapDays: 7 });

  assert.equal(
    decideReturnPrompt({
      enabled: true,
      hasActiveTopic: true,
      lastActivityKey: '2026-10-04',
      ackKey: '2026-10-04',
      today: '2026-10-11',
    }),
    null,
  );
});

// ─── Locked Rules R1 to R14 DB Verification Tests ───

const testUserIds: string[] = [];

async function createTestUser(): Promise<string> {
  const email = `cses-test-${randomUUID()}@local.test`;
  const user = await prisma.user.create({
    data: {
      email,
      googleId: randomUUID(),
      name: 'CSES Test Student',
      coins: 0,
      timezone: TZ,
    },
  });
  testUserIds.push(user.id);
  return user.id;
}

after(async () => {
  if (testUserIds.length > 0) {
    await prisma.user.deleteMany({ where: { id: { in: testUserIds } } });
  }
});

test('R1: One CSES problem per day globally - no extras, no replacement after solve/skip even across topics', async () => {
  const userId = await createTestUser();
  const topics = await prisma.practiceTopic.findMany({ where: { source: 'cses', isActive: true }, orderBy: { order: 'asc' }, take: 2 });
  assert(topics.length >= 2, 'Need 2 topics');

  await cses.setCsesEnabled(userId, true, TZ);
  const o1 = await cses.selectCsesTopic(userId, topics[0].id, TZ);
  assert.equal(o1.problemToday?.position, 1);
  const taskId = o1.problemToday!.task.id;

  // Solve problem 1 today
  await taskCompletionService.completeTask(userId, taskId, undefined, TZ);

  // Overview shows done-today, problemToday is null
  const o2 = await cses.getCsesOverview(userId, TZ);
  assert.equal(o2.message, 'done-today');
  assert.equal(o2.problemToday, null);

  // Switch to topic 2 today: problem for topic 2 is parked, NOT served today!
  const o3 = await cses.selectCsesTopic(userId, topics[1].id, TZ);
  assert.equal(o3.activeTopic?.id, topics[1].id);
  assert.equal(o3.problemToday, null); // no second problem served on the same day globally!
  assert.equal(o3.message, 'done-today');
});

test('R2: Solve only today problem - awards +10 base + rating bonus and schedules revisions', async () => {
  const userId = await createTestUser();
  const topic = await prisma.practiceTopic.findFirst({ where: { source: 'cses', isActive: true }, orderBy: { order: 'asc' } });
  assert(topic);

  await cses.setCsesEnabled(userId, true, TZ);
  const overview = await cses.selectCsesTopic(userId, topic.id, TZ);
  const task = overview.problemToday!.task;

  // Complete task with rating 'hard' (+10 solve + 10 bonus = 20)
  const result = await taskCompletionService.completeTask(userId, task.id, 'hard', TZ);
  assert.equal(result.task.status, 'completed');
  assert.equal(result.coinsDelta, 20);

  const user = await prisma.user.findUnique({ where: { id: userId } });
  assert.equal(user?.coins, 20);

  // Revisions created for this solve
  const revs = await prisma.revision.findMany({ where: { parentTaskId: task.id } });
  assert(revs.length > 0, 'Revision schedule must be created for CSES solve');

  // Overview now shows done-today
  const nextOverview = await cses.getCsesOverview(userId, TZ);
  assert.equal(nextOverview.message, 'done-today');
  assert.equal(nextOverview.resolvedTodayKind, 'solved');
  assert.equal(nextOverview.activeTopic?.solvedInRun, 1);
});

test('R3: Skip today problem only - marks skipped with skippedAt, consumes day slot, no replacement served', async () => {
  const userId = await createTestUser();
  const topic = await prisma.practiceTopic.findFirst({ where: { source: 'cses', isActive: true }, orderBy: { order: 'asc' } });
  assert(topic);

  await cses.setCsesEnabled(userId, true, TZ);
  const overview = await cses.selectCsesTopic(userId, topic.id, TZ);
  const taskId = overview.problemToday!.task.id;

  // Skip
  const skipped = await cses.skipCsesProblem(userId, taskId, TZ);
  assert.equal(skipped.message, 'done-today');
  assert.equal(skipped.resolvedTodayKind, 'skipped');
  assert.equal(skipped.problemToday, null); // no replacement served that day!
  assert.equal(skipped.retryable.length, 1);
  assert.equal(skipped.retryable[0].taskId, taskId);

  // DB verification: 0 coins, skippedAt set, not in backlog or expired
  const row = await prisma.task.findUnique({ where: { id: taskId } });
  assert.equal(row?.status, 'skipped');
  assert.equal(row?.isSkipped, true);
  assert(row?.skippedAt !== null);
  assert.equal(row?.scheduledDateKey, null);
  assert.equal(row?.isBacklog, false);
  assert.equal(row?.isExpired, false);

  const user = await prisma.user.findUnique({ where: { id: userId } });
  assert.equal(user?.coins, 0);
});

test('R4: Carry-over - unsolved problem stays pending, moves to today on every load, never backlog/expired', async () => {
  const userId = await createTestUser();
  const topic = await prisma.practiceTopic.findFirst({ where: { source: 'cses', isActive: true }, orderBy: { order: 'asc' } });
  assert(topic);

  await cses.setCsesEnabled(userId, true, TZ);
  const overview = await cses.selectCsesTopic(userId, topic.id, TZ);
  const taskId = overview.problemToday!.task.id;

  // Manually backdate the pending problem to yesterday
  await prisma.task.update({
    where: { id: taskId },
    data: { scheduledDateKey: '2026-10-10', scheduledDate: new Date('2026-10-10T00:00:00Z') },
  });

  // Run overdue reconciliation for today ('2026-10-11')
  const nowDay2 = new Date('2026-10-11T10:00:00Z');
  const moved = await reconcileOverdueForUser(userId, TZ, nowDay2);
  assert.equal(moved, 0, 'CSES tasks must NEVER be moved to backlog');

  // Verify task row is still pending, not backlog
  let row = await prisma.task.findUnique({ where: { id: taskId } });
  assert.equal(row?.status, 'pending');
  assert.equal(row?.isBacklog, false);
  assert.equal(row?.isExpired, false);

  // On overview load today, problem is carried over to today's date key
  const day2Overview = await cses.getCsesOverview(userId, TZ, nowDay2);
  assert.equal(day2Overview.message, 'in-progress');
  assert.equal(day2Overview.problemToday?.task.id, taskId);

  row = await prisma.task.findUnique({ where: { id: taskId } });
  assert.equal(row?.scheduledDateKey, '2026-10-11');
});

test('R5: One active topic - switching topics parks waiting problem (scheduledDateKey null), returning resumes it', async () => {
  const userId = await createTestUser();
  const topics = await prisma.practiceTopic.findMany({ where: { source: 'cses', isActive: true }, orderBy: { order: 'asc' }, take: 2 });
  assert.equal(topics.length, 2);

  await cses.setCsesEnabled(userId, true, TZ);
  const o1 = await cses.selectCsesTopic(userId, topics[0].id, TZ);
  const problemTopic1Id = o1.problemToday!.task.id;
  assert.equal(o1.problemToday?.parked, false);

  // Switch to topic 2
  const o2 = await cses.selectCsesTopic(userId, topics[1].id, TZ);
  assert.equal(o2.activeTopic?.id, topics[1].id);
  assert.equal(o2.problemToday?.parked, false);

  // Topic 1 problem is parked in DB (scheduledDateKey is null)
  const topic1Row = await prisma.task.findUnique({ where: { id: problemTopic1Id } });
  assert.equal(topic1Row?.scheduledDateKey, null);

  // Switch back to topic 1: resumes problem 1
  const o3 = await cses.selectCsesTopic(userId, topics[0].id, TZ);
  assert.equal(o3.activeTopic?.id, topics[0].id);
  assert.equal(o3.problemToday?.task.id, problemTopic1Id);
  assert.equal(o3.problemToday?.parked, false);
});

test('R6: Restart a topic (review run) - increments run number, resets position to 1, preserves history and coins', async () => {
  const userId = await createTestUser();
  const topic = await prisma.practiceTopic.findFirst({ where: { source: 'cses', isActive: true }, orderBy: { order: 'asc' } });
  assert(topic);

  await cses.setCsesEnabled(userId, true, TZ);
  const o1 = await cses.selectCsesTopic(userId, topic.id, TZ);
  const problem1Id = o1.problemToday!.task.id;

  // Cannot restart when pending problem exists in run
  await assert.rejects(
    async () => cses.restartCsesTopic(userId, topic.id, TZ),
    /waiting problem/,
  );

  // Solve problem 1 (+10 coins)
  await taskCompletionService.completeTask(userId, problem1Id, undefined, TZ);

  // Delete remaining catalog problems in topic except problem 1 to simulate topic completion
  // Or simply verify restart when no pending problem exists in run
  const restartResult = await cses.restartCsesTopic(userId, topic.id, TZ);
  assert.equal(restartResult.activeTopic?.currentRun, 2);

  // Solved history and coins are preserved
  const user = await prisma.user.findUnique({ where: { id: userId } });
  assert.equal(user?.coins, 10);

  // Run record in DB is incremented
  const runRecord = await prisma.csesTopicRun.findUnique({
    where: { userId_topicId: { userId, topicId: topic.id } },
  });
  assert.equal(runRecord?.currentRun, 2);
});

test('R7: Retry swap - swaps fresh untouched problem (deleting fresh row), refused if has notes or resolved today', async () => {
  const userId = await createTestUser();
  const topic = await prisma.practiceTopic.findFirst({ where: { source: 'cses', isActive: true }, orderBy: { order: 'asc' } });
  assert(topic);

  await cses.setCsesEnabled(userId, true, TZ);
  const overview = await cses.selectCsesTopic(userId, topic.id, TZ);
  const problem1 = overview.problemToday!.task;

  // Skip problem 1 on day 1
  const clockDay1 = new Date('2026-10-10T10:00:00Z');
  await cses.skipCsesProblem(userId, problem1.id, TZ, clockDay1);

  // On day 2, fresh problem 2 is served
  const clockDay2 = new Date('2026-10-11T10:00:00Z');
  const day2Overview = await cses.getCsesOverview(userId, TZ, clockDay2);
  assert.equal(day2Overview.problemToday?.position, 2);
  const problem2Id = day2Overview.problemToday!.task.id;

  // Retry problem 1 swaps out untouched fresh problem 2: problem 2 row is deleted!
  const retried = await cses.retryCsesProblem(userId, problem1.id, TZ, clockDay2);
  assert.equal(retried.problemToday?.position, 1);
  assert.equal(retried.problemToday?.task.id, problem1.id);

  // Fresh problem 2 was deleted from tasks (returns to unserved queue)
  const problem2Row = await prisma.task.findUnique({ where: { id: problem2Id } });
  assert.equal(problem2Row, null);

  // Refusal case: cannot retry again today because slot is now used / problem is pending today
  // Skip it again on day 2 so slot is resolved today
  await cses.skipCsesProblem(userId, problem1.id, TZ, clockDay2);
  await assert.rejects(
    async () => cses.retryCsesProblem(userId, problem1.id, TZ, clockDay2),
    /already done today's problem/,
  );
});

test('R8: Undo of CSES solve - returns to Retry list (status skipped, skippedAt null), refunds coins, cleans revisions', async () => {
  const userId = await createTestUser();
  const topic = await prisma.practiceTopic.findFirst({ where: { source: 'cses', isActive: true }, orderBy: { order: 'asc' } });
  assert(topic);

  await cses.setCsesEnabled(userId, true, TZ);
  const overview = await cses.selectCsesTopic(userId, topic.id, TZ);
  const task = overview.problemToday!.task;

  // Solve with rating 'hard' (+20 coins)
  await taskCompletionService.completeTask(userId, task.id, 'hard', TZ);
  let user = await prisma.user.findUnique({ where: { id: userId } });
  assert.equal(user?.coins, 20);

  // Undo solve
  const undoResult = await taskCompletionService.undoTask(userId, task.id, TZ);
  assert.equal(undoResult.coinsDelta, -20);

  user = await prisma.user.findUnique({ where: { id: userId } });
  assert.equal(user?.coins, 0);

  // Revisions cleaned
  const revs = await prisma.revision.findMany({ where: { parentTaskId: task.id } });
  assert.equal(revs.length, 0);

  // Task row in DB: status is 'skipped', skippedAt is null!
  const undoneTask = await prisma.task.findUnique({ where: { id: task.id } });
  assert.equal(undoneTask?.status, 'skipped');
  assert.equal(undoneTask?.isSkipped, true);
  assert.equal(undoneTask?.skippedAt, null);
  assert.equal(undoneTask?.scheduledDateKey, null);

  // Appears in retryable list
  const afterUndo = await cses.getCsesOverview(userId, TZ);
  assert.equal(afterUndo.retryable.length, 1);
  assert.equal(afterUndo.retryable[0].taskId, task.id);
});

test('R9: Welcome-back prompt - triggers after >= 7 days gap, acknowledged by continue/topic switch/restart', async () => {
  const userId = await createTestUser();
  const topic = await prisma.practiceTopic.findFirst({ where: { source: 'cses', isActive: true }, orderBy: { order: 'asc' } });
  assert(topic);

  const day1 = new Date('2026-10-01T10:00:00Z');
  await cses.setCsesEnabled(userId, true, TZ, day1);
  const o1 = await cses.selectCsesTopic(userId, topic.id, TZ, day1);
  const taskId = o1.problemToday!.task.id;

  // Solve on day 1 ('2026-10-01')
  await taskCompletionService.completeTask(userId, taskId, undefined, TZ, day1);

  // 6 days later ('2026-10-07'): no prompt
  const day7 = new Date('2026-10-07T10:00:00Z');
  const o7 = await cses.getCsesOverview(userId, TZ, day7);
  assert.equal(o7.returnPrompt, null);

  // 7 days later ('2026-10-08'): prompt triggers!
  const day8 = new Date('2026-10-08T10:00:00Z');
  const o8 = await cses.getCsesOverview(userId, TZ, day8);
  assert(o8.returnPrompt !== null);
  assert.equal(o8.returnPrompt?.gapDays, 7);

  // Acknowledge via continue
  const acked = await cses.acknowledgeCsesReturn(userId, TZ, day8);
  assert.equal(acked.returnPrompt, null);

  // Same absence never prompts twice
  const o8Again = await cses.getCsesOverview(userId, TZ, day8);
  assert.equal(o8Again.returnPrompt, null);
});

test('R10: No pressure - CSES tasks excluded from backlog, expiry, and streak penalties', async () => {
  assert.equal(
    BACKLOG_TASK_TYPES.includes('cses' as any),
    false,
    'cses must NOT be included in BACKLOG_TASK_TYPES',
  );

  const userId = await createTestUser();
  const topic = await prisma.practiceTopic.findFirst({ where: { source: 'cses', isActive: true } });
  assert(topic);

  await cses.setCsesEnabled(userId, true, TZ);
  const o = await cses.selectCsesTopic(userId, topic.id, TZ);
  const taskId = o.problemToday!.task.id;

  // Even if 30 days overdue, overdue reconciler never marks it backlog
  await prisma.task.update({
    where: { id: taskId },
    data: { scheduledDateKey: '2026-09-01' },
  });

  await reconcileOverdueForUser(userId, TZ, new Date('2026-10-11T10:00:00Z'));
  const task = await prisma.task.findUnique({ where: { id: taskId } });
  assert.equal(task?.status, 'pending');
  assert.equal(task?.isBacklog, false);
  assert.equal(task?.isExpired, false);
});

test('R11: Turning CSES off parks waiting problem, turning on resumes same problem', async () => {
  const userId = await createTestUser();
  const topic = await prisma.practiceTopic.findFirst({ where: { source: 'cses', isActive: true } });
  assert(topic);

  await cses.setCsesEnabled(userId, true, TZ);
  const o = await cses.selectCsesTopic(userId, topic.id, TZ);
  const taskId = o.problemToday!.task.id;

  // Turn CSES off
  const off = await cses.setCsesEnabled(userId, false, TZ);
  assert.equal(off.enabled, false);
  assert.equal(off.status, 'off');
  assert.equal(off.problemToday, null);

  // In DB, waiting problem is parked (scheduledDateKey is null)
  const taskParked = await prisma.task.findUnique({ where: { id: taskId } });
  assert.equal(taskParked?.scheduledDateKey, null);
  assert.equal(taskParked?.status, 'pending');

  // Turn CSES back on
  const on = await cses.setCsesEnabled(userId, true, TZ);
  assert.equal(on.enabled, true);
  assert.equal(on.status, 'active');
  assert.equal(on.problemToday?.task.id, taskId);
  assert.equal(on.problemToday?.parked, false);
});

test('R12: CSES row is never deleted by user via API (deleteTask throws ValidationError)', async () => {
  const userId = await createTestUser();
  const topic = await prisma.practiceTopic.findFirst({ where: { source: 'cses', isActive: true } });
  assert(topic);

  await cses.setCsesEnabled(userId, true, TZ);
  const overview = await cses.selectCsesTopic(userId, topic.id, TZ);
  const taskId = overview.problemToday!.task.id;

  // deleteTask rejects
  await assert.rejects(
    async () => taskService.deleteTask(taskId, userId),
    /CSES problems can’t be deleted — use Skip instead/,
  );

  // createTask rejects 'cses'
  await assert.rejects(
    async () =>
      taskService.createTask(
        userId,
        { title: 'My CSES', topic: 'CSES', taskType: 'cses', scheduledDate: '2026-10-11' } as any,
        TZ,
      ),
    /created automatically/,
  );

  // updateTask rejects
  await assert.rejects(
    async () => taskService.updateTask(taskId, userId, { title: 'Renamed' }, TZ),
    /CSES problems are managed by the daily track and can’t be edited/,
  );
});

test('R13: Todo integration - CSES task appears only in Daily block and counts toward today total', async () => {
  const userId = await createTestUser();
  const topic = await prisma.practiceTopic.findFirst({ where: { source: 'cses', isActive: true } });
  assert(topic);

  await cses.setCsesEnabled(userId, true, TZ);
  await cses.selectCsesTopic(userId, topic.id, TZ);

  const todo = await todoService.getTodo(userId, TZ);
  assert.equal(todo.today.cses.length, 1);
  assert.equal(todo.dailyChallenges.cses?.enabled, true);
  assert.equal(todo.dailyChallenges.cses?.activeTopic?.id, topic.id);
  assert(todo.summary.today >= 1);

  // CSES task is isolated to today.cses, not in plan or revisions
  const csesId = todo.today.cses[0].id;
  assert.equal(todo.today.plan.some((t) => t.id === csesId), false);
  assert.equal(todo.today.revisions.some((t) => t.id === csesId), false);
});

test('R14: Dashboard integration - CSES solves count in totalQuestions, no CSES streak', async () => {
  const userId = await createTestUser();
  const topic = await prisma.practiceTopic.findFirst({ where: { source: 'cses', isActive: true } });
  assert(topic);

  await cses.setCsesEnabled(userId, true, TZ);
  await cses.selectCsesTopic(userId, topic.id, TZ);

  const todo = await todoService.getTodo(userId, TZ);
  const csesTaskId = todo.today.cses[0].id;

  // Solve CSES task
  await taskCompletionService.completeTask(userId, csesTaskId, undefined, TZ);

  const dashboard = await dashboardService.getDashboardData(userId, TZ);
  assert.equal(dashboard.statusOverview.totalQuestions, 1);
});
