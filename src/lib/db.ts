import { PrismaClient } from '@prisma/client'
import { PrismaLibSQL } from '@prisma/adapter-libsql'

/**
 * Prisma client factory with dual datasource support:
 *
 *  - TURSO_DATABASE_URL set (libsql://... or file:...)  → Turso / libSQL
 *    via the official driver adapter. Used on serverless/edge-friendly
 *    deployments (Cloudflare Workers via OpenNext) and for hosted SQLite.
 *  - Otherwise → classic local SQLite file (DATABASE_URL), which keeps the
 *    sandbox / single-VPS deployments working with zero configuration.
 */
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

function createClient(): PrismaClient {
  const tursoUrl = process.env.TURSO_DATABASE_URL
  if (tursoUrl) {
    const adapter = new PrismaLibSQL({
      url: tursoUrl,
      authToken: process.env.TURSO_AUTH_TOKEN || undefined,
    })
    return new PrismaClient({
      adapter,
      log: ['query'],
    })
  }
  return new PrismaClient({
    log: ['query'],
  })
}

export const db =
  globalForPrisma.prisma ??
  createClient()

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db
