.DEFAULT_GOAL := help
.PHONY: help install lint test tf-check build lock

help: ## Show this help
	@grep -hE '^[a-zA-Z0-9_-]+:.*## ' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  %-16s %s\n", $$1, $$2}'

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

# Diagrams: docs/diagrams/<name>.d2 rendered to <name>.svg (committed). One pinned D2 everywhere.
# Layout engine, themes and padding live in docs/diagrams/_style.d2 (d2-config), so d2 runs in a
# clean environment: D2_* and SCALE variables would override that config. --scale 1 is not a
# d2-config key; it writes the natural width and height, so GitHub never upscales a small diagram.
# These recipes need bash; the other targets keep make's default shell.
.PHONY: d2-install diagrams diagrams-check diagrams-watch
d2-install diagrams diagrams-check diagrams-watch: SHELL := bash
d2-install diagrams diagrams-check diagrams-watch: .SHELLFLAGS := -eu -o pipefail -c
D2_VERSION := 0.9.0
# sha256 of d2-v$(D2_VERSION)-linux-amd64.tar.gz, from the release's SHA256SUMS
D2_SHA256 := 5669ddc46b99e942cc96078f4a4e36d5e62103348f4c05179ede27802fdd87a9
D2_HOME ?= $(HOME)/.local/share/d2/v$(D2_VERSION)
D2 ?= $(D2_HOME)/bin/d2
D2_RUN = env -i PATH="$$PATH" HOME="$$HOME" "$(D2)" --scale 1
DIAGRAMS := $(filter-out docs/diagrams/_%,$(wildcard docs/diagrams/*.d2))

d2-install: ## install the pinned D2 (Linux x86_64) into D2_HOME, checksum verified
	@if [ -x "$(D2_HOME)/bin/d2" ]; then echo "D2 v$(D2_VERSION) already in $(D2_HOME)"; exit 0; fi; \
	[ "$$(uname -sm)" = "Linux x86_64" ] || { echo "d2-install covers Linux x86_64 only;" \
		"install D2 v$(D2_VERSION) yourself and pass D2=/path/to/d2" >&2; exit 1; }; \
	tmp="$$(mktemp -d)"; trap 'rm -rf "$$tmp"' EXIT; \
	curl -fsSLo "$$tmp/d2.tar.gz" \
		"https://github.com/terrastruct/d2/releases/download/v$(D2_VERSION)/d2-v$(D2_VERSION)-linux-amd64.tar.gz"; \
	echo "$(D2_SHA256)  $$tmp/d2.tar.gz" | sha256sum --check --strict; \
	tar -xzf "$$tmp/d2.tar.gz" -C "$$tmp"; \
	mkdir -p "$(D2_HOME)/bin"; \
	install -m 0755 "$$tmp/d2-v$(D2_VERSION)/bin/d2" "$(D2_HOME)/bin/d2"; \
	"$(D2_HOME)/bin/d2" --version

diagrams: ## render docs/diagrams/*.d2 to SVG with the pinned D2 (run make d2-install once)
	@v="$$($(D2_RUN) --version 2>/dev/null || true)"; [ "$$v" = "v$(D2_VERSION)" ] || { \
		echo "need D2 v$(D2_VERSION) at $(D2), found '$${v:-nothing}': run make d2-install" >&2; exit 1; }
	@for f in $(DIAGRAMS); do $(D2_RUN) "$$f" "$${f%.d2}.svg"; done

diagrams-check: diagrams ## render, then fail if a committed SVG is stale, missing or has no source
	@shopt -s nullglob; for s in docs/diagrams/*.svg; do \
		[ -f "$${s%.svg}.d2" ] || { echo "$$s has no .d2 source" >&2; exit 1; }; done
	@changed="$$(git status --porcelain --untracked-files=all -- 'docs/diagrams/*.svg')"; \
	if [ -n "$$changed" ]; then echo "$$changed" >&2; \
		echo "rendered SVGs differ from the committed ones: run make diagrams and commit" >&2; exit 1; fi

diagrams-watch: ## live preview in the browser while editing: make diagrams-watch NAME=architecture
	@# NAME only from the command line: WSL exports NAME (the hostname) into every shell.
	@[ "$(origin NAME)" = "command line" ] && [ -f "docs/diagrams/$(NAME).d2" ] || { \
		echo "usage: make diagrams-watch NAME=<one of: $(basename $(notdir $(DIAGRAMS)))>" >&2; exit 1; }
	$(D2_RUN) --watch --browser "$${BROWSER:-0}" docs/diagrams/$(NAME).d2 docs/diagrams/$(NAME).svg
