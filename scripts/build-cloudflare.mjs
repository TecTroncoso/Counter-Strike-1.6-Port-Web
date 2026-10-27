import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

const root = fileURLToPath(new URL("../", import.meta.url));
const cli = join(root, "node_modules", "@opennextjs", "cloudflare", "dist", "cli", "index.js");
const envFiles = [".env", ".env.production", ".env.local", ".env.production.local"];
const publicNames = new Set([
  "NEXT_PUBLIC_CS16_BRIDGE_URL",
  "NEXT_PUBLIC_ASSETS_BASE_URL",
]);
const sensitiveName = /(TOKEN|SECRET|PASSWORD|API_KEY|DATABASE_URL|PRIVATE_KEY)/i;
const shouldDeploy = process.argv.includes("--deploy");

function filesBelow(path) {
  if (!existsSync(path)) return [];
  if (!statSync(path).isDirectory()) return [path];
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) =>
    filesBelow(join(path, entry.name)),
  );
}

function parseEnvFile(path) {
  if (!existsSync(path)) return {};
  return parseEnv(readFileSync(path, "utf8"));
}

// OpenNext merges these files in this order. Keep only explicitly public
// values; server secrets must be provided as Cloudflare runtime secrets.
const sourceVars = {};
for (const name of envFiles) {
  Object.assign(sourceVars, parseEnvFile(join(root, name)));
}

const childEnv = { ...process.env };
for (const name of Object.keys(childEnv)) {
  if (Object.hasOwn(sourceVars, name) && !publicNames.has(name)) {
    delete childEnv[name];
  }
}
// Remove inherited application secrets, but preserve Cloudflare's CLI auth
// variables (they authenticate the upload and are never Worker bindings).
const preservedAuthNames = new Set([
  "CLOUDFLARE_API_TOKEN",
  "CF_API_TOKEN",
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_ZONE_ID",
]);
for (const name of Object.keys(childEnv)) {
  if (sensitiveName.test(name) && !preservedAuthNames.has(name)) {
    delete childEnv[name];
  }
}
for (const name of publicNames) {
  childEnv[name] = process.env[name] ?? sourceVars[name] ?? "";
}

const backupDir = mkdtempSync(join(tmpdir(), "cs16-cloudflare-env-"));
const moved = [];
let operationStatus = 0;
try {
  for (const name of envFiles) {
    const source = join(root, name);
    if (existsSync(source)) {
      const backup = join(backupDir, name);
      try {
        renameSync(source, backup);
      } catch {
        copyFileSync(source, backup);
        rmSync(source, { force: true });
      }
      moved.push(name);
    }
  }

  const publicEnv = [...publicNames]
    .map((name) => `${name}=${JSON.stringify(childEnv[name] ?? "")}`)
    .join("\n");
  writeFileSync(join(root, ".env.production"), `${publicEnv}\n`);

  const build = spawnSync(process.execPath, [cli, "build"], {
    cwd: root,
    env: childEnv,
    stdio: "inherit",
  });
  operationStatus = build.status ?? 1;
  if (operationStatus !== 0) {
    throw new Error(`OpenNext build failed with exit code ${operationStatus}`);
  }

  // Defence in depth: sensitive values from the developer's .env must never be
  // present in the generated Worker/server-function artifacts.
  const sensitiveValues = Object.entries(sourceVars).filter(
    ([name, value]) =>
      sensitiveName.test(name) && typeof value === "string" && value.length >= 8,
  );
  const bundleFiles = filesBelow(join(root, ".open-next")).filter(
    (path) => !path.includes(`${join(root, ".open-next", "assets")}`),
  );
  const leaks = [];
  for (const path of bundleFiles) {
    if (!existsSync(path) || !statSync(path).isFile()) continue;
    const bytes = readFileSync(path);
    for (const [name, value] of sensitiveValues) {
      if (bytes.includes(Buffer.from(value))) leaks.push(`${name} in ${path}`);
    }
  }
  if (leaks.length > 0) {
    const details = leaks.map((leak) => `- ${leak}`).join("\n");
    throw new Error(`Cloudflare build contains sensitive environment values:\n${details}`);
  }
  console.log("Cloudflare build passed the environment-secret audit.");

  const prepare = spawnSync(
    process.execPath,
    [join(root, "scripts", "prepare-cloudflare-assets.mjs")],
    { cwd: root, env: childEnv, stdio: "inherit" },
  );
  operationStatus = prepare.status ?? 1;
  if (operationStatus !== 0) {
    throw new Error(`Cloudflare asset preparation failed with exit code ${operationStatus}`);
  }

  if (shouldDeploy) {
    const deploy = spawnSync(process.execPath, [cli, "deploy"], {
      cwd: root,
      env: childEnv,
      stdio: "inherit",
    });
    operationStatus = deploy.status ?? 1;
    if (operationStatus !== 0) {
      throw new Error(`OpenNext deploy failed with exit code ${operationStatus}`);
    }
  }
} finally {
  rmSync(join(root, ".env.production"), { force: true });
  for (const name of moved) {
    const backup = join(backupDir, name);
    const target = join(root, name);
    try {
      renameSync(backup, target);
    } catch {
      copyFileSync(backup, target);
      rmSync(backup, { force: true });
    }
  }
  rmSync(backupDir, { recursive: true, force: true });
}
