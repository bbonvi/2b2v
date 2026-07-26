.PHONY: test test-unit check check-profiles lint

# Supports: make test, make test src/agent/, make test src/agent/foo.test.ts
TEST_TARGETS := $(filter-out test,$(MAKECMDGOALS))
TEST_PARALLEL_FLAGS := $(if $(TEST_TARGETS),,--parallel=4 --parallel-delay=0)
test:
	bun test $(TEST_PARALLEL_FLAGS) $(TEST_TARGETS)

# Swallow extra positional args (e.g. file paths after `make test`)
%:
	@:

# Supports: make test-unit, make test-unit src/agent/, make test-unit src/agent/foo.test.ts
# Excludes integration tests for faster targeted loops.
UNIT_TEST_FILES := $(shell find src -name '*.test.ts' ! -name '*.integration.test.ts')
UNIT_TEST_TARGETS := $(filter-out test-unit,$(MAKECMDGOALS))
UNIT_TEST_PARALLEL_FLAGS := $(if $(UNIT_TEST_TARGETS),,--parallel=4 --parallel-delay=0)
test-unit:
	bun test --timeout 5000 $(UNIT_TEST_PARALLEL_FLAGS) $(if $(UNIT_TEST_TARGETS),$(UNIT_TEST_TARGETS),$(UNIT_TEST_FILES))

# Validate the committed profile layout and load both instruction stacks.
check-profiles:
	bun test src/config/profile-layout.test.ts

# Profile validation + type-check + lint
check: check-profiles
	bun run check

lint:
	bun run lint
