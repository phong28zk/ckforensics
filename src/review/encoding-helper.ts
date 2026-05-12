/**
 * Encoding detection via BOM sniffing.
 *
 * ckforensics assumes UTF-8 throughout the pipeline. Files in other encodings
 * (UTF-16 LE/BE, UTF-32, GB18030, Shift-JIS) would corrupt on `readFileSync("utf8")`.
 *
 * Rather than support arbitrary encodings (complexity blowup), we sniff the
 * BOM and refuse non-UTF-8 files with a clear error. UTF-8 BOM is tolerated
 * (stripped on read) since some Windows editors prepend it.
 *
 * BOMs (per RFC 3629 + Unicode):
 *   EF BB BF        UTF-8        (supported, stripped)
 *   FF FE           UTF-16 LE    (refuse)
 *   FE FF           UTF-16 BE    (refuse)
 *   FF FE 00 00     UTF-32 LE    (refuse)
 *   00 00 FE FF     UTF-32 BE    (refuse)
 */

import { readFileSync, existsSync } from "node:fs";

export type Encoding = "utf-8" | "utf-8-bom" | "utf-16-le" | "utf-16-be" | "utf-32-le" | "utf-32-be" | "unknown";

export interface EncodingInfo {
  encoding: Encoding;
  /** True if ckforensics can safely read/write this file. */
  supported: boolean;
}

/** Detect file encoding from BOM. Returns "utf-8" when no BOM (the common case). */
export function detectEncoding(absPath: string): EncodingInfo {
  if (!existsSync(absPath)) return { encoding: "utf-8", supported: true };
  let buf: Buffer;
  try {
    buf = readFileSync(absPath);
  } catch {
    return { encoding: "unknown", supported: false };
  }
  return classify(buf);
}

export function classify(buf: Buffer): EncodingInfo {
  // UTF-32 LE: FF FE 00 00 — check BEFORE UTF-16 LE (which is a prefix)
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xfe && buf[2] === 0x00 && buf[3] === 0x00) {
    return { encoding: "utf-32-le", supported: false };
  }
  if (buf.length >= 4 && buf[0] === 0x00 && buf[1] === 0x00 && buf[2] === 0xfe && buf[3] === 0xff) {
    return { encoding: "utf-32-be", supported: false };
  }
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { encoding: "utf-8-bom", supported: true };
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { encoding: "utf-16-le", supported: false };
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return { encoding: "utf-16-be", supported: false };
  }
  return { encoding: "utf-8", supported: true };
}
