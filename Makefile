# pdf-triage root makefile.
#
#   make build            -> dist/pdf-triage (static, CGO-free Go binary) + dashboard assets
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

.PHONY: build frontend test run-instructions clean

.DEFAULT_GOAL := build

## build: dashboard assets + static Go binary into dist/pdf-triage
build: frontend
	@mkdir -p $(DIST)
	$(MAKE) -C $(SUBMODULE) build DIST=../../$(DIST)

## frontend: compile public/scss -> public/style.css and public/ts -> public/js
frontend:
	$(PNPM) run build:frontend

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
