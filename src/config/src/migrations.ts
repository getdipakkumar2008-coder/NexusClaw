import type { Migration } from "./migrate.js";

/** All config migrations, oldest first. Every breaking schema change adds one (docs/08 section 5). */
export const migrations: readonly Migration[] = [
  {
    from: 0,
    to: 1,
    description: "Move top-level host/port into gateway.bind/gateway.port; stamp configVersion",
    up(raw) {
      const { host, port, ...rest } = raw;
      const gateway = { ...((rest["gateway"] as Record<string, unknown> | undefined) ?? {}) };
      if (typeof host === "string" && gateway["bind"] === undefined) gateway["bind"] = host;
      if (typeof port === "number" && gateway["port"] === undefined) gateway["port"] = port;
      return Object.keys(gateway).length > 0 ? { ...rest, gateway } : rest;
    },
  },
];
