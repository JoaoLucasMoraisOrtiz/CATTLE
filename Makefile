.PHONY: dev build clean

CGOFLAGS = CGO_CFLAGS="-DSQLITE_ENABLE_FTS5" CGO_LDFLAGS="-lm"

export PKG_CONFIG_PATH := /usr/lib/x86_64-linux-gnu/pkgconfig:/usr/share/pkgconfig:$(PKG_CONFIG_PATH)

dev:
	$(CGOFLAGS) wails dev

build:
	$(CGOFLAGS) wails build -s

binary:
	@echo "Building Go binary..."
	$(CGOFLAGS) go build -tags "production webkit2_41" -o build/bin/redo .

clean:
	rm -rf build/
