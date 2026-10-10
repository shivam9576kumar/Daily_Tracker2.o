import { runBacklogCron } from './backlogCron';
import { runExpiryCron } from './expiryCron';
import { runPotdWarmupCron, runPotdPruneCron } from './potdCron';
import { cronRunService } from '../services/cron/cronRunService';
import logger from '../utils/logger';

/**
 * Initializes daily cron jobs.
 *
 * CronRun table prevents duplicate daily runs.
 * Individual cron jobs are also idempotent.
 */
export const runDailyMaintenance = async () => {
  await cronRunService.runOncePerDay('daily-maintenance', async () => {
    await runBacklogCron();
    await runExpiryCron();
    await runPotdWarmupCron();
    await runPotdPruneCron();
  });
};

export function initCronJobs() {
  logger.info('⏰ Cron scheduler initialized');

  // Run once on startup.
  runDailyMaintenance().catch((err) => {
    logger.error('Startup daily maintenance failed:', err);
  });

  // Check every minute if a new day has started.
  setInterval(() => {
    runDailyMaintenance().catch((err) => {
      logger.error('Scheduled daily maintenance failed:', err);
    });
  }, 60_000);
}
