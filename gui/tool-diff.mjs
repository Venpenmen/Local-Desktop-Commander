// Pure comparison used for real discovery and synthetic mismatch tests.
export function compareTools(expected, actual) {
  const left = new Set(expected), right = new Set(actual);
  if (left.size !== expected.length || right.size !== actual.length)
    throw Error('DUPLICATE_TOOL_NAME');
  return {
    missing: expected.filter(name => !right.has(name)).sort(),
    extra: actual.filter(name => !left.has(name)).sort(),
    equal: left.size === right.size && expected.every(name => right.has(name))
  };
}
