/**
 * JSON exporter: wraps any data in the standard ckforensics-export-v1 envelope.
 *
 * Envelope shape:
 *   { "$schema": "ckforensics-export-v1", "generatedAt": ISO, "data": ... }
 *
 * SessionManifest requires special handling: fileChanges is a Map which
 * JSON.stringify does not serialise — converted to an array of entries.
 */

import type { SessionManifest } from "../../audit/manifest-types.ts";

export interface JsonEnvelope {
  $schema: "ckforensics-export-v1";
  generatedAt: string;
  data: unknown;
}

/** Wrap arbitrary data in the export envelope and return as JSON string. */
export function toJsonEnvelope(data: unknown): string {
  const envelope: JsonEnvelope = {
    $schema: "ckforensics-export-v1",
    generatedAt: new Date().toISOString(),
    data,
  };
  return JSON.stringify(envelope, null, 2);
}

/** Serialise a SessionManifest to a JSON-safe object (Map → array). */
export function manifestToJsonSafe(manifest: SessionManifest): unknown {
  return {
    session: manifest.session,
    tokenTotals: manifest.tokenTotals,
    estimatedCostUsd: manifest.estimatedCostUsd,
    subagentSpans: manifest.subagentSpans,
    fileChanges: Array.from(manifest.fileChanges.entries()).map(
      ([path, fc]) => ({
        path,
        isNew: fc.isNew,
        linesAdded: fc.linesAdded,
        linesRemoved: fc.linesRemoved,
        ops: fc.ops,
      })
    ),
    // Omit raw events array — too large for export, use DB directly if needed
    eventCount: manifest.events.length,
  };
}
