import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  LocalImMediaError,
  LocalImMediaStore,
} from "../src/im/media-store.js";
import type { ImAttachment } from "../src/im/types.js";
import {
  WorkspaceFileError,
  WorkspaceFileService,
} from "../src/workspace/file-service.js";

const tinyPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

test("the IM media boundary confines paths and derives inbound image identity from bytes", async (context) => {
  const root = temporaryDirectory(context, "yourchar-im-media-path-");
  const workspaceDirectory = join(root, "workspace");
  const media = new LocalImMediaStore(workspaceDirectory);

  for (const path of [
    "https://attacker.invalid/private.pdf",
    "../outside/private.pdf",
    "/etc/passwd",
    "uploads\\im\\escape.pdf",
  ]) {
    assert.throws(
      () => media.describeOutboundAttachments([{
        path,
        name: "private.pdf",
        contentType: "application/pdf",
      }]),
      (error: unknown) => error instanceof WorkspaceFileError,
      `the media boundary must reject ${path}`,
    );
  }

  const attachment = await media.saveInboundAttachment({
    provider: "wechat",
    eventId: "owner-image-event",
    kind: "image",
    name: "../../avatar.exe",
    contentType: "text/plain",
    declaredSize: tinyPng.length,
    bytes: tinyPng,
  });
  assert.equal(attachment.kind, "image");
  assert.equal(attachment.contentType, "image/png");
  assert.equal(attachment.size, tinyPng.length);
  assert.equal(attachment.sha256, sha256(tinyPng));
  assert.match(attachment.path, /^uploads\/im\/wechat\/[0-9a-f]{64}\/[0-9a-f]{64}-[0-9a-f]{64}\//u);
  assert.equal(attachment.path.includes("../"), false);
  assert.equal(attachment.name.endsWith(".png"), true);
  assert.equal(existsSync(join(workspaceDirectory, attachment.path)), true);

  assert.deepEqual(
    await media.saveInboundAttachment({
      provider: "wechat",
      eventId: "owner-image-event",
      kind: "image",
      name: "../../avatar.exe",
      contentType: "application/octet-stream",
      bytes: Buffer.from(tinyPng),
    }),
    attachment,
    "a connector retry must reuse the identical content-addressed attachment",
  );
  await assert.rejects(
    media.saveInboundAttachment({
      provider: "wechat",
      eventId: "fake-image-event",
      kind: "image",
      name: "fake.png",
      contentType: "image/png",
      bytes: Buffer.from("not an image", "utf8"),
    }),
    (error: unknown) => error instanceof LocalImMediaError && error.code === "IM_MEDIA_INVALID",
  );
});

test("outbound IM media revalidates path, size, digest, and exact image MIME at send time", async (context) => {
  const root = temporaryDirectory(context, "yourchar-im-media-revalidate-");
  const workspaceDirectory = join(root, "workspace");
  const media = new LocalImMediaStore(workspaceDirectory);
  const inbound = await media.saveInboundAttachment({
    provider: "feishu",
    eventId: "queued-image-event",
    kind: "image",
    name: "queued.png",
    contentType: "image/png",
    bytes: tinyPng,
  });
  const [queued] = media.describeOutboundAttachments([{
    path: inbound.path,
    name: "untrusted-name.jpg",
    contentType: "image/jpeg",
    size: 1,
  }]);
  assert.deepEqual(queued, inbound, "queue metadata must be derived from the Workspace file");
  assert.deepEqual((await media.loadOutboundAttachment(queued)).bytes, tinyPng);

  await assertMediaChanged(media, { ...queued, size: queued.size + 1 });
  await assertMediaChanged(media, { ...queued, sha256: "0".repeat(64) });
  await assertMediaChanged(media, { ...queued, contentType: "image/jpeg" });

  const absolutePath = join(workspaceDirectory, queued.path);
  const sameLengthNonImage = Buffer.alloc(tinyPng.length, 0x41);
  writeFileSync(absolutePath, sameLengthNonImage);
  await assertMediaChanged(media, {
    ...queued,
    size: sameLengthNonImage.length,
    sha256: sha256(sameLengthNonImage),
  });

  writeFileSync(absolutePath, Buffer.concat([tinyPng, Buffer.from("changed")]));
  await assertMediaChanged(media, queued);
  rmSync(absolutePath);
  await assert.rejects(
    media.loadOutboundAttachment(queued),
    (error: unknown) => error instanceof WorkspaceFileError && error.code === "WORKSPACE_NOT_FOUND",
  );
});

test("clearing managed IM media preserves unrelated normal Workspace files", async (context) => {
  const root = temporaryDirectory(context, "yourchar-im-media-clear-");
  const workspaceDirectory = join(root, "workspace");
  const media = new LocalImMediaStore(workspaceDirectory);
  const workspace = new WorkspaceFileService(workspaceDirectory);
  const attachment = await media.saveInboundAttachment({
    provider: "wechat",
    eventId: "clear-managed-media",
    kind: "image",
    name: "managed.png",
    contentType: "image/png",
    bytes: tinyPng,
  });
  const unrelated = workspace.upload({
    directory: "notes",
    name: "keep.txt",
    bytes: Buffer.from("normal workspace content", "utf8"),
  });

  media.clearInboundAttachments();
  assert.equal(existsSync(join(workspaceDirectory, attachment.path)), false);
  assert.equal(existsSync(join(workspaceDirectory, "uploads", "im")), false);
  assert.equal(existsSync(join(workspaceDirectory, unrelated.path)), true);
  media.clearInboundAttachments();
});

async function assertMediaChanged(
  media: LocalImMediaStore,
  attachment: ImAttachment,
): Promise<void> {
  await assert.rejects(
    media.loadOutboundAttachment(attachment),
    (error: unknown) => error instanceof LocalImMediaError && error.code === "IM_MEDIA_CHANGED",
  );
}

function temporaryDirectory(context: TestContext, prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
