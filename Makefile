.DEFAULT_GOAL := help
.PHONY: help install lint test tf-check build lock

help: ## Show this help
	@grep -E '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  %-10s %s\n", $$1, $$2}'

install: ## Install Python dev tools (uv) and frontend deps (npm ci)
	uv sync --locked
	cd frontend && npm ci

lint: ## Same checks as CI lint jobs (ruff, terraform fmt, frontend lint+typecheck; tflint/checkov when installed)
	uv run ruff check .
	uv run ruff format --check .
	terraform fmt -check -recursive
	cd frontend && npm run lint && npm run typecheck
	@if command -v tflint >/dev/null 2>&1; then tflint --init && tflint --recursive; else echo "tflint not installed: skipped (CI runs it)"; fi
	@if command -v uvx >/dev/null 2>&1; then uvx --from checkov==3.3.30 checkov -d . --framework terraform --compact --quiet --baseline .checkov.baseline; else echo "uvx not installed: checkov skipped (CI runs it)"; fi

test: ## Run the Python and frontend unit tests (builds the console first when coordinator/index.html is missing)
	@test -f coordinator/index.html || (cd frontend && npm ci && npm run build)
	uv run pytest
	cd frontend && npm test

tf-check: ## terraform init (no backend), validate
	terraform init -backend=false -input=false -lockfile=readonly
	terraform validate

build: ## Build the console into coordinator/ (index.html, assets/; untracked build output)
	cd frontend && npm run build

lock: ## Regenerate coordinator/requirements.lock (hashed, linux x86_64, Python 3.12) from requirements.txt
	uv pip compile coordinator/requirements.txt --python-version 3.12 --python-platform x86_64-manylinux_2_28 --generate-hashes -o coordinator/requirements.lock

.PHONY: demo analytics-test
ANALYTICS = PYTHONPATH=analytics/src uv run --locked --group analytics
# One reporting window drives the generator and dbt: [PERIOD_START, PERIOD_END), local days.
PERIOD_START ?= 2026-09-01
DAYS ?= 30
PERIOD_END = $(shell date -d "$(PERIOD_START) + $(DAYS) days" +%F)
# Fresh parse and a target under the (gitignored) data dir: an OS switch cannot reuse a stale cache.
DBT = $(ANALYTICS) dbt build --no-partial-parse --project-dir analytics/dbt --profiles-dir analytics/dbt --target-path $(CURDIR)/analytics/data/dbt/target --log-path $(CURDIR)/analytics/data/dbt/logs --vars "{period_start: '$(PERIOD_START)', period_end: '$(PERIOD_END)'}"

demo: ## Analytics demo: generate synthetic history, ingest, dbt build, report
	$(ANALYTICS) python -m palpilot_analytics.generate --start $(PERIOD_START) --days $(DAYS)
	$(ANALYTICS) python -m palpilot_analytics.ingest
	$(DBT)
	$(ANALYTICS) python -m palpilot_analytics.report

analytics-test: ## Analytics tests (includes an end-to-end dbt build)
	$(ANALYTICS) pytest analytics/tests
