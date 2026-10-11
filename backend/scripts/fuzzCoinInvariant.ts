/**
 * Coin-invariant fuzz across ALL task kinds + daily-challenge toggles.
 * At every step:  users.coins === Σ completed(new|potd|cp31) 10+bonus  +  Σ completed revision 10  +  personal 0
 * Usage: npm run fuzz:coins --workspace=backend [-- --steps=300 --seed=42]
 */
import prisma from '../src/config/database';
import { NotFoundError, ValidationError } from '../src/utils/error';
import { taskService } from '../src/services/task/taskService';
import { taskCompletionService } from '../src/services/task/taskCompletionService';
import { personalTaskService } from '../src/services/todo/personalTaskService';
import { dailyChallengeSettingsService } from '../src/services/dailyChallenges/dailyChallengeSettingsService';
import { ensureCp31TasksForUser, serveOneMore, skipCp31Problem, retrySkippedCp31Problem } from '../src/services/cp31/cp31Service';
import { ensurePotdTaskForUser, currentPotdDateKey } from '../src/services/potd/potdService';
import { getCp31Bands } from '../src/services/plan/cp31SheetLoader';
import {
  getCsesOverview,
  setCsesEnabled,
  selectCsesTopic,
  skipCsesProblem,
  retryCsesProblem,
  restartCsesTopic,
} from '../src/services/cses/csesService';
import { todayKey } from '../src/utils/dateKeys';

const TZ = 'Asia/Kolkata';
const RATINGS = ['easy', 'medium', 'hard'] as const;
const BONUS: Record<string, number> = { easy: 0, medium: 5, hard: 10 };
const PARENT = ['new', 'potd', 'cp31', 'cses'];

const argv = Object.fromEntries(process.argv.slice(2).map((a) => { const m = a.match(/^--(\w+)=(.+)$/); return m ? [m[1], m[2]] : [a, 'true']; }));
const STEPS = Number(argv.steps ?? 300);
const SEED = Number(argv.seed ?? (Date.now() % 1_000_000_000));

function mulberry32(a: number) {
  return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const rnd = mulberry32(SEED);
const pick = <T>(arr: T[]): T | undefined => (arr.length ? arr[Math.floor(rnd() * arr.length)] : undefined);

let uid = '';
const today = todayKey(TZ);
let csesTopics: { id: string }[] = [];

async function expectedCoins(): Promise<number> {
  const rows = await prisma.task.findMany({ where: { userId: uid, status: 'completed' }, select: { taskType: true, rating: true } });
  return rows.reduce((s, r) => s + (r.taskType === 'revision' ? 10 : PARENT.includes(r.taskType) ? 10 + (BONUS[r.rating ?? ''] ?? 0) : 0), 0);
}
const actualCoins = async () => (await prisma.user.findUnique({ where: { id: uid }, select: { coins: true } }))?.coins ?? -1;
const tasks = (where: object) => prisma.task.findMany({ where: { userId: uid, ...where } });

const ops: { name: string; w: number; run: () => Promise<string> }[] = [
  { name: 'createDsa', w: 6, run: async () => { await taskService.createTask(uid, { title: `dsa-${rnd().toString(36).slice(2, 7)}`, topic: 'Arrays', difficulty: pick([...RATINGS])!, platform: 'leetcode', scheduledDate: today }, TZ); return 'ok'; } },
  { name: 'solve', w: 10, run: async () => { const t = pick(await tasks({ status: 'pending', taskType: { in: [...PARENT, 'revision', 'personal'] } })); if (!t) return 'noop'; await taskCompletionService.completeTask(uid, t.id, undefined, TZ); return t.taskType; } },
  { name: 'rate', w: 6, run: async () => { const t = pick(await tasks({ status: 'completed', taskType: { in: PARENT } })); if (!t) return 'noop'; const r = pick([...RATINGS])!; await taskCompletionService.completeTask(uid, t.id, r, TZ); return `${t.taskType}:${r}`; } },
  { name: 'unrate', w: 3, run: async () => { const t = pick(await tasks({ status: 'completed', taskType: { in: PARENT }, rating: { not: null } })); if (!t) return 'noop'; await taskCompletionService.unrateTask(uid, t.id); return t.taskType; } },
  { name: 'undo', w: 4, run: async () => { const t = pick(await tasks({ status: 'completed' })); if (!t) return 'noop'; await taskCompletionService.undoTask(uid, t.id); return t.taskType; } },
  { name: 'delete', w: 3, run: async () => { const t = pick(await tasks({})); if (!t) return 'noop'; await taskService.deleteTask(t.id, uid); return `${t.taskType}/${t.status}`; } },
  { name: 'personal', w: 3, run: async () => { const p = await personalTaskService.create(uid, { title: 'p', scheduledDateKey: today }); if (rnd() < 0.5) await taskCompletionService.completeTask(uid, p.id, undefined, TZ); return 'ok'; } },
  { name: 'potdEnsure', w: 2, run: async () => String((await ensurePotdTaskForUser(uid, TZ)).enabled) },
  { name: 'cp31Ensure', w: 4, run: async () => String((await ensureCp31TasksForUser(uid, TZ)).served.length) },
  { name: 'cp31OneMore', w: 3, run: async () => (await serveOneMore(uid, TZ)).task.cp31ProblemId ?? 'ok' },
  { name: 'cp31Skip', w: 2, run: async () => { const t = pick(await tasks({ taskType: 'cp31', status: 'pending' })); if (!t) return 'noop'; await skipCp31Problem(uid, t.id, TZ); return 'ok'; } },
  { name: 'cp31Retry', w: 1, run: async () => { const t = pick(await tasks({ taskType: 'cp31', status: 'skipped' })); if (!t) return 'noop'; await retrySkippedCp31Problem(uid, t.id, TZ); return 'ok'; } },
  { name: 'togglePotd', w: 1, run: async () => { const s = await dailyChallengeSettingsService.get(uid); await dailyChallengeSettingsService.update(uid, { potdEnabled: !s.potdEnabled }, TZ); return String(!s.potdEnabled); } },
  { name: 'toggleCp31', w: 1, run: async () => { const s = await dailyChallengeSettingsService.get(uid); await dailyChallengeSettingsService.update(uid, s.cp31Enabled ? { cp31Enabled: false } : { cp31Enabled: true, cp31Band: pick(getCp31Bands())!.band }, TZ); return String(!s.cp31Enabled); } },
  { name: 'switchBand', w: 1, run: async () => { const b = pick(getCp31Bands())!.band; await dailyChallengeSettingsService.update(uid, { cp31Band: b }, TZ); return String(b); } },
  { name: 'csesEnsure', w: 4, run: async () => { const o = await getCsesOverview(uid, TZ); return o.status; } },
  { name: 'csesSkip', w: 2, run: async () => { const t = pick(await tasks({ taskType: 'cses', status: 'pending' })); if (!t) return 'noop'; await skipCsesProblem(uid, t.id, TZ); return 'ok'; } },
  { name: 'csesRetry', w: 2, run: async () => { const t = pick(await tasks({ taskType: 'cses', status: 'skipped' })); if (!t) return 'noop'; await retryCsesProblem(uid, t.id, TZ); return 'ok'; } },
  { name: 'toggleCses', w: 1, run: async () => { const o = await getCsesOverview(uid, TZ); await setCsesEnabled(uid, !o.enabled, TZ); return String(!o.enabled); } },
  { name: 'switchCsesTopic', w: 2, run: async () => { const top = pick(csesTopics); if (!top) return 'noop'; await selectCsesTopic(uid, top.id, TZ); return top.id; } },
  { name: 'csesRestart', w: 1, run: async () => { const top = pick(csesTopics); if (!top) return 'noop'; await restartCsesTopic(uid, top.id, TZ); return 'ok'; } },
];
const totalW = ops.reduce((s, o) => s + o.w, 0);
const pickOp = () => { let r = rnd() * totalW; for (const o of ops) { r -= o.w; if (r <= 0) return o; } return ops[ops.length - 1]; };

async function main() {
  const email = 'fuzz-coins@test.local';
  await prisma.user.deleteMany({ where: { email } });
  const dateKey = currentPotdDateKey();
  const seeded = !(await prisma.potdCache.findUnique({ where: { dateKey } }));
  if (seeded) await prisma.potdCache.create({ data: { dateKey, title: 'Fuzz POTD', titleSlug: 'fuzz', difficulty: 'easy', url: 'https://leetcode.com/problems/two-sum/', topicTags: ['Array'], questionId: '1' } });
  uid = (await prisma.user.create({ data: { googleId: `fuzz-${Date.now()}`, email, name: 'Fuzz', coins: 0, timezone: TZ } })).id;
  await dailyChallengeSettingsService.update(uid, { cp31Band: 1300, cp31Enabled: true, cp31DailyCount: 2 }, TZ);
  csesTopics = await prisma.practiceTopic.findMany({ where: { source: 'cses', isActive: true }, select: { id: true } });
  await setCsesEnabled(uid, true, TZ);
  if (csesTopics[0]) await selectCsesTopic(uid, csesTopics[0].id, TZ);

  const hist: Record<string, number> = {};
  console.log(`seed=${SEED} steps=${STEPS}`);
  try {
    for (let step = 1; step <= STEPS; step++) {
      const op = pickOp();
      let out = '';
      try { out = await op.run(); }
      catch (err) { if (err instanceof ValidationError || err instanceof NotFoundError) out = `rejected(${(err as Error).message.slice(0, 40)})`; else throw err; }
      hist[op.name] = (hist[op.name] ?? 0) + 1;
      const [exp, act] = [await expectedCoins(), await actualCoins()];
      if (exp !== act || act < 0) {
        console.log(`\n❌ INVARIANT BROKEN at step ${step} op=${op.name} (${out}) expected=${exp} actual=${act} seed=${SEED}`);
        process.exitCode = 1; return;
      }
    }
    const byType = await prisma.task.groupBy({ by: ['taskType', 'status'], where: { userId: uid }, _count: { _all: true } });
    console.log('ops:', hist);
    console.log('tasks:', byType.map((r) => `${r.taskType}/${r.status}=${r._count._all}`).join(' '));
    console.log(`\n✅ COIN INVARIANT HELD FOR ${STEPS} STEPS (seed ${SEED}); final coins=${await actualCoins()}`);
  } finally {
    await prisma.user.deleteMany({ where: { email } });
    if (seeded) await prisma.potdCache.delete({ where: { dateKey } }).catch(() => {});
    await prisma.$disconnect();
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
