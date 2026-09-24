# printshop-discord-bot

A very small Discord bot, published so the people who run the Discord server
can read exactly what will be added to it. It is used by
[printshop-scheduler](https://github.com/imeckler/printshop-scheduler) to
announce new print requests and let print squad members claim them.

## What it does

1. **Posts an announcement** (plain text, no embeds, no mentions) in one
   configured channel, and reacts to it with 👍.
2. **Reports who reacted 👍** to one of its own announcements to the
   application that runs it, as `{ userId, username, ref }`.
3. **Posts follow-ups** as replies to an earlier announcement ("claimed by
   …", "completed by …").

That's the whole surface: [`src/index.ts`](src/index.ts) is ~250 lines.

## What it does not do

- It does **not** request the `MESSAGE_CONTENT` intent and never reads
  message text. It only sees reactions, and only acts on reactions to
  messages it posted itself.
- It does **not** read the member list, roles, or presence
  (`GUILD_MEMBERS` / `GUILD_PRESENCES` are not requested).
- It never DMs anyone, never mentions anyone (`allowedMentions: { parse: [] }`),
  and never posts outside the configured channel.
- It stores nothing. The application that embeds it keeps its own records.

Gateway intents: `GUILDS`, `GUILD_MESSAGE_REACTIONS`. Neither is privileged.

Permissions requested by the invite link: View Channel, Send Messages,
Add Reactions, Read Message History. See `BOT_PERMISSIONS` in the source.

## Adding it to a server

An admin of the server opens the invite link (`inviteUrl(clientId)`, shown on
the application's admin page), picks the server, and confirms the four
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
