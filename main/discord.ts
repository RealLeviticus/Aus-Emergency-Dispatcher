import { Client } from '@xhayper/discord-rpc';

export const DEFAULT_DISCORD_APP_ID = '1546378216162336778';

export type DiscordContext = {
  connected: boolean;
  callsign: string;
  aircraft: string;
  phase: string;
  jobId: string;
  jobKind: string;
  jobPlace?: string;
  agency?: string;
  /** true = helicopter, false = fixed wing, undefined = unknown */
  rotary?: boolean;
  operator?: string;
};

const PHASE_TEXT: Record<string, string> = {
  enroute: 'En route to scene',
  onscene: 'On scene',
  transport: 'Transporting patient',
  athospital: 'At hospital — handover',
  returning: 'Returning to base',
  idle: 'On watch',
};

/**
 * Discord Rich Presence — shows the pilot's callsign, aircraft, and (roughly)
 * the job they're on. The Application client id is hard-coded
 * (DEFAULT_DISCORD_APP_ID); if Discord isn't running this quietly does nothing.
 * Upload a 512px art asset named `aed` in the Discord app's Rich Presence
 * assets for the large icon.
 */
class DiscordPresence {
  private client: Client | null = null;
  private appId = '';
  private ready = false;
  private since = Date.now();
  private lastKey = '';
  private pending: DiscordContext | null = null;

  setAppId(id: string): void {
    const next = (id || '').trim() || DEFAULT_DISCORD_APP_ID;
    if (next === this.appId) return;
    this.appId = next;
    this.restart();
  }

  start(appId?: string): void {
    this.appId = (appId?.trim() || DEFAULT_DISCORD_APP_ID).trim();
    this.restart();
  }

  stop(): void {
    this.ready = false;
    try {
      void this.client?.destroy();
    } catch {
      /* ignore */
    }
    this.client = null;
  }

  update(ctx: DiscordContext): void {
    this.pending = ctx;
    if (this.ready) this.push(ctx);
  }

  private restart(): void {
    this.stop();
    if (!this.appId) return;
    try {
      const client = new Client({ clientId: this.appId });
      this.client = client;
      client.on('ready', () => {
        this.ready = true;
        if (this.pending) this.push(this.pending);
      });
      client.login().catch(() => {
        this.ready = false;
      });
    } catch {
      this.client = null;
    }
  }

  private push(ctx: DiscordContext): void {
    if (!this.client || !this.ready) return;
    const onJob = Boolean(ctx.jobKind);
    const phaseLabel = PHASE_TEXT[ctx.phase] ?? (ctx.connected ? 'On watch' : 'Standing by');

    const details = onJob ? `${ctx.jobKind} · ${phaseLabel}` : ctx.connected ? 'On watch' : 'Standing by';
    const unit = ctx.callsign || ctx.operator || 'Unit';
    const state = ctx.aircraft ? `${unit} · ${ctx.aircraft}` : unit;
    const largeText = onJob
      ? [ctx.agency, ctx.jobPlace].filter(Boolean).join(' — ') || 'Aus Emergency Dispatcher'
      : 'Aus Emergency Dispatcher';
    const smallKey = ctx.rotary === true ? 'rotary' : ctx.rotary === false ? 'fixed' : undefined;
    const smallText = ctx.rotary === true ? 'Rotary wing' : ctx.rotary === false ? 'Fixed wing' : undefined;

    const key = `${details}|${state}|${largeText}|${smallKey ?? ''}`;
    if (key === this.lastKey) return;
    this.lastKey = key;
    // Reset the elapsed timer at the start of a job / when idle.
    if (!onJob || ctx.phase === 'enroute') this.since = Date.now();

    try {
      void this.client.user?.setActivity({
        details,
        state,
        startTimestamp: this.since,
        largeImageKey: 'aed',
        largeImageText: largeText,
        smallImageKey: smallKey,
        smallImageText: smallText,
        instance: false,
      });
    } catch {
      /* ignore */
    }
  }
}

export const discord = new DiscordPresence();
