import { DefaultAccessPolicy } from "../security/public-api.js";

const policy = new DefaultAccessPolicy();

export const bootstrapDecision = policy.authorize({
  id: "operator-7",
  clearance: 9,
});
