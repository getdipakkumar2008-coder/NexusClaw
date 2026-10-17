# Telegram channel

Lets people talk to your assistant through a Telegram bot. It uses long polling, so you do not need a public address,
a domain or a certificate.

## Set up

1. In Telegram, talk to **@BotFather**, send `/newbot`, and copy the token it gives you.
2. Install and configure the plugin (the token is asked for without being shown; never put it on the command line):

   ```
   clawnexus plugins install extensions/telegram
   clawnexus plugins secret telegram set bot_token
   clawnexus plugins enable telegram --yes
   clawnexus channels
   ```

   `channels` should show `telegram  connected  @your_bot`. `auth_required` means Telegram rejected the token.
3. Message your bot. A stranger gets a pairing code and nothing else; approve them with
   `clawnexus pairing approve <code>`.
4. To be recognised as yourself (the owner, with full authority), find your numeric Telegram id (message
   **@userinfobot**) and run `clawnexus pairing owner telegram <your-id>`. Only do this for your own account.

## Behaviour

- Direct messages: everyone you approve is served as a guest; the owner is served as the owner.
- Groups: ignored unless the message mentions the bot, is a command addressed to it, or replies to one of its
  messages. Group messages are always served at guest level, even from the owner. Add the bot to a group and, if
  you want it to see ordinary messages, turn off privacy mode with @BotFather (`/setprivacy`).
- Replies are plain text, split at 4096 characters. In groups a reply points at the message it answers.
- Pictures, documents, audio and voice notes (up to 8 MB each, four per message) are downloaded from Telegram and given to the assistant, which accepts only images, PDF, audio and text, judged by their content. Videos, stickers and bigger files are noted but not taken.
- Edited messages, channel posts, and messages from other bots are ignored.

## Settings

| name | meaning |
| --- | --- |
| `apiBase` | Bot API address. Leave unset for Telegram. Must be `https`, or point at this computer (used for testing). |
| `pollSeconds` | How long each wait for news lasts, 0 to 50 (default 25). |

## What it can and cannot be held to

It asks for the network (`api.telegram.org`) and one secret (`bot_token`). The network permission is **not
enforced** by the system, so you are trusting this code, which is small and readable: `index.mjs`.

- Files the assistant sends (it asks you to approve each one, and only into the conversation it is in) are uploaded to Telegram as a photo, audio or document. Pictures, PDF, audio and text up to 8 MB.
