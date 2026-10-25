import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { challengeBytes, parseChallengeBytes } from "../../src/auth/canonical.ts";
import { CONTRACT_DIR, readJson } from "../helpers/contract.ts";
import { deref, doc, jsonSchema, operations, validator } from "../helpers/openapi.ts";

const dir = join(CONTRACT_DIR, "fixtures", "api");
const names = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
const fixtures = names.map((n) => ({ name: n, f: readJson("fixtures", "api", n) }));
const ops = new Map(operations.map((o) => [o.id, o]));

describe("server: contract fixtures parse", () => {
  it("has fixtures", () => expect(fixtures.length).toBeGreaterThanOrEqual(40));

  it.each(fixtures)("$name matches openapi", ({ f }) => {
    expect(f._fixture_header).toMatchObject({ kind: expect.stringMatching(/^(real|synthetic)$/), source: expect.any(String), created: expect.any(String), description: expect.any(String) });
    const o = ops.get(f.operationId);
    expect(o, `operationId ${f.operationId}`).toBeDefined();

    // path params
    for (const [k, v] of Object.entries<string>(f.request?.path ?? {})) {
      const p = o!.op.parameters?.map(deref).find((x: any) => x.name === k && x.in === "path");
      expect(p, `path param ${k}`).toBeDefined();
      expect(validator(p.schema)(v), `path param ${k}`).toEqual([]);
    }
    // query / headers: declared and valid
    const q = new URLSearchParams(f.request?.query ?? "");
    for (const [k, v] of q) {
      const p = o!.op.parameters?.map(deref).find((x: any) => x.name === k && x.in === "query");
      expect(p, `query param ${k}`).toBeDefined();
      expect(validator(p.schema, true)(v), `query ${k}=${v}`).toEqual(f.response.status === 400 ? expect.anything() : []);
    }
    for (const k of Object.keys(f.request?.headers ?? {})) expect(o!.op.parameters?.map(deref).some((x: any) => x.name === k && x.in === "header")).toBe(true);

    // request body
    const rb = jsonSchema(o!.op.requestBody);
    if (f.request?.body !== undefined) {
      expect(rb, "operation takes a body").toBeDefined();
      const errs = validator(rb)(f.request.body);
      if (f.request_invalid) expect(errs, "request must be schema-invalid").not.toEqual([]);
      else expect(errs).toEqual([]);
    } else expect(o!.op.requestBody?.required ?? false).toBe(false);

    // response
    const spec = deref(o!.op.responses[String(f.response.status)]);
    expect(spec, `status ${f.response.status} declared`).toBeDefined();
    const schema = jsonSchema(spec);
    if (schema) expect(validator(schema)(f.response.body)).toEqual([]);
    else expect(typeof f.response.body).toBe("string"); // SSE sample
  });

  it("every operation has a success fixture", () => {
    for (const o of operations) {
      const ok = fixtures.some(({ f }) => f.operationId === o.id && f.response.status >= 200 && f.response.status < 300);
      expect(ok, `${o.id} has no 2xx fixture`).toBe(true);
    }
  });

  it("every error code appears in at least one fixture, and error bodies use only known codes", () => {
    const enumCodes: string[] = doc.components.schemas.ErrorCode.enum;
    const seen = new Set(fixtures.filter(({ f }) => f.response.body?.error).map(({ f }) => f.response.body.error.code));
    expect([...seen].filter((c) => !enumCodes.includes(c))).toEqual([]);
    expect(enumCodes.filter((c) => !seen.has(c))).toEqual([]);
  });

  it("prepare-action challenge bytes equal the canonical bytes of its fields", () => {
    const f = readJson("fixtures", "api", "prepare-action.200.json").response.body;
    const bytes = Buffer.from(f.bytes_b64, "base64");
    expect(Buffer.compare(bytes, Buffer.from(challengeBytes(f.fields)))).toBe(0);
    expect(parseChallengeBytes(bytes)).toEqual(f.fields);
    expect(Number(f.fields.exp)).toBe(f.exp);
    expect(f.action_id).toBe(f.fields.action_id);
  });

  it("create-grant fixture reuses the signed grant vector", () => {
    const g = readJson("signing-vectors.json").grant.find((v: any) => v.id === "grant-valid");
    const body = readJson("fixtures", "api", "create-grant.200.json").request.body;
    expect(body.signature).toBe(g.signature_b64u);
    expect({ id: body.id, scope: body.scope, action: body.action, created: body.created, expires: body.expires, max_uses: body.max_uses }).toEqual({
      id: g.input.id, scope: g.input.scope, action: g.input.action, created: g.input.created, expires: g.input.expires, max_uses: g.input.max_uses,
    });
  });
});
