# Demo recording instructions

The `demo.sh` script in this folder drives a scripted 60-90s walkthrough suitable for asciinema. Three steps to record + publish:

## 1. Install asciinema

```bash
# macOS
brew install asciinema

# Linux
sudo apt install asciinema   # Ubuntu/Debian
pipx install asciinema       # any distro via pip
```

## 2. Record

```bash
cd /path/to/ckforensics
asciinema rec docs/demo.cast \
  --command './scripts/demo.sh' \
  --rows 35 --cols 110 \
  --title "ckforensics — Forensic CLI for Claude Code"
```

The script auto-paces. Hit Ctrl-D (or `exit`) if asciinema doesn't return after demo.sh finishes.

## 3. Publish + embed

```bash
asciinema upload docs/demo.cast
# → returns URL like https://asciinema.org/a/abc123XYZ
```

Then replace `PLACEHOLDER` in the root `README.md` "Demo" section with the cast ID (the path segment after `/a/`).

```markdown
[![asciicast](https://asciinema.org/a/abc123XYZ.svg)](https://asciinema.org/a/abc123XYZ)
```

## Re-recording

The `demo.cast` file is just JSON timing data — version it in git or regenerate freely. Tune pacing via the `SLEEP_*` knobs in `scripts/demo.sh`.

## Self-hosting (optional)

If you'd rather not depend on asciinema.org:

1. Keep `docs/demo.cast` in the repo
2. Use asciinema-player web component on your docs site (GitHub Pages, Mintlify, etc.)
3. Or convert to GIF via `agg demo.cast demo.gif` for Slack/Discord paste
