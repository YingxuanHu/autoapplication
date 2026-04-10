type HeaderSource = {
  get(name: string): string | null;
};

function isLocalHost(host: string) {
  return host.startsWith("localhost") || host.startsWith("127.0.0.1");
}

function resolveRequestOrigin(headers?: HeaderSource | null) {
  const forwardedHost = headers?.get("x-forwarded-host");
  const host = forwardedHost ?? headers?.get("host");

  if (host) {
    const forwardedProto = headers?.get("x-forwarded-proto");
    const protocol = forwardedProto ?? (isLocalHost(host) ? "http" : "https");
    return `${protocol}://${host}`;
  }

  return process.env.BETTER_AUTH_URL ?? "http://localhost:3000";
}

export function buildRuntimeTrustedOrigins(headers?: HeaderSource | null) {
  const origins = new Set<string>();

  origins.add(process.env.BETTER_AUTH_URL ?? "http://localhost:3000");
  origins.add("http://localhost:3000");
  origins.add("http://127.0.0.1:3000");
  origins.add("http://localhost:3001");
  origins.add("http://127.0.0.1:3001");
  origins.add("http://localhost:3002");
  origins.add("http://127.0.0.1:3002");
  origins.add("http://localhost:3003");
  origins.add("http://127.0.0.1:3003");

  const requestOrigin = resolveRequestOrigin(headers);
  if (requestOrigin) {
    origins.add(requestOrigin);
  }

  const explicitOrigin = headers?.get("origin");
  if (explicitOrigin) {
    origins.add(explicitOrigin);
  }

  return [...origins];
}
