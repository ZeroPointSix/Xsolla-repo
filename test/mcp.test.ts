import { describe, expect, it } from "vitest";
import { assertMcpCommandsAllowed, mapMcpInput } from "../src/mcp.js";

describe("MCP request mapping", () => {
  it("maps the public snake_case contract to the core contract", () => {
    expect(
      mapMcpInput({
        repo_path: "/tmp/repo",
        base_ref: "main",
        validation_commands: ["npm test"],
      }),
    ).toEqual({
      repositoryPath: "/tmp/repo",
      baseRef: "main",
      validationCommands: ["npm test"],
    });
  });

  it("allows the default safe validation presets", () => {
    expect(() => assertMcpCommandsAllowed(["npm test", "npm run typecheck"])).not.toThrow();
  });

  it("rejects commands outside the MCP allowlist", () => {
    expect(() => assertMcpCommandsAllowed(["node -e dangerous"])).toThrow(/not allowed/);
  });
});

