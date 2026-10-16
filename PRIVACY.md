# Privacy

**The software sends no telemetry or analytics.** Nothing leaves your installation unless you configure it.

Data you configure to leave your machine, and where it goes:

| Feature | Destination | Default |
|---|---|---|
| Messaging channels you enable | The messaging platform's servers | Off until you add a channel |
| AI provider / harness you choose | That provider (local models stay local) | You choose during setup |
| Update checks | Project release metadata | **Off** (opt-in) |
| Push relay | Self-hosted relay, or a hosted one if you opt in; payloads end-to-end encrypted | Off |
| Plugin registry | Registry host when you search or install | Only when you run those commands |

All state (sessions, memory, credentials, logs) lives in your data directory. A CI check will keep this table in sync with the outbound endpoints in the code (SEC-2).

Prompts and message content sent to a third-party AI provider are governed by that provider's terms.
