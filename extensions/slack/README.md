# Slack channel

Lets people talk to your assistant through a Slack app, in direct messages and in channels. It uses Slack's Socket Mode:
the plugin connects out to Slack, so you do not need a public address, a domain or a certificate.

## Set up

1. Go to api.slack.com/apps and create an app (from scratch) in your workspace.
2. **Socket Mode**: turn it on. Slack asks you to create an app-level token with the `connections:write` scope; copy it
   (it starts with `xapp-`).
3. **OAuth & Permissions**: add the bot scopes `chat:write`, `im:history` and `app_mentions:read`. Install the app to
   the workspace and copy the **Bot User OAuth Token** (it starts with `xoxb-`).
4. **Event Subscriptions**: turn them on and subscribe the bot to the events `message.im` and `app_mention`. Nothing
   else is needed.
5. **App Home**: under *Messages Tab*, allow people to send messages to the app.
6. Install and configure the plugin (tokens are asked for without being shown; never put them on the command line):

   ```
   clawnexus plugins install extensions/slack
   clawnexus plugins secret slack set bot_token
   clawnexus plugins secret slack set app_token
   clawnexus plugins enable slack --yes
   clawnexus channels
   ```

   `channels` should show `slack  connected  @your_bot`. `auth_required` means Slack rejected a token.
7. Message the app. A stranger gets a pairing code and nothing else; approve them with
   `clawnexus pairing approve <code>`.
8. To be recognised as yourself (the owner, with full authority), open your Slack profile, choose **Copy member ID**,
   and run `clawnexus pairing owner slack <your-id>`. Only do this for your own account.

## Behaviour

- Direct messages: everyone you approve is served as a guest; the owner is served as the owner.
- Channels: the bot answers only when it is mentioned (invite it to the channel first). Channel messages are always
  served at guest level, even from the owner. The replies go in a thread under the message that asked. Ordinary channel
  chatter is never seen, because the plugin does not subscribe to it.
- Replies are plain text, split at 3000 characters. Anything the model writes that looks like a mention (`@channel`,
  `@here`, a person) or a link is escaped, so a reply can never ping anyone.
- Files are noted and dropped. The plugin never downloads them.
- Other bots, edits, deletions and the app's own messages are ignored.
- Slack reconnects the socket from time to time; the plugin follows, and a message it had not acknowledged is resent by
  Slack and processed once.
- There is no typing indicator.

## Settings

| name | meaning |
| --- | --- |
| `apiBase` | Slack Web API address. Leave unset for Slack. Must be `https`, or point at this computer (used for testing). |

## What it can and cannot be held to

It asks for the network (`slack.com` and its sub-domains) and two secrets (`bot_token`, `app_token`). The network
permission is **not enforced** by the system, so you are trusting this code, which is small and readable: `index.mjs`.
