import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import prisma from '../config/database';
import { reconcileOverdueForUser } from '../services/task/overdueReconciler';
import { requireCronSecret } from '../middleware/cronAuthMiddleware';
import { requireDisposableDb } from './testGuards';

requireDisposableDb();

const TZ = 'Asia/Kolkata';
// 2026-10-14 06:00 UTC = 2026-10-14 11:30 IST
const NOW = new Date('2026-10-14T06:00:00.000Z');
const SRC = path.resolve(__dirname, '..');

async function makeUser() {
  return prisma.user.create({
    data: { googleId: `t-${randomUUID()}`, email: `t-${randomUUID()}@test.local`, name: 'Test', coins: 0, timezone: TZ },
  });
}

test('C4-A: a missed revision moves to backlog without any cron running', async () => {
  const user = await makeUser();
  try {
    const rev = await prisma.task.create({
      data: {
        userId: user.id, taskType: 'revision', status: 'pending', title: 'Missed revision', topic: 'Arrays',
        difficulty: 'medium', platform: 'custom',
        scheduledDateKey: '2026-10-12', scheduledDate: new Date('2026-10-12T00:00:00.000Z'), revisionNumber: 1,
      },
    });
    const moved = await reconcileOverdueForUser(user.id, TZ, NOW);
    assert.equal(moved, 1);
    const row = await prisma.task.findUniqueOrThrow({ where: { id: rev.id } });
    assert.equal(row.status, 'backlog');
    assert.equal(row.isBacklog, true);
    assert.equal(row.isExpired, false);
    assert.equal(row.backlogSince?.toISOString(), NOW.toISOString());
  } finally {
    await prisma.user.delete({ where: { id: user.id } });
  }
});

test('C4-B: ineligible rows are never moved', async () => {
  const user = await makeUser();
  try {
    const base = { userId: user.id, status: 'pending', title: 'x', topic: 'Arrays', difficulty: 'medium', platform: 'custom' } as const;
    const overdue = new Date('2026-10-12T00:00:00.000Z');

    const cp31 = await prisma.task.create({ data: { ...base, taskType: 'cp31', cp31ProblemId: 'cp31-1300-99', scheduledDateKey: '2026-10-12', scheduledDate: overdue } });
    const potd = await prisma.task.create({ data: { ...base, taskType: 'potd', potdDateKey: '1999-01-01', scheduledDateKey: '2026-10-12', scheduledDate: overdue } });
    const inbox = await prisma.task.create({ data: { ...base, taskType: 'personal', scheduledDateKey: null, scheduledDate: null } });
    const done = await prisma.task.create({ data: { ...base, taskType: 'revision', status: 'completed', completedAt: NOW, scheduledDateKey: '2026-10-12', scheduledDate: overdue } });
    const future = await prisma.task.create({ data: { ...base, taskType: 'revision', scheduledDateKey: '2026-10-20', scheduledDate: new Date('2026-10-20T00:00:00.000Z') } });

    await reconcileOverdueForUser(user.id, TZ, NOW);

    for (const [row, expected] of [
      [cp31, 'pending'], [potd, 'pending'], [inbox, 'pending'], [done, 'completed'], [future, 'pending'],
    ] as const) {
      const fresh = await prisma.task.findUniqueOrThrow({ where: { id: row.id } });
      assert.equal(fresh.status, expected, `${row.taskType} changed unexpectedly`);
      assert.equal(fresh.isBacklog, false, `${row.taskType} got isBacklog`);
    }
  } finally {
    await prisma.user.delete({ where: { id: user.id } });
  }
});

test('C4-C: reconciliation is idempotent and keeps the original backlogSince', async () => {
  const user = await makeUser();
  try {
    const rev = await prisma.task.create({
      data: {
        userId: user.id, taskType: 'revision', status: 'pending', title: 'r', topic: 'Arrays',
        difficulty: 'medium', platform: 'custom',
        scheduledDateKey: '2026-10-12', scheduledDate: new Date('2026-10-12T00:00:00.000Z'), revisionNumber: 1,
      },
    });
    await reconcileOverdueForUser(user.id, TZ, NOW);
    const first = await prisma.task.findUniqueOrThrow({ where: { id: rev.id } });

    const later = new Date(NOW.getTime() + 3 * 3_600_000);
    const secondCount = await reconcileOverdueForUser(user.id, TZ, later);
    const second = await prisma.task.findUniqueOrThrow({ where: { id: rev.id } });

    assert.equal(secondCount, 0);
    assert.equal(second.backlogSince?.toISOString(), first.backlogSince?.toISOString());
  } finally {
    await prisma.user.delete({ where: { id: user.id } });
  }
});

test('C4-D: a revision moved to backlog is returned by the Today backlog predicate', async () => {
  const user = await makeUser();
  try {
    const rev = await prisma.task.create({
      data: {
        userId: user.id, taskType: 'revision', status: 'pending', title: 'r', topic: 'Arrays',
        difficulty: 'medium', platform: 'custom',
        scheduledDateKey: '2026-10-12', scheduledDate: new Date('2026-10-12T00:00:00.000Z'), revisionNumber: 1,
      },
    });
    await reconcileOverdueForUser(user.id, TZ, NOW);
    // Same predicate the Today/Todo backlog view uses.
    const visible = await prisma.task.findMany({
      where: { userId: user.id, isBacklog: true, status: 'backlog' },
    });
    assert.ok(visible.some((t) => t.id === rev.id));
  } finally {
    await prisma.user.delete({ where: { id: user.id } });
  }
});

test('C4-E: Todo and Dashboard call the reconciler on load', () => {
  for (const rel of ['services/todo/todoService.ts', 'services/dashboard/dashboardService.ts']) {
    const src = fs.readFileSync(path.join(SRC, rel), 'utf8');
    assert.match(src, /reconcileOverdueForUser\(/, `${rel} does not call the reconciler`);
  }
});

test('C4-F: cron endpoint is disabled without a secret, rejects wrong tokens, admits the right one', () => {
  const run = (header: string | undefined, secret: string | undefined) => {
    let status = 0;
    let nextCalled = false;
    const res: any = {
      status(code: number) { status = code; return this; },
      json() { return this; },
    };
    requireCronSecret(() => secret)(
      { headers: header === undefined ? {} : { authorization: header } } as any,
      res,
      () => { nextCalled = true; },
    );
    return { status, nextCalled };
  };

  assert.deepEqual(run('Bearer abc', undefined), { status: 503, nextCalled: false });
  assert.deepEqual(run(undefined, 'abc'), { status: 401, nextCalled: false });
  assert.deepEqual(run('Bearer wrong', 'abc'), { status: 401, nextCalled: false });
  assert.deepEqual(run('Bearer abc', 'abc'), { status: 0, nextCalled: true });
});
