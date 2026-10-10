import json
import unittest
from unittest.mock import patch

import zet.webserver.webserver as webserver


class FeedbackTest(unittest.TestCase):
    def setUp(self):
        server_patch = patch.object(
            webserver, 'gtfs_server', webserver.GtfsServer('ws://unused'))
        server_patch.start()
        self.addCleanup(server_patch.stop)
        send_patch = patch.object(webserver, 'send_feedback_email', return_value=True)
        self.send = send_patch.start()
        self.addCleanup(send_patch.stop)
        self.client = webserver.app.test_client()

    def test_diagnostics_are_delivered_without_message_length_truncation(self):
        diagnostics = json.dumps({'error': 'driver failure', 'details': 'x' * 8000})
        message = f'Please help\n\nTehnički podaci:\n{diagnostics}'
        response = self.client.post('/api/feedback', json={
            'message': message,
            'email': 'user@example.org',
            'kind': 'map-error',
        })
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.send.call_args.args[1],
                         f'{message}\n\nE-mail: user@example.org')

    def test_regular_feedback_is_unchanged(self):
        response = self.client.post('/api/feedback', json={'message': 'Hello'})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.send.call_args.args[1], 'Hello')

    def test_invalid_messages_are_rejected_before_sending_or_rate_limit(self):
        for message in [None, {}, [], 123, '   ', 'x' * (webserver.FEEDBACK_MESSAGE_MAX_LENGTH + 1)]:
            with self.subTest(message_type=type(message).__name__):
                response = self.client.post('/api/feedback', json={
                    'message': message,
                })
                self.assertEqual(response.status_code, 400)
        self.send.assert_not_called()
        self.assertEqual(webserver.gtfs_server._feedback_timestamps, [])

    def test_edited_technical_details_are_delivered_as_written(self):
        message = 'Please help\n\nTehnički podaci:\nDevice details removed by user'
        response = self.client.post('/api/feedback', json={
            'message': message,
            'kind': 'map-error',
        })
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.send.call_args.args[1], message)

    def test_message_limit_is_inclusive(self):
        for kind, limit in [('feedback', 1000), ('map-error', 20_000)]:
            with self.subTest(kind=kind):
                response = self.client.post('/api/feedback', json={
                    'message': 'x' * limit,
                    'kind': kind,
                })
                self.assertEqual(response.status_code, 200)

    def test_each_kind_rejects_messages_over_its_limit(self):
        for kind, limit in [('feedback', 1000), ('map-error', 20_000)]:
            with self.subTest(kind=kind):
                response = self.client.post('/api/feedback', json={
                    'message': 'x' * (limit + 1),
                    'kind': kind,
                })
                self.assertEqual(response.status_code, 400)
        self.send.assert_not_called()

    def test_invalid_kind_is_rejected(self):
        for kind in [None, 'unknown', [], {}, True]:
            with self.subTest(kind=kind):
                response = self.client.post('/api/feedback', json={
                    'message': 'Hello', 'kind': kind,
                })
                self.assertEqual(response.status_code, 400)
        self.send.assert_not_called()


if __name__ == '__main__':
    unittest.main()
