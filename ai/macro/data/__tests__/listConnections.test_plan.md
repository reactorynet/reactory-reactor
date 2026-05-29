# Test Plan for List Data Connections Macro

## Test Scenarios
- [x] Utility returns only connection settings and excludes secrets.
- [x] Utility enforces role-based filtering when roles are configured.
- [x] Utility denies role-protected settings when role checker is absent.
- [x] Macro returns error when partner context is missing.
- [x] Macro lists unrestricted and authorized role-protected connections.
- [x] Macro denies unauthorized role-protected connections.
- [x] Macro falls back to state user roles when context role helper is unavailable.
- [x] Macro supports variant and variants filters.
- [x] Registry metadata and tool signature are correct.

## Coverage Targets
- Target: 80% minimum for targeted files
- Current (macro scoped):
	- Lines: 100%
	- Statements: 97.22%
	- Functions: 100%
	- Branches: 90%

## Test Results
- [x] All tests passing (15/15)
- [x] Coverage target met (macro scoped >= 80%)
- [x] Plan updated with results and metrics
