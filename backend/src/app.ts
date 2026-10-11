import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import path from 'path';
import fs from 'fs';
import { env } from './config/env';
import { errorMiddleware } from './middleware/errorMiddleware';
import { timezoneMiddleware } from './middleware/timezoneMiddleware';
import { sendSuccess } from './utils/response';
import prisma from './config/database';
import logger from './utils/logger';
import { checkDatabaseReady } from './services/health/readiness';

// Route imports
import authRoutes from './routes/authRoutes';
import taskRoutes from './routes/taskRoutes';
import notesRoutes from './routes/notesRoutes';
import assignmentRoutes from './routes/assignmentRoutes';
import dashboardRoutes from './routes/dashboardRoutes';
import notificationRoutes from './routes/notificationRoutes';
import debugRoutes from './routes/debugRoutes';
import planRoutes from './routes/planRoutes';
import progressRoutes from './routes/progressRoutes';
import classesRoutes from './routes/classesRoutes';
import potdRoutes from './routes/potdRoutes';
import todoRoutes from './routes/todoRoutes';
import dailyChallengesRoutes from './routes/dailyChallengesRoutes';

const app = express();

// ─── Security ───
app.use(
  helmet({
    contentSecurityPolicy: false,
  })
);

// ─── CORS ───
const allowedOrigins = env.FRONTEND_URL.split(',').map((s) => s.trim()).filter(Boolean);

/**
 * Requests with no Origin header (server-to-server calls, curl, same-origin
 * navigation) are not subject to CORS in the first place and are allowed
 * through unconditionally — this mirrors standard CORS middleware practice
 * and is not a security gap.
 *
 * Exported for direct unit testing without spinning up an HTTP server.
 */
import { requireCronSecret } from './middleware/cronAuthMiddleware';
import { runDailyMaintenance } from './cron';

export function isAllowedOrigin(origin: string | undefined, frontendUrlConfig: string = env.FRONTEND_URL): boolean {
  if (!origin) return true;
  if (origin.endsWith('.vercel.app') || origin.includes('localhost') || origin.includes('127.0.0.1')) {
    return true;
  }
  const origins = frontendUrlConfig.split(',').map((s) => s.trim()).filter(Boolean);
  return origins.includes(origin);
}

app.use(
  cors({
    origin(origin, callback) {
      if (isAllowedOrigin(origin)) {
        callback(null, true);
      } else {
        callback(new Error(`Origin ${origin} is not allowed by CORS`));
      }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Timezone'],
  })
);

// ─── Body Parsing ───
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ─── Timezone Middleware ───
app.use(timezoneMiddleware);

// ─── Request Logging ───
if (env.isDev) {
  app.use(morgan('dev'));
}

// ─── Health Check ───
app.get('/api/health', (_req, res) => {
  sendSuccess(res, {
    status: 'ok',
    timestamp: new Date().toISOString(),
    environment: env.NODE_ENV,
  });
});

// Liveness (unchanged): process is up.
// Readiness: database answers within 2s. Responds WITHOUT the error text.
app.get('/api/health/ready', async (_req, res) => {
  const db = await checkDatabaseReady(() => prisma.$queryRaw`SELECT 1`);
  if (!db.ok) {
    logger.warn('readiness: database check failed', { error: db.error });
  }
  res.status(db.ok ? 200 : 503).json({
    success: db.ok,
    data: { status: db.ok ? 'ready' : 'degraded', database: { ok: db.ok, latencyMs: db.latencyMs } },
  });
});

// ─── API Routes ───
app.use('/api/auth', authRoutes);
app.use('/api/tasks', taskRoutes);
app.use('/api/tasks', notesRoutes); // Notes nested under /api/tasks/:id/notes
app.use('/api/assignments', assignmentRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/debug', debugRoutes);
app.use('/api/plans', planRoutes);
app.use('/api/progress', progressRoutes);
app.use('/api/classes', classesRoutes);
app.use('/api/potd', potdRoutes);
app.use('/api/todo', todoRoutes);
app.use('/api/daily-challenges', dailyChallengesRoutes);

// ─── Scheduled Maintenance Cron Route ───
app.get('/api/cron/daily', requireCronSecret(), async (_req, res, next) => {
  try {
    await runDailyMaintenance();
    sendSuccess(res, { ok: true, ranAt: new Date().toISOString() });
  } catch (err) {
    next(err);
  }
});

// ─── Production Static Hosting & SPA Fallback ───
const frontendDistPath = path.resolve(__dirname, '../../frontend/dist');

if (fs.existsSync(frontendDistPath)) {
  app.use(express.static(frontendDistPath));

  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) {
      return next();
    }
    res.sendFile(path.join(frontendDistPath, 'index.html'));
  });
}

// ─── 404 Handler for API routes ───
app.use((_req, res) => {
  res.status(404).json({
    success: false,
    error: 'Route not found',
  });
});

// ─── Global Error Handler ───
app.use(errorMiddleware);

export default app;
