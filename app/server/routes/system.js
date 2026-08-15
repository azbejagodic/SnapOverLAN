import crypto from 'crypto';
import { Router } from 'express';
import { PORT } from '../config.js';
import { SERVER_APPLICATION, SERVER_CONTROL_ID, SERVER_PROTOCOL_VERSION } from '../identity.js';
import { getPhoneUrlRecords } from '../lan.js';

const createSystemRouter = ({
  getAutoCopySetting = null,
  getServerStatus,
  isLoopbackRequest = () => false,
  onShutdown = () => {},
  setAutoCopySetting = null,
  shutdownToken = '',
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
  router.post('/server-shutdown', (req, res) => {
    const suppliedToken = req.get('x-snapoverlan-shutdown-token') || '';
    const suppliedTokenBuffer = Buffer.from(suppliedToken);
    const shutdownTokenBuffer = Buffer.from(shutdownToken);
    const validToken = suppliedTokenBuffer.length === shutdownTokenBuffer.length
      && crypto.timingSafeEqual(suppliedTokenBuffer, shutdownTokenBuffer);
    if (!isLoopbackRequest(req) || !validToken) { res.sendStatus(404); return; }
    res.status(202).json({ stopping: true });
    setImmediate(() => onShutdown('localhost-control'));
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
  router.get('/phone-url', (req, res) => {
    const lanUrls = getPhoneUrlRecords();
    const requestHost = req.get('host') || `localhost:${PORT}`;
    const fallbackUrl = `http://${requestHost}`;
    const urls = lanUrls.length > 0
      ? lanUrls
      : [{ address: requestHost.split(':')[0], private: false, url: fallbackUrl }];
    res.json({ port: PORT, primaryUrl: urls[0].url, urls });
  });
  router.get('/server-status', (_req, res) => res.json(getServerStatus()));
  return router;
};

export { createSystemRouter };
