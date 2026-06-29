import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { authMiddleware } from "../../src/middleware/auth.middleware";

function mockReqResNext(authHeader?: string) {
  const req: any = { headers: {} };
  if (authHeader !== undefined) {
    req.headers["authorization"] = authHeader;
  }
  const res: any = {
    statusCode: 200,
    body: null,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(data: any) {
      this.body = data;
      return this;
    },
  };
  const next = vi.fn();
  return { req, res, next };
}

describe("authMiddleware", () => {
  const ORIGINAL_KEY = process.env.API_KEY;

  beforeEach(() => {
    process.env.API_KEY = "test-secret-key";
  });

  afterEach(() => {
    if (ORIGINAL_KEY !== undefined) {
      process.env.API_KEY = ORIGINAL_KEY;
    } else {
      delete process.env.API_KEY;
    }
  });

  it("calls next() with valid Bearer token", () => {
    const { req, res, next } = mockReqResNext("Bearer test-secret-key");
    authMiddleware(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it("returns 401 when no authorization header", () => {
    const { req, res, next } = mockReqResNext();
    authMiddleware(req, res, next);
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 401 when authorization is not Bearer", () => {
    const { req, res, next } = mockReqResNext("Basic abc123");
    authMiddleware(req, res, next);
    expect(res.statusCode).toBe(401);
  });

  it("returns 401 with wrong token", () => {
    const { req, res, next } = mockReqResNext("Bearer wrong-key");
    authMiddleware(req, res, next);
    expect(res.statusCode).toBe(401);
  });

  it("returns 500 when API_KEY not configured", () => {
    delete process.env.API_KEY;
    const { req, res, next } = mockReqResNext("Bearer anything");
    authMiddleware(req, res, next);
    expect(res.statusCode).toBe(500);
    expect(next).not.toHaveBeenCalled();
  });

  // Constant-time comparison must still reject length-mismatched tokens.
  it("rejects a token that is a prefix of the key", () => {
    const { req, res, next } = mockReqResNext("Bearer test-secret");
    authMiddleware(req, res, next);
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("rejects an empty bearer token", () => {
    const { req, res, next } = mockReqResNext("Bearer ");
    authMiddleware(req, res, next);
    expect(res.statusCode).toBe(401);
  });
});
