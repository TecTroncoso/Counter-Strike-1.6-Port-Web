import { cp, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const standaloneNext = `${root}.next/standalone/.next/`;
const standalonePublic = `${root}.next/standalone/public/`;

await mkdir(standaloneNext, { recursive: true });
await cp(`${root}.next/static/`, standaloneNext, {
  recursive: true,
  force: true,
});
await cp(`${root}public/`, standalonePublic, {
  recursive: true,
  force: true,
});

console.log("Copied static assets into the standalone Next.js output.");
