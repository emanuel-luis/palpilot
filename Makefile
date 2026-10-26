.DEFAULT_GOAL := help
.PHONY: help install lint test tf-check build

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

test: ## Run the Python unit tests (needs the built console in coordinator/) and the frontend tests
	uv run pytest
	cd frontend && npm test

tf-check: ## terraform init (no backend), validate
	terraform init -backend=false -input=false -lockfile=readonly
	terraform validate

build: ## Build the console. REWRITES tracked files in coordinator/ (index.html, assets/)
	cd frontend && npm run build
