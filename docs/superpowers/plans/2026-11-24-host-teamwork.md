# Same-owner cross-host Teamwork

Host A may dispatch on behalf of its own bot to a bot on Host B. The owner chose to limit discovery to their own hosts and have Host B approve each directional bot pair. The installed desktop and terminal apps share this behavior.

1. Authenticate both hosts against the owner's profile directory and their pinned Link keys. Use an encrypted, dispatch-only exchange over the direct Link or its relay. Check member hosts, removed hosts, changed keys and replayed packets.
2. On Host B, keep the immutable request ID and message, expose the pending card to the owner, and persist grants by owner, both hosts, and both bots. A day ends at the target's next local midnight. A cancelled, denied or completed request can be retried without invoking the bot again.
3. Extend the existing Teamwork tool with a host selector and an on-demand roster. Preserve local asks, the per-turn ask limit and the rules around member turns, projects and helping sessions. Show both the bot and host in activity, including when a local bot has the same ID.
4. Exercise two real Link listeners and a paired device through discovery, waiting, human approval and delivery. Check stop, restart, revocation, and the four choices separately. Verify the desktop, phone, and terminal together.

Node Host setup is a separate feasibility investigation in [Node Host setup](../../node-host.md).
