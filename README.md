# printshop-discord-bot

A very small Discord bot, published so the people who run the Discord server
can read exactly what will be added to it. It is used by
[printshop-scheduler](https://github.com/imeckler/printshop-scheduler) to
announce new print requests and let print squad members claim them.

## What it does

1. **Posts an announcement** (plain text, no embeds, no mentions) in one
   configured channel.
2. **Reports who reacted 👍** to an announcement to the application that
   runs it, as `{ userId, username, ref }`.
3. **Posts follow-ups** about an earlier announcement ("claimed by …",
   "completed by …").

That's the whole surface: [`src/index.ts`](src/index.ts) is ~250 lines.

## What it does not do

- It does **not** request the `MESSAGE_CONTENT` intent and never reads
  message text. It only sees reactions, and only acts on reactions to
  messages it posted itself.
- It does **not** read the member list, roles, or presence
  (`GUILD_MEMBERS` / `GUILD_PRESENCES` are not requested).
- It never DMs anyone, never mentions anyone (`allowedMentions: { parse: [] }`),
  never reacts to anything, never fetches a message, and never posts outside
  the configured channel.
- It stores nothing. The application that embeds it keeps its own records.

Gateway intents: `GUILDS`, `GUILD_MESSAGE_REACTIONS`. Neither is privileged.

## Permissions

The aim is the smallest set that works. Two conveniences were dropped for
that: reacting 👍 to its own announcements (a one-click claim button) and
fetching a message to confirm it was the bot's own. Both would need
`READ_MESSAGE_HISTORY`.

One choice remains, made at compile time by `FOLLOW_UP_MODE` in
[`src/index.ts`](src/index.ts):

| `FOLLOW_UP_MODE` | Follow-ups are posted as… | Permissions requested |
| --- | --- | --- |
| `'reply'` (current) | a Discord reply quoting the announcement | View Channel, Send Messages, Read Message History |
| `'message'` | a plain message in the same channel | View Channel, Send Messages |

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

## How printshop-scheduler uses it

`printshop-scheduler` depends on this package **pinned to a git commit**
(`git+https://github.com/imeckler/printshop-discord-bot.git#<sha>` in its
`package.json`), so the code running in production is always a specific,
reviewable commit of this repository. Bumping the pin is a visible change in
that repository's history.

```ts
import { PrintRequestBot } from 'printshop-discord-bot';

const bot = new PrintRequestBot({ token, channelId });
bot.onClaim(async ({ ref, userId, username }) => {
  // look up userId in your own database, record the claim…
});
await bot.start();
const ref = await bot.announce('🖨️ New print request #12 …');
await bot.reply(ref, '✅ Claimed by Sam.');
```

## Development

```
npm ci
npm run build       # tsc -> dist/
npm run format
```

`dist/` is not committed: `prepare` builds it on install, including when the
package is installed from git.
