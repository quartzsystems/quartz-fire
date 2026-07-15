// Test-only ESM resolve hook: let extensionless relative imports (the app's
// bundler-style `./api`) resolve to their `.ts` source, so `node --test
// --experimental-strip-types` can load the real lib modules without a bundler.
export async function resolve(specifier, context, nextResolve) {
  if (/^\.\.?\//.test(specifier) && !/\.[cm]?[jt]sx?$/.test(specifier)) {
    try {
      return await nextResolve(specifier + ".ts", context);
    } catch {
      /* fall through to default resolution */
    }
  }
  return nextResolve(specifier, context);
}
