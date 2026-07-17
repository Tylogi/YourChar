export const USER_PROFILE_MAX_CHARACTERS = 2_000;
export const USER_PROFILE_REALM = "reality" as const;
export const USER_PROFILE_SCOPE = "global" as const;

export type UserProfileDocument = {
  realm: typeof USER_PROFILE_REALM;
  scope: typeof USER_PROFILE_SCOPE;
  markdown: string;
  characterCount: number;
  maxCharacters: typeof USER_PROFILE_MAX_CHARACTERS;
  updatedAt: string;
};
