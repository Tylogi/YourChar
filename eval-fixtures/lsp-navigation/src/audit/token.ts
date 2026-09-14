export function makeAuditToken(eventId: string): string {
  return `audit:${eventId.toLowerCase()}`;
}
