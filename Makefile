.PHONY: test test-unit check lint

# Supports: make test, make test src/agent/, make test src/agent/foo.test.ts
test:
	bun test $(filter-out test,$(MAKECMDGOALS))

# Swallow extra positional args (e.g. file paths after `make test`)
%:
	@:

# Supports: make test-unit, make test-unit src/agent/, make test-unit src/agent/foo.test.ts
# Excludes integration tests for faster targeted loops.
UNIT_TEST_FILES := $(shell find src -name '*.test.ts' ! -name '*.integration.test.ts')
test-unit:
	bun test --timeout 5000 $(if $(filter-out test-unit,$(MAKECMDGOALS)),$(filter-out test-unit,$(MAKECMDGOALS)),$(UNIT_TEST_FILES))

# Type-check + lint
check:
	bun run check

lint:
	bun run lint
