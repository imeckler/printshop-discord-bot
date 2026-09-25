// A deliberately small Discord bot. It does exactly three things:
//
//   1. Posts a text announcement, with a "Claim" button under it, in one
//      configured channel.
//   2. Reports who clicked the button, so the application using it can
//      record the "claim", and lets the application answer that person
//      privately.
//   3. Posts follow-ups about an announcement ("claimed by …").
//
// What it can observe is exactly clicks on its own button. Discord sends a
// bot an interaction only for components on messages the bot itself
// posted; that needs no gateway intent at all. So the bot never sees
// messages (no GUILD_MESSAGES or MESSAGE_CONTENT intent), never sees
// reactions (no GUILD_MESSAGE_REACTIONS intent), never fetches messages,
// never DMs anyone, never mentions anyone, and only ever writes to the
// configured channel. Everything the application does with a claim
// (matching the Discord user to an account, deciding whether it counts)
// happens outside this package, through the `onClaim` callback.
//
// Gateway intents used: GUILDS only (to see which channels exist, for the
// admin page). Not privileged.
//
// Permissions: the goal is the smallest set that works, so the server's
// admins have as little as possible to trust. Earlier designs used a 👍
// reaction as the claim; that needed the reactions intent (every reaction
// in every visible channel is delivered) and, for conveniences like
// reacting first or checking a message was ours, READ_MESSAGE_HISTORY. The
// button removes all of that. The one remaining trade-off is
// FOLLOW_UP_MODE below.

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  OAuth2Scopes,
  PermissionFlagsBits,
  type ButtonInteraction,
  type Guild,
  type Interaction,
  type SendableChannels,
  escapeMarkdown,
} from 'discord.js';

export interface BotOptions {
  // Bot token from the Discord developer portal (Bot > Token).
  token: string;
  // Channel announcements are posted in. Optional so the bot can be started
  // before the channel is chosen: `status()` lists the channels it can see.
  channelId?: string;
  // Text on the claim button (default "Claim").
  claimLabel?: string;
  log?: Pick<Console, 'log' | 'warn' | 'error'>;
}

// A member clicked the claim button under one of the bot's announcements.
export interface Claim {
  // The announcement, as returned by `announce()`.
  ref: string;
  // Discord user id (a snowflake, stable for the life of the account).
  userId: string;
  // Display name at the time of the click; for humans, not for matching.
  username: string;
  // Sends `text` so that only the person who clicked sees it (an ephemeral
  // follow-up). Discord allows this for 15 minutes after the click. Never
  // throws.
  replyPrivately(text: string): Promise<void>;
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

// What posting in a channel takes.
const POST_PERMISSIONS = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages];

// Everything the bot needs for the selected mode, and nothing more.
export const BOT_PERMISSIONS: readonly bigint[] = [
  ...POST_PERMISSIONS,
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

// For text that comes from users. Discord renders markdown in bot messages,
// including masked links and headings (which discord.js's escapeMarkdown
// leaves alone by default), so anything untrusted should go through this.
export const escapeUserText = (text: string): string =>
  escapeMarkdown(text, { maskedLink: true, heading: true, bulletedList: true, numberedList: true });

const DEFAULT_CLAIM_LABEL = 'Claim';
// customId of the claim button; the only component the bot ever posts.
const CLAIM_BUTTON_ID = 'claim';

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
  private readonly claimLabel: string;
  private readonly log: Pick<Console, 'log' | 'warn' | 'error'>;
  private readonly handlers: ClaimHandler[] = [];
  private state: BotState = 'stopped';
  private detail: string | undefined;
  private stopped = true;
  private reloginTimer: ReturnType<typeof setTimeout> | null = null;
  private reloginAttempt = 0;

  constructor(private readonly options: BotOptions) {
    this.claimLabel = options.claimLabel || DEFAULT_CLAIM_LABEL;
    this.log = options.log ?? console;
  }

  private createClient(): Client {
    // Button clicks (interactions) arrive without any intent.
    const c = new Client({ intents: [GatewayIntentBits.Guilds] });
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
    c.on(Events.InteractionCreate, (interaction: Interaction) => {
      if (!interaction.isButton() || interaction.customId !== CLAIM_BUTTON_ID) return;
      this.handleClick(interaction).catch(err =>
        this.log.error('discord bot: claim handler failed', err)
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

  // The client, if it is connected and ready to talk to Discord.
  private readyClient(): Client | null {
    return this.state === 'ready' ? this.client : null;
  }

  // Same, but says what is being dropped when it isn't.
  private readyOrDrop(what: string): Client | null {
    const client = this.readyClient();
    if (!client) this.log.warn(`discord bot: not ready (${this.state}); dropping ${what}`);
    return client;
  }

  // For `.catch(this.failed('…'))`: log the rejection and turn it into null.
  private failed(what: string, level: 'warn' | 'error' = 'error') {
    return (err: unknown): null => {
      this.log[level](`discord bot: ${what}`, err);
      return null;
    };
  }

  private async handleClick(interaction: ButtonInteraction) {
    // Discord only delivers interactions for components on our own
    // messages, so this is a click on a claim button we posted. Acknowledge
    // it right away (Discord gives 3 s, after which the click shows as
    // failed to the user); handlers may then take their time, and can
    // still answer the clicker privately for 15 minutes.
    await interaction.deferUpdate();
    if (this.handlers.length === 0) return;

    const user = interaction.user;
    const claim: Claim = {
      ref: `${interaction.channelId}/${interaction.message.id}`,
      userId: user.id,
      username: user.globalName || user.username,
      replyPrivately: async text => {
        await interaction
          .followUp({
            content: text,
            flags: MessageFlags.Ephemeral,
            allowedMentions: { parse: [] },
          })
          .catch(this.failed('private reply failed'));
      },
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

  // Posts `text`, with the claim button under it, in the configured
  // channel. Returns the announcement ref, or null if nothing was posted.
  // Never throws.
  async announce(text: string): Promise<string | null> {
    if (!this.readyOrDrop('announcement')) return null;
    const channelId = this.options.channelId;
    if (!channelId) {
      this.log.warn('discord bot: no channel configured; dropping announcement');
      return null;
    }
    const channel = await this.sendableChannel(channelId);
    if (!channel) return null;
    const button = new ButtonBuilder()
      .setCustomId(CLAIM_BUTTON_ID)
      .setLabel(this.claimLabel)
      .setStyle(ButtonStyle.Primary);
    const message = await channel
      .send({
        content: text,
        components: [new ActionRowBuilder<ButtonBuilder>().addComponents(button)],
        allowedMentions: { parse: [] },
      })
      .catch(this.failed('send failed'));
    if (!message) return null;
    return `${channel.id}/${message.id}`;
  }

  // Posts a follow-up about an earlier announcement: as a reply quoting it,
  // or as a plain message in its channel, per FOLLOW_UP_MODE. Never throws.
  async reply(ref: string, text: string): Promise<boolean> {
    const parsed = parseRef(ref);
    if (!parsed) return false;
    if (!this.readyOrDrop('reply')) return false;
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
    const client = this.readyClient();
    if (!client?.user) return status;
    status.botUser = { id: client.user.id, tag: client.user.tag };

    // Text channels in each server where the bot can both see and post.
    const postableIn = async (guild: Guild): Promise<ChannelInfo[]> => {
      const member = guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
      if (!member) return [];
      return guild.channels.cache
        .filter(c => c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement)
        .filter(c => c.permissionsFor(member).has(POST_PERMISSIONS))
        .map(c => ({ id: c.id, name: `#${c.name} (${guild.name})` }));
    };
    status.channels = (await Promise.all(client.guilds.cache.map(postableIn))).flat();
    if (this.options.channelId) {
      status.channel = status.channels.find(c => c.id === this.options.channelId);
    }
    return status;
  }
}
