/**
 * Tests for BOM-based encoding detection.
 */

import { describe, it, expect } from "bun:test";
import { classify } from "../encoding-helper.ts";

describe("encoding classify (BOM sniff)", () => {
  it("plain ASCII → utf-8 supported", () => {
    expect(classify(Buffer.from("hello world\n"))).toEqual({
      encoding: "utf-8",
      supported: true,
    });
  });

  it("utf-8 BOM (EF BB BF) → supported", () => {
    const buf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("hello")]);
    expect(classify(buf)).toEqual({ encoding: "utf-8-bom", supported: true });
  });

  it("utf-16 LE BOM (FF FE) → refused", () => {
    const buf = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("x")]);
    expect(classify(buf)).toEqual({ encoding: "utf-16-le", supported: false });
  });

  it("utf-16 BE BOM (FE FF) → refused", () => {
    const buf = Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from("x")]);
    expect(classify(buf)).toEqual({ encoding: "utf-16-be", supported: false });
  });

  it("utf-32 LE BOM (FF FE 00 00) → refused (not misread as utf-16 LE)", () => {
    const buf = Buffer.from([0xff, 0xfe, 0x00, 0x00, 0x61, 0x00, 0x00, 0x00]);
    expect(classify(buf)).toEqual({ encoding: "utf-32-le", supported: false });
  });

  it("utf-32 BE BOM (00 00 FE FF) → refused", () => {
    const buf = Buffer.from([0x00, 0x00, 0xfe, 0xff, 0x00, 0x00, 0x00, 0x61]);
    expect(classify(buf)).toEqual({ encoding: "utf-32-be", supported: false });
  });

  it("multi-byte UTF-8 content (no BOM) → supported", () => {
    expect(classify(Buffer.from("Tiếng Việt với dấu\n", "utf8"))).toEqual({
      encoding: "utf-8",
      supported: true,
    });
  });

  it("empty buffer → utf-8 supported (no false positive)", () => {
    expect(classify(Buffer.alloc(0))).toEqual({ encoding: "utf-8", supported: true });
  });
});
