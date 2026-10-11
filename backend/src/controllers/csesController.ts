import type { NextFunction, Request, Response } from 'express';
import { getAuthUser } from '../middleware/authMiddleware';
import { getTz } from '../middleware/timezoneMiddleware';
import { sendSuccess } from '../utils/response';
import * as cses from '../services/cses/csesService';

export const csesController = {
  async overview(req: Request, res: Response, next: NextFunction) {
    try {
      const user = getAuthUser(req);
      sendSuccess(res, await cses.getCsesOverview(user.id, getTz(req)));
    } catch (err) { next(err); }
  },
  async setEnabled(req: Request, res: Response, next: NextFunction) {
    try {
      const user = getAuthUser(req);
      sendSuccess(res, await cses.setCsesEnabled(user.id, req.body?.enabled, getTz(req)));
    } catch (err) { next(err); }
  },
  async selectTopic(req: Request, res: Response, next: NextFunction) {
    try {
      const user = getAuthUser(req);
      sendSuccess(res, await cses.selectCsesTopic(user.id, req.body?.topicId, getTz(req)));
    } catch (err) { next(err); }
  },
  async restart(req: Request, res: Response, next: NextFunction) {
    try {
      const user = getAuthUser(req);
      sendSuccess(res, await cses.restartCsesTopic(user.id, req.params.topicId, getTz(req)));
    } catch (err) { next(err); }
  },
  async skip(req: Request, res: Response, next: NextFunction) {
    try {
      const user = getAuthUser(req);
      sendSuccess(res, await cses.skipCsesProblem(user.id, req.params.taskId as string, getTz(req)));
    } catch (err) { next(err); }
  },
  async retry(req: Request, res: Response, next: NextFunction) {
    try {
      const user = getAuthUser(req);
      sendSuccess(res, await cses.retryCsesProblem(user.id, req.params.taskId as string, getTz(req)));
    } catch (err) { next(err); }
  },
  async acknowledgeReturn(req: Request, res: Response, next: NextFunction) {
    try {
      const user = getAuthUser(req);
      sendSuccess(res, await cses.acknowledgeCsesReturn(user.id, getTz(req)));
    } catch (err) { next(err); }
  },
};
