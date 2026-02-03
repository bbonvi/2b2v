QDRANT_CONTAINER := qdrant-test
QDRANT_IMAGE := qdrant/qdrant:latest
QDRANT_URL := http://qdrant-test.orb.local:6333

.PHONY: test test-unit qdrant-up qdrant-down qdrant-ensure check lint

# Run all tests (starts Qdrant if needed)
# Supports: make test, make test src/agent/, make test src/agent/foo.test.ts
test: qdrant-ensure
	QDRANT_URL=$(QDRANT_URL) bun test $(filter-out test,$(MAKECMDGOALS))

# Swallow extra positional args (e.g. file paths after `make test`)
%:
	@:

# Run only non-Qdrant unit tests (no container needed)
# Supports: make test-unit, make test-unit src/agent/, make test-unit src/agent/foo.test.ts
# Excludes *.integration.test.ts files which require Qdrant
UNIT_TEST_FILES := $(shell find src -name '*.test.ts' ! -name '*.integration.test.ts')
test-unit:
	bun test --timeout 5000 $(if $(filter-out test-unit,$(MAKECMDGOALS)),$(filter-out test-unit,$(MAKECMDGOALS)),$(UNIT_TEST_FILES))

# Type-check + lint
check:
	bun run check

lint:
	bun run lint

# Start Qdrant test container if not running
qdrant-ensure:
	@docker inspect -f '{{.State.Running}}' $(QDRANT_CONTAINER) 2>/dev/null | grep -q true \
		|| (echo "Starting $(QDRANT_CONTAINER)..." && \
		    docker run -d --name $(QDRANT_CONTAINER) -p 6333:6333 -p 6334:6334 $(QDRANT_IMAGE) && \
		    echo "Waiting for Qdrant health..." && \
		    until wget -q --spider $(QDRANT_URL)/healthz 2>/dev/null; do sleep 0.5; done && \
		    echo "Qdrant ready.")

# Explicit start/stop
qdrant-up: qdrant-ensure

qdrant-down:
	@docker stop $(QDRANT_CONTAINER) 2>/dev/null; docker rm $(QDRANT_CONTAINER) 2>/dev/null; true
