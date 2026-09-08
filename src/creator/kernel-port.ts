import type { CompanionKernel } from "../domain/kernel.js";
import { CreatorError, type CreatorOperation, type CreatorTarget } from "./contracts.js";
import type { CreatorPort } from "./service.js";

/** Explicit projections: never spread full snapshots containing chats or memory. */
export function createCreatorPort(kernel: CompanionKernel, assertAvailable: () => void): CreatorPort {
  const world = (id: string) => {
    const value = kernel.worldService.getWorld(id);
    return { id: value.id, name: value.name, description: value.description, rulesMarkdown: value.rulesMarkdown,
      timezone: value.timezone, revision: value.revision, status: value.status };
  };
  const character = (id: string) => {
    const value = kernel.getCharacter(id);
    return { id: value.id, name: value.name, soulMarkdown: value.soulMarkdown };
  };
  const membership = (id: string) => kernel.worldService.repository.getMembership(id) ?? null;
  const policy = (id: string) => {
    const value = kernel.worldService.repository.getPolicy(id);
    return value ? { enabled: value.enabled, proactiveEnabled: value.proactiveEnabled, socialEnabled: value.socialEnabled,
      dailyMessageLimit: value.dailyMessageLimit, socialDailyLimit: value.socialDailyLimit,
      quietStart: value.quietStart, quietEnd: value.quietEnd } : null;
  };
  const place = (id: string) => {
    const value = kernel.worldService.getPlace(id);
    return { id: value.id, worldId: value.worldId, name: value.name, description: value.description, capabilityIds: value.capabilityIds };
  };
  const activeWorld = (id: string) => {
    const value = world(id);
    if (value.status !== "active") throw new CreatorError("不能编辑已归档世界，请先在世界管理中恢复它");
    return value;
  };
  const inspect = (target: CreatorTarget): Record<string, unknown> => {
    switch (target.kind) {
      case "world": {
        const value = world(target.id);
        const places = kernel.worldService.listPlaces(target.id);
        const members = kernel.worldService.repository.listMemberships(target.id);
        const offset = target.offset ?? 0;
        return { ...value, places: places.slice(offset, offset + 30).map(value => place(value.id)), memberships: members.slice(offset, offset + 30),
          nextOffset: Math.max(places.length, members.length) > offset + 30 ? offset + 30 : null };
      }
      case "place": return place(target.id);
      case "character": {
        const runtime = kernel.worldService.repository.getRuntime(target.id);
        return { ...character(target.id), membership: membership(target.id), autonomy: policy(target.id),
          runtime: runtime ? { placeId: runtime.placeId, activity: runtime.activity, availability: runtime.availability, energy: runtime.energy } : null };
      }
    }
  };
  return {
    assertAvailable,
    assertApplyIdle: () => {
      assertAvailable(); kernel.assertControlPlaneIdle();
      if (kernel.worldCoordinator.isBusy || kernel.characterBackgroundTasks.isBusy || kernel.characterInteractionCoordinator.isBusy || kernel.characterDiaries.isBusy)
        throw new CreatorError("角色或世界后台活动正在运行，请稍后确认变更", 409);
    },
    overview(offset) {
      // Use the repository: listing identities must not read every SOUL document.
      const characters = kernel.rpService.repository.listCharacters();
      const worlds = kernel.listWorlds(true);
      return {
        characters: characters.slice(offset, offset + 30).map(value => ({ id: value.id, name: value.name, membership: membership(value.id), autonomy: policy(value.id) })),
        worlds: worlds.slice(offset, offset + 30).map(value => ({ id: value.id, name: value.name, status: value.status })),
        nextOffset: Math.max(characters.length, worlds.length) > offset + 30 ? offset + 30 : null,
        background: { worldPlanning: kernel.worldCoordinator.isBusy, tasks: kernel.characterBackgroundTasks.isBusy,
          social: kernel.characterInteractionCoordinator.isBusy, diaries: kernel.characterDiaries.isBusy },
      };
    },
    inspect,
    baseline(operation) {
      switch (operation.kind) {
        case "create_world": case "create_character": return null;
        case "update_world": return activeWorld(operation.worldId);
        case "create_place": return activeWorld(operation.worldId);
        case "update_place": { const value = place(operation.placeId); return { ...value, world: activeWorld(value.worldId) }; }
        case "update_character": return character(operation.characterId);
        case "update_autonomy": {
          const owner = character(operation.characterId);
          const member = membership(operation.characterId);
          if (!member) throw new CreatorError("请先将角色加入世界，再修改自主生活设置");
          return { character: owner, membership: member, world: activeWorld(member.worldId), autonomy: policy(operation.characterId) };
        }
        case "assign_character": {
          const places = [operation.homePlaceId, operation.currentPlaceId].filter((value): value is string => Boolean(value)).map(place);
          if (places.some(value => value.worldId !== operation.worldId)) throw new CreatorError("居所和当前位置必须属于目标世界");
          const runtime = kernel.worldService.repository.getRuntime(operation.characterId);
          return { character: character(operation.characterId), membership: membership(operation.characterId), world: activeWorld(operation.worldId), places,
            runtime: runtime ? { worldId: runtime.worldId, placeId: runtime.placeId, activity: runtime.activity,
              availability: runtime.availability, energy: runtime.energy, expectedUntil: runtime.expectedUntil } : null };
        }
      }
    },
    execute(operation: CreatorOperation) {
      switch (operation.kind) {
        case "create_world": { const value = kernel.createWorld(operation.input); return { worldId: value.id, name: value.name }; }
        case "update_world": { const value = kernel.updateWorld(operation.worldId, operation.patch); return { worldId: value.id, revision: value.revision }; }
        case "create_character": { const value = kernel.createCharacter(operation.input); return { characterId: value.id, name: value.name }; }
        case "update_character": { const value = kernel.updateCharacter(operation.characterId, operation.patch); return { characterId: value.id, name: value.name }; }
        case "create_place": { const value = kernel.createWorldPlace({ ...operation.input, worldId: operation.worldId }); return { placeId: value.id, worldId: value.worldId, name: value.name }; }
        case "update_place": { const value = kernel.updateWorldPlace(operation.placeId, operation.patch); return { placeId: value.id, name: value.name }; }
        case "assign_character": {
          kernel.assignCharacterWorld(operation.characterId, { worldId: operation.worldId, homePlaceId: operation.homePlaceId, currentPlaceId: operation.currentPlaceId });
          return { characterId: operation.characterId, membership: membership(operation.characterId) };
        }
        case "update_autonomy": {
          kernel.updateCharacterAutonomyPolicy(operation.characterId, operation.patch);
          return { characterId: operation.characterId, autonomy: policy(operation.characterId) };
        }
      }
    },
  };
}
