import prisma from '../src/config/database';

async function main() {
  const rows = await prisma.task.findMany({
    where: { taskType: 'revision', parentTaskId: { not: null } },
    select: { id: true, parentTaskId: true, revisionNumber: true, status: true },
  });

  const byParent = new Map<string, typeof rows>();
  for (const r of rows) {
    const list = byParent.get(r.parentTaskId!) ?? [];
    list.push(r);
    byParent.set(r.parentTaskId!, list);
  }

  let affected = 0;
  for (const [parentId, list] of byParent) {
    const counts = new Map<number, number>();
    for (const r of list) counts.set(r.revisionNumber, (counts.get(r.revisionNumber) ?? 0) + 1);
    const dupes = [...counts].filter(([, c]) => c > 1).map(([n]) => n);
    if (dupes.length > 0) {
      affected++;
      console.log(`parent ${parentId}: duplicate revision numbers ${dupes.join(', ')}`);
    }
  }
  console.log(`Parents checked: ${byParent.size}. Parents with duplicate numbers: ${affected}. READ-ONLY: no changes made.`);
}

main()
  .catch((err) => { console.error(err); process.exit(1); })
  .finally(() => prisma.$disconnect());
