.PHONY: dev build clean

dev:
	CGO_CFLAGS="-DSQLITE_ENABLE_FTS5" CGO_LDFLAGS="-lm" wails dev

build:
	CGO_CFLAGS="-DSQLITE_ENABLE_FTS5" CGO_LDFLAGS="-lm" wails build

clean:
	rm -rf build/
