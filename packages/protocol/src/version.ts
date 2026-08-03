export const PROTOCOL_VERSION = 1 as const;
export const API_V1_PREFIX = "/api/v1" as const;
export const REALTIME_SUBPROTOCOL = "replicantos.v1" as const;

export type ProtocolVersion = typeof PROTOCOL_VERSION;
