/** Public application settings use one namespace; other product variables are not configuration. */
export function environmentValue(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env[`AI_MODELING_${name}`];
}
