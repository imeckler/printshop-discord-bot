// A deliberately small Discord bot. It does exactly three things:
//
//   1. Posts a text announcement in one configured channel.
//   2. Reports who reacted with the claim emoji (👍 by default) to an
//      announcement, so the application using it can record the "claim".
//   3. Posts follow-ups about an announcement ("claimed by …").
//
// It never reads message content (the MESSAGE_CONTENT intent is not
// requested), never reacts to anything, never fetches messages, never DMs
// anyone, never mentions anyone, and only ever writes to the configured
// channel. Everything the application does with a claim (matching the
// Discord user to an account, deciding whether it counts) happens outside
// this package, through the `onClaim` callback.
//
// Gateway intents used: GUILDS (to see which channels exist) and
// GUILD_MESSAGE_REACTIONS (to receive reactions). Neither is privileged.
//
// Permissions: the goal is the smallest set that works, so the server's
// admins have as little as possible to trust. Two things that would have
// been nice were dropped for that reason: reacting 👍 to our own
// announcement (a one-click claim button; needs ADD_REACTIONS and
// READ_MESSAGE_HISTORY) and fetching a message to check it was ours
// (needs READ_MESSAGE_HISTORY; the application matches refs against its
// own records instead). The one remaining trade-off is FOLLOW_UP_MODE
// below.

import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  OAuth2Scopes,
  Partials,
  PermissionFlagsBits,
  type MessageReaction,
  type PartialMessageReaction,
  type PartialUser,
  type SendableChannels,
  type User,
} from 'discord.js';

export interface BotOptions {
  // Bot token from the Discord developer portal (Bot > Token).
  token: string;
  // Channel announcements are posted in, and the only channel whose
  // reactions are looked at. Optional so the bot can be started before the
  // channel is chosen: `status()` lists the channels it can see.
  channelId?: string;
  // Reaction that counts as a claim. Skin-tone variants of it also count.
  claimEmoji?: string;
  log?: Pick<Console, 'log' | 'warn' | 'error'>;
}

// A member reacted with the claim emoji to one of the bot's announcements.
export interface Claim {
  // The announcement, as returned by `announce()`.
  ref: string;
  // Discord user id (a snowflake, stable for the life of the account).
  userId: string;
  // Display name at the time of the reaction; for humans, not for matching.
  username: string;
}

export type ClaimHandler = (claim: Claim) => void | Promise<void>;

export type BotState = 'stopped' | 'starting' | 'ready' | 'disconnected' | 'error';

export interface ChannelInfo {
  id: string;
  name: string; // "#channel (Server name)"
}

export interface BotStatus {
  state: BotState;
  detail?: string;
  // The bot's own account, once logged in.
  botUser?: { id: string; tag: string };
  // The configured channel, if the bot can see and post in it.
  channel?: ChannelInfo;
  // Channels the bot could post in, across every server it has been added to.
  channels: ChannelInfo[];
}

// How follow-ups ("claimed by …", "completed") are posted. Chosen at
// compile time; change it here and rebuild.
//
//   'reply':   posted as a Discord reply quoting the announcement, so the
//              follow-up sits visibly under the request it belongs to.
//              Discord requires READ_MESSAGE_HISTORY to create a message
//              that references another one, so this mode needs one more
//              permission.
//   'message': posted as an ordinary message in the same channel. The
//              application must say which request the follow-up is about
//              in the text itself. Needs only VIEW_CHANNEL + SEND_MESSAGES.
//
// We wanted the minimal set and would have preferred 'message' on that
// ground alone; 'reply' is kept as an option because a follow-up that
// visibly hangs off its announcement is the one convenience that seemed
// worth a permission. Pick whichever the server's admins are comfortable
// with; the invite link (BOT_PERMISSIONS / inviteUrl) follows the choice.
export type FollowUpMode = 'reply' | 'message';
// (`as`, not a type annotation: a const initialised with a literal is narrowed
// to that literal, and the other branch of each check would then be an error.)
export const FOLLOW_UP_MODE = 'message' as FollowUpMode;

// Everything the bot needs for the selected mode, and nothing more.
export const BOT_PERMISSIONS: readonly bigint[] = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  ...(FOLLOW_UP_MODE === 'reply' ? [PermissionFlagsBits.ReadMessageHistory] : []),
];

// Link a server admin opens to add the bot (`clientId` is the application's
// id from the developer portal). The permissions asked for are exactly
// BOT_PERMISSIONS.
export function inviteUrl(clientId: string): string {
  const permissions = BOT_PERMISSIONS.reduce((acc, p) => acc | p, 0n);
  const params = new URLSearchParams({
    client_id: clientId,
    scope: OAuth2Scopes.Bot,
    permissions: permissions.toString(),
  });
  return `https://discord.com/oauth2/authorize?${params}`;
}

const DEFAULT_CLAIM_EMOJI = '👍';

// Announcement refs are "<channel id>/<message id>": enough to reply to the
// message later without any other state.
const parseRef = (ref: string): { channelId: string; messageId: string } | null => {
  const m = /^(\d+)\/(\d+)$/.exec(ref);
  return m ? { channelId: m[1], messageId: m[2] } : null;
};

// After Discord invalidates a session, discord.js gives up for good on that
// Client; the only way back is a brand-new one. Re-login attempts back off
// from RELOGIN_MIN_MS, doubling up to RELOGIN_MAX_MS, so a token that has
// really been revoked never hammers Discord (a new IDENTIFY is rationed to
// 1000 per day) while an operational hiccup heals within minutes.
const RELOGIN_MIN_MS = 30_000;
const RELOGIN_MAX_MS = 10 * 60_000;

export class PrintRequestBot {
  // Null until start(), and between a session being invalidated and the
  // replacement client logging in.
  private client: Client | null = null;
  private readonly claimEmoji: string;
  private readonly log: Pick<Console, 'log' | 'warn' | 'error'>;
  private readonly handlers: ClaimHandler[] = [];
  private state: BotState = 'stopped';
  private detail: string | undefined;
  private stopped = true;
  private reloginTimer: ReturnType<typeof setTimeout> | null = null;
  private reloginAttempt = 0;

  constructor(private readonly options: BotOptions) {
    this.claimEmoji = options.claimEmoji ?? DEFAULT_CLAIM_EMOJI;
    this.log = options.log ?? console;
  }

  private createClient(): Client {
    const c = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessageReactions],
      // Reactions to messages posted before this process started arrive
      // with the message not in the cache; partials let us still see them
      // (we never fetch the message, its id is enough).
      partials: [Partials.Message, Partials.Reaction, Partials.User],
    });
    this.wire(c);
    return c;
  }

  private wire(c: Client) {
    c.once(Events.ClientReady, ready => {
      this.state = 'ready';
      this.detail = undefined;
      this.reloginAttempt = 0;
      this.log.log(`discord bot: logged in as ${ready.user.tag}`);
    });
    c.on(Events.ShardReady, () => {
      this.state = 'ready';
      this.detail = undefined;
    });
    c.on(Events.ShardResume, () => {
      this.state = 'ready';
      this.detail = undefined;
    });
    c.on(Events.ShardReconnecting, () => {
      this.state = 'starting';
      this.detail = 'Reconnecting…';
    });
    c.on(Events.ShardDisconnect, event => {
      this.state = 'disconnected';
      this.detail = `Disconnected from Discord (code ${event.code})`;
      this.log.warn('discord bot: disconnected', event.code);
    });
    c.on(Events.Invalidated, () => {
      // Terminal for this Client: discord.js will not reconnect it. Start
      // over with a fresh one (see RELOGIN_MIN_MS).
      this.state = 'error';
      this.detail = 'Discord session invalidated; logging in again with a fresh session…';
      this.log.error('discord bot: session invalidated; will log in again');
      this.scheduleRelogin();
    });
    c.on(Events.Error, err => this.log.error('discord bot: client error', err));
    c.on(Events.MessageReactionAdd, (reaction, user) => {
      this.handleReaction(reaction, user).catch(err =>
        this.log.error('discord bot: reaction handler failed', err)
      );
    });
  }

  private scheduleRelogin() {
    if (this.stopped || this.reloginTimer) return;
    const delay = Math.min(RELOGIN_MIN_MS * 2 ** this.reloginAttempt, RELOGIN_MAX_MS);
    this.reloginAttempt++;
    this.log.warn(`discord bot: next login attempt in ${Math.round(delay / 1000)}s`);
    this.reloginTimer = setTimeout(() => {
      this.reloginTimer = null;
      this.connect().catch(() => this.scheduleRelogin());
    }, delay);
    this.reloginTimer.unref?.();
  }

  // Replaces the current client (if any) with a fresh one and logs it in.
  // Rejects if the login fails; the state and detail say why.
  private async connect() {
    const old = this.client;
    this.client = null;
    if (old) await old.destroy().catch(() => undefined);
    if (this.stopped) return;

    const c = this.createClient();
    this.client = c;
    this.state = 'starting';
    this.detail = 'Connecting to Discord…';
    await c.login(this.options.token).catch((err: Error) => {
      this.state = 'error';
      this.detail = `Login failed: ${err.message}`;
      throw err;
    });
  }

  // For `.catch(this.failed('…'))`: log the rejection and turn it into null.
  private failed(what: string, level: 'warn' | 'error' = 'error') {
    return (err: unknown): null => {
      this.log[level](`discord bot: ${what}`, err);
      return null;
    };
  }

  private async handleReaction(
    reaction: MessageReaction | PartialMessageReaction,
    user: User | PartialUser
  ) {
    // The GUILD_MESSAGE_REACTIONS intent delivers every reaction in every
    // channel the bot can view; it cannot be narrowed server-side. Anything
    // outside the configured channel is dropped here, before any lookup or
    // request happens. (Only when a channel is configured: until then the
    // bot is just being set up and nothing is announced anyway.)
    const message = reaction.message;
    if (this.options.channelId && message.channelId !== this.options.channelId) return;
    if (user.bot) return;
    if (this.handlers.length === 0) return;
    const name = reaction.emoji.name ?? '';
    if (!name.startsWith(this.claimEmoji)) return;

    // The message is usually a partial (not cached) and is left that way:
    // its channel and id are all we need for the ref, and fetching it would
    // need READ_MESSAGE_HISTORY. Reactions to messages in the channel that
    // we didn't post are reported too; the application ignores refs it
    // doesn't know.
    const full = user.partial ? await user.fetch() : user;
    const claim: Claim = {
      ref: `${message.channelId}/${message.id}`,
      userId: full.id,
      username: full.globalName || full.username,
    };
    for (const h of this.handlers) await h(claim);
  }

  onClaim(handler: ClaimHandler) {
    this.handlers.push(handler);
  }

  // Logs in. Resolves once the gateway connection is up; rejects if the
  // login fails (bad token, no network), in which case it keeps retrying in
  // the background with backoff. discord.js reconnects on its own after
  // that; a session Discord invalidates is replaced with a fresh client.
  async start() {
    this.stopped = false;
    await this.connect().catch(err => {
      this.scheduleRelogin();
      throw err;
    });
  }

  async stop() {
    this.stopped = true;
    if (this.reloginTimer) {
      clearTimeout(this.reloginTimer);
      this.reloginTimer = null;
    }
    this.reloginAttempt = 0;
    const c = this.client;
    this.client = null;
    if (c) await c.destroy().catch(() => undefined);
    this.state = 'stopped';
    this.detail = undefined;
  }

  private async sendableChannel(channelId: string): Promise<SendableChannels | null> {
    const channel = await this.client?.channels
      .fetch(channelId)
      .catch(this.failed(`cannot fetch channel ${channelId}`, 'warn'));
    return channel?.isSendable() ? channel : null;
  }

  // Posts `text` in the configured channel. Returns the announcement ref,
  // or null if nothing was posted. Never throws.
  async announce(text: string): Promise<string | null> {
    if (this.state !== 'ready') {
      this.log.warn(`discord bot: not ready (${this.state}); dropping announcement`);
      return null;
    }
    const channelId = this.options.channelId;
    if (!channelId) {
      this.log.warn('discord bot: no channel configured; dropping announcement');
      return null;
    }
    const channel = await this.sendableChannel(channelId);
    if (!channel) return null;
    const message = await channel
      .send({ content: text, allowedMentions: { parse: [] } })
      .catch(this.failed('send failed'));
    return message && `${channel.id}/${message.id}`;
  }

  // Posts a follow-up about an earlier announcement: as a reply quoting it,
  // or as a plain message in its channel, per FOLLOW_UP_MODE. Never throws.
  async reply(ref: string, text: string): Promise<boolean> {
    const parsed = parseRef(ref);
    if (!parsed) return false;
    if (this.state !== 'ready') {
      this.log.warn(`discord bot: not ready (${this.state}); dropping reply`);
      return false;
    }
    const channel = await this.sendableChannel(parsed.channelId);
    if (!channel) return false;
    const message = await channel
      .send({
        content: text,
        allowedMentions: { parse: [] },
        ...(FOLLOW_UP_MODE === 'reply'
          ? { reply: { messageReference: parsed.messageId, failIfNotExists: false } }
          : {}),
      })
      .catch(this.failed('reply failed'));
    return message !== null;
  }

  async status(): Promise<BotStatus> {
    const status: BotStatus = { state: this.state, detail: this.detail, channels: [] };
    const client = this.client;
    const me = client?.user;
    if (!client || !me || this.state !== 'ready') return status;
    status.botUser = { id: me.id, tag: me.tag };

    for (const guild of client.guilds.cache.values()) {
      const member = guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
      if (!member) continue;
      for (const channel of guild.channels.cache.values()) {
        if (
          channel.type !== ChannelType.GuildText &&
          channel.type !== ChannelType.GuildAnnouncement
        )
          continue;
        const perms = channel.permissionsFor(member);
        if (
          !perms.has(PermissionFlagsBits.ViewChannel) ||
          !perms.has(PermissionFlagsBits.SendMessages)
        )
          continue;
        status.channels.push({ id: channel.id, name: `#${channel.name} (${guild.name})` });
      }
    }
    if (this.options.channelId) {
      status.channel = status.channels.find(c => c.id === this.options.channelId);
    }
    return status;
  }
}
