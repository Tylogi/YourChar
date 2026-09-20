import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, rmdirSync, statfsSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";

const tmpfsMagic = 0x01021994;
const markerName = ".yourchar-memory-owner.json";
type Volume = { path: string; device: string; dev: number; dispose(): void };
const volumes = new Map<string, Volume>();
let registeredExit = false;
let recovered = false;

export type MemoryDirectory = { path: string; dispose(): void };

/** No ordinary temporary-directory fallback: callers must fail closed. */
export function createMemoryDirectory(prefix: string, capacityMiB = 64): MemoryDirectory {
  if (!/^yourchar-[a-z-]+-$/.test(prefix) || !Number.isInteger(capacityMiB) || capacityMiB < 32 || capacityMiB > 512) {
    throw new Error("Invalid memory-directory request");
  }
  if (process.platform === "linux") {
    assertMemoryBacked("/dev/shm");
    const path = mkdtempSync(join("/dev/shm", prefix));
    chmodSync(path, 0o700);
    return { path, dispose: () => rmSync(path, { recursive: true, force: true }) };
  }
  if (process.platform !== "darwin") {
    throw new Error("Memory-backed workers require Linux/WSL2 or macOS. On Windows, start the backend inside WSL2.");
  }
  if (!recovered) {
    recoverStaleVolumes();
    recovered = true;
  }
  const path = realpathSync(mkdtempSync(join(tmpdir(), "yourchar-memory-")));
  chmodSync(path, 0o700);
  let device: string | undefined;
  let mounted = false;
  try {
    const sectors = capacityMiB * 2048;
    const attached = plist("/usr/bin/hdiutil", ["attach", "-nomount", "-plist", `ram://${sectors}`]);
    const entities = attached["system-entities"];
    if (!Array.isArray(entities) || entities.length !== 1 || !/^\/dev\/disk\d+$/.test(entities[0]?.["dev-entry"])) {
      throw new Error("RAM attach returned an unexpected device");
    }
    const candidate = String(entities[0]["dev-entry"]);
    // Never format a device based only on attach output. Recheck image type,
    // ownership and size against DiskImages' live device inventory first.
    const image = ramImages().find(value => value["image-path"] === `ram://${sectors}` &&
      value["owner-uid"] === process.getuid!() && value["system-entities"]?.some((entry: Record<string, unknown>) => entry["dev-entry"] === candidate));
    if (!image) throw new Error("New device is not an owned RAM image");
    device = candidate;
    run("/sbin/newfs_hfs", ["-s", "-U", String(process.getuid!()), "-G", String(process.getgid!()), "-M", "700", "-v", "YourChar-RAM", device]);
    run("/sbin/mount", ["-t", "hfs", "-o", "nobrowse,nodev,nosuid", device, path]);
    mounted = true;
    const live = ramImages().some(value => value["owner-uid"] === process.getuid!() &&
      value["system-entities"]?.some((entry: Record<string, unknown>) => entry["dev-entry"] === device && entry["mount-point"] === path));
    if (!live || statSync(path).dev === statSync(tmpdir()).dev) throw new Error("RAM mount verification failed");
    chmodSync(path, 0o700);
    // Prevent desktop indexing/backups before any document or chat is staged.
    writeFileSync(join(path, ".metadata_never_index"), "", { flag: "wx", mode: 0o600 });
    const identity = processIdentity(process.pid);
    if (!identity) throw new Error("Cannot identify the RAM volume owner process");
    writeFileSync(join(path, markerName), JSON.stringify({ pid: process.pid, identity, uid: process.getuid!(), device, path }), { flag: "wx", mode: 0o600 });
    const ownedDevice = device;
    let disposed = false;
    const volume: Volume = {
      path, device: ownedDevice, dev: statSync(path).dev,
      dispose() {
        if (disposed) return;
        // Never delete a mountpoint recursively: unmount, detach the exact
        // owned RAM device, then remove only the empty mountpoint.
        if (mounted) {
          assertMemoryBacked(path);
          run("/sbin/umount", [path]);
          mounted = false;
        }
        const sameImage = ramImages().some(value => value["hdid-pid"] === image["hdid-pid"] && value["owner-uid"] === process.getuid!() &&
          value["system-entities"]?.some((entry: Record<string, unknown>) => entry["dev-entry"] === ownedDevice));
        if (!sameImage) throw new Error("Owned RAM device identity changed during cleanup");
        run("/usr/bin/hdiutil", ["detach", ownedDevice]);
        volumes.delete(path);
        disposed = true;
        rmdirSync(path);
      },
    };
    volumes.set(path, volume);
    if (!registeredExit) {
      registeredExit = true;
      process.once("exit", () => {
        for (const volume of volumes.values()) {
          try { volume.dispose(); } catch { /* Retained for next-start owned-volume recovery. */ }
        }
      });
    }
    return volume;
  } catch (error) {
    if (mounted) { try { run("/sbin/umount", [path]); } catch { /* Never recursively delete a mounted volume. */ } }
    if (device) { try { run("/usr/bin/hdiutil", ["detach", device]); } catch { /* No force-detach of busy devices. */ } }
    try { rmdirSync(path); } catch { /* Fail closed; no disk payload has been written. */ }
    throw error;
  }
}

export function assertMemoryBacked(path: string): void {
  if (process.platform === "linux" && Number(statfsSync(path).type) === tmpfsMagic) return;
  if (process.platform === "darwin") {
    const canonical = realpathSync(path);
    for (const volume of volumes.values()) {
      const child = relative(volume.path, canonical);
      if ((child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !child.startsWith(sep))) &&
          statSync(canonical).dev === volume.dev && statSync(volume.path).dev === volume.dev) return;
    }
  }
  throw new Error("Refusing storage that is not a verified memory-backed filesystem");
}

export function processIdentity(pid: number): string | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  try {
    if (process.platform === "linux") {
      const source = readFileSync(`/proc/${pid}/stat`, "utf8").trim();
      const start = source.slice(source.lastIndexOf(")") + 1).trim().split(/\s+/)[19];
      return start ? `${pid}:${start}` : undefined;
    }
    if (process.platform === "darwin") {
      const start = run("/bin/ps", ["-p", String(pid), "-o", "lstart="]).trim();
      return start ? `${pid}:${start}` : undefined;
    }
  } catch { /* Missing process or unavailable identity. */ }
  return undefined;
}

export function processDefinitelyExited(pid: number): boolean {
  try { process.kill(pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}

function recoverStaleVolumes(): void {
  for (const image of ramImages()) {
    if (image["owner-uid"] !== process.getuid!()) continue;
    for (const entry of image["system-entities"] ?? []) {
      const path = entry["mount-point"];
      const device = entry["dev-entry"];
      if (typeof path !== "string" || !path.startsWith(`${realpathSync(tmpdir())}/yourchar-memory-`) || !/^\/dev\/disk\d+$/.test(device)) continue;
      try {
        if (!existsSync(join(path, markerName)) || statSync(path).uid !== process.getuid!()) continue;
        const marker = JSON.parse(readFileSync(join(path, markerName), "utf8"));
        if (marker.path !== path || marker.device !== device || marker.uid !== process.getuid!() || !Number.isSafeInteger(marker.pid) || marker.pid <= 0) continue;
        const identity = processIdentity(marker.pid);
        // An unreadable live process is not evidence that its volume is stale.
        if (!processDefinitelyExited(marker.pid) && (!identity || identity === marker.identity)) continue;
        run("/sbin/umount", [path]);
        run("/usr/bin/hdiutil", ["detach", device]);
        rmdirSync(path);
      } catch { /* Unknown/busy resources are never forcibly removed. */ }
    }
  }
}

function run(command: string, args: string[], input?: string): string {
  return execFileSync(command, args, { encoding: "utf8", timeout: 15_000, maxBuffer: 4 * 1024 * 1024,
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LC_ALL: "C" }, input, stdio: ["pipe", "pipe", "pipe"] });
}

function plist(command: string, args: string[]): Record<string, any> {
  return JSON.parse(run("/usr/bin/plutil", ["-convert", "json", "-o", "-", "-"], run(command, args)));
}

function ramImages(): Array<Record<string, any>> {
  return (plist("/usr/bin/hdiutil", ["info", "-plist"]).images ?? [])
    .filter((image: Record<string, any>) => typeof image["image-path"] === "string" && /^ram:\/\/\d+$/.test(image["image-path"]));
}
