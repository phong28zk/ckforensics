/**
 * Interactive review TUI — Copilot-style hunk navigator.
 *
 * Keybindings:
 *   y / →    keep current hunk, advance
 *   n        mark revert, advance
 *   s        skip (decision unset), advance
 *   ←        previous hunk
 *   A        approve all (keep all remaining)
 *   R        reject all (revert all remaining)
 *   r        toggle full reasoning view
 *   q        quit and prompt apply / save / discard
 *   ?        toggle help overlay
 */

import React, { useState, useMemo } from "react";
import { relative as pathRelative, basename } from "node:path";
import { Box, Text, useInput, useApp } from "ink";
import type { Hunk, HunkDecision } from "../hunk-types.ts";
import { buildUnifiedDiff } from "../diff-builder.ts";

/** Shorten an absolute path for display: relative-to-cwd if inside, else basename. */
function shortPath(absPath: string): string {
  const rel = pathRelative(process.cwd(), absPath);
  if (!rel.startsWith("..") && !rel.startsWith("/")) return rel || ".";
  return basename(absPath);
}

export type QuitAction = "apply" | "save" | "discard";

export interface ReviewAppProps {
  sessionId: string;
  hunks: Hunk[];
  /** Called when user quits with an action + final decisions. */
  onQuit: (action: QuitAction, decisions: Map<string, HunkDecision>) => void;
}

export function ReviewApp({ sessionId, hunks, onQuit }: ReviewAppProps): React.JSX.Element {
  const { exit } = useApp();
  const [idx, setIdx] = useState(0);
  const [decisions, setDecisions] = useState<Map<string, HunkDecision>>(
    () => new Map(hunks.map((h) => [h.id, h.unreviewable ? "unreviewable" : "keep"]))
  );
  const [showReason, setShowReason] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [quitMenu, setQuitMenu] = useState(false);

  const total = hunks.length;
  const cur = hunks[idx];

  // Pre-compute per-file groupings + first-hunk indices for jump navigation
  const fileGroups = useMemo(() => {
    const groups: Array<{ filePath: string; firstIdx: number; count: number }> = [];
    let lastPath = "";
    hunks.forEach((h, i) => {
      if (h.filePath !== lastPath) {
        groups.push({ filePath: h.filePath, firstIdx: i, count: 1 });
        lastPath = h.filePath;
      } else {
        groups[groups.length - 1]!.count++;
      }
    });
    return groups;
  }, [hunks]);

  const curFileGroupIdx = useMemo(() => {
    if (!cur) return -1;
    return fileGroups.findIndex((g) => g.filePath === cur.filePath);
  }, [fileGroups, cur]);

  const curFileGroup = curFileGroupIdx >= 0 ? fileGroups[curFileGroupIdx] : undefined;

  const counts = useMemo(() => {
    const c = { keep: 0, revert: 0, skip: 0, unreviewable: 0 };
    for (const d of decisions.values()) c[d as keyof typeof c]++;
    return c;
  }, [decisions]);

  function setDecision(id: string, d: HunkDecision): void {
    setDecisions((m) => {
      const next = new Map(m);
      next.set(id, d);
      return next;
    });
  }

  function advance(): void {
    if (idx < total - 1) setIdx(idx + 1);
  }

  useInput((input, key) => {
    if (quitMenu) {
      if (input === "a") { onQuit("apply", decisions); exit(); }
      else if (input === "s") { onQuit("save", decisions); exit(); }
      else if (input === "d" || key.escape) { onQuit("discard", decisions); exit(); }
      return;
    }

    if (input === "?") { setShowHelp((v) => !v); return; }
    if (showHelp) { setShowHelp(false); return; }

    if (input === "q") { setQuitMenu(true); return; }
    if (!cur) return;

    if (input === "r") { setShowReason((v) => !v); return; }

    if (input === "y" || key.rightArrow) {
      if (!cur.unreviewable) setDecision(cur.id, "keep");
      advance();
      return;
    }
    if (input === "n") {
      if (!cur.unreviewable) setDecision(cur.id, "revert");
      advance();
      return;
    }
    if (input === "s") {
      if (!cur.unreviewable) setDecision(cur.id, "skip");
      advance();
      return;
    }
    if (key.leftArrow) {
      if (idx > 0) setIdx(idx - 1);
      return;
    }
    if (input === "f") {
      // Jump to next file's first hunk
      const next = fileGroups[curFileGroupIdx + 1];
      if (next) setIdx(next.firstIdx);
      return;
    }
    if (input === "F") {
      // Jump to previous file's first hunk
      const prev = fileGroups[curFileGroupIdx - 1];
      if (prev) setIdx(prev.firstIdx);
      return;
    }
    // Numeric jump: 1..9 → first hunk of N-th file
    if (input >= "1" && input <= "9") {
      const target = fileGroups[Number(input) - 1];
      if (target) setIdx(target.firstIdx);
      return;
    }
    if (input === "A") {
      // Approve all remaining (keep all from current onwards, excluding unreviewable)
      setDecisions((m) => {
        const next = new Map(m);
        for (let i = idx; i < hunks.length; i++) {
          const h = hunks[i]!;
          if (!h.unreviewable) next.set(h.id, "keep");
        }
        return next;
      });
      setQuitMenu(true);
      return;
    }
    if (input === "R") {
      // Reject all remaining
      setDecisions((m) => {
        const next = new Map(m);
        for (let i = idx; i < hunks.length; i++) {
          const h = hunks[i]!;
          if (!h.unreviewable) next.set(h.id, "revert");
        }
        return next;
      });
      setQuitMenu(true);
      return;
    }
  });

  if (total === 0) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text>No reviewable hunks in session <Text color="cyan">{sessionId}</Text>.</Text>
        <Text dimColor>Press q to exit.</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" padding={1}>
      <HeaderBar
        sessionId={sessionId}
        idx={idx}
        total={total}
        counts={counts}
        curFileGroup={curFileGroup}
        fileTotal={fileGroups.length}
        curFileGroupIdx={curFileGroupIdx}
      />
      {showHelp ? <HelpOverlay /> : quitMenu ? <QuitMenu counts={counts} /> : (
        <>
          <HunkPane hunk={cur!} showReason={showReason} />
          <FooterBar />
        </>
      )}
    </Box>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function HeaderBar({
  sessionId, idx, total, counts, curFileGroup, fileTotal, curFileGroupIdx,
}: {
  sessionId: string;
  idx: number;
  total: number;
  counts: { keep: number; revert: number; skip: number; unreviewable: number };
  curFileGroup?: { filePath: string; firstIdx: number; count: number };
  fileTotal: number;
  curFileGroupIdx: number;
}): React.JSX.Element {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold>ckforensics review — session <Text color="cyan">{sessionId}</Text></Text>
      {curFileGroup ? (
        <Text>
          <Text color="cyan">File {curFileGroupIdx + 1}/{fileTotal}:</Text>{" "}
          {shortPath(curFileGroup.filePath)}{" "}
          <Text dimColor>({curFileGroup.count} hunk{curFileGroup.count > 1 ? "s" : ""})</Text>
        </Text>
      ) : null}
      <Text dimColor>
        Hunk {idx + 1}/{total}  ·  kept {counts.keep}  ·  revert {counts.revert}  ·  skip {counts.skip}
        {counts.unreviewable > 0 ? `  ·  unreviewable ${counts.unreviewable}` : ""}
      </Text>
    </Box>
  );
}

function HunkPane({ hunk, showReason }: { hunk: Hunk; showReason: boolean }): React.JSX.Element {
  const short = shortPath(hunk.filePath);
  const diff = useMemo(
    () => (hunk.unreviewable ? "" : buildUnifiedDiff(hunk, { pathOverride: short })),
    [hunk, short]
  );

  return (
    <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1}>
      <Text>
        <Text color="cyan">{short}</Text>{"  "}
        <Text dimColor>{hunk.type} @ {hunk.timestamp}</Text>
      </Text>
      {hunk.reason ? (
        <Text dimColor>
          Reason: {showReason ? hunk.reason : truncate(hunk.reason, 80)}
          {!showReason && hunk.reason.length > 80 ? "  (r for full)" : ""}
        </Text>
      ) : null}
      <Box flexDirection="column" marginTop={1}>
        {hunk.unreviewable ? (
          <Text color="yellow">[unreviewable: {hunk.unreviewableReason}]</Text>
        ) : (
          <DiffBody diff={diff} />
        )}
      </Box>
    </Box>
  );
}

function DiffBody({ diff }: { diff: string }): React.JSX.Element {
  const lines = diff.split("\n").slice(0, 40); // cap for terminal sanity
  return (
    <Box flexDirection="column">
      {lines.map((line, i) => {
        const color = line.startsWith("+") && !line.startsWith("+++")
          ? "green"
          : line.startsWith("-") && !line.startsWith("---")
            ? "red"
            : line.startsWith("@@")
              ? "cyan"
              : undefined;
        return <Text key={i} color={color}>{line || " "}</Text>;
      })}
    </Box>
  );
}

function FooterBar(): React.JSX.Element {
  return (
    <Box marginTop={1} flexDirection="column">
      <Text dimColor>
        [y]keep  [n]revert  [s]skip  [←/→]hunk  [f/F]file  [1-9]jump  [A]approve-all  [R]reject-all
      </Text>
      <Text dimColor>
        [r]reason  [q]quit  [?]help
      </Text>
    </Box>
  );
}

function HelpOverlay(): React.JSX.Element {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold>Keybindings</Text>
      <Text>  y / →   keep current hunk, advance</Text>
      <Text>  n       revert current hunk, advance</Text>
      <Text>  s       skip (decision unset)</Text>
      <Text>  ←       previous hunk</Text>
      <Text>  f / F   next file / previous file (jumps to first hunk)</Text>
      <Text>  1-9     jump to N-th file's first hunk</Text>
      <Text>  A       approve all remaining (keep)</Text>
      <Text>  R       reject all remaining (revert)</Text>
      <Text>  r       toggle full reasoning</Text>
      <Text>  q       quit menu</Text>
      <Text>  ?       toggle this help</Text>
      <Text dimColor>Press any key to dismiss.</Text>
    </Box>
  );
}

function QuitMenu({ counts }: { counts: { keep: number; revert: number } }): React.JSX.Element {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text bold>Quit — what now?</Text>
      <Text>You have <Text color="green">{counts.keep} keep</Text> and <Text color="red">{counts.revert} revert</Text> decisions.</Text>
      <Text> </Text>
      <Text><Text color="cyan">[a]</Text> apply revert decisions now</Text>
      <Text><Text color="cyan">[s]</Text> save decisions to review.md (apply later)</Text>
      <Text><Text color="cyan">[d]</Text> discard decisions and exit</Text>
    </Box>
  );
}

function truncate(s: string, n: number): string {
  const single = s.replace(/\s+/g, " ").trim();
  if (single.length <= n) return single;
  return single.slice(0, n - 1) + "…";
}
