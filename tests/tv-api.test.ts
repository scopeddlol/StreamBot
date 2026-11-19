import { test, expect } from "bun:test";
import type { Server } from "node:http";
import { fixture, instance } from "./tv-helpers.js";
import { createTVApp } from "../src/tv/server.js";
test("zero-config HTTP onboarding, protected metadata, persistent sessions, eight UI-addressed instances, secret-safe APIs and CSRF", async () => {
  const { runtime: r, code, cleanup } = fixture();
  const app = createTVApp(r),
    server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  let cookie = "";
  const call = async (
    route: string,
    body?: any,
    method = "POST",
    origin = "http://localhost:3000",
  ) => {
    const res = await fetch(
      base + route,
      body === undefined
        ? { headers: { Cookie: cookie } }
        : {
            method,
            headers: {
              Cookie: cookie,
              Origin: origin,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(body),
          },
    );
    const data = await res.json();
    return { res, data };
  };
  try {
    expect((await call("/healthz")).data).toEqual({ status: "ok" });
    expect((await call("/api/v1/bootstrap/status")).data.initialized).toBe(
      false,
    );
    expect((await call("/api/v1/instances")).res.status).toBe(401);
    expect(
      (
        await call("/api/v1/auth/login", {
          username: "admin",
          password: "admin",
        })
      ).res.status,
    ).toBe(401);
    expect(
      (
        await call(
          "/api/v1/bootstrap/claim",
          {
            code,
            username: "fixture-owner",
            password: "fixture-password-long-enough",
            rightsAccepted: true,
          },
          "POST",
          "https://evil.invalid",
        )
      ).res.status,
    ).toBe(403);
    const claimed = await call("/api/v1/bootstrap/claim", {
      code,
      username: "fixture-owner",
      password: "fixture-password-long-enough",
      rightsAccepted: true,
    });
    expect(claimed.res.status).toBe(201);
    cookie = claimed.res.headers.get("set-cookie")!.split(";")[0];
    expect(claimed.res.headers.get("set-cookie")).toContain("HttpOnly");
    expect((await call("/api/v1/auth/me")).data.user.role).toBe("owner");
    const roomIds: string[] = [];
    for (let i = 0; i < 8; i++) {
      const created = await call("/api/v1/instances", {
        name: `Room ${i}`,
        mode: i < 6 ? "live" : "on-demand",
        transport: "official-control-only",
        guildId: "100000000000000001",
        voiceChannelId: String(200000000000000000n + BigInt(i)),
        credential: `fixture-account-${i}`,
      });
      expect(created.res.status).toBe(200);
      expect(JSON.stringify(created.data)).not.toContain(
        `fixture-account-${i}`,
      );
      roomIds.push(created.data.id);
    }
    expect((await call("/api/v1/instances")).data).toHaveLength(8);
    const config = await call("/api/v1/instances/" + roomIds[0]);
    expect(config.data.secret.configured).toBe(true);
    expect(
      (await call(`/api/v1/instances/${roomIds[0]}/start`, {})).res.status,
    ).toBe(400);
    expect(
      (
        await call(
          "/api/v1/instances",
          { name: "bad" },
          "POST",
          "https://evil.invalid",
        )
      ).res.status,
    ).toBe(403);
    expect((await call("/api/v1/auth/logout", {})).res.status).toBe(200);
    expect((await call("/api/v1/instances")).res.status).toBe(401);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await cleanup();
  }
}, 20000);
