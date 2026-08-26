export type CharacterSkillRemoteInstallTurnState = {
  characterSkillRemoteInstallAttempts: number;
  characterSkillRemoteInstallInFlight: boolean;
  successfulCharacterSkillInstallSourceUrl?: string;
};

export function resetCharacterSkillRemoteInstallTurn(
  state: CharacterSkillRemoteInstallTurnState,
): void {
  state.characterSkillRemoteInstallAttempts = 0;
  state.characterSkillRemoteInstallInFlight = false;
  state.successfulCharacterSkillInstallSourceUrl = undefined;
}

/** Reserve the installer synchronously before any model-selected fetch begins. */
export function beginCharacterSkillRemoteInstall(
  state: CharacterSkillRemoteInstallTurnState,
  sourceUrl: string,
): void {
  state.characterSkillRemoteInstallAttempts += 1;
  if (state.characterSkillRemoteInstallAttempts > 3) {
    throw new Error(
      "At most three remote Skill installation attempts are allowed in a foreground user turn.",
    );
  }
  if (state.characterSkillRemoteInstallInFlight) {
    throw new Error("Only one remote Skill installation may be in flight at a time.");
  }
  if (
    state.successfulCharacterSkillInstallSourceUrl !== undefined
    && state.successfulCharacterSkillInstallSourceUrl !== sourceUrl
  ) {
    throw new Error(
      "Only one remote Skill source may complete installation in a foreground user turn.",
    );
  }
  state.characterSkillRemoteInstallInFlight = true;
}

export function finishCharacterSkillRemoteInstall(
  state: CharacterSkillRemoteInstallTurnState,
  sourceUrl: string,
  success: boolean,
): void {
  state.characterSkillRemoteInstallInFlight = false;
  if (success) state.successfulCharacterSkillInstallSourceUrl = sourceUrl;
}
