from typing import Any
import json

def _format_json(
    data: Any,
    indent_char: str,
    indent: str,
    compact_list_max_len: int,
) -> str:
    if isinstance(data, dict):
        if not data:
            return indent + '{}'

        next_indent = indent + indent_char
        items_str = []
        for key, value in data.items():
            key_json = json.dumps(key)
            value_json = _format_json(
                value, indent_char, next_indent,
                compact_list_max_len - len(indent_char))
            items_str.append(f'{next_indent}{key_json}: {value_json}')

        mid = ',\n'.join(items_str)
        return f'{{{indent}\n{mid}\n{indent}}}'

    elif isinstance(data, list):
        if not data:
            return '[]'

        # Attempt to format as a single-line list
        out = json.dumps(data)
        if len(out) <= compact_list_max_len:
            return out

        # Fallback to multi-line list
        next_indent = indent + indent_char
        items_str = []
        for item in data:
            item_json_formatted = _format_json(
                item, indent_char, next_indent,
                compact_list_max_len - len(indent_char))
            items_str.append(f'{next_indent}{item_json_formatted}')

        mid = ',\n'.join(items_str)
        return f'[\n{mid}\n{indent}]'

    else:
        return json.dumps(data)


def dump_json(
    data: Any,
    indent: int = 2,
    compact_list_max_len: int = 70,
) -> str:
    indent_char = ' ' * indent
    return _format_json(data, indent_char, '', compact_list_max_len)
