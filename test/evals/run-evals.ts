/**
 * NLU eval harness (PLAN §11.2). Phase 3 fills in the provider call and the
 * case files; until then this exits non-zero with a clear message rather than
 * reporting a pass nobody earned.
 */
const CASES_DIR = new URL('.', import.meta.url).pathname;

function main(): never {
  // eslint-disable-next-line no-console -- this is a CLI, not the Worker.
  console.error(
    [
      'pnpm eval: the NLU provider lands in Phase 3.',
      'Nothing to evaluate yet, so this is a failure rather than a green run.',
      `Case files will live in ${CASES_DIR}`,
    ].join('\n'),
  );
  process.exit(1);
}

main();
