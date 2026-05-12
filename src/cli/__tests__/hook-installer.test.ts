/**
 * Tests for the Stop-hook installer's pure logic — no filesystem IO.
 */

import { describe, it, expect } from "bun:test";
import {
  installManagedHook,
  uninstallManagedHook,
  isManaged,
  buildHookCommand,
  HOOK_TAG,
  type ClaudeSettings,
} from "../commands/hook.ts";

describe("buildHookCommand", () => {
  it("emits an `mkdir + ingest + review --emit` chain", () => {
    const cmd = buildHookCommand("/tmp/r.md");
    expect(cmd).toContain("mkdir -p");
    expect(cmd).toContain("ckforensics ingest");
    expect(cmd).toContain("ckforensics review --last --emit '/tmp/r.md'");
  });

  it("appends exec command with {path} substitution", () => {
    const cmd = buildHookCommand("/tmp/r.md", "code {path}");
    expect(cmd).toContain("code /tmp/r.md");
  });

  it("expands ~/ in out path", () => {
    const cmd = buildHookCommand("~/notes/r.md");
    // Cross-platform: just verify ~/ was expanded (no literal ~/) and the
    // tail still references notes/r.md (with native separator).
    expect(cmd).not.toContain("~/notes");
    expect(cmd).toMatch(/notes[\\/]r\.md/);
  });
});

describe("installManagedHook", () => {
  it("adds a Stop hook with the managed sentinel", () => {
    const s: ClaudeSettings = {};
    installManagedHook(s, "ckforensics review --last --emit /tmp/r.md");
    expect(s.hooks?.Stop?.[0]?.hooks?.[0]?.comment).toBe(HOOK_TAG);
  });

  it("is idempotent — re-install does not duplicate", () => {
    const s: ClaudeSettings = {};
    installManagedHook(s, "cmd-v1");
    installManagedHook(s, "cmd-v2");
    const managedCount = (s.hooks?.Stop ?? [])
      .flatMap((e) => e.hooks ?? [])
      .filter(isManaged).length;
    expect(managedCount).toBe(1);
    // Latest command wins
    expect(
      (s.hooks?.Stop ?? []).flatMap((e) => e.hooks ?? []).find(isManaged)?.command
    ).toBe("cmd-v2");
  });

  it("preserves other user-configured Stop hooks", () => {
    const s: ClaudeSettings = {
      hooks: {
        Stop: [
          {
            matcher: "",
            hooks: [{ type: "command", command: "user-custom-hook" }],
          },
        ],
      },
    };
    installManagedHook(s, "ckforensics review --last --emit /tmp/r.md");
    const all = (s.hooks?.Stop ?? []).flatMap((e) => e.hooks ?? []);
    expect(all.some((h) => h.command === "user-custom-hook")).toBe(true);
    expect(all.some(isManaged)).toBe(true);
  });

  it("preserves unrelated hook types (PreToolUse etc)", () => {
    const s: ClaudeSettings = {
      hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "x" }] }] },
    };
    installManagedHook(s, "cmd");
    expect((s.hooks as Record<string, unknown>)["PreToolUse"]).toBeDefined();
  });
});

describe("uninstallManagedHook", () => {
  it("removes only managed entries", () => {
    const s: ClaudeSettings = {
      hooks: {
        Stop: [
          {
            matcher: "",
            hooks: [
              { type: "command", command: "user-custom" },
              { type: "command", command: "managed", comment: HOOK_TAG },
            ],
          },
        ],
      },
    };
    const removed = uninstallManagedHook(s);
    expect(removed).toBe(1);
    const all = (s.hooks?.Stop ?? []).flatMap((e) => e.hooks ?? []);
    expect(all).toHaveLength(1);
    expect(all[0]!.command).toBe("user-custom");
  });

  it("returns 0 when no managed entries exist", () => {
    const s: ClaudeSettings = {
      hooks: { Stop: [{ matcher: "", hooks: [{ type: "command", command: "user-only" }] }] },
    };
    expect(uninstallManagedHook(s)).toBe(0);
  });

  it("collapses empty Stop entries after removal", () => {
    const s: ClaudeSettings = {
      hooks: {
        Stop: [
          { matcher: "", hooks: [{ type: "command", command: "managed", comment: HOOK_TAG }] },
        ],
      },
    };
    uninstallManagedHook(s);
    expect(s.hooks?.Stop).toEqual([]);
  });
});

describe("isManaged", () => {
  it("recognizes the tagged comment", () => {
    expect(isManaged({ command: "anything", comment: HOOK_TAG })).toBe(true);
  });

  it("recognizes by command substring as fallback", () => {
    expect(isManaged({ command: "ckforensics review --last --emit foo" })).toBe(true);
  });

  it("does not match unrelated hooks", () => {
    expect(isManaged({ command: "other tool" })).toBe(false);
  });
});
