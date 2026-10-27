/**
 * Smoke test: Prisma driver adapter (libSQL/Turso path) in src/lib/db.ts.
 * Uses a file: libSQL URL to exercise the same code path a Turso database
 * would use, without needing a remote account.
 */
async function main() {
  process.env.TURSO_DATABASE_URL = "file:/home/z/my-project/db/turso-smoke.db";
  delete (process.env as Record<string, unknown>).DATABASE_URL;

  const { db } = await import("../src/lib/db");

  // Trivial write + read through the adapter.
  const user = await db.user.create({
    data: { email: `smoke-${Date.now()}@test.local`, name: "turso-smoke" },
  });
  const count = await db.user.count();
  console.log(`[OK] adapter libSQL funcionando — user ${user.id} creado, total users: ${count}`);

  await db.user.delete({ where: { id: user.id } });
  await db.$disconnect();
}

main().catch((e) => {
  console.error("[FALLO]", e instanceof Error ? e.message : e);
  process.exit(1);
});
