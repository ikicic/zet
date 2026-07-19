from dataclasses import dataclass
from email.message import Message
from email.utils import parsedate_to_datetime
from html.parser import HTMLParser
import hashlib
import html
import json
import logging
import os
import re
import threading
import time
from typing import Any, Protocol, TypeAlias
from urllib.error import HTTPError
from urllib.parse import urljoin, urlparse
from urllib.request import HTTPRedirectHandler, Request, build_opener
from xml.etree import ElementTree


NewsJson: TypeAlias = dict[str, str | int]


class RssResponse(Protocol):
    def read(self, size: int = -1) -> bytes: ...

    def geturl(self) -> str: ...

NEWS_FETCH_INTERVAL_SECONDS: int = 5 * 60
RSS_FETCH_TIMEOUT_SECONDS: int = 15
RSS_FETCH_TOTAL_TIMEOUT_SECONDS: int = 20
MAX_RSS_RESPONSE_BYTES: int = 256 * 1024
RSS_READ_CHUNK_BYTES: int = 16 * 1024
MAX_RSS_ITEMS_PER_FEED: int = 100
RSS_FEEDS: tuple[tuple[str, str], ...] = (
    ('traffic', 'https://www.zet.hr/rss_promet.aspx'),
    ('news', 'https://www.zet.hr/rss_novosti.aspx'),
)
MAX_NEWS_ITEMS: int = 30
MAX_NEWS_TITLE_LENGTH: int = 250
MAX_NEWS_URL_LENGTH: int = 2048
MAX_NEWS_SUMMARY_SOURCE_LENGTH: int = 4096
MAX_NEWS_SUMMARY_HTML_LENGTH: int = 8192
MIN_NEWS_TIMESTAMP: int = 0
MAX_NEWS_TIMESTAMP: int = 4_102_444_800  # 2100-01-01

logger = logging.getLogger(__name__)


class HtmlTextExtractor(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.parts: list[str] = []

    def handle_data(self, data: str) -> None:
        self.parts.append(data)

    def text(self) -> str:
        return ' '.join(' '.join(self.parts).split())


def html_to_text(value: str) -> str:
    parser = HtmlTextExtractor()
    parser.feed(html.unescape(value))
    return parser.text()


ALLOWED_RSS_TAGS: set[str] = {
    'strong', 'b', 'em', 'i', 'br', 'p', 'ul', 'ol', 'li'}
DROP_CONTENT_RSS_TAGS: set[str] = {
    'iframe', 'object', 'script', 'style', 'template'}
BLOCK_RSS_TAGS: set[str] = {
    'article', 'blockquote', 'div', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5',
    'h6', 'header', 'section'}
TRAILING_RSS_SPACE: re.Pattern[str] = re.compile(
    r'(?:[\s\u00a0]|<br>)+(?=(?:</(?:strong|b|em|i|p|ul|ol|li)>)*$)')


class SafeHtmlExtractor(HTMLParser):
    """Keep only harmless presentation tags from RSS descriptions."""
    def __init__(self) -> None:
        super().__init__()
        self.parts: list[str] = []
        self.open_tags: list[str] = []
        self.dropped_content_tag: str | None = None

    def handle_starttag(
            self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if self.dropped_content_tag is not None:
            return
        if tag in DROP_CONTENT_RSS_TAGS:
            self.dropped_content_tag = tag
            return
        if tag in BLOCK_RSS_TAGS:
            self._append_line_break()
        if tag == 'br':
            self.parts.append('<br>')
        elif tag in ALLOWED_RSS_TAGS:
            self.parts.append(f'<{tag}>')
            self.open_tags.append(tag)

    def handle_startendtag(
            self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if self.dropped_content_tag is not None:
            return
        if tag == 'br' or tag in BLOCK_RSS_TAGS:
            self.parts.append('<br>')

    def handle_endtag(self, tag: str) -> None:
        if self.dropped_content_tag is not None:
            if tag == self.dropped_content_tag:
                self.dropped_content_tag = None
            return
        if tag in BLOCK_RSS_TAGS:
            self._append_line_break()
        if tag not in self.open_tags:
            return
        # Close any allowed nested tags first, keeping the emitted fragment
        # balanced even if the source RSS has malformed nesting.
        while self.open_tags:
            open_tag = self.open_tags.pop()
            self.parts.append(f'</{open_tag}>')
            if open_tag == tag:
                return

    def handle_data(self, data: str) -> None:
        if self.dropped_content_tag is None:
            self.parts.append(html.escape(data))

    def _append_line_break(self) -> None:
        if self.parts and self.parts[-1] != '<br>':
            self.parts.append('<br>')

    def sanitized_html(self) -> str:
        while self.open_tags:
            self.parts.append(f'</{self.open_tags.pop()}>')
        value = ''.join(self.parts)
        while True:
            value, count = TRAILING_RSS_SPACE.subn('', value)
            if count == 0:
                return value


def sanitize_rss_html(value: str) -> str:
    try:
        parser = SafeHtmlExtractor()
        parser.feed(html.unescape(value))
        parser.close()
        return parser.sanitized_html()
    except Exception as e:
        logger.warning('Could not sanitize RSS HTML; using plain text: %s', e)
        return html.escape(html_to_text(value))


def limit_summary_html(value: str) -> str:
    if len(value) <= MAX_NEWS_SUMMARY_HTML_LENGTH:
        return value
    # Preserve the bound even for text that expands when escaped. Falling back
    # to text keeps the result safe and well-formed.
    return html.escape(html_to_text(value)[:MAX_NEWS_SUMMARY_HTML_LENGTH // 6])


def news_item_id(
        kind: str,
        published_at: int,
        title: str,
        summary_html: str,
        url: str,
) -> str:
    message = json.dumps(
        [kind, published_at, title, summary_html, url],
        ensure_ascii=False,
        separators=(',', ':'),
    ).encode()
    return hashlib.sha256(message).hexdigest()[:32]


def is_zet_url(value: str) -> bool:
    parsed = urlparse(value)
    return (parsed.scheme == 'https'
            and parsed.hostname in {'zet.hr', 'www.zet.hr'})


class ZetRedirectHandler(HTTPRedirectHandler):
    def redirect_request(
            self,
            req: Request,
            fp: Any,
            code: int,
            msg: str,
            headers: Message,
            newurl: str,
    ) -> Request | None:
        redirect_url = urljoin(req.full_url, newurl)
        if not is_zet_url(redirect_url):
            raise HTTPError(
                req.full_url, code, 'RSS redirect outside zet.hr', headers, fp)
        return super().redirect_request(
            req, fp, code, msg, headers, redirect_url)


RSS_OPENER = build_opener(ZetRedirectHandler)


def read_bounded_response(response: RssResponse) -> bytes:
    deadline = time.monotonic() + RSS_FETCH_TOTAL_TIMEOUT_SECONDS
    chunks: list[bytes] = []
    total_size = 0
    while True:
        if time.monotonic() > deadline:
            raise TimeoutError('RSS download exceeded total timeout')
        chunk = response.read(min(
            RSS_READ_CHUNK_BYTES,
            MAX_RSS_RESPONSE_BYTES + 1 - total_size,
        ))
        if not chunk:
            return b''.join(chunks)
        total_size += len(chunk)
        if total_size > MAX_RSS_RESPONSE_BYTES:
            raise ValueError('RSS response exceeds size limit')
        chunks.append(chunk)


@dataclass(frozen=True)
class NewsItem:
    id: str
    kind: str
    published_at: int
    title: str
    summary_html: str
    url: str

    def to_json(self) -> NewsJson:
        return {
            'id': self.id,
            'kind': self.kind,
            'publishedAt': self.published_at,
            'title': self.title,
            'summaryHtml': self.summary_html,
            'url': self.url,
        }


class NewsCache:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._items_by_kind: dict[str, list[NewsItem]] = {
            'traffic': [], 'news': []}
        self._items: list[NewsItem] = []
        self._version = ''
        self._fetched_at = 0

    @staticmethod
    def _parse_feed(url: str, kind: str) -> list[NewsItem]:
        request = Request(url, headers={
            'User-Agent': 'zet.skoljka.org RSS reader (+https://github.com/ikicic/zet)',
        })
        with RSS_OPENER.open(
                request,
                timeout=min(
                    RSS_FETCH_TIMEOUT_SECONDS, RSS_FETCH_TOTAL_TIMEOUT_SECONDS),
        ) as response:
            if not is_zet_url(response.geturl()):
                raise ValueError('RSS response outside zet.hr')
            raw_feed = read_bounded_response(response)
        logger.info('Fetched %s RSS feed (%d bytes)', kind, len(raw_feed))
        root = ElementTree.fromstring(raw_feed)

        if root.tag != 'rss':
            raise ValueError('RSS document has unexpected root element')
        channel = root.find('channel')
        if channel is None:
            raise ValueError('RSS document has no channel element')

        items: list[NewsItem] = []
        # A syntactically valid channel with no items is a genuine empty feed
        # and intentionally replaces the previously cached category.
        item_nodes = channel.findall('item')
        if len(item_nodes) > MAX_RSS_ITEMS_PER_FEED:
            logger.warning('RSS feed has %d items; parsing first %d',
                           len(item_nodes), MAX_RSS_ITEMS_PER_FEED)
        for node in item_nodes[:MAX_RSS_ITEMS_PER_FEED]:
            title = html_to_text(
                node.findtext('title', default=''))[:MAX_NEWS_TITLE_LENGTH]
            link = node.findtext('link', default='').strip()
            published = node.findtext('pubDate', default='').strip()
            if (not title or not link or not published
                    or len(link) > MAX_NEWS_URL_LENGTH
                    or not is_zet_url(link)):
                continue
            try:
                published_at = int(parsedate_to_datetime(published).timestamp())
            except (TypeError, ValueError, IndexError):
                logger.warning('Skipping RSS item with invalid date: %s', published)
                continue
            if not MIN_NEWS_TIMESTAMP <= published_at <= MAX_NEWS_TIMESTAMP:
                logger.warning('Skipping RSS item with out-of-range date: %s',
                               published)
                continue
            summary_html = limit_summary_html(sanitize_rss_html(
                node.findtext(
                    'description', default='')[:MAX_NEWS_SUMMARY_SOURCE_LENGTH]))
            items.append(NewsItem(
                id=news_item_id(kind, published_at, title, summary_html, link),
                kind=kind,
                published_at=published_at,
                title=title,
                summary_html=summary_html,
                url=link,
            ))
        if item_nodes and not items:
            raise ValueError('RSS feed has items but none passed validation')
        return items

    def refresh(self) -> bool:
        fetched: dict[str, list[NewsItem]] = {}
        for kind, url in RSS_FEEDS:
            try:
                logger.info('Fetching %s RSS feed: %s', kind, url)
                fetched[kind] = self._parse_feed(url, kind)
            except Exception as e:
                logger.warning('Failed to fetch %s RSS feed (%s): %s',
                               kind, url, e)

        if not fetched:
            return False

        with self._lock:
            items_by_kind = dict(self._items_by_kind)
        items_by_kind.update(fetched)
        combined_items = sorted(
            items_by_kind['traffic'] + items_by_kind['news'],
            key=lambda item: (item.published_at, item.id), reverse=True)
        unique_items = list({item.id: item for item in reversed(combined_items)}.values())
        combined_items = list(reversed(unique_items))
        if os.environ.get('ZET_DEV') == '1':
            now = int(time.time())
            combined_items.insert(0, NewsItem(
                id=f'dev-news-{now}', kind='traffic', published_at=now,
                title='Testna obavijest',
                summary_html='<strong>Test:</strong> nova obavijest s poslužitelja.',
                url='https://www.zet.hr/'))
        items = combined_items[:MAX_NEWS_ITEMS]
        encoded_items = json.dumps([item.to_json() for item in items], ensure_ascii=False,
                                  sort_keys=True, separators=(',', ':')).encode()
        version = hashlib.sha256(encoded_items).hexdigest()[:16]
        with self._lock:
            self._items_by_kind = items_by_kind
            self._items = items
            changed = version != self._version
            self._version = version
            self._fetched_at = int(time.time())
            if changed:
                logger.info('RSS news changed: %d items in snapshot',
                            len(self._items))
            return changed

    def snapshot(self) -> tuple[str, str] | None:
        with self._lock:
            if not self._version:
                return None
            version, fetched_at, items = self._version, self._fetched_at, list(self._items)
        message = json.dumps({'type': 'news', 'version': version,
                              'fetchedAt': fetched_at,
                              'items': [item.to_json() for item in items]}, separators=(',', ':'))
        return version, message

    def status_message(self) -> str | None:
        with self._lock:
            if not self._version:
                return None
            version = self._version
            latest_at = self._items[0].published_at if self._items else None
        return json.dumps({'type': 'news-status', 'version': version,
                           'latestAt': latest_at}, separators=(',', ':'))
