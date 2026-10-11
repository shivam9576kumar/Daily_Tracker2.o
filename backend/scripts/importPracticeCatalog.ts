import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PrismaClient } from '@prisma/client';
import prismaClient from '../src/config/database';
import {
  CsesCatalogFile,
  validateCsesCatalog,
} from '../src/services/practice/cses/csesCatalogValidator';

export interface CatalogSnapshot {
  topics: { id: string; source: string; slug: string; title: string; order: number; isActive: boolean }[];
  problems: { id: string; source: string; topicId: string; order: number; title: string; url: string; isActive: boolean }[];
}

export interface CatalogImportPlan {
  topicCreates: { id: string; source: string; slug: string; title: string; order: number }[];
  topicUpdates: { id: string; data: { title?: string; order?: number; isActive?: boolean } }[];
  problemCreates: { id: string; source: string; topicId: string; order: number; title: string; url: string }[];
  problemUpdates: { id: string; data: { topicId?: string; order?: number; title?: string; url?: string; isActive?: boolean } }[];
  retiredTopicIds: string[];
  retiredProblemIds: string[];
  unchanged: { topics: number; problems: number };
  errors: string[];
}

export function planCatalogImport(
  snapshot: CatalogSnapshot,
  catalog: CsesCatalogFile,
  options?: { retireMissing?: boolean },
): CatalogImportPlan {
  const errors: string[] = [];
  const topicCreates: CatalogImportPlan['topicCreates'] = [];
  const topicUpdates: CatalogImportPlan['topicUpdates'] = [];
  const problemCreates: CatalogImportPlan['problemCreates'] = [];
  const problemUpdates: CatalogImportPlan['problemUpdates'] = [];
  let unchangedTopics = 0;
  let unchangedProblems = 0;

  // Topic slug to id mapping (existing or newly assigned)
  const topicIdMap = new Map<string, string>();

  // 1. Plan topics
  for (const t of catalog.topics) {
    const matched = snapshot.topics.find((st) => st.source === catalog.source && st.slug === t.slug);
    if (!matched) {
      const newId = randomUUID();
      topicIdMap.set(t.slug, newId);
      topicCreates.push({
        id: newId,
        source: catalog.source,
        slug: t.slug,
        title: t.title,
        order: t.order,
      });
    } else {
      topicIdMap.set(t.slug, matched.id);
      const data: { title?: string; order?: number; isActive?: boolean } = {};
      if (matched.title !== t.title) data.title = t.title;
      if (matched.order !== t.order) data.order = t.order;
      if (matched.isActive === false) data.isActive = true;

      if (Object.keys(data).length > 0) {
        topicUpdates.push({ id: matched.id, data });
      } else {
        unchangedTopics++;
      }
    }
  }

  // 2. Plan problems
  for (const t of catalog.topics) {
    const topicId = topicIdMap.get(t.slug);
    if (!topicId) {
      errors.push(`Topic id missing for topic slug "${t.slug}"`);
      continue;
    }

    for (const p of t.problems) {
      const matched = snapshot.problems.find((sp) => sp.id === p.id);
      if (matched) {
        if (matched.source !== catalog.source) {
          errors.push(`Problem "${p.id}" exists in snapshot with different source "${matched.source}"`);
        }

        const urlCollision = snapshot.problems.find((sp) => sp.source === catalog.source && sp.url === p.url && sp.id !== p.id);
        if (urlCollision) {
          errors.push(`Problem "${p.id}" URL "${p.url}" is already used by problem "${urlCollision.id}"`);
        }

        const data: { topicId?: string; order?: number; title?: string; url?: string; isActive?: boolean } = {};
        if (matched.topicId !== topicId) data.topicId = topicId;
        if (matched.order !== p.order) data.order = p.order;
        if (matched.title !== p.title) data.title = p.title;
        if (matched.url !== p.url) data.url = p.url;
        if (matched.isActive === false) data.isActive = true;

        if (Object.keys(data).length > 0) {
          problemUpdates.push({ id: matched.id, data });
        } else {
          unchangedProblems++;
        }
      } else {
        const urlCollision = snapshot.problems.find((sp) => sp.source === catalog.source && sp.url === p.url);
        if (urlCollision) {
          errors.push(`Problem "${p.id}" URL "${p.url}" is already used by problem "${urlCollision.id}"`);
        }

        problemCreates.push({
          id: p.id,
          source: catalog.source,
          topicId,
          order: p.order,
          title: p.title,
          url: p.url,
        });
      }
    }
  }

  // 3. Missing rows
  const catalogTopicSlugs = new Set(catalog.topics.map((t) => t.slug));
  const catalogProblemIds = new Set(catalog.topics.flatMap((t) => t.problems.map((p) => p.id)));

  const missingTopics = snapshot.topics.filter(
    (st) => st.source === catalog.source && !catalogTopicSlugs.has(st.slug) && st.isActive !== false,
  );
  const missingProblems = snapshot.problems.filter(
    (sp) => sp.source === catalog.source && !catalogProblemIds.has(sp.id) && sp.isActive !== false,
  );

  const retiredTopicIds = options?.retireMissing ? missingTopics.map((t) => t.id) : [];
  const retiredProblemIds = options?.retireMissing ? missingProblems.map((p) => p.id) : [];

  if (errors.length > 0) {
    return {
      topicCreates: [],
      topicUpdates: [],
      problemCreates: [],
      problemUpdates: [],
      retiredTopicIds: [],
      retiredProblemIds: [],
      unchanged: { topics: 0, problems: 0 },
      errors,
    };
  }

  return {
    topicCreates,
    topicUpdates,
    problemCreates,
    problemUpdates,
    retiredTopicIds,
    retiredProblemIds,
    unchanged: { topics: unchangedTopics, problems: unchangedProblems },
    errors,
  };
}

export async function applyCatalogImport(prisma: PrismaClient, plan: CatalogImportPlan): Promise<void> {
  const ops: any[] = [];
  if (plan.topicCreates.length > 0) {
    ops.push(prisma.practiceTopic.createMany({ data: plan.topicCreates }));
  }
  if (plan.problemCreates.length > 0) {
    ops.push(prisma.practiceProblem.createMany({ data: plan.problemCreates }));
  }
  for (const u of plan.topicUpdates) {
    ops.push(prisma.practiceTopic.update({ where: { id: u.id }, data: u.data }));
  }
  for (const u of plan.problemUpdates) {
    ops.push(prisma.practiceProblem.update({ where: { id: u.id }, data: u.data }));
  }
  for (const id of plan.retiredTopicIds) {
    ops.push(prisma.practiceTopic.update({ where: { id }, data: { isActive: false } }));
  }
  for (const id of plan.retiredProblemIds) {
    ops.push(prisma.practiceProblem.update({ where: { id }, data: { isActive: false } }));
  }

  if (ops.length > 0) {
    await prisma.$transaction(ops);
  }
}

export async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let isApply =
    args.includes('--apply') ||
    process.env.npm_config_apply === 'true' ||
    process.env.npm_config_apply === '' ||
    process.env.npm_config_all === 'true';
  let retireMissing =
    args.includes('--retire-missing') ||
    process.env.npm_config_retire_missing === 'true' ||
    process.env.npm_config_retire_missing === '';
  let allowRemote =
    args.includes('--allow-remote') ||
    process.env.npm_config_allow_remote === 'true' ||
    process.env.npm_config_allow_remote === '';

  const sourceArg = args.find((a) => a.startsWith('--source='));
  let source = sourceArg ? sourceArg.split('=')[1] : null;
  if (!source && process.env.npm_config_source) {
    source = process.env.npm_config_source;
  }

  if (!source || source !== 'cses') {
    console.error('Error: --source=cses is required.');
    process.exit(1);
  }

  const databaseUrl = process.env.DATABASE_URL ?? '';
  let hostname = 'unknown';
  try {
    const parsed = new URL(databaseUrl);
    hostname = parsed.hostname;
  } catch {
    console.error('Error: Invalid DATABASE_URL.');
    process.exit(1);
  }

  if (!['localhost', '127.0.0.1'].includes(hostname) && !allowRemote) {
    console.error(`Error: Refusing to run against remote host "${hostname}". Pass --allow-remote to override.`);
    process.exit(1);
  }

  // 1. Mode
  console.log(`Mode: ${isApply ? 'APPLY' : 'DRY-RUN'}`);
  // 2. Source
  console.log(`Source: ${source}`);
  // 3. Target host
  console.log(`Target host: ${hostname}`);

  // 4. Read & Validate file
  const filePath = path.resolve(__dirname, '../src/data/practice/cses.json');
  let rawContent: string;
  try {
    rawContent = fs.readFileSync(filePath, 'utf-8');
  } catch (err: any) {
    console.error(`Error reading ${filePath}: ${err.message}`);
    process.exit(1);
  }

  let catalogJson: unknown;
  try {
    catalogJson = JSON.parse(rawContent);
  } catch (err: any) {
    console.error(`Error parsing JSON from ${filePath}: ${err.message}`);
    process.exit(1);
  }

  const validation = validateCsesCatalog(catalogJson, source);
  if (validation.errors.length > 0) {
    console.error(`Validation: FAILED (${validation.errors.length} error(s))`);
    for (const err of validation.errors) {
      console.error(`  - ${err}`);
    }
    process.exit(1);
  }
  console.log(`Validation: OK (${validation.counts.topics} topics, ${validation.counts.problems} problems)`);

  const catalog = catalogJson as CsesCatalogFile;

  // Load snapshot
  const [existingTopics, existingProblems] = await Promise.all([
    prismaClient.practiceTopic.findMany({ where: { source } }),
    prismaClient.practiceProblem.findMany({ where: { source } }),
  ]);

  const snapshot: CatalogSnapshot = {
    topics: existingTopics,
    problems: existingProblems,
  };

  const plan = planCatalogImport(snapshot, catalog, { retireMissing });

  if (plan.errors.length > 0) {
    console.error(`Import plan failed with ${plan.errors.length} error(s):`);
    for (const err of plan.errors) {
      console.error(`  - ${err}`);
    }
    process.exit(1);
  }

  // 5. Topics created / updated / unchanged
  console.log(`Topics: ${plan.topicCreates.length} created, ${plan.topicUpdates.length} updated, ${plan.unchanged.topics} unchanged`);

  // 6. Problems created / updated / unchanged
  console.log(`Problems: ${plan.problemCreates.length} created, ${plan.problemUpdates.length} updated, ${plan.unchanged.problems} unchanged`);

  // 7. Per-topic problem counts
  console.log('Per-topic problem counts:');
  for (const t of catalog.topics) {
    console.log(`  - ${t.title}: ${t.problems.length}`);
  }

  // 8. Retirements
  const catalogTopicSlugs = new Set(catalog.topics.map((t) => t.slug));
  const catalogProblemIds = new Set(catalog.topics.flatMap((t) => t.problems.map((p) => p.id)));
  const wouldRetireTopics = existingTopics.filter((t) => !catalogTopicSlugs.has(t.slug) && t.isActive !== false).length;
  const wouldRetireProblems = existingProblems.filter((p) => !catalogProblemIds.has(p.id) && p.isActive !== false).length;

  if (retireMissing) {
    console.log(`Retirements: ${plan.retiredTopicIds.length} topics retired, ${plan.retiredProblemIds.length} problems retired`);
  } else {
    console.log(`Retirements: ${wouldRetireTopics} topics would retire, ${wouldRetireProblems} problems would retire`);
  }

  // Apply if requested
  if (isApply) {
    await applyCatalogImport(prismaClient, plan);
    console.log('Result: Apply completed successfully. Catalog is up to date.');
  } else {
    console.log('Result: Dry-run completed successfully. No changes were applied.');
  }

  process.exit(0);
}

if (require.main === module) {
  main()
    .catch((err) => {
      console.error('Fatal error:', err);
      process.exit(1);
    })
    .finally(() => prismaClient.$disconnect());
}
