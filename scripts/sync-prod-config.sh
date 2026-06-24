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
STAGING_DIR="$BACKUP_DIR/staging"

if [[ ! -d "$SOURCE_PROMPTS" ]]; then
  echo "Missing source prompts directory: $SOURCE_PROMPTS" >&2
  exit 1
fi

if [[ ! -f "$SOURCE_CONFIG" ]]; then
  echo "Missing source config file: $SOURCE_CONFIG" >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR" "$STAGING_DIR"
mkdir -p "$STAGING_DIR/$TARGET_PROMPTS"
cp -a "$SOURCE_PROMPTS/." "$STAGING_DIR/$TARGET_PROMPTS/"
cp -a "$SOURCE_CONFIG" "$STAGING_DIR/config.prod.yaml"

if [[ -e "$TARGET_PROMPTS" ]]; then
  mv "$TARGET_PROMPTS" "$BACKUP_DIR/$TARGET_PROMPTS"
fi

if [[ -e "$TARGET_CONFIG" ]]; then
  mkdir -p "$BACKUP_DIR/config"
  mv "$TARGET_CONFIG" "$BACKUP_DIR/$TARGET_CONFIG"
fi

mv "$STAGING_DIR/$TARGET_PROMPTS" "$TARGET_PROMPTS"
mv "$STAGING_DIR/config.prod.yaml" "$TARGET_CONFIG"

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

if ! cmp -s "$SOURCE_CONFIG" "$TARGET_CONFIG"; then
  echo "Config sync verification failed: $SOURCE_CONFIG differs from $TARGET_CONFIG" >&2
  exit 1
fi

echo "Synced $SOURCE_PROMPTS -> $TARGET_PROMPTS"
echo "Synced $SOURCE_CONFIG -> $TARGET_CONFIG"
echo "Backup: $BACKUP_DIR"
