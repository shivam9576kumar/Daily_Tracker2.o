import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import prisma from '../config/database';
import { taskService } from '../services/task/taskService';
import { personalTaskService } from '../services/todo/personalTaskService';
import { requireDisposableDb } from './testGuards';

requireDisposableDb();

const TZ = 'Asia/Kolkata';

async function makeUser() {
  return prisma.user.create({
    data: {
      googleId: `t-${randomUUID()}`,
      email: `t-${randomUUID()}@test.local`,
      name: 'Test',
      coins: 0,
      timezone: TZ,
    },
  });
}

async function makeTask(userId: string, title: string) {
  return taskService.createTask(
    userId,
    { title, topic: 'Arrays', difficulty: 'medium', platform: 'custom', scheduledDate: '2026-10-14' },
    TZ,
  );
}

test('H4-A: blank, whitespace-only, and non-string titles are rejected and nothing changes', async () => {
  const user = await makeUser();
  try {
    const task = await makeTask(user.id, 'Original');
    await assert.rejects(() => taskService.updateTask(task.id, user.id, { title: '' }, TZ), /Title cannot be empty/);
    await assert.rejects(() => taskService.updateTask(task.id, user.id, { title: '   ' }, TZ), /Title cannot be empty/);
    await assert.rejects(() => taskService.updateTask(task.id, user.id, { title: 5 as unknown as string }, TZ), /must be text/);
    const after = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    assert.equal(after.title, 'Original');
  } finally {
    await prisma.user.delete({ where: { id: user.id } });
  }
});

test('H4-B: blank topic is rejected', async () => {
  const user = await makeUser();
  try {
    const task = await makeTask(user.id, 'Original');
    await assert.rejects(() => taskService.updateTask(task.id, user.id, { topic: '  ' }, TZ), /Topic cannot be empty/);
  } finally {
    await prisma.user.delete({ where: { id: user.id } });
  }
});

test('H4-C: over-long title is rejected', async () => {
  const user = await makeUser();
  try {
    const task = await makeTask(user.id, 'Original');
    await assert.rejects(
      () => taskService.updateTask(task.id, user.id, { title: 'x'.repeat(201) }, TZ),
      /200 characters or fewer/,
    );
  } finally {
    await prisma.user.delete({ where: { id: user.id } });
  }
});

test('H4-D: valid title saves; omitted title is untouched', async () => {
  const user = await makeUser();
  try {
    const task = await makeTask(user.id, 'Original');
    await taskService.updateTask(task.id, user.id, { title: '  Renamed  ' }, TZ);
    let row = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    assert.equal(row.title, 'Renamed');

    await taskService.updateTask(task.id, user.id, { topic: 'Trees' }, TZ);
    row = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    assert.equal(row.title, 'Renamed');
    assert.equal(row.topic, 'Trees');
  } finally {
    await prisma.user.delete({ where: { id: user.id } });
  }
});

test('H4-E (Section 4-C): personalTaskService.update rejects blank and non-string titles', async () => {
  const user = await makeUser();
  try {
    const task = await personalTaskService.create(user.id, { title: 'Personal task' }, TZ);
    await assert.rejects(
      () => personalTaskService.update(user.id, task.id, { title: '' }, TZ),
      /Title is required/,
    );
    await assert.rejects(
      () => personalTaskService.update(user.id, task.id, { title: '   ' }, TZ),
      /Title is required/,
    );
    await assert.rejects(
      () => personalTaskService.update(user.id, task.id, { title: 123 as unknown as string }, TZ),
      /Title is required/,
    );
    const after = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    assert.equal(after.title, 'Personal task');
  } finally {
    await prisma.user.delete({ where: { id: user.id } });
  }
});
