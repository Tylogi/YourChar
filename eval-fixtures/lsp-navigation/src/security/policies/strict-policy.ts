import type {
  AccessDecision,
  AccessPolicy,
  Subject,
} from "../contracts.js";

export class StrictAccessPolicy implements AccessPolicy {
  authorize(subject: Subject): AccessDecision {
    return subject.clearance >= 7
      ? { allowed: true, code: "STRICT_GRANTED" }
      : { allowed: false, code: "STRICT_DENIED" };
  }
}
