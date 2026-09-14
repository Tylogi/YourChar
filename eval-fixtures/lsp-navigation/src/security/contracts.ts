export type Subject = Readonly<{
  id: string;
  clearance: number;
}>;

export type AccessDecision = Readonly<{
  allowed: boolean;
  code: string;
}>;

export interface AccessPolicy {
  authorize(subject: Subject): AccessDecision;
}
