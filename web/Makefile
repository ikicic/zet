.PHONY: build watch_style format check-node-modules

build: check-node-modules BUILD/style.json
	npm run build

check-node-modules:
	@if [ ! -d node_modules ]; then \
		echo "node_modules is missing. Run 'npm install' in web/." >&2; \
		exit 1; \
	fi
	@if [ ! -f node_modules/.package-lock.json ] \
		|| [ package-lock.json -nt node_modules/.package-lock.json ] \
		|| [ package.json -nt node_modules/.package-lock.json ]; then \
		echo "node_modules is outdated. Run 'npm install' in web/." >&2; \
		exit 1; \
	fi

BUILD/style.json: templates/liberty.modified.template.json
	mkdir -p BUILD
	(cd .. && ./venv/bin/python3 -m zet.tools.compile_style --minify web/$< --output web/$@)

watch_style:
	(cd .. && ./venv/bin/python3 -m zet.tools.compile_style web/templates/liberty.modified.template.json --output web/BUILD/style.json --watch)

format: check-node-modules
	npx prettier --write "src/**/*.{ts,tsx,css}"
