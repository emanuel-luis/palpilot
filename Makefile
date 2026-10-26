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
