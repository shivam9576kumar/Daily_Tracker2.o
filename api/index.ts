import type { IncomingMessage, ServerResponse } from 'http';
import app from '../backend/src/app';

export default function handler(req: IncomingMessage, res: ServerResponse) {
  return app(req, res);
}
