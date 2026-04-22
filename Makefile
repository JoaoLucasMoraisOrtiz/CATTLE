.PHONY: dev build clean

dev:
	wails dev

build:
	wails build

clean:
	rm -rf build/
