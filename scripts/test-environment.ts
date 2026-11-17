/** Test configuration admits only explicit optional executables from the application namespace. */
export function offlineTestEnvironment(
  source: NodeJS.ProcessEnv,
  directory: string,
  hook: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(source).filter(
      ([name]) => !/^(?:AI_MODELING_|TRIPO_|MODELING_TEST_|NODE_OPTIONS$)/.test(name),
    ),
  );
  const blender = source.AI_MODELING_TEST_BLENDER ?? source.AI_MODELING_BLENDER;
  if (blender?.trim()) env.AI_MODELING_TEST_BLENDER = blender;
  env.MODELING_TEST_SANDBOX = directory;
  env.NODE_OPTIONS = `--import=${hook}`;
  return env;
}
