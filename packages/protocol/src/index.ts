import { z } from "zod";

/** Protocol version negotiated in `hello` (docs/03 section 2). Minor bumps are additive only. */
export const PROTOCOL_VERSION = { major: 1, minor: 0 } as const;

/** Max size of one JSON frame in bytes (docs/03 section 4). Larger payloads use upload + blob refs. */
export const MAX_FRAME_BYTES = 1024 * 1024;

export const ERROR_CODE_FAMILIES = [
  "AUTH",
  "POLICY",
  "PROVIDER",
  "CHANNEL",
  "CONFIG",
  "PLUGIN",
  "RATE_LIMIT",
  "UNSUPPORTED",
  "INTERNAL",
  "SLOW_CONSUMER",
  "BAD_FRAME",
] as const;

export const errorCodeSchema = z
  .string()
  .regex(/^[A-Z][A-Z_]*(\.[A-Z0-9_]+)?$/, "error code must look like FAMILY or FAMILY.DETAIL")
  .refine(
    (code) => (ERROR_CODE_FAMILIES as readonly string[]).includes(code.split(".")[0] ?? ""),
    "unknown error code family",
  );

export const errorBodySchema = z.strictObject({
  code: errorCodeSchema,
  message: z.string().min(1),
  remediation: z.string().min(1),
  retryable: z.boolean(),
  docsUrl: z.string().optional(),
});
export type ErrorBody = z.infer<typeof errorBodySchema>;

const idSchema = z.string().min(1).max(128);

export const reqFrameSchema = z.strictObject({
  t: z.literal("req"),
  id: idSchema,
  method: z.string().regex(/^[a-z][a-z0-9]*(\.[a-z][a-z0-9_]*)+$/, "method must be dotted lowercase, e.g. session.send"),
  params: z.unknown().optional(),
});

export const resOkFrameSchema = z.strictObject({
  t: z.literal("res"),
  id: idSchema,
  ok: z.literal(true),
  result: z.unknown().optional(),
});

export const resErrFrameSchema = z.strictObject({
  t: z.literal("res"),
  id: idSchema,
  ok: z.literal(false),
  error: errorBodySchema,
});

export const evtFrameSchema = z.strictObject({
  t: z.literal("evt"),
  /** Totally ordered, durable sequence number; clients resume with `since` (docs/03 section 6). */
  seq: z.number().int().nonnegative(),
  type: z.string().min(1),
  session: z.string().optional(),
  data: z.unknown().optional(),
});

export const frameSchema = z.union([reqFrameSchema, resOkFrameSchema, resErrFrameSchema, evtFrameSchema]);

export type ReqFrame = z.infer<typeof reqFrameSchema>;
export type ResFrame = z.infer<typeof resOkFrameSchema> | z.infer<typeof resErrFrameSchema>;
export type EvtFrame = z.infer<typeof evtFrameSchema>;
export type Frame = z.infer<typeof frameSchema>;

export type ParseFrameResult = { ok: true; frame: Frame } | { ok: false; error: ErrorBody };

function badFrame(message: string): ParseFrameResult {
  return {
    ok: false,
    error: {
      code: "BAD_FRAME",
      message,
      remediation: "Send one UTF-8 JSON object per frame matching the protocol schema.",
      retryable: false,
    },
  };
}

/** Parse one raw text frame. Never throws; enforces the size cap before touching JSON.parse. */
export function parseFrame(raw: string): ParseFrameResult {
  if (Buffer.byteLength(raw, "utf8") > MAX_FRAME_BYTES) return badFrame("frame exceeds maximum size");
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return badFrame("frame is not valid JSON");
  }
  const parsed = frameSchema.safeParse(value);
  if (!parsed.success) return badFrame("frame does not match the protocol schema");
  return { ok: true, frame: parsed.data };
}

export const helloParamsSchema = z.strictObject({
  protocol: z.strictObject({ major: z.number().int(), minor: z.number().int().nonnegative() }),
  client: z.strictObject({ kind: z.string().min(1), version: z.string().min(1) }),
  capabilities: z.array(z.string()).default([]),
});
export type HelloParams = z.infer<typeof helloParamsSchema>;

/** A client may connect iff the major versions match; minors are additive (docs/03 section 2). */
export function isCompatible(clientMajor: number): boolean {
  return clientMajor === PROTOCOL_VERSION.major;
}
