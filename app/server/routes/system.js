import crypto from 'crypto';
import { Router } from 'express';
import { uploadLifecycle } from '../upload-lifecycle.js';
import { SERVER_APPLICATION, SERVER_CONTROL_ID, SERVER_PROTOCOL_VERSION } from '../identity.js';

const createSystemRouter = ({
  getAutoCopySetting = null,
  getServerStatus,
  isLoopbackRequest = () => false,
  onShutdown = () => {},
  setAutoCopySetting = null,
  shutdownToken = '',
  drainLifecycle = uploadLifecycle,
}) => {
  const router = Router();
  router.get('/server-control', (req, res) => {
    if (!isLoopbackRequest(req)) { res.sendStatus(404); return; }
    res.json({
      service: SERVER_CONTROL_ID,
      application: SERVER_APPLICATION,
      protocolVersion: SERVER_PROTOCOL_VERSION,
      shutdownToken,
      server: getServerStatus(),
    });
  });
  const authorizeShutdown = (req, res, next) => {
    const suppliedToken = req.get('x-snapoverlan-shutdown-token') || '';
    const suppliedTokenBuffer = Buffer.from(suppliedToken);
    const shutdownTokenBuffer = Buffer.from(shutdownToken);
    const validToken = suppliedTokenBuffer.length === shutdownTokenBuffer.length
      && crypto.timingSafeEqual(suppliedTokenBuffer, shutdownTokenBuffer);
    if (!isLoopbackRequest(req) || !validToken) { res.sendStatus(404); return; }
    next();
  };
  // One authenticated control stream carries state changes; no status polling.
  router.get('/server-shutdown', authorizeShutdown, (req, res) => {
    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Cache-Control', 'no-store');
    const sendState = (state) => res.write(`${JSON.stringify(state)}\n`);
    const unsubscribe = drainLifecycle.subscribeDrain(sendState);
    res.once('close', unsubscribe);
    sendState(drainLifecycle.getDrainState());
  });
  router.post('/server-shutdown', authorizeShutdown, (req, res) => {
    const accepted = onShutdown('localhost-control', { onlyIfIdle: req.body?.onlyIfIdle === true });
    if (accepted === false) {
      res.status(409).json({ error: 'upload-active' });
      return;
    }
    res.status(202).json({ stopping: true });
  });
  router.get('/auto-copy', async (req, res) => {
    if (!isLoopbackRequest(req)) { res.sendStatus(404); return; }
    if (typeof getAutoCopySetting !== 'function') {
      res.status(503).json({ error: 'Auto-copy control is unavailable.' });
      return;
    }
    try { res.json({ enabled: Boolean(await getAutoCopySetting()) }); }
    catch (err) { res.status(503).json({ error: err.message || 'Auto-copy control is unavailable.' }); }
  });
  router.put('/auto-copy', async (req, res) => {
    if (!isLoopbackRequest(req)) { res.sendStatus(404); return; }
    if (typeof req.body?.enabled !== 'boolean') {
      res.status(400).json({ error: 'Expected { enabled: boolean }.' });
      return;
    }
    if (typeof setAutoCopySetting !== 'function') {
      res.status(503).json({ error: 'Auto-copy control is unavailable.' });
      return;
    }
    try { res.json({ enabled: Boolean(await setAutoCopySetting(req.body.enabled)) }); }
    catch (err) { res.status(503).json({ error: err.message || 'Auto-copy control is unavailable.' }); }
  });
  router.get('/server-status', (_req, res) => res.json(getServerStatus()));
  return router;
};

export { createSystemRouter };
