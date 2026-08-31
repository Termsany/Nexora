import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";

const SAFE_REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function requestId(req: Request, res: Response, next: NextFunction) {
  const supplied = req.headers["x-request-id"];
  req.requestId = typeof supplied === "string" && SAFE_REQUEST_ID.test(supplied)
    ? supplied
    : crypto.randomUUID();
  res.setHeader("X-Request-ID", req.requestId);
  next();
}

declare global {
  namespace Express { interface Request { requestId: string } }
}
