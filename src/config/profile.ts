import { existsSync } from "fs";
import { join } from "path";

/** Validate and return a filesystem-safe profile name. */
export function validateProfileName(profile: string): string {
  if (!/^[a-z0-9][a-z0-9_-]*$/u.test(profile)) {
    throw new Error("PROFILE must contain only lowercase letters, numbers, underscores, and hyphens");
  }
  return profile;
}

/** Resolve an existing profile config, failing instead of silently loading defaults. */
export function requireProfileConfigPath(profilesDir: string, profile: string): string {
  const configPath = join(profilesDir, validateProfileName(profile), "config.yaml");
  if (!existsSync(configPath)) {
    throw new Error(`Profile "${profile}" config not found at ${configPath}`);
  }
  return configPath;
}
