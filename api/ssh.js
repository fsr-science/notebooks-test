// api/ssh.js — SSH auth server proxy
// Requires: @vercel/kv in package.json + KV store provisioned in Vercel dashboard

import { kv } from '@vercel/kv';

// ── Rate limiting ─────────────────────────────────────────────────────────────
// Max 5 login attempts per IP per 15-minute window.
// Max 3 registrations per IP per hour.

async function checkRateLimit(ip, type) {
  if (!ip) return true; // can't determine IP, allow through
  const key = `ratelimit:${type}:${ip}`;
  const limits = { login: { max: 5, windowSec: 900 }, register: { max: 3, windowSec: 3600 } };
  const { max, windowSec } = limits[type] || { max: 10, windowSec: 60 };

  try {
    const count = await kv.incr(key);
    if (count === 1) await kv.expire(key, windowSec);
    if (count > max) {
      const ttl = await kv.ttl(key);
      return { blocked: true, retryAfter: ttl };
    }
    return { blocked: false, remaining: max - count };
  } catch (e) {
    return { blocked: false }; // KV failure → fail open
  }
}

function getIP(req) {
  return (
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.headers['x-real-ip'] ||
    req.socket?.remoteAddress ||
    null
  );
}

// ── Admin auth check ──────────────────────────────────────────────────────────
async function requireAdmin(req, res) {
  const fingerprint = req.headers['x-ssh-fingerprint'];
  if (!fingerprint) {
    res.status(401).json({ error: 'Missing X-SSH-Fingerprint header' });
    return false;
  }
  const adminId = await kv.get(`ssh:fp:admin:${fingerprint}`);
  if (!adminId) {
    res.status(403).json({ error: 'Not an admin' });
    return false;
  }
  return true;
}

// ── Main handler ──────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const ip = getIP(req);
  const body = req.body || {};
  const { action, username, publicKey, publicKeyHash, fingerprint,
          role, permissions, userId, limit } = body;

  try {

    // ── checkUsername ─────────────────────────────────────────────────────────
    if (action === 'checkUsername') {
      if (!username) return res.status(400).json({ error: 'Missing username' });
      const existing = await kv.get(`ssh:user:${username.toLowerCase()}`);
      return res.json({ taken: !!existing });
    }

    // ── register ──────────────────────────────────────────────────────────────
    if (action === 'register') {
      if (!username || !publicKey || !publicKeyHash || !fingerprint) {
        return res.status(400).json({ error: 'Missing required fields' });
      }

      // Rate limit registrations per IP
      const rl = await checkRateLimit(ip, 'register');
      if (rl.blocked) {
        return res.status(429).json({
          error: `Too many registrations. Try again in ${Math.ceil(rl.retryAfter / 60)} minutes.`
        });
      }

      const usernameKey = username.toLowerCase();

      // Uniqueness guard
      const existing = await kv.get(`ssh:user:${usernameKey}`);
      if (existing) return res.status(409).json({ error: 'Username already registered' });

      // Also check if this public key hash is already registered (prevent duplicate keys)
      const existingKeyUser = await kv.get(`ssh:keyhash:${publicKeyHash}`);
      if (existingKeyUser) return res.status(409).json({ error: 'Key already registered' });

      const allowedRoles = ['user', 'member', 'admin'];
      const assignedRole = allowedRoles.includes(role) ? role : 'member';

      const user = {
        id: crypto.randomUUID(),
        username,
        publicKey,
        publicKeyHash,
        fingerprint,
        role: assignedRole,
        permissions: assignedRole === 'admin'
          ? (permissions || ['create', 'delete', 'modify', 'approve'])
          : ['upload'],  // members can only upload
        createdAt: Date.now(),
        registeredIP: ip
      };

      await kv.set(`ssh:user:${usernameKey}`, user);
      await kv.set(`ssh:keyhash:${publicKeyHash}`, usernameKey);

      if (user.role === 'admin' || user.role === 'superadmin') {
        await kv.set(`ssh:fp:admin:${fingerprint}`, user.id);
      }

      // Log registration
      await appendLog({
        event: 'register',
        username: user.username,
        role: user.role,
        fingerprint: user.fingerprint,
        ip
      });

      return res.json({ ok: true, id: user.id, role: user.role });
    }

    // ── lookup (called during login) ──────────────────────────────────────────
    if (action === 'lookup') {
      if (!publicKeyHash) return res.status(400).json({ error: 'Missing publicKeyHash' });

      // Rate limit login attempts per IP
      const rl = await checkRateLimit(ip, 'login');
      if (rl.blocked) {
        return res.status(429).json({
          error: `Too many login attempts. Try again in ${Math.ceil(rl.retryAfter / 60)} minutes.`
        });
      }

      const usernameKey = await kv.get(`ssh:keyhash:${publicKeyHash}`);
      if (!usernameKey) return res.status(404).json({ error: 'Key not found' });

      const user = await kv.get(`ssh:user:${usernameKey}`);
      if (!user) return res.status(404).json({ error: 'User not found' });

      return res.json({ ok: true, user });
    }

    // ── logEvent ──────────────────────────────────────────────────────────────
    if (action === 'logEvent') {
      const { eventAction, username: evtUser, ...rest } = body;
      await appendLog({
        event: eventAction || 'unknown',
        username: evtUser || 'anonymous',
        ip,
        ...rest,
        action: undefined  // don't store the routing field
      });
      return res.json({ ok: true });
    }

    // ── Admin-only routes ─────────────────────────────────────────────────────
    const isAdmin = await requireAdmin(req, res);
    if (!isAdmin) return;

    // ── listUsers / listAdmins ────────────────────────────────────────────────
    if (action === 'listUsers' || action === 'listAdmins') {
      const targetRole = action === 'listAdmins' ? 'admin' : 'member';
      const keys = await kv.keys('ssh:user:*');
      const allUsers = await Promise.all(keys.map(k => kv.get(k)));
      const filtered = allUsers
        .filter(u => u && (action === 'listUsers' ? u.role !== 'admin' : u.role === 'admin'))
        .map(u => ({
          id: u.id, username: u.username, fingerprint: u.fingerprint,
          role: u.role, permissions: u.permissions,
          createdAt: u.createdAt, registeredIP: u.registeredIP
        }));
      return res.json({ [action === 'listAdmins' ? 'admins' : 'users']: filtered });
    }

    // ── promoteUser (admin can promote a member to admin) ─────────────────────
    if (action === 'promoteUser') {
      if (!userId) return res.status(400).json({ error: 'Missing userId' });
      const keys = await kv.keys('ssh:user:*');
      for (const k of keys) {
        const u = await kv.get(k);
        if (u && u.id === userId) {
          u.role = 'admin';
          u.permissions = ['create', 'delete', 'modify', 'approve'];
          await kv.set(k, u);
          await kv.set(`ssh:fp:admin:${u.fingerprint}`, u.id);
          return res.json({ ok: true });
        }
      }
      return res.status(404).json({ error: 'User not found' });
    }

    // ── revoke ────────────────────────────────────────────────────────────────
    if (action === 'revoke') {
      if (!userId) return res.status(400).json({ error: 'Missing userId' });
      const keys = await kv.keys('ssh:user:*');
      for (const k of keys) {
        const u = await kv.get(k);
        if (u && u.id === userId) {
          await kv.del(k);
          await kv.del(`ssh:keyhash:${u.publicKeyHash}`);
          if (u.role === 'admin') await kv.del(`ssh:fp:admin:${u.fingerprint}`);
          await appendLog({ event: 'revoke', targetUsername: u.username, ip });
          return res.json({ ok: true });
        }
      }
      return res.status(404).json({ error: 'User not found' });
    }

    // ── rotateKey ─────────────────────────────────────────────────────────────
    if (action === 'rotateKey') {
      if (!userId || !publicKey || !publicKeyHash || !fingerprint) {
        return res.status(400).json({ error: 'Missing required fields' });
      }
      const keys = await kv.keys('ssh:user:*');
      for (const k of keys) {
        const u = await kv.get(k);
        if (u && u.id === userId) {
          await kv.del(`ssh:keyhash:${u.publicKeyHash}`);
          if (u.role === 'admin') await kv.del(`ssh:fp:admin:${u.fingerprint}`);
          u.publicKey = publicKey;
          u.publicKeyHash = publicKeyHash;
          u.fingerprint = fingerprint;
          u.rotatedAt = Date.now();
          await kv.set(k, u);
          await kv.set(`ssh:keyhash:${publicKeyHash}`, k.replace('ssh:user:', ''));
          if (u.role === 'admin') await kv.set(`ssh:fp:admin:${fingerprint}`, u.id);
          return res.json({ ok: true, username: u.username });
        }
      }
      return res.status(404).json({ error: 'User not found' });
    }

    // ── getLogs ───────────────────────────────────────────────────────────────
    if (action === 'getLogs') {
      const logs = (await kv.get('ssh:logs')) || [];
      const n = Math.min(Number(limit) || 50, 500);
      return res.json({ logs: logs.slice(-n).reverse() });
    }

    // ── clearLogs ─────────────────────────────────────────────────────────────
    if (action === 'clearLogs') {
      await kv.set('ssh:logs', []);
      return res.json({ ok: true });
    }

    return res.status(400).json({ error: `Unknown action: ${action}` });

  } catch (err) {
    console.error('[api/ssh]', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
}

// ── Log helper ────────────────────────────────────────────────────────────────
async function appendLog(entry) {
  try {
    const MAX_LOGS = 500;
    const logs = (await kv.get('ssh:logs')) || [];
    logs.push({ timestamp: Date.now(), ...entry });
    if (logs.length > MAX_LOGS) logs.splice(0, logs.length - MAX_LOGS);
    await kv.set('ssh:logs', logs);
  } catch (e) {
    console.error('[api/ssh] appendLog failed:', e);
  }
}