import { makeAuditToken as rebuildAuditToken } from "./token.js";

export function replayAuditEvent(eventId: string): string {
  return rebuildAuditToken(eventId);
}
