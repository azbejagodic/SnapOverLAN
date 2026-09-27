import http from 'http';
import net from 'net';
import { classifyServerStatus, SERVER_CONTROL_ID } from '../server/identity.js';

const createServerClient = ({ port, requestTimeoutMs = 1500 }) => {
  const statusUrl = `http://127.0.0.1:${port}/api/server-status`;
  const controlUrl = `http://127.0.0.1:${port}/api/server-control`;
  const shutdownUrl = `http://127.0.0.1:${port}/api/server-shutdown`;

  const getJson = (url) => new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 400) {
          reject(new Error(`Request failed (${res.statusCode}) for ${url}`));
          return;
        }
        try { resolve(JSON.parse(body)); } catch (err) { reject(err); }
      });
    });
    req.on('error', reject);
    req.setTimeout(requestTimeoutMs, () => req.destroy(new Error(`Timed out requesting ${url}`)));
  });

  const postServerShutdown = (token, decision) => new Promise((resolve, reject) => {
    const req = http.request(shutdownUrl, {
      method: 'POST',
      headers: { 'x-snapoverlan-shutdown-token': token, 'Content-Type': 'application/json' },
    }, (res) => {
      res.resume();
      if (res.statusCode !== 202) {
        reject(new Error(`Shutdown request failed (${res.statusCode})`));
        return;
      }
      resolve();
    });
    req.on('error', reject);
    req.setTimeout(requestTimeoutMs, () => req.destroy(new Error('Timed out requesting server shutdown')));
    req.end(decision ? JSON.stringify(decision) : undefined);
  });

  const watchServerShutdown = (token, observer) => new Promise((resolve, reject) => {
    let opened = false;
    let disposed = false;
    const req = http.get(shutdownUrl, {
      headers: { 'x-snapoverlan-shutdown-token': token },
    }, (res) => {
      clearTimeout(timer);
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`Shutdown control stream failed (${res.statusCode})`));
        return;
      }
      opened = true;
      let pending = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        pending += chunk;
        let newline;
        while ((newline = pending.indexOf('\n')) !== -1) {
          const line = pending.slice(0, newline);
          pending = pending.slice(newline + 1);
          try { observer.state(JSON.parse(line)); }
          catch (error) { observer.error(error); }
        }
      });
      res.on('error', (error) => { if (!disposed) observer.error(error); });
      res.on('end', () => { if (!disposed) observer.closed(); });
      resolve(() => { disposed = true; req.destroy(); });
    });
    const timer = setTimeout(() => req.destroy(new Error('Timed out opening shutdown control stream')), requestTimeoutMs);
    req.on('error', (error) => {
      clearTimeout(timer);
      if (!opened) reject(error);
      else if (!disposed) observer.error(error);
    });
  });

  const getServerIdentity = async () => {
    try {
      const control = await getJson(controlUrl);
      const kind = classifyServerStatus(control?.server);
      if (control?.service !== SERVER_CONTROL_ID
        || typeof control.shutdownToken !== 'string'
        || !/^[a-f0-9]{64}$/.test(control.shutdownToken)
        || kind === 'unrelated') {
        throw new Error('Invalid SnapOverLAN control response');
      }
      return { kind, server: control.server, shutdownToken: control.shutdownToken };
    } catch {
      try {
        const status = await getJson(statusUrl);
        const kind = classifyServerStatus(status);
        if (kind === 'unrelated') return null;
        return { kind, server: status, shutdownToken: '' };
      } catch {
        return null;
      }
    }
  };

  const isPortInUse = () => new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const finish = (inUse) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(inUse);
    };
    socket.setTimeout(500);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });

  const waitForPortRelease = async (timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!(await isPortInUse())) return true;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return !(await isPortInUse());
  };

  return { getServerIdentity, isPortInUse, postServerShutdown, waitForPortRelease, watchServerShutdown };
};

export { createServerClient };
