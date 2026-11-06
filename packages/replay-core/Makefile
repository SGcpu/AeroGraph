# Makefile for aerograph.dev/replay-core
# Builds the aerograph-replay-core binary for the current platform and cross-compiled targets.

GO      ?= go
GOOS    ?= $(shell $(GO) env GOOS)
GOARCH  ?= $(shell $(GO) env GOARCH)

BIN_DIR  := bin
BINARY   := aerograph-replay-core
PKG      := aerograph.dev/replay-core

# Current platform
.PHONY: build
build:
	$(GO) build -o $(BIN_DIR)/$(BINARY) .

# Cross-compilation targets
.PHONY: build-all
build-all: build-linux-amd64 build-darwin-arm64 build-windows-amd64

.PHONY: build-linux-amd64
build-linux-amd64:
	GOOS=linux GOARCH=amd64 $(GO) build -o $(BIN_DIR)/$(BINARY)-linux-amd64 .

.PHONY: build-darwin-arm64
build-darwin-arm64:
	GOOS=darwin GOARCH=arm64 $(GO) build -o $(BIN_DIR)/$(BINARY)-darwin-arm64 .

.PHONY: build-windows-amd64
build-windows-amd64:
	GOOS=windows GOARCH=amd64 $(GO) build -o $(BIN_DIR)/$(BINARY)-windows-amd64.exe .

.PHONY: test
test:
	$(GO) test ./... -v -count=1

.PHONY: test-bench
test-bench:
	$(GO) test ./pkg/interceptor/... -bench=. -benchmem -run=^$$ -v

.PHONY: vet
vet:
	$(GO) vet ./...

.PHONY: clean
clean:
	rm -f $(BIN_DIR)/$(BINARY) $(BIN_DIR)/$(BINARY)-*

# CI stub: create a placeholder binary for test environments without Go
.PHONY: stub-binary
stub-binary:
	mkdir -p $(BIN_DIR)
	echo '#!/bin/sh\necho "aerograph-replay-core stub"\nexit 0' > $(BIN_DIR)/$(BINARY)
	chmod +x $(BIN_DIR)/$(BINARY)

.PHONY: tidy
tidy:
	$(GO) mod tidy

.DEFAULT_GOAL := build
