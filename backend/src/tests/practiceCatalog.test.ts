import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import test, { after } from 'node:test';
import prisma from '../config/database';
import {
  applyCatalogImport,
  CatalogSnapshot,
  planCatalogImport,
} from '../../scripts/importPracticeCatalog';
import {
  CsesCatalogFile,
  validateCsesCatalog,
} from '../services/practice/cses/csesCatalogValidator';
import { requireDisposableDb } from './testGuards';

requireDisposableDb();

const csesFilePath = path.resolve(__dirname, '../data/practice/cses.json');
const rawCsesJson = fs.readFileSync(csesFilePath, 'utf-8');
const csesCatalog: CsesCatalogFile = JSON.parse(rawCsesJson);

// ─── 5.1 Pure Tests (No Database) ───

test('Pure A: committed cses.json validates with zero errors', () => {
  const result = validateCsesCatalog(csesCatalog);
  assert.equal(result.errors.length, 0, `Validation errors: ${result.errors.join(', ')}`);
});

test('Pure B: counts match topic and problem totals with sanity floors', () => {
  const result = validateCsesCatalog(csesCatalog);
  const totalProblems = csesCatalog.topics.reduce((acc, t) => acc + t.problems.length, 0);

  assert.equal(result.counts.topics, csesCatalog.topics.length);
  assert.equal(result.counts.problems, totalProblems);
  assert.ok(result.counts.topics >= 15, `Expected >= 15 topics, got ${result.counts.topics}`);
  assert.ok(result.counts.problems >= 300, `Expected >= 300 problems, got ${result.counts.problems}`);
});

test('Pure C: duplicate problem id is rejected', () => {
  const clone: CsesCatalogFile = JSON.parse(JSON.stringify(csesCatalog));
  clone.topics[0].problems[1].id = clone.topics[0].problems[0].id;
  const result = validateCsesCatalog(clone);
  assert.ok(result.errors.some((e) => e.includes('duplicated')));
});

test('Pure D: duplicate url is rejected', () => {
  const clone: CsesCatalogFile = JSON.parse(JSON.stringify(csesCatalog));
  clone.topics[0].problems[1].url = clone.topics[0].problems[0].url;
  const result = validateCsesCatalog(clone);
  assert.ok(result.errors.some((e) => e.includes('url duplicated')));
});

test('Pure E: non-sequential order inside a topic is rejected', () => {
  const clone: CsesCatalogFile = JSON.parse(JSON.stringify(csesCatalog));
  clone.topics[0].problems[1].order = 999;
  const result = validateCsesCatalog(clone);
  assert.ok(result.errors.some((e) => e.includes('.order must be')));
});

test('Pure F: id whose number differs from url number is rejected', () => {
  const clone: CsesCatalogFile = JSON.parse(JSON.stringify(csesCatalog));
  clone.topics[0].problems[0].url = 'https://cses.fi/problemset/task/9999';
  const result = validateCsesCatalog(clone);
  assert.ok(result.errors.some((e) => e.includes('does not match url number')));
});

test('Pure G: URL on host other than https://cses.fi/problemset/task/<n> is rejected', () => {
  const clone: CsesCatalogFile = JSON.parse(JSON.stringify(csesCatalog));
  clone.topics[0].problems[0].url = 'https://leetcode.com/problemset/task/1068';
  const result = validateCsesCatalog(clone);
  assert.ok(result.errors.some((e) => e.includes('must match https://cses.fi/problemset/task/<number>')));
});

test('Pure H: blank title is rejected', () => {
  const cloneT: CsesCatalogFile = JSON.parse(JSON.stringify(csesCatalog));
  cloneT.topics[0].title = '   ';
  const resultT = validateCsesCatalog(cloneT);
  assert.ok(resultT.errors.some((e) => e.includes('title is blank')));

  const cloneP: CsesCatalogFile = JSON.parse(JSON.stringify(csesCatalog));
  cloneP.topics[0].problems[0].title = '   ';
  const resultP = validateCsesCatalog(cloneP);
  assert.ok(resultP.errors.some((e) => e.includes('title is blank')));
});

test('Pure I: duplicate topic slug is rejected', () => {
  const clone: CsesCatalogFile = JSON.parse(JSON.stringify(csesCatalog));
  clone.topics[1].slug = clone.topics[0].slug;
  const result = validateCsesCatalog(clone);
  assert.ok(result.errors.some((e) => e.includes('slug duplicated')));
});

test('Pure J: non-kebab-case slug is rejected', () => {
  const clone: CsesCatalogFile = JSON.parse(JSON.stringify(csesCatalog));
  clone.topics[0].slug = 'Introductory_Problems';
  const result = validateCsesCatalog(clone);
  assert.ok(result.errors.some((e) => e.includes('slug invalid')));
});

test('Pure K: planCatalogImport against empty snapshot produces only creates (18 topics, 400 problems)', () => {
  const plan = planCatalogImport({ topics: [], problems: [] }, csesCatalog);
  assert.equal(plan.errors.length, 0);
  assert.equal(plan.topicCreates.length, 18);
  assert.equal(plan.problemCreates.length, 400);
  assert.equal(plan.topicUpdates.length, 0);
  assert.equal(plan.problemUpdates.length, 0);
  assert.equal(plan.retiredTopicIds.length, 0);
  assert.equal(plan.retiredProblemIds.length, 0);
  assert.equal(plan.unchanged.topics, 0);
  assert.equal(plan.unchanged.problems, 0);
});

function buildRealSnapshotFromCatalog(catalog: CsesCatalogFile): CatalogSnapshot {
  const topics = catalog.topics.map((t, idx) => ({
    id: `mock-topic-${idx + 1}`,
    source: catalog.source,
    slug: t.slug,
    title: t.title,
    order: t.order,
    isActive: true,
  }));
  const topicMap = new Map(topics.map((t) => [t.slug, t.id]));
  const problems = catalog.topics.flatMap((t) =>
    t.problems.map((p) => ({
      id: p.id,
      source: catalog.source,
      topicId: topicMap.get(t.slug)!,
      order: p.order,
      title: p.title,
      url: p.url,
      isActive: true,
    })),
  );
  return { topics, problems };
}

test('Pure L: planCatalogImport against equal snapshot produces zero creates, updates, retirements', () => {
  const snapshot = buildRealSnapshotFromCatalog(csesCatalog);
  const plan = planCatalogImport(snapshot, csesCatalog);
  assert.equal(plan.errors.length, 0);
  assert.equal(plan.topicCreates.length, 0);
  assert.equal(plan.topicUpdates.length, 0);
  assert.equal(plan.problemCreates.length, 0);
  assert.equal(plan.problemUpdates.length, 0);
  assert.equal(plan.retiredTopicIds.length, 0);
  assert.equal(plan.retiredProblemIds.length, 0);
  assert.equal(plan.unchanged.topics, 18);
  assert.equal(plan.unchanged.problems, 400);
});

test('Pure M: changed title in catalog produces exactly one problem update', () => {
  const snapshot = buildRealSnapshotFromCatalog(csesCatalog);
  const catalogM: CsesCatalogFile = JSON.parse(JSON.stringify(csesCatalog));
  catalogM.topics[0].problems[0].title = 'Weird Algorithm (Modified)';

  const plan = planCatalogImport(snapshot, catalogM);
  assert.equal(plan.errors.length, 0);
  assert.equal(plan.problemUpdates.length, 1);
  assert.equal(plan.problemUpdates[0].id, catalogM.topics[0].problems[0].id);
  assert.equal(plan.problemUpdates[0].data.title, 'Weird Algorithm (Modified)');
  assert.equal(plan.problemCreates.length, 0);
  assert.equal(plan.topicCreates.length, 0);
  assert.equal(plan.topicUpdates.length, 0);
  assert.equal(plan.retiredProblemIds.length, 0);
});

test('Pure N: removed problem produces zero retirements without retireMissing, exactly one with it', () => {
  const snapshot = buildRealSnapshotFromCatalog(csesCatalog);
  const catalogN: CsesCatalogFile = JSON.parse(JSON.stringify(csesCatalog));
  const removedProblem = catalogN.topics[0].problems.shift()!; // remove first problem

  const planNoRetire = planCatalogImport(snapshot, catalogN, { retireMissing: false });
  assert.equal(planNoRetire.errors.length, 0);
  assert.equal(planNoRetire.retiredProblemIds.length, 0);

  const planWithRetire = planCatalogImport(snapshot, catalogN, { retireMissing: true });
  assert.equal(planWithRetire.errors.length, 0);
  assert.equal(planWithRetire.retiredProblemIds.length, 1);
  assert.equal(planWithRetire.retiredProblemIds[0], removedProblem.id);
});

test('Pure O: problem whose id exists under different source produces error and no writes', () => {
  const snapshot = buildRealSnapshotFromCatalog(csesCatalog);
  const conflictingId = csesCatalog.topics[0].problems[0].id;
  const pIndex = snapshot.problems.findIndex((p) => p.id === conflictingId);
  snapshot.problems[pIndex].source = 'other-source';

  const plan = planCatalogImport(snapshot, csesCatalog);
  assert.ok(plan.errors.length > 0);
  assert.ok(plan.errors.some((e) => e.includes('different source')));
  assert.equal(plan.topicCreates.length, 0);
  assert.equal(plan.topicUpdates.length, 0);
  assert.equal(plan.problemCreates.length, 0);
  assert.equal(plan.problemUpdates.length, 0);
  assert.equal(plan.retiredTopicIds.length, 0);
  assert.equal(plan.retiredProblemIds.length, 0);
});

// ─── 5.2 Database Tests (Disposable Database Only) ───

function makeSyntheticCatalog(source: string, u: string) {
  return {
    source,
    version: 1,
    topics: [
      {
        slug: `synth-topic-1-${u}`,
        title: `Synthetic Topic 1 ${u}`,
        order: 1,
        problems: [
          { id: `test-${u}-p1`, order: 1, title: 'Synthetic 1', url: `https://example.test/${u}/p1` },
          { id: `test-${u}-p2`, order: 2, title: 'Synthetic 2', url: `https://example.test/${u}/p2` },
          { id: `test-${u}-p3`, order: 3, title: 'Synthetic 3', url: `https://example.test/${u}/p3` },
        ],
      },
      {
        slug: `synth-topic-2-${u}`,
        title: `Synthetic Topic 2 ${u}`,
        order: 2,
        problems: [
          { id: `test-${u}-p4`, order: 1, title: 'Synthetic 4', url: `https://example.test/${u}/p4` },
          { id: `test-${u}-p5`, order: 2, title: 'Synthetic 5', url: `https://example.test/${u}/p5` },
          { id: `test-${u}-p6`, order: 3, title: 'Synthetic 6', url: `https://example.test/${u}/p6` },
        ],
      },
    ],
  };
}

async function getDbSnapshot(source: string): Promise<CatalogSnapshot> {
  const [topics, problems] = await Promise.all([
    prisma.practiceTopic.findMany({ where: { source } }),
    prisma.practiceProblem.findMany({ where: { source } }),
  ]);
  return { topics, problems };
}

async function cleanupTestRows(src: string) {
  if (!src.startsWith('test-cses-')) return;
  await prisma.practiceProblem.deleteMany({ where: { source: src } });
  await prisma.practiceTopic.deleteMany({ where: { source: src } });
}

test('DB P: plan and apply synthetic catalog twice; second plan has zero writes', async () => {
  const testSource = `test-cses-${randomUUID()}`;
  const u = randomUUID().slice(0, 8);
  const synth = makeSyntheticCatalog(testSource, u);

  try {
    const snap1 = await getDbSnapshot(testSource);
    const plan1 = planCatalogImport(snap1, synth);
    assert.equal(plan1.topicCreates.length, 2);
    assert.equal(plan1.problemCreates.length, 6);
    await applyCatalogImport(prisma, plan1);

    const snap2 = await getDbSnapshot(testSource);
    const plan2 = planCatalogImport(snap2, synth);
    assert.equal(plan2.topicCreates.length, 0);
    assert.equal(plan2.topicUpdates.length, 0);
    assert.equal(plan2.problemCreates.length, 0);
    assert.equal(plan2.problemUpdates.length, 0);
    assert.equal(plan2.retiredTopicIds.length, 0);
    assert.equal(plan2.retiredProblemIds.length, 0);
    assert.equal(plan2.unchanged.topics, 2);
    assert.equal(plan2.unchanged.problems, 6);
    await applyCatalogImport(prisma, plan2);
  } finally {
    await cleanupTestRows(testSource);
  }
});

test('DB Q: change one title in synthetic catalog; apply updates exactly one row', async () => {
  const testSource = `test-cses-${randomUUID()}`;
  const u = randomUUID().slice(0, 8);
  const synth = makeSyntheticCatalog(testSource, u);

  try {
    const snap1 = await getDbSnapshot(testSource);
    const plan1 = planCatalogImport(snap1, synth);
    await applyCatalogImport(prisma, plan1);

    synth.topics[0].problems[0].title = 'Updated Title Q';
    const snap2 = await getDbSnapshot(testSource);
    const plan2 = planCatalogImport(snap2, synth);
    assert.equal(plan2.problemUpdates.length, 1);
    assert.equal(plan2.problemUpdates[0].id, `test-${u}-p1`);
    assert.equal(plan2.problemUpdates[0].data.title, 'Updated Title Q');
    await applyCatalogImport(prisma, plan2);

    const updatedRow = await prisma.practiceProblem.findUniqueOrThrow({ where: { id: `test-${u}-p1` } });
    assert.equal(updatedRow.title, 'Updated Title Q');
  } finally {
    await cleanupTestRows(testSource);
  }
});

test('DB R: remove problem with retireMissing: false; row still exists and isActive is true', async () => {
  const testSource = `test-cses-${randomUUID()}`;
  const u = randomUUID().slice(0, 8);
  const synth = makeSyntheticCatalog(testSource, u);

  try {
    const snap1 = await getDbSnapshot(testSource);
    const plan1 = planCatalogImport(snap1, synth);
    await applyCatalogImport(prisma, plan1);

    const removedId = synth.topics[0].problems[0].id;
    synth.topics[0].problems.shift();

    const snap2 = await getDbSnapshot(testSource);
    const plan2 = planCatalogImport(snap2, synth, { retireMissing: false });
    assert.equal(plan2.retiredProblemIds.length, 0);
    await applyCatalogImport(prisma, plan2);

    const checkRow = await prisma.practiceProblem.findUniqueOrThrow({ where: { id: removedId } });
    assert.equal(checkRow.isActive, true);
  } finally {
    await cleanupTestRows(testSource);
  }
});

test('DB S: remove problem with retireMissing: true; row exists with isActive = false', async () => {
  const testSource = `test-cses-${randomUUID()}`;
  const u = randomUUID().slice(0, 8);
  const synth = makeSyntheticCatalog(testSource, u);

  try {
    const snap1 = await getDbSnapshot(testSource);
    const plan1 = planCatalogImport(snap1, synth);
    await applyCatalogImport(prisma, plan1);

    const removedId = synth.topics[0].problems[0].id;
    synth.topics[0].problems.shift();

    const snap2 = await getDbSnapshot(testSource);
    const plan2 = planCatalogImport(snap2, synth, { retireMissing: true });
    assert.equal(plan2.retiredProblemIds.length, 1);
    assert.equal(plan2.retiredProblemIds[0], removedId);
    await applyCatalogImport(prisma, plan2);

    const checkRow = await prisma.practiceProblem.findUniqueOrThrow({ where: { id: removedId } });
    assert.equal(checkRow.isActive, false);
  } finally {
    await cleanupTestRows(testSource);
  }
});

test('DB T: for every stored problem, topicId equals the id of containing topic', async () => {
  const testSource = `test-cses-${randomUUID()}`;
  const u = randomUUID().slice(0, 8);
  const synth = makeSyntheticCatalog(testSource, u);

  try {
    const snap1 = await getDbSnapshot(testSource);
    const plan1 = planCatalogImport(snap1, synth);
    await applyCatalogImport(prisma, plan1);

    const topicsWithProblems = await prisma.practiceTopic.findMany({
      where: { source: testSource },
      include: { problems: true },
    });

    assert.equal(topicsWithProblems.length, 2);
    for (const top of topicsWithProblems) {
      assert.equal(top.problems.length, 3);
      for (const prob of top.problems) {
        assert.equal(prob.topicId, top.id);
      }
    }
  } finally {
    await cleanupTestRows(testSource);
  }
});

test('DB U: real cses source imported idempotently; second plan has zero writes', async () => {
  const snap1 = await getDbSnapshot('cses');
  const plan1 = planCatalogImport(snap1, csesCatalog);
  await applyCatalogImport(prisma, plan1);

  const snap2 = await getDbSnapshot('cses');
  const plan2 = planCatalogImport(snap2, csesCatalog);
  assert.equal(plan2.topicCreates.length, 0);
  assert.equal(plan2.topicUpdates.length, 0);
  assert.equal(plan2.problemCreates.length, 0);
  assert.equal(plan2.problemUpdates.length, 0);
  assert.equal(plan2.retiredTopicIds.length, 0);
  assert.equal(plan2.retiredProblemIds.length, 0);
  await applyCatalogImport(prisma, plan2);
});
