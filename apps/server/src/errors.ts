import { ZodError } from "zod";

export type ServerErrorCode =
  | "authentication_required"
  | "conflict"
  | "forbidden"
  | "internal_error"
  | "invalid_credentials"
  | "invalid_request"
  | "not_found"
  | "origin_rejected"
  | "rate_limited"
  | "service_unavailable";

export class HttpError extends Error {
  readonly statusCode: number;
  readonly code: ServerErrorCode;

  constructor(statusCode: number, code: ServerErrorCode, message: string) {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

export function invalidRequest(): HttpError {
  return new HttpError(400, "invalid_request", "The request is invalid.");
}

export function parseInput<Output>(
  schema: { parse(value: unknown): Output },
  value: unknown,
): Output {
  try {
    return schema.parse(value);
  } catch (error) {
    if (error instanceof ZodError) throw invalidRequest();
    throw error;
  }
}
