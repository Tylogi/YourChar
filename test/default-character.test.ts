import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_CHARACTER_NAME,
  DEFAULT_CHARACTER_SOUL_MARKDOWN,
  createDefaultCharacterForNewInstallation,
} from "../src/app/default-character.js";
import type { CharacterProfile, CreateCharacterInput } from "../src/rp/types.js";

test("a new installation receives the bundled Kurisu character exactly once", () => {
  const characters: CharacterProfile[] = [];
  const target = bootstrapTarget(characters);

  const created = createDefaultCharacterForNewInstallation(target, true);

  assert.equal(created?.name, DEFAULT_CHARACTER_NAME);
  assert.equal(created?.soulMarkdown, DEFAULT_CHARACTER_SOUL_MARKDOWN);
  assert.match(created?.soulMarkdown ?? "", /牧濑红莉栖/u);
  assert.match(created?.soulMarkdown ?? "", /脑科学研究者/u);
  assert.ok([...(created?.soulMarkdown ?? "")].length <= 8_000);
  assert.equal(characters.length, 1);
  assert.equal(createDefaultCharacterForNewInstallation(target, true), undefined);
  assert.equal(characters.length, 1);
});

test("default-character bootstrap never changes an existing installation", () => {
  const existing = character("character-existing", "用户自己的角色", "# Existing soul");
  const characters = [existing];
  const target = bootstrapTarget(characters);

  assert.equal(createDefaultCharacterForNewInstallation(target, false), undefined);
  assert.deepEqual(characters, [existing]);
  assert.equal(createDefaultCharacterForNewInstallation(target, true), undefined);
  assert.deepEqual(characters, [existing]);
});

function bootstrapTarget(characters: CharacterProfile[]) {
  return {
    listCharacters: () => [...characters],
    createCharacter(input: CreateCharacterInput) {
      const created = character(
        `character-${characters.length + 1}`,
        input.name,
        input.soulMarkdown ?? "",
      );
      characters.push(created);
      return created;
    },
  };
}

function character(id: string, name: string, soulMarkdown: string): CharacterProfile {
  return {
    id,
    name,
    soulMarkdown,
    soulCharacterCount: [...soulMarkdown].length,
    soulMaxCharacters: 8_000,
    createdAt: "2026-09-15T00:00:00.000Z",
    updatedAt: "2026-09-15T00:00:00.000Z",
  };
}
