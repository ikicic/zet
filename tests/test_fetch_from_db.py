from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

from zet.fetcher.fetch_from_db import load_snapshots


class LoadSnapshotsTest(unittest.TestCase):
    def test_missing_database_is_not_created(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'missing.sqlite3'
            with self.assertRaises(sqlite3.OperationalError):
                load_snapshots(str(path))
            self.assertFalse(path.exists())

    def test_reads_existing_database_read_only(self):
        with tempfile.TemporaryDirectory() as directory:
            # URI-sensitive characters must be treated as part of the filename.
            path = Path(directory) / 'recording #1?.sqlite3'
            conn = sqlite3.connect(path)
            for table in ('static_snapshots', 'snapshots'):
                conn.execute(f'CREATE TABLE {table} '
                             '(id INTEGER, fetched_at REAL, gzipped_data BLOB)')
                conn.executemany(f'INSERT INTO {table} VALUES (?, ?, ?)', [
                    (2, 20, b'second'), (1, 10, b'first'), (3, 30, b''),
                ])
            conn.commit()
            conn.close()

            connect = sqlite3.connect

            def verify_read_only(*args, **kwargs):
                connection = connect(*args, **kwargs)
                with self.assertRaisesRegex(sqlite3.OperationalError, 'readonly'):
                    connection.execute('CREATE TABLE forbidden (id INTEGER)')
                return connection

            with patch('zet.fetcher.fetch_from_db.sqlite3.connect',
                       side_effect=verify_read_only):
                static, realtime = load_snapshots(str(path))
            self.assertEqual(static, [(10, b'first'), (20, b'second')])
            self.assertEqual(realtime, static)


if __name__ == '__main__':
    unittest.main()
