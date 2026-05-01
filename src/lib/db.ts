import { PrismaClient } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const globalForPrisma = globalThis as unknown as {
  prismaClient: PrismaClient | undefined;
  prismaProxy: PrismaClient | undefined;
  prismaReconnectPromise: Promise<void> | undefined;
};

type DatabaseProcessRole =
  | "web"
  | "daemon"
  | "recovery_poll"
  | "recovery_validation"
  | "recovery_discovery"
  | "bulk_recovery"
  | "expansion_pipeline"
  | "other";

function readPositiveIntegerEnv(name: string) {
  const raw = process.env[name]?.trim();
  if (!raw) return null;

  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : null;
}

function detectDatabaseProcessRole(): DatabaseProcessRole {
  const explicitRole = process.env.DATABASE_PROCESS_ROLE?.trim();
  if (
    explicitRole === "web" ||
    explicitRole === "daemon" ||
    explicitRole === "recovery_poll" ||
    explicitRole === "recovery_validation" ||
    explicitRole === "recovery_discovery" ||
    explicitRole === "bulk_recovery" ||
    explicitRole === "expansion_pipeline" ||
    explicitRole === "other"
  ) {
    return explicitRole;
  }

  const argv = process.argv.join(" ");

  if (argv.includes("scripts/ingest-recovery-worker.ts")) {
    if (argv.includes("--role=poll")) return "recovery_poll";
    if (argv.includes("--role=validation")) return "recovery_validation";
    if (argv.includes("--role=discovery")) return "recovery_discovery";
    return "other";
  }

  if (argv.includes("scripts/ingest-daemon.ts")) {
    return "daemon";
  }

  if (argv.includes("scripts/bulk-recovery-loop.ts")) {
    return "bulk_recovery";
  }

  if (argv.includes("scripts/run-expansion-pipeline.ts")) {
    return "expansion_pipeline";
  }

  return "web";
}

function getDatabasePoolMax(role: DatabaseProcessRole) {
  const explicitGlobal = readPositiveIntegerEnv("DATABASE_POOL_MAX");
  if (explicitGlobal != null) {
    return explicitGlobal;
  }

  const roleEnvMap: Record<DatabaseProcessRole, string | null> = {
    web: "DATABASE_POOL_MAX_WEB",
    daemon: "DATABASE_POOL_MAX_DAEMON",
    recovery_poll: "DATABASE_POOL_MAX_RECOVERY_POLL",
    recovery_validation: "DATABASE_POOL_MAX_RECOVERY_VALIDATION",
    recovery_discovery: "DATABASE_POOL_MAX_RECOVERY_DISCOVERY",
    bulk_recovery: "DATABASE_POOL_MAX_BULK_RECOVERY",
    expansion_pipeline: "DATABASE_POOL_MAX_EXPANSION_PIPELINE",
    other: "DATABASE_POOL_MAX_OTHER",
  };

  const explicitByRole = roleEnvMap[role]
    ? readPositiveIntegerEnv(roleEnvMap[role]!)
    : null;
  if (explicitByRole != null) {
    return explicitByRole;
  }

  if (process.env.NODE_ENV !== "production") {
    return 5;
  }

  const defaults: Record<DatabaseProcessRole, number> = {
    web: 6,
    daemon: 4,
    recovery_poll: 3,
    recovery_validation: 2,
    recovery_discovery: 2,
    bulk_recovery: 2,
    expansion_pipeline: 1,
    other: 4,
  };

  return defaults[role];
}

function getDatabaseIdleTimeoutMs() {
  return readPositiveIntegerEnv("DATABASE_POOL_IDLE_TIMEOUT_MS") ?? 10_000;
}

function getDatabaseConnectionTimeoutMs() {
  return readPositiveIntegerEnv("DATABASE_POOL_CONNECTION_TIMEOUT_MS") ?? 3_000;
}

function createPrismaClient() {
  const role = detectDatabaseProcessRole();
  const adapter = new PrismaPg(
    {
      connectionString: process.env.DATABASE_URL!,
      max: getDatabasePoolMax(role),
      idleTimeoutMillis: getDatabaseIdleTimeoutMs(),
      connectionTimeoutMillis: getDatabaseConnectionTimeoutMs(),
    },
    {
      onPoolError(error) {
        console.error("[prisma] Pool error:", error.message);
      },
      onConnectionError(error) {
        console.error("[prisma] Connection error:", error.message);
      },
    }
  );
  return new PrismaClient({ adapter });
}

let prismaClient = globalForPrisma.prismaClient ?? createPrismaClient();

function setPrismaClient(nextClient: PrismaClient) {
  prismaClient = nextClient;
  globalForPrisma.prismaClient = nextClient;
}

function createPrismaProxy() {
  return new Proxy({} as PrismaClient, {
    get(_target, property) {
      const value = Reflect.get(prismaClient as object, property, prismaClient);
      return typeof value === "function" ? value.bind(prismaClient) : value;
    },
  });
}

export const prisma = globalForPrisma.prismaProxy ?? createPrismaProxy();

function visitErrorTree(
  error: unknown,
  visitor: (value: unknown) => boolean,
  seen = new WeakSet<object>()
): boolean {
  if (visitor(error)) {
    return true;
  }

  if (!error || typeof error !== "object") {
    return false;
  }

  if (seen.has(error)) {
    return false;
  }

  seen.add(error);

  const candidate = error as {
    cause?: unknown;
    meta?: Record<string, unknown>;
  };

  if (candidate.cause && visitErrorTree(candidate.cause, visitor, seen)) {
    return true;
  }

  if (candidate.meta) {
    for (const value of Object.values(candidate.meta)) {
      if (visitErrorTree(value, visitor, seen)) {
        return true;
      }
    }
  }

  return false;
}

export function isPrismaConnectionClosedError(error: unknown) {
  return visitErrorTree(error, (value) => {
    if (!value || typeof value !== "object") {
      return false;
    }

    const candidate = value as {
      code?: unknown;
      message?: unknown;
      name?: unknown;
    };

    if (candidate.code === "P1017") {
      return true;
    }

    if (typeof candidate.message === "string") {
      return /Server has closed the connection|ConnectionClosed/i.test(candidate.message);
    }

    if (typeof candidate.name === "string") {
      return /ConnectionClosed/i.test(candidate.name);
    }

    return false;
  });
}

function isPrismaConnectionSaturatedError(error: unknown) {
  return visitErrorTree(error, (value) => {
    if (!value || typeof value !== "object") {
      return false;
    }

    const candidate = value as {
      code?: unknown;
      message?: unknown;
      name?: unknown;
    };

    if (candidate.code === "P2037") {
      return true;
    }

    if (typeof candidate.message === "string") {
      return /Too many database connections|too many clients already|TooManyConnections/i.test(
        candidate.message
      );
    }

    if (typeof candidate.name === "string") {
      return /TooManyConnections/i.test(candidate.name);
    }

    return false;
  });
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function reconnectPrisma() {
  if (globalForPrisma.prismaReconnectPromise) {
    await globalForPrisma.prismaReconnectPromise;
    return;
  }

  globalForPrisma.prismaReconnectPromise = (async () => {
    const previousClient = prismaClient;

    try {
      await previousClient.$disconnect();
    } catch {
      // ignore stale disconnect failures
    }

    const nextClient = createPrismaClient();
    setPrismaClient(nextClient);
    await nextClient.$connect();
  })().finally(() => {
    globalForPrisma.prismaReconnectPromise = undefined;
  });

  await globalForPrisma.prismaReconnectPromise;
}

export async function ensurePrismaConnection() {
  try {
    await prisma.$connect();
  } catch (error) {
    if (!isPrismaConnectionClosedError(error)) {
      throw error;
    }

    await reconnectPrisma();
  }
}

export async function withPrismaConnectionRetry<T>(operation: () => Promise<T>) {
  await ensurePrismaConnection();

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (isPrismaConnectionClosedError(error)) {
        await reconnectPrisma();
        continue;
      }

      if (isPrismaConnectionSaturatedError(error) && attempt < 2) {
        await sleep(150 * (attempt + 1));
        continue;
      }

      throw error;
    }
  }

  return operation();
}

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prismaClient = prismaClient;
  globalForPrisma.prismaProxy = prisma;
}
