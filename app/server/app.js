import crypto from 'crypto';
import cors from 'cors';
import express from 'express';
import { createLanAccessPolicy } from './access-policy.js';
import { PWA_DIR } from './config.js';
import { createApiRouter } from './routes/api.js';
import { createFilesRouter } from './routes/files.js';

const createServerApp = ({
  getAutoCopySetting,
  getServerStatus,
  isLoopbackRequest,
  onShutdown,
  onUploadCompleted,
  setAutoCopySetting,
  shutdownToken = crypto.randomBytes(32).toString('hex'),
}) => {
  const app = express();
  const loopbackCors = cors({
    origin: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
  });

  app.use(createLanAccessPolicy({ isLoopbackRequest }));
  app.use((req, res, next) => {
    if (!isLoopbackRequest(req)) {
      next();
      return;
    }
    loopbackCors(req, res, next);
  });

  app.use('/api', express.json({ limit: '32kb' }), createApiRouter({
    getAutoCopySetting,
    getServerStatus,
    isLoopbackRequest,
    onShutdown,
    onUploadCompleted,
    setAutoCopySetting,
    shutdownToken,
  }));
  app.use('/files', createFilesRouter());
  app.use('/', express.static(PWA_DIR));

  app.use((err, _req, res, _next) => {
    console.error(err);
    res.status(500).json({ error: 'Internal server error.' });
  });

  return app;
};

export { createServerApp };
