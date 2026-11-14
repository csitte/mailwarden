import { describe, it, expect } from "vitest";
import http from "node:http";
import https from "node:https";

// test/setup.ts cuts the network for the whole run. Without that, the `--auth` tests sent real
// token requests to Google and one of them timed out on CI (see the comment there). These cases
// only hold while the block is in place: delete it and every one of them goes out for real.
describe("the test run has no network", () => {
  it("blocks https.request to Google's token endpoint", () => {
    expect(() => https.request("https://oauth2.googleapis.com/token")).toThrow(/no network in tests.*oauth2\.googleapis\.com/);
  });

  it("blocks the options form too, and https.get", () => {
    expect(() => https.request({ hostname: "gmail.googleapis.com", path: "/" })).toThrow(/gmail\.googleapis\.com/);
    expect(() => https.get({ host: "example.com:443", path: "/" })).toThrow(/example\.com/);
    expect(() => http.request(new URL("http://example.com/"))).toThrow(/example\.com/);
  });

  it("blocks fetch, failing the way an unreachable host does", async () => {
    const err = await fetch("https://oauth2.googleapis.com/token").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TypeError);
    expect((err as TypeError).cause).toMatchObject({ code: "ENETUNREACH" });
  });

  it("leaves loopback open for the servers the tests start themselves", async () => {
    const server = http.createServer((_req, res) => res.end("ok"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = server.address() as { port: number };
      expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe("ok");
      const body = await new Promise<string>((resolve, reject) => {
        http
          .get({ hostname: "127.0.0.1", port, path: "/" }, (res) => {
            let data = "";
            res.on("data", (c) => (data += c));
            res.on("end", () => resolve(data));
          })
          .on("error", reject);
      });
      expect(body).toBe("ok");
    } finally {
      server.close();
    }
  });
});
