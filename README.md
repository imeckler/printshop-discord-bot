# printshop-discord-bot

A very small Discord bot, published so the people who run the Discord server
can read exactly what will be added to it. It is used by
[printshop-scheduler](https://github.com/imeckler/printshop-scheduler) to
announce new print requests and let print squad members claim them.

## What it does

1. **Posts an announcement** (plain text, no embeds, no mentions) with a
   **Claim** button under it, in one configured channel.
2. **Reports who clicked the button** to the application that runs it, as
   `{ userId, username, ref }`, and lets the application answer that person
   privately (an ephemeral message only they see).
3. **Posts follow-ups** about an earlier announcement ("claimed by …",
   "completed by …").

That's the whole surface: [`src/index.ts`](src/index.ts) is ~250 lines.

## What it does not do

- It does **not** see messages or reactions. The only events it receives
  are clicks on its own button: Discord delivers component interactions
  only for messages the bot itself posted, and they need no intent. The
  `GUILD_MESSAGES`, `MESSAGE_CONTENT` and `GUILD_MESSAGE_REACTIONS` intents
  are not requested.
- It does **not** read the member list, roles, or presence
  (`GUILD_MEMBERS` / `GUILD_PRESENCES` are not requested).
- It never DMs anyone, never mentions anyone (`allowedMentions: { parse: [] }`),
  never reacts to anything, never fetches a message, and never posts outside
  the configured channel. The one private message it can send is an
  ephemeral reply to someone who just clicked the button.
- It stores nothing. The application that embeds it keeps its own records.
- It reconnects on its own. Ordinary disconnects are handled by discord.js;
  if Discord invalidates the session outright, the bot logs in again with a
  fresh client, backing off from 30 s to 10 min between attempts.

Gateway intents: `GUILDS` only (to list channels for the admin page). Not
privileged.

## Permissions

The aim is the smallest set that works. An earlier design used a 👍
reaction as the claim; that meant receiving every reaction in every channel
the bot could see, and the conveniences around it (reacting first, checking
a message was the bot's own) needed `READ_MESSAGE_HISTORY`. A button under
the announcement replaces all of that with zero intents and no extra
permission.

One choice remains, made at compile time by `FOLLOW_UP_MODE` in
[`src/index.ts`](src/index.ts):

| `FOLLOW_UP_MODE`      | Follow-ups are posted as…                | Permissions requested                             |
| --------------------- | ---------------------------------------- | ------------------------------------------------- |
| `'reply'`             | a Discord reply quoting the announcement | View Channel, Send Messages, Read Message History |
| `'message'` (current) | a plain message in the same channel      | View Channel, Send Messages                       |

Discord requires `READ_MESSAGE_HISTORY` to create a message that references
another one, which is the only reason `'reply'` needs it. Replies are kept
as an option because a follow-up that visibly hangs off its request is the
one convenience that seemed worth a permission. If the server's admins would
rather not grant it, switch the constant to `'message'` and rebuild; the
invite link (`BOT_PERMISSIONS` / `inviteUrl`) follows the choice.

## Adding it to a server

An admin of the server opens the invite link (`inviteUrl(clientId)`, shown on
the application's admin page), picks the server, and confirms the
permissions above. Then restrict the bot to a single channel using normal
Discord channel permissions if you like; it only needs the one.

## Development

```
npm ci
npm run build       # tsc -> dist/
npm run format
```

`dist/` is not committed: `prepare` builds it on install, including when the
package is installed from git.
