// A deliberately small Discord bot. It does exactly two things:
//
//   1. Posts a text announcement in one configured channel (and reacts to
//      it with the claim emoji so members can claim with one click).
//   2. Reports who reacted with the claim emoji (👍 by default) to one of
//      its own announcements, so the application using it can record the
//      "claim".
//
// It never reads message content (the MESSAGE_CONTENT intent is not
// requested), never reacts to messages it didn't post, never DMs anyone,
// and only ever writes to the configured channel. Everything the
// application does with a claim (matching the Discord user to an account,
// deciding whether it counts) happens outside this package, through the
// `onClaim` callback.
//
// Gateway intents used: GUILDS (to see which channels exist) and
// GUILD_MESSAGE_REACTIONS (to receive reactions). Neither is privileged.

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
  // Channel announcements are posted in. Optional so the bot can be started
  // before the channel is chosen: `status()` lists the channels it can see.
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

// Everything the bot needs, and nothing more: see/post in channels, add its
// own reaction, and read history (required to resolve reactions to messages
// posted before the process started).
export const BOT_PERMISSIONS = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.AddReactions,
  PermissionFlagsBits.ReadMessageHistory,
] as const;

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

export class PrintRequestBot {
  private readonly client: Client;
  private readonly claimEmoji: string;
  private readonly log: Pick<Console, 'log' | 'warn' | 'error'>;
  private readonly handlers: ClaimHandler[] = [];
  private state: BotState = 'stopped';
  private detail: string | undefined;

  constructor(private readonly options: BotOptions) {
    this.claimEmoji = options.claimEmoji ?? DEFAULT_CLAIM_EMOJI;
    this.log = options.log ?? console;
    this.client = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessageReactions],
      // Reactions to messages posted before this process started arrive
      // with the message not in the cache; partials let us still see them.
      partials: [Partials.Message, Partials.Reaction, Partials.User],
    });
    this.wire();
  }

  private wire() {
    const c = this.client;
    c.once(Events.ClientReady, ready => {
      this.state = 'ready';
      this.detail = undefined;
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
      this.state = 'error';
      this.detail = 'Discord session invalidated; restart the app (check the token).';
      this.log.error('discord bot: session invalidated');
    });
    c.on(Events.Error, err => this.log.error('discord bot: client error', err));
    c.on(Events.MessageReactionAdd, (reaction, user) => {
      this.handleReaction(reaction, user).catch(err =>
        this.log.error('discord bot: reaction handler failed', err)
      );
    });
  }

  private async handleReaction(
    reaction: MessageReaction | PartialMessageReaction,
    user: User | PartialUser
  ) {
    if (user.bot) return; // incl. our own claim-emoji reaction
    if (this.handlers.length === 0) return;
    const name = reaction.emoji.name ?? '';
    if (!name.startsWith(this.claimEmoji)) return;

    // Fill in partials. If the message is gone, so is the claim.
    let message = reaction.message;
    if (message.partial) {
      try {
        message = await message.fetch();
      } catch {
        return;
      }
    }
    // Only our own announcements count.
    if (message.author?.id !== this.client.user?.id) return;

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
  // token is refused. discord.js reconnects on its own after that.
  async start() {
    this.state = 'starting';
    this.detail = 'Connecting to Discord…';
    try {
      await this.client.login(this.options.token);
    } catch (err) {
      this.state = 'error';
      this.detail = `Login failed: ${(err as Error).message}`;
      throw err;
    }
  }

  async stop() {
    await this.client.destroy();
    this.state = 'stopped';
    this.detail = undefined;
  }

  private async sendableChannel(channelId: string): Promise<SendableChannels | null> {
    try {
      const channel = await this.client.channels.fetch(channelId);
      return channel && channel.isSendable() ? channel : null;
    } catch (err) {
      this.log.warn(`discord bot: cannot fetch channel ${channelId}`, (err as Error).message);
      return null;
    }
  }

  // Posts `text` in the configured channel and reacts to it with the claim
  // emoji. Returns the announcement ref, or null if nothing was posted.
  // Never throws.
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
    try {
      const message = await channel.send({ content: text, allowedMentions: { parse: [] } });
      message
        .react(this.claimEmoji)
        .catch(err =>
          this.log.warn('discord bot: could not add claim reaction', (err as Error).message)
        );
      return `${channel.id}/${message.id}`;
    } catch (err) {
      this.log.error('discord bot: send failed', err);
      return null;
    }
  }

  // Posts `text` as a reply to an earlier announcement. Never throws.
  async reply(ref: string, text: string): Promise<boolean> {
    const parsed = parseRef(ref);
    if (!parsed) return false;
    if (this.state !== 'ready') {
      this.log.warn(`discord bot: not ready (${this.state}); dropping reply`);
      return false;
    }
    const channel = await this.sendableChannel(parsed.channelId);
    if (!channel) return false;
    try {
      await channel.send({
        content: text,
        reply: { messageReference: parsed.messageId, failIfNotExists: false },
        allowedMentions: { parse: [] },
      });
      return true;
    } catch (err) {
      this.log.error('discord bot: reply failed', err);
      return false;
    }
  }

  async status(): Promise<BotStatus> {
    const status: BotStatus = { state: this.state, detail: this.detail, channels: [] };
    const me = this.client.user;
    if (!me || this.state !== 'ready') return status;
    status.botUser = { id: me.id, tag: me.tag };

    for (const guild of this.client.guilds.cache.values()) {
      let member;
      try {
        member = guild.members.me ?? (await guild.members.fetchMe());
      } catch {
        continue;
      }
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
