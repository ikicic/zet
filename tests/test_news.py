from email.message import Message
import json
from unittest.mock import patch
import unittest
from urllib.error import HTTPError
from urllib.request import Request

from zet.webserver.news import (
    MAX_NEWS_TIMESTAMP,
    MAX_NEWS_SUMMARY_HTML_LENGTH,
    MAX_NEWS_TITLE_LENGTH,
    MAX_RSS_ITEMS_PER_FEED,
    MAX_RSS_RESPONSE_BYTES,
    RSS_FETCH_TIMEOUT_SECONDS,
    NewsItem,
    NewsCache,
    ZetRedirectHandler,
    html_to_text,
    sanitize_rss_html,
)
import zet.webserver.webserver as webserver


class FakeResponse:
    def __init__(self, body: bytes, url: str = 'https://www.zet.hr/rss') -> None:
        self.body = body
        self.url = url
        self.position = 0

    def __enter__(self) -> 'FakeResponse':
        return self

    def __exit__(self, *args: object) -> None:
        pass

    def read(self, size: int = -1) -> bytes:
        if size < 0:
            size = len(self.body) - self.position
        chunk = self.body[self.position:self.position + size]
        self.position += len(chunk)
        return chunk

    def geturl(self) -> str:
        return self.url


class NewsHtmlTest(unittest.TestCase):
    def test_plain_text_decodes_entities_and_removes_tags(self) -> None:
        self.assertEqual(
            html_to_text('<p>  Tram &amp; <strong>bus</strong>  </p>'),
            'Tram & bus',
        )

    def test_sanitizer_keeps_only_allowed_tags_without_attributes(self) -> None:
        self.assertEqual(
            sanitize_rss_html(
                '<p class="message">Hello <strong onclick="bad()">world</strong>'
                '<br data-extra="ignored">&nbsp; </p>'),
            '<p>Hello <strong>world</strong></p>',
        )

    def test_sanitizer_balances_malformed_markup_and_removes_unsafe_tags(self) -> None:
        sanitized = sanitize_rss_html(
            '<p>One <strong>two</p><img src=x onerror="bad()">'
            '<a href="https://example.invalid">three</a><br>&nbsp;')

        self.assertEqual(sanitized, '<p>One <strong>two</strong></p>three')
        self.assertNotIn('<img', sanitized)
        self.assertNotIn('<a ', sanitized)
        self.assertNotIn('onerror', sanitized)

    def test_sanitizer_neutralizes_script_markup(self) -> None:
        sanitized = sanitize_rss_html(
            '<script>alert("bad")</script><em>Still safe</em>')

        self.assertEqual(sanitized, '<em>Still safe</em>')
        self.assertNotIn('<script', sanitized)

    def test_sanitizer_rejects_adversarial_markup(self) -> None:
        cases = {
            '&lt;img src=x onerror=alert(1)&gt;': '',
            '&#60;svg onload=alert(1)&#62;payload&#60;/svg&#62;': 'payload',
            '<a href="javascript:alert(1)"><strong>click</strong></a>':
                '<strong>click</strong>',
            '<style>body{background:url(javascript:alert(1))}</style><b>safe</b>':
                '<b>safe</b>',
            '<iframe src="https://example.invalid">fallback</iframe>after':
                'after',
            '<object data=x>fallback</object><em>safe</em>': '<em>safe</em>',
            '<template><img src=x onerror=alert(1)></template><i>safe</i>':
                '<i>safe</i>',
            '<p><em>open <strong>nested</p> after':
                '<p><em>open <strong>nested</strong></em></p> after',
            '<!-- <img src=x onerror=bad> --><br/>&nbsp; ': '',
        }

        for source, expected in cases.items():
            with self.subTest(source=source):
                sanitized = sanitize_rss_html(source)
                self.assertEqual(sanitized, expected)
                self.assertNotIn('onerror', sanitized)
                self.assertNotIn('javascript:', sanitized)

    def test_sanitizer_keeps_block_boundaries_without_attributes(self) -> None:
        self.assertEqual(
            sanitize_rss_html(
                '<div class="first">first</div><div onclick="bad()">second</div>'),
            'first<br>second',
        )


class NewsFeedParsingTest(unittest.TestCase):
    def test_parse_feed_sanitizes_description_and_skips_invalid_items(self) -> None:
        feed = b'''<?xml version="1.0"?>
            <rss><channel>
              <item>
                <title>  Traffic &amp;amp; works  </title>
                <link>https://www.zet.hr/traffic</link>
                <guid>traffic-1</guid>
                <pubDate>Wed, 16 Jul 2026 12:34:00 +0200</pubDate>
                <description><![CDATA[<p><strong>Important</strong><img src=x onerror=bad><br>&nbsp;</p>]]></description>
              </item>
              <item>
                <title>Wrong host</title>
                <link>https://zet.hr.example.invalid/nope</link>
                <pubDate>Wed, 16 Jul 2026 12:34:00 +0200</pubDate>
              </item>
              <item>
                <title>Wrong date</title>
                <link>https://www.zet.hr/nope</link>
                <pubDate>not a date</pubDate>
              </item>
            </channel></rss>'''
        response = FakeResponse(feed)

        with patch(
                'zet.webserver.news.RSS_OPENER.open', return_value=response) as open_url:
            items = NewsCache._parse_feed('https://www.zet.hr/rss', 'traffic')

        self.assertEqual(len(items), 1)
        self.assertRegex(items[0].id, r'^[0-9a-f]{32}$')
        self.assertEqual(items[0].title, 'Traffic & works')
        self.assertEqual(items[0].summary_html, '<p><strong>Important</strong></p>')
        self.assertEqual(
            open_url.call_args.kwargs['timeout'], RSS_FETCH_TIMEOUT_SECONDS)

    def test_parse_feed_rejects_oversized_and_invalid_documents(self) -> None:
        oversized = FakeResponse(b'x' * (MAX_RSS_RESPONSE_BYTES + 1))
        with patch('zet.webserver.news.RSS_OPENER.open', return_value=oversized):
            with self.assertRaisesRegex(ValueError, 'size limit'):
                NewsCache._parse_feed('https://www.zet.hr/rss', 'traffic')

        invalid = FakeResponse(b'<html><body>error</body></html>')
        with patch('zet.webserver.news.RSS_OPENER.open', return_value=invalid):
            with self.assertRaisesRegex(ValueError, 'unexpected root'):
                NewsCache._parse_feed('https://www.zet.hr/rss', 'traffic')

    def test_parse_feed_limits_item_count_and_field_sizes(self) -> None:
        small_item = '''<item>
            <title>item</title><link>https://www.zet.hr/item</link>
            <pubDate>Wed, 16 Jul 2026 12:34:00 +0200</pubDate>
        </item>'''
        many_items_feed = (
            '<rss><channel>' + small_item * (MAX_RSS_ITEMS_PER_FEED + 1)
            + '</channel></rss>').encode()
        with patch(
                'zet.webserver.news.RSS_OPENER.open',
                return_value=FakeResponse(many_items_feed)):
            items = NewsCache._parse_feed('https://www.zet.hr/rss', 'traffic')
        self.assertEqual(len(items), MAX_RSS_ITEMS_PER_FEED)

        long_fields_feed = f'''<rss><channel><item>
            <title>{'x' * (MAX_NEWS_TITLE_LENGTH + 1)}</title>
            <link>https://www.zet.hr/item</link>
            <pubDate>Wed, 16 Jul 2026 12:34:00 +0200</pubDate>
            <description><![CDATA[{"'" * 6000}]]></description>
        </item></channel></rss>'''.encode()
        with patch(
                'zet.webserver.news.RSS_OPENER.open',
                return_value=FakeResponse(long_fields_feed)):
            items = NewsCache._parse_feed('https://www.zet.hr/rss', 'traffic')
        self.assertEqual(len(items[0].title), MAX_NEWS_TITLE_LENGTH)
        self.assertLessEqual(
            len(items[0].summary_html), MAX_NEWS_SUMMARY_HTML_LENGTH)

    def test_parse_feed_rejects_nonempty_feed_with_no_valid_items(self) -> None:
        feed = b'''<rss><channel><item>
            <title>Future</title><link>https://www.zet.hr/future</link>
            <pubDate>Wed, 16 Jul 2200 12:34:00 +0200</pubDate>
        </item></channel></rss>'''
        with patch(
                'zet.webserver.news.RSS_OPENER.open',
                return_value=FakeResponse(feed)):
            with self.assertRaisesRegex(ValueError, 'none passed validation'):
                NewsCache._parse_feed('https://www.zet.hr/rss', 'traffic')

    def test_refresh_deduplicates_identical_items(self) -> None:
        item = NewsItem('same', 'traffic', MAX_NEWS_TIMESTAMP, 'Title', '',
                        'https://www.zet.hr/item')
        cache = NewsCache()
        with patch.object(
                NewsCache, '_parse_feed', side_effect=[[item, item], []]):
            self.assertTrue(cache.refresh())
        self.assertEqual(cache._items, [item])
        self.assertEqual(
            json.loads(cache.status_message() or '{}'),
            {
                'type': 'news-status',
                'version': cache._version,
                'latestAt': MAX_NEWS_TIMESTAMP,
            },
        )

    def test_failed_category_keeps_last_good_items(self) -> None:
        traffic_item = NewsItem('traffic', 'traffic', 1, 'Traffic', '',
                                'https://www.zet.hr/traffic')
        news_item = NewsItem('news', 'news', 2, 'News', '',
                             'https://www.zet.hr/news')
        cache = NewsCache()
        with patch.object(
                NewsCache, '_parse_feed', side_effect=[[traffic_item], [news_item]]):
            self.assertTrue(cache.refresh())
        with patch.object(
                NewsCache, '_parse_feed', side_effect=[ValueError('bad feed'), [news_item]]):
            self.assertFalse(cache.refresh())

        self.assertEqual(cache._items_by_kind['traffic'], [traffic_item])

    def test_redirect_handler_rejects_non_zet_destinations(self) -> None:
        handler = ZetRedirectHandler()
        with self.assertRaises(HTTPError) as raised:
            handler.redirect_request(
                Request('https://www.zet.hr/rss'),
                None,
                302,
                'Found',
                Message(),
                'http://127.0.0.1/internal',
            )
        raised.exception.close()

    def test_parse_feed_rejects_non_zet_final_response_url(self) -> None:
        response = FakeResponse(
            b'<rss><channel></channel></rss>',
            'http://127.0.0.1/internal',
        )
        with patch('zet.webserver.news.RSS_OPENER.open', return_value=response):
            with self.assertRaisesRegex(ValueError, 'outside zet.hr'):
                NewsCache._parse_feed('https://www.zet.hr/rss', 'traffic')


class NewsHttpTest(unittest.TestCase):
    def setUp(self) -> None:
        self.previous_server = webserver.gtfs_server
        self.server = webserver.GtfsServer('ws://unused')
        self.server.news_cache._version = '0123456789abcdef'
        self.server.news_cache._fetched_at = 1
        self.server.news_cache._items = [NewsItem(
            'item', 'traffic', 1, 'Title', '', 'https://www.zet.hr/item')]
        webserver.gtfs_server = self.server

    def tearDown(self) -> None:
        webserver.gtfs_server = self.previous_server

    def test_news_endpoint_revalidates_with_etag(self) -> None:
        client = webserver.app.test_client()
        response = client.get('/news')

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers['ETag'], '"0123456789abcdef"')
        self.assertEqual(response.headers['Cache-Control'], 'private, no-cache')
        self.assertEqual(response.json['type'], 'news')

        response = client.get(
            '/news', headers={'If-None-Match': '"0123456789abcdef"'})
        self.assertEqual(response.status_code, 304)
        self.assertEqual(response.headers['ETag'], '"0123456789abcdef"')


if __name__ == '__main__':
    unittest.main()
