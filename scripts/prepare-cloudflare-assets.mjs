import { cp, mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const source = join(root, "game-files");
const destination = join(root, ".open-next", "assets", "assets");

async function assertDirectory(path) {
  try {
    const info = await stat(path);
    if (!info.isDirectory()) {
      throw new Error(`${path} is not a directory`);
    }
  } catch (error) {
    throw new Error(`Required game-assets directory is missing: ${path}`, {
      cause: error,
    });
  }
}

await assertDirectory(source);
await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
await cp(source, destination, { recursive: true, force: true });

console.log(`Prepared Cloudflare game assets at ${destination}`);
