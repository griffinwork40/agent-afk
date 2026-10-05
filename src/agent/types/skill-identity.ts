/** Display-only resolved metadata. Never use these fields to execute a skill. */
export interface SkillIdentity {
  name: string;
  purpose?: string;
  arguments?: string;
}
