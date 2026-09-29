// Fixture for the offline tests: stands in for a web-capability extension so the
// built-in `web` grant resolves to an in-repo path. Never loaded — grants are
// validated by path existence only.
export default function webGrantStub(): void { /* no tools registered */ }
