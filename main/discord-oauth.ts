import http from 'http';
import { randomBytes } from 'crypto';
import { BrowserWindow } from 'electron';
import { DEFAULT_SYNC_URL } from './syncclient';

/**
 * Discord sign-in for RAAFv access. The server (VPS API) holds the client
 * secret and does the code exchange + role check; the desktop only opens the
 * consent screen and catches the loopback redirect.
 */

/** REST base derived from the sync URL (ws://host:3100/ws -> http://host:3100). */
function apiBase(): string {
  try {
    const u = new URL(DEFAULT_SYNC_URL);
    const proto = u.protocol === 'wss:' ? 'https:' : 'http:';
    return `${proto}//${u.host}`;
  } catch {
    return 'http://139.99.195.169:3100';
  }
}

const LOOPBACK_PORT = 8737; // must match the Discord app's registered redirect URI

export type DiscordLinkResult = {
  ok: boolean;
  error?: string;
  raafv?: boolean;
  roleReason?: string;
  user?: { id: string; username: string; avatar: string | null };
};

async function getConfig(): Promise<{
  configured: boolean;
  clientId: string;
  redirectUri: string;
  scope: string;
} | null> {
  try {
    const r = await fetch(`${apiBase()}/auth/discord/config`);
    if (!r.ok) return null;
    return (await r.json()) as { configured: boolean; clientId: string; redirectUri: string; scope: string };
  } catch {
    return null;
  }
}

export async function isConfigured(): Promise<boolean> {
  return (await getConfig())?.configured ?? false;
}

/** Run the full flow. Resolves with the link result (raafv true/false). */
export async function linkDiscord(): Promise<DiscordLinkResult> {
  const cfg = await getConfig();
  if (!cfg?.configured) return { ok: false, error: 'Discord sign-in is not set up on the server yet.' };

  const state = randomBytes(16).toString('hex');
  const redirectUri = cfg.redirectUri || `http://127.0.0.1:${LOOPBACK_PORT}/callback`;

  return new Promise<DiscordLinkResult>((resolve) => {
    let done = false;
    const finish = (r: DiscordLinkResult) => {
      if (done) return;
      done = true;
      try {
        server.close();
      } catch {
        /* ignore */
      }
      if (authWin && !authWin.isDestroyed()) authWin.close();
      resolve(r);
    };

    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${LOOPBACK_PORT}`);
      if (url.pathname !== '/callback') {
        res.writeHead(404).end();
        return;
      }
      const code = url.searchParams.get('code');
      const gotState = url.searchParams.get('state');
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html><body style="font:14px system-ui;padding:2rem">Discord sign-in complete — you can close this window.</body></html>');
      if (!code || gotState !== state) {
        finish({ ok: false, error: 'Discord sign-in was cancelled.' });
        return;
      }
      try {
        const ex = await fetch(`${apiBase()}/auth/discord/exchange`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ code, redirectUri }),
        });
        const data = (await ex.json()) as DiscordLinkResult;
        finish(ex.ok ? data : { ok: false, error: data.error ?? 'Sign-in failed.' });
      } catch (err) {
        finish({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    });

    server.on('error', (err) => finish({ ok: false, error: `Could not open the loopback listener: ${err.message}` }));
    server.listen(LOOPBACK_PORT, '127.0.0.1');

    const authUrl =
      'https://discord.com/oauth2/authorize?' +
      new URLSearchParams({
        client_id: cfg.clientId,
        response_type: 'code',
        redirect_uri: redirectUri,
        scope: cfg.scope,
        state,
        prompt: 'consent',
      });

    const authWin = new BrowserWindow({
      width: 520,
      height: 760,
      title: 'Sign in with Discord',
      autoHideMenuBar: true,
      webPreferences: { nodeIntegration: false, contextIsolation: true },
    });
    authWin.on('closed', () => finish({ ok: false, error: 'Discord sign-in window closed.' }));
    void authWin.loadURL(authUrl);
    setTimeout(() => finish({ ok: false, error: 'Discord sign-in timed out.' }), 180_000);
  });
}
