// ---------------------------------------------------------------------------
// A Node resolution hook that mirrors one Metro convention.
//
// React Native source omits the file extension on relative imports
// (`from './sqlite'`); Metro resolves that, Node's ESM loader does not. Rather
// than rewrite every import in the app to suit the test runner, the runner is
// taught the convention.
//
// This is the only build-ish accommodation the suite needs. It changes nothing
// about how the modules behave — only how their paths are spelled.
// ---------------------------------------------------------------------------

export async function resolve(specifier, context, nextResolve) {
  const isRelative = specifier.startsWith('./') || specifier.startsWith('../');
  const hasExtension = /\.(js|mjs|cjs|json)$/.test(specifier);

  if (isRelative && !hasExtension) {
    try {
      return await nextResolve(`${specifier}.js`, context);
    } catch {
      // Fall through to the default behaviour so the real error is reported.
    }
  }

  return nextResolve(specifier, context);
}
