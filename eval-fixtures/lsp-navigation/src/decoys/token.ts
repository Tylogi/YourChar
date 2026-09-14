// Same spelling, different symbol: semantic references to audit/token.ts must
// never include this declaration or call.
export function makeAuditToken(eventId: string): string {
  return `decoy:${eventId}`;
}

export const decoyToken = makeAuditToken("NOT_A_REAL_AUDIT_REFERENCE");
