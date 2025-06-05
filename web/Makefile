.PHONY: npm watch_style

build: node_modules BUILD/style.json
	npm run build

node_modules:
	npm install

BUILD/style.json: templates/liberty.modified.template.json
	mkdir -p BUILD
	(cd .. && ./venv/bin/python3 -m zet.tools.compile_style --minify web/$< --output web/$@)

watch_style:
	(cd .. && ./venv/bin/python3 -m zet.tools.compile_style web/templates/liberty.modified.template.json --output web/BUILD/style.json --watch)
