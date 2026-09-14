import { makeAuditToken } from "./token.js";

export function recordAuditEvent(eventId: string): string {
  return makeAuditToken(eventId);
}
