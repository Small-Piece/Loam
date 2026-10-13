/**
 * Reads the LOAM_<name> environment variable. The old UM_<name> spelling from
 * before the rename is still accepted for the 0.1 releases, so existing
 * scripts keep working; when both are set, LOAM_<name> wins (even if empty).
 */
export function envSetting(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const current = env[`LOAM_${name}`]
  return current !== undefined ? current : env[`UM_${name}`]
}
