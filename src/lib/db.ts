import { PrismaClient } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const globalForPrisma = globalThis as unknown as {
  prismaClient: PrismaClient | undefined;
  prismaProxy: PrismaClient | undefined;
  prismaReconnectPromise: Promise<void> | undefined;
};

function createPrismaClient() {
  const adapter = new PrismaPg(
    { connectionString: process.env.DATABASE_URL! },
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

  try {
    return await operation();
  } catch (error) {
    if (!isPrismaConnectionClosedError(error)) {
      throw error;
    }

    await reconnectPrisma();
    return operation();
  }
}

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prismaClient = prismaClient;
  globalForPrisma.prismaProxy = prisma;
}
