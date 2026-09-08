type TimelineMessage = { role: string; burstId?: string; inboxBurstId?: string; entryId?: string; replyToEntryId?: string };

/**
 * Queue admission and Pi persistence use different clocks/timestamps. A live
 * reply belongs after the last user message in its burst, not at an estimated
 * timestamp. Persisted replies retain the input link from transcript order
 * when they replace a transient row. Leave unrelated rows untouched.
 * Keep this function self-contained: the same implementation runs in the UI.
 */
export function anchorStreamingReplies<T extends TimelineMessage>(messages: readonly T[]): T[] {
  const anchors = new Map<string, T>();
  const storedAnchors = new Map<string, T>();
  for (const message of messages) {
    if (message.role === "user" && message.inboxBurstId) anchors.set(message.inboxBurstId, message);
    if (message.role === "user" && message.entryId) storedAnchors.set(message.entryId, message);
  }
  const replies = new Map<T, T[]>();
  const anchored = new Set<T>();
  for (const message of messages) {
    const anchor = message.role === "user" ? undefined
      : (message.burstId ? anchors.get(message.burstId) : undefined) ??
        (message.replyToEntryId ? storedAnchors.get(message.replyToEntryId) : undefined);
    if (!anchor) continue;
    const group = replies.get(anchor) ?? [];
    group.push(message);
    replies.set(anchor, group);
    anchored.add(message);
  }
  return messages.flatMap(message => anchored.has(message) ? [] : [message, ...(replies.get(message) ?? [])]);
}

export const streamingOrderScript = anchorStreamingReplies.toString();
