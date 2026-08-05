import http, { type Server } from "node:http";
import express from "express";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createCorsMiddleware } from "../../utils/cors-config.js";

let server: Server;
let port: number;

beforeAll(async () => {
  const app = express();
  app.use(createCorsMiddleware());
  app.get("/check", (_req, res) => res.json({ ok: true }));
  app.use(
    (
      _error: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => res.status(403).json({ error: "cors denied" }),
  );
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("CORS 测试服务器未绑定端口");
  }
  port = address.port;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

afterEach(() => vi.unstubAllEnvs());

function request(origin?: string) {
  return new Promise<{ status: number; allowOrigin?: string }>(
    (resolve, reject) => {
      const outgoing = http.request(
        {
          host: "127.0.0.1",
          port,
          path: "/check",
          headers: origin ? { Origin: origin } : undefined,
        },
        (response) => {
          response.resume();
          response.once("end", () =>
            resolve({
              status: response.statusCode ?? 0,
              allowOrigin: response.headers["access-control-allow-origin"],
            }),
          );
        },
      );
      outgoing.once("error", reject);
      outgoing.end();
    },
  );
}

describe("CORS 代理边界", () => {
  it("生产环境不因后端 socket 来自本机 Nginx 而放行任意来源", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const response = await request("https://attacker.example");
    expect(response.status).toBe(403);
    expect(response.allowOrigin).toBeUndefined();
  });

  it("生产环境允许同源和无 Origin 的内部请求", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const origin = `http://127.0.0.1:${port}`;
    await expect(request(origin)).resolves.toEqual({
      status: 200,
      allowOrigin: origin,
    });
    await expect(request()).resolves.toEqual({
      status: 200,
      allowOrigin: undefined,
    });
  });

  it("开发服务器来源只在非生产环境放行", async () => {
    vi.stubEnv("NODE_ENV", "production");
    expect((await request("http://localhost:5173")).status).toBe(403);
    vi.stubEnv("NODE_ENV", "test");
    expect((await request("http://localhost:5173")).status).toBe(200);
  });

  it("生产环境拒绝会携带凭据的通配来源配置", async () => {
    vi.stubEnv("CORS_ALLOWED_ORIGINS", "*");
    vi.stubEnv("NODE_ENV", "production");
    expect((await request("https://attacker.example")).status).toBe(403);

    vi.stubEnv("NODE_ENV", "test");
    expect((await request("https://dev-tool.example")).status).toBe(200);
  });
});
