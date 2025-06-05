"""
Usage:
    python compile_style.py style.template.json --output style.json --watch

This script is used to compile a style template into a style file.

Example json:
{
    "variables": {
        "background-color": "#000000"
    },
    ...
    "layers": [
        {
            "id": "background",
            "type": "background",
            "paint": {
                "background-color": "[[background-color]]"
            }
        },
    ]
}
"""

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable
import argparse
import logging
import json
import time

from zet.utils.json import dump_json

logger = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")


def replace_placeholders(obj: Any, variables: dict[str, str]) -> Any:
    """
    Recursively replaces placeholders in a dictionary or list structure.
    Placeholders are strings like "[[variable_name]]".
    """
    if isinstance(obj, dict):
        return {k: replace_placeholders(v, variables) for k, v in obj.items()}
    elif isinstance(obj, list):
        return [replace_placeholders(item, variables) for item in obj]
    elif isinstance(obj, str):
        if obj.startswith('[[') and obj.endswith(']]') and len(obj) > 4:
            var_name = obj[2:-2]
            if var_name in variables:
                return variables[var_name]  # Return the actual variable type
            else:
                raise ValueError(f"Variable '{var_name}' not found")
        return obj
    else:
        return obj


def process_style(template_data: dict) -> dict:
    assert isinstance(template_data, dict)
    variables_section = template_data.pop('variables', None)
    variables = {}

    if variables_section is None:
        logger.warning(
            "'variables' key not found at the top level of the template")
    elif not isinstance(variables_section, dict):
        logger.error("'variables' should be a dictionary, aborting")
        return template_data
    else:
        variables = variables_section
        logger.info(f"Found {len(variables)} variables to use for replacement.")

    processed_style = replace_placeholders(template_data, variables)
    return processed_style


def watch_file(path: str, callback: Callable[[], None]):
    last_modified = Path(path).stat().st_mtime
    logger.info(f"Watching {path} for changes...")

    try:
        while True:
            current_modified = Path(path).stat().st_mtime
            if current_modified > last_modified:
                logger.info(f"File {path} changed, recompiling...")
                callback()
                last_modified = current_modified
            time.sleep(0.5)
    except KeyboardInterrupt:
        logger.info("\nStopped watching file")


@dataclass
class CmdlineArguments:
    input: str
    output: str
    watch: bool
    minify: bool


def parse_args() -> CmdlineArguments:
    parser = argparse.ArgumentParser(
        description="Compile style.template.json to style.json")
    add = parser.add_argument
    add('input', type=str, help="Input file to use for replacement")
    add('--output', type=str, default='/dev/stdout',
        help="Output file to use for replacement")
    add('--watch', action='store_true', help="Watch for changes and recompile")
    add('--minify', action='store_true', help="Minify the output")

    args = parser.parse_args()
    return CmdlineArguments(input=args.input, output=args.output,
                            watch=args.watch, minify=args.minify)


def main(args: CmdlineArguments):
    def on_change():
        try:
            with open(args.input, 'r', encoding='utf-8') as f:
                style = json.load(f)
            style = process_style(style)
            if args.minify:
                out = json.dumps(style, separators=(',', ':'))
            else:
                out = dump_json(style, indent=2)
            with open(args.output, 'w', encoding='utf-8') as f:
                f.write(out)
        except Exception as e:
            logger.error(f"Error loading and processing style: {e}")
            return

    on_change()
    if args.watch:
        watch_file(args.input, on_change)


if __name__ == '__main__':
    args = parse_args()
    main(args)
