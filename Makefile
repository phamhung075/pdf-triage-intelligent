# pdf-triage root makefile.
#
#   make build            -> dist/pdf-triage (static, CGO-free Go binary) + dashboard assets
#   make dev              -> live reload: dashboard watchers + Go backend rebuilt on save (air)
#   make dev-server       -> live reload of the Go backend only
#   make test             -> the Go module's test suite
#   make run-instructions -> how the operator starts the server (the agent never runs it)
#   make clean            -> remove build output
#
# The backend is one Go binary built from the services/pdf-triage-pdf2w submodule
# (composition root cmd/pdf-triage: serve | scan | mcp | vision-lab). The dashboard
# (public/ts -> public/js, public/scss -> public/style.css) is built here by pnpm and
# served as static files by that binary.

PNPM   ?= pnpm
GO     ?= go
DIST   := dist
BINARY := pdf-triage
SUBMODULE := services/pdf-triage-pdf2w
AIR    ?= $(shell which air 2>/dev/null || (test -x $(HOME)/go/bin/air && echo $(HOME)/go/bin/air) || echo air)

.PHONY: build dev dev-server frontend test run-instructions clean

.DEFAULT_GOAL := build

## build: dashboard assets + static Go binary into dist/pdf-triage
build: frontend
	@mkdir -p $(DIST)
	$(MAKE) -C $(SUBMODULE) build DIST=../../$(DIST)

## frontend: compile public/scss -> public/style.css and public/ts -> public/js
frontend:
	$(PNPM) run build:frontend

## dev: live-reloading dev mode (dashboard watchers + Go backend hot-reload on save). The
## operator runs this; the agent never does. Starts the sibling pdf2w extractor if it is not up.
dev:
	@mkdir -p tmp
	@curl -s http://127.0.0.1:3984/health >/dev/null 2>&1 || (test -x ../markdown-extract-service/public/server/bin/pdf2md-server && PORT=3984 ../markdown-extract-service/public/server/bin/pdf2md-server >/dev/null 2>&1 &)
	@trap 'kill 0' EXIT INT TERM; \
	$(PNPM) run watch:css & \
	$(PNPM) run watch:frontend & \
	($(AIR) 2>/dev/null || $(GO) run ./$(SUBMODULE)/cmd/pdf-triage serve)

## dev-server: hot-reload the Go backend only on save
dev-server:
	@curl -s http://127.0.0.1:3984/health >/dev/null 2>&1 || (test -x ../markdown-extract-service/public/server/bin/pdf2md-server && PORT=3984 ../markdown-extract-service/public/server/bin/pdf2md-server >/dev/null 2>&1 &)
	@$(AIR) 2>/dev/null || $(GO) run ./$(SUBMODULE)/cmd/pdf-triage serve

## test: the whole Go module's test suite
test:
	cd $(SUBMODULE) && $(GO) test ./...

## run-instructions: print how the operator starts the server (the agent never starts it)
run-instructions:
	@echo "From the repository root, start the server yourself (the agent never runs it):"
	@echo "    ./$(DIST)/$(BINARY) serve"
	@echo "Other subcommands: scan | mcp | vision-lab"

## clean: remove the root and submodule build output
clean:
	rm -rf $(DIST)
	$(MAKE) -C $(SUBMODULE) clean
