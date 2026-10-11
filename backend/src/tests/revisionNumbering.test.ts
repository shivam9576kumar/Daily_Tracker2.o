import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import prisma from '../config/database';
import { taskService } from '../services/task/taskService';
import { taskCompletionService } from '../services/task/taskCompletionService';
import { requireDisposableDb } from './testGuards';
import type { Task } from '@prisma/client';

requireDisposableDb();

const TZ = 'Asia/Kolkata';
const TODAY = '2026-10-14';

type Mutation = Task | { task: Task; coinsDelta: number };
const unwrap = (r: Mutation): Task => ('task' in r ? r.task : r);

async function makeUser() {
  return prisma.user.create({
    data: { googleId: `t-${randomUUID()}`, email: `t-${randomUUID()}@test.local`, name: 'Test', coins: 0, timezone: TZ },
  });
}

async function revisionRows(parentId: string) {
  return prisma.task.findMany({
    where: { parentTaskId: parentId, taskType: 'revision' },
    orderBy: { revisionNumber: 'asc' },
    select: { id: true, revisionNumber: true, status: true },
  });
}

async function revisionRecordNumbers(parentId: string): Promise<number[]> {
  const rows = await prisma.revision.findMany({
    where: { parentTaskId: parentId },
    select: { revisionNumber: true },
    orderBy: { revisionNumber: 'asc' },
  });
  return rows.map((r) => r.revisionNumber);
}

async function createParent(userId: string): Promise<Task> {
  return unwrap(
    await taskService.createTask(
      userId,
      { title: 'Two Sum', topic: 'Arrays', difficulty: 'medium', platform: 'custom', scheduledDate: TODAY },
      TZ,
    ),
  );
}

test('H3-A: completing #1 then re-rating hard continues at #2 with no gap or duplicate', async () => {
  const user = await makeUser();
  try {
    const parent = await createParent(user.id);
    await taskCompletionService.completeTask(user.id, parent.id, 'medium', TZ);
    const rows = await revisionRows(parent.id);
    await taskCompletionService.completeTask(user.id, rows[0].id, undefined, TZ);
    await taskCompletionService.completeTask(user.id, parent.id, 'hard', TZ);

    const after = await revisionRows(parent.id);
    assert.deepEqual(after.map((r) => r.revisionNumber), [1, 2, 3, 4, 5]);
    assert.deepEqual(await revisionRecordNumbers(parent.id), [1, 2, 3, 4, 5]);
  } finally {
    await prisma.user.delete({ where: { id: user.id } });
  }
});

test('H3-B: an expired revision keeps its number; re-rating never reuses it', async () => {
  const user = await makeUser();
  try {
    const parent = await createParent(user.id);
    await taskCompletionService.completeTask(user.id, parent.id, 'medium', TZ);
    const rows = await revisionRows(parent.id);
    await taskCompletionService.completeTask(user.id, rows[0].id, undefined, TZ); // #1 completed

    // Simulate expiry of #2 (what the expiry cron does to a lapsed backlog revision).
    const rev2 = rows[1];
    await prisma.task.update({
      where: { id: rev2.id },
      data: { status: 'expired', isExpired: true, isBacklog: false },
    });
    await prisma.revision.updateMany({
      where: { revisionTaskId: rev2.id },
      data: { status: 'expired' },
    });

    await taskCompletionService.completeTask(user.id, parent.id, 'hard', TZ);

    const after = await revisionRows(parent.id);
    assert.deepEqual(after.map((r) => r.revisionNumber), [1, 2, 3, 4, 5], 'numbers must be unique and contiguous');
    const expiredRow = after.find((r) => r.id === rev2.id);
    assert.ok(expiredRow, 'expired revision row must still exist');
    assert.equal(expiredRow!.revisionNumber, 2);
    assert.equal(expiredRow!.status, 'expired');
    assert.deepEqual(await revisionRecordNumbers(parent.id), [1, 2, 3, 4, 5]);
  } finally {
    await prisma.user.delete({ where: { id: user.id } });
  }
});
