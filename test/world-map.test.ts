import assert from "node:assert/strict";
import test from "node:test";
import { createHttpServer } from "../src/http/router.js";
import { createTestRuntime } from "../src/testing/index.js";

test("world map snapshots group current, traveling, and unlocated character state", async () => {
  const runtime = createTestRuntime({ seed: "world-map" });
  const server = createHttpServer({ kernel: runtime.kernel });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const alice = runtime.kernel.createCharacter({ name: "林澈" });
    const bob = runtime.kernel.createCharacter({ name: "顾遥" });
    const celine = runtime.kernel.createCharacter({ name: "许愿" });
    const world = runtime.kernel.createWorld({ name: "青岚市" });
    const bookshop = runtime.kernel.createWorldPlace({
      worldId: world.id,
      name: "河岸书店",
      capabilityIds: ["study", "rest"],
    });
    const station = runtime.kernel.createWorldPlace({
      worldId: world.id,
      name: "中央车站",
      capabilityIds: ["travel", "socialize"],
    });
    runtime.kernel.assignCharacterWorld(alice.id, {
      worldId: world.id,
      homePlaceId: bookshop.id,
      currentPlaceId: bookshop.id,
    });
    runtime.kernel.assignCharacterWorld(bob.id, {
      worldId: world.id,
      homePlaceId: bookshop.id,
      currentPlaceId: station.id,
    });
    runtime.kernel.updateCharacterRuntime(bob.id, {
      placeId: station.id,
      activity: "搭乘夜班列车",
      availability: "traveling",
      energy: 62,
    });
    runtime.kernel.assignCharacterWorld(celine.id, {
      worldId: world.id,
      homePlaceId: bookshop.id,
      currentPlaceId: null,
    });
    runtime.kernel.database.connection.prepare("UPDATE character_runtime_states SET place_id = NULL WHERE character_id = ?").run(celine.id);

    // A durable membership can outlive a missing runtime row during recovery;
    // the map must still fall back to the character's home place.
    runtime.kernel.worldService.repository.deleteRuntime(alice.id);

    const snapshot = runtime.kernel.listWorldMapSnapshots().find((entry) => entry.worldId === world.id);
    assert.ok(snapshot);
    assert.deepEqual(snapshot.places.map((place) => place.id).sort(), [bookshop.id, station.id].sort());
    assert.deepEqual(
      snapshot.characters.map((entry) => ({
        characterId: entry.characterId,
        placeId: entry.placeId,
        activity: entry.activity,
        availability: entry.availability,
      })),
      [
        { characterId: alice.id, placeId: bookshop.id, activity: "自由活动", availability: "free" },
        { characterId: bob.id, placeId: station.id, activity: "搭乘夜班列车", availability: "traveling" },
        { characterId: celine.id, placeId: null, activity: "自由活动", availability: "free" },
      ],
    );

    const address = server.address();
    assert.ok(address && typeof address === "object");
    const origin = `http://127.0.0.1:${address.port}`;
    const response = await fetch(`${origin}/api/v1/worlds?includeMap=1`);
    assert.equal(response.status, 200);
    const body = await response.json() as { maps: Array<{ worldId: string }> };
    assert.deepEqual(body.maps.map((entry) => entry.worldId), [world.id]);

    const regularResponse = await fetch(`${origin}/api/v1/worlds`);
    const regularBody = await regularResponse.json() as Record<string, unknown>;
    assert.equal("maps" in regularBody, false);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    runtime.dispose();
  }
});
