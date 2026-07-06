#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

SOURCE_PROMPTS="prompts"
TARGET_PROMPTS="prompts-prod"
SOURCE_CONFIG="config/config.yaml"
TARGET_CONFIG="config/config.prod.yaml"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)-$$"
BACKUP_DIR=".dev/prod-sync-backups/${STAMP}"

if [[ ! -d "$SOURCE_PROMPTS" ]]; then
  echo "Missing source prompts directory: $SOURCE_PROMPTS" >&2
  exit 1
fi

if [[ ! -f "$SOURCE_CONFIG" ]]; then
  echo "Missing source config file: $SOURCE_CONFIG" >&2
  exit 1
fi

if [[ -e "$TARGET_PROMPTS" && ! -d "$TARGET_PROMPTS" ]]; then
  echo "Target prompts path is not a directory: $TARGET_PROMPTS" >&2
  exit 1
fi

if [[ -e "$TARGET_CONFIG" && ! -f "$TARGET_CONFIG" ]]; then
  echo "Target config path is not a file: $TARGET_CONFIG" >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR" "$TARGET_PROMPTS" "$(dirname "$TARGET_CONFIG")"

if [[ -d "$TARGET_PROMPTS" ]]; then
  mkdir -p "$BACKUP_DIR/$TARGET_PROMPTS"
  cp -a "$TARGET_PROMPTS/." "$BACKUP_DIR/$TARGET_PROMPTS/"
fi

if [[ -f "$TARGET_CONFIG" ]]; then
  mkdir -p "$BACKUP_DIR/config"
  cp -a "$TARGET_CONFIG" "$BACKUP_DIR/$TARGET_CONFIG"
fi

rsync -a --delete "$SOURCE_PROMPTS/" "$TARGET_PROMPTS/"
cp "$SOURCE_CONFIG" "$TARGET_CONFIG"

prompt_delta="$(
  comm -3 \
    <(find "$SOURCE_PROMPTS" -type f | sed "s#^$SOURCE_PROMPTS/##" | sort) \
    <(find "$TARGET_PROMPTS" -type f | sed "s#^$TARGET_PROMPTS/##" | sort)
)"

if [[ "$prompt_delta" != "" ]]; then
  echo "Prompt sync verification failed; differing files:" >&2
  echo "$prompt_delta" >&2
  exit 1
fi

if ! diff -qr "$SOURCE_PROMPTS" "$TARGET_PROMPTS" >/dev/null; then
  echo "Prompt sync verification failed: $SOURCE_PROMPTS differs from $TARGET_PROMPTS" >&2
  diff -qr "$SOURCE_PROMPTS" "$TARGET_PROMPTS" >&2 || true
  exit 1
fi

if ! cmp -s "$SOURCE_CONFIG" "$TARGET_CONFIG"; then
  echo "Config sync verification failed: $SOURCE_CONFIG differs from $TARGET_CONFIG" >&2
  exit 1
fi

echo "Synced $SOURCE_PROMPTS -> $TARGET_PROMPTS"
echo "Synced $SOURCE_CONFIG -> $TARGET_CONFIG"
echo "Backup: $BACKUP_DIR"
