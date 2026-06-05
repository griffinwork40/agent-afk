const TRUTHY = ["1", "true", "yes", "on"];
const FALSY = ["0", "false", "no", "off"];

export function isEnvTruthy(envVar: string | boolean | undefined): boolean {
  if (!envVar && envVar !== false) return false;
  if (typeof envVar === "boolean") return envVar;
  return TRUTHY.includes(envVar.toLowerCase().trim());
}

export function isEnvDefinedFalsy(envVar: string | boolean | undefined): boolean {
  if (envVar === undefined) return false;
  if (typeof envVar === "boolean") return !envVar;
  if (envVar === "") return false;
  return FALSY.includes(envVar.toLowerCase().trim());
}
