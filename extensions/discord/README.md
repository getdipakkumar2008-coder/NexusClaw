# Discord channel

Lets people talk to your assistant through a Discord bot, in direct messages and in servers. It connects out to
Discord, so you do not need a public address, a domain or a certificate.

## Set up

1. Go to the Discord developer portal, create an application, and open its **Bot** page. Copy the bot token (use
   **Reset Token** if it is not shown).
2. You do **not** need to switch on any "privileged intent". The plugin asks only for server messages and direct
   messages. Discord still includes the text of messages that mention the bot.
3. Under **Installation** (or **OAuth2 > URL Generator**), choose the `bot` scope with the permissions
   *View Channels*, *Send Messages* and *Read Message History*, open the link, and add the bot to your server.
   Direct messages work without a server, as long as you share one with the bot.
4. Install and configure the plugin (the token is asked for without being shown; never put it on the command line):

   ```
   clawnexus plugins install extensions/discord
   clawnexus plugins secret discord set bot_token
   clawnexus plugins enable discord --yes
   clawnexus channels
   ```

   `channels` should show `discord  connected  @your_bot`. `auth_required` means Discord rejected the token.
5. Message the bot. A stranger gets a pairing code and nothing else; approve them with
   `clawnexus pairing approve <code>`.
6. To be recognised as yourself (the owner, with full authority), turn on Developer Mode in Discord (Settings >
   Advanced), right-click your name, **Copy User ID**, and run `clawnexus pairing owner discord <your-id>`. Only do
   this for your own account.

## Behaviour

- Direct messages: everyone you approve is served as a guest; the owner is served as the owner.
- Servers: ignored unless the message mentions the bot or replies to one of its messages. Server messages are always
  served at guest level, even from the owner. The bot's own mention is removed from the text the assistant sees.
- Replies are plain text, split at 2000 characters. In servers a reply points at the message it answers. A reply can
  never ping anyone (`@everyone`, roles or people), whatever the model writes.
- Attachments (up to 8 MB each, four per message) are downloaded from Discord's own file hosts only and given to the assistant, which accepts only images, PDF, audio and text, judged by their content. Anything else is noted but not taken.
- Other bots, webhooks and service messages are ignored.
- If the connection drops it reconnects and resumes, so messages sent in the gap arrive once.

## Settings

| name | meaning |
| --- | --- |
| `apiBase` | Discord REST address. Leave unset for Discord. Must be `https`, or point at this computer (used for testing). |

## What it can and cannot be held to

It asks for the network (`discord.com`, `gateway.discord.gg`) and one secret (`bot_token`). The network permission is
**not enforced** by the system, so you are trusting this code, which is small and readable: `index.mjs`.

- Files the assistant sends (it asks you to approve each one, and only into the conversation it is in) are uploaded to Discord together with the message. Pictures, PDF, audio and text up to 8 MB.
