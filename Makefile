VENV_DIR = ./venv
PYTHON = python3
REQUIREMENTS = ./requirements.txt

all: $(VENV_DIR)/bin/activate web/node_modules

$(VENV_DIR)/bin/activate: $(REQUIREMENTS)
	$(PYTHON) -m venv $(VENV_DIR)
	$(VENV_DIR)/bin/pip install -r $(REQUIREMENTS)
	touch $(VENV_DIR)/bin/activate

web/node_modules: web/package.json
	(cd web && npm install)

clean:
	rm -rf $(VENV_DIR)
	rm -rf web/node_modules

.PHONY: all clean
