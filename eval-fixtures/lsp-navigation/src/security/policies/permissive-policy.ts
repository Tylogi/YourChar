import type {
  AccessDecision,
  AccessPolicy,
  Subject,
} from "../contracts.js";

export class PermissiveAccessPolicy implements AccessPolicy {
  authorize(_subject: Subject): AccessDecision {
    return { allowed: true, code: "PERMISSIVE_GRANTED" };
  }
}
