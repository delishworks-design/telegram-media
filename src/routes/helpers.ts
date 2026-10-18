import type { NextFunction, Request, RequestHandler, Response } from "express";

export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}

export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly code = "error",
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export function badRequest(message: string, code = "bad_request"): HttpError {
  return new HttpError(400, message, code);
}

export function notFound(message = "Not found", code = "not_found"): HttpError {
  return new HttpError(404, message, code);
}

export function requireString(value: unknown, field: string, max = 500): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw badRequest(`${field} is required`);
  }
  if (value.length > max) throw badRequest(`${field} is too long`);
  return value;
}

export function asInt(value: unknown, field: string): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(n)) throw badRequest(`${field} must be an integer`);
  return n;
}
