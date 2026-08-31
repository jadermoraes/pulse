import { it, expect } from 'vitest';
import { parseStreamId, buildPlayStream, buildRequestStream } from './stream';

it('parses a movie id', () => {
  expect(parseStreamId('tt0111161')).toEqual({ imdbId: 'tt0111161', season: null, episode: null });
});

it('parses an episode id', () => {
  // Stremio addresses episodes as tt<id>:<season>:<episode>. This format is convention rather
  // than documented, and is the first thing to verify against a real client.
  expect(parseStreamId('tt0903747:2:7')).toEqual({ imdbId: 'tt0903747', season: 2, episode: 7 });
});

it('rejects anything that is not a tt id or tt:S:E', () => {
  for (const bad of ['', 'nope', 'tt', 'tt1:2', 'tt1:2:3:4', 'tt1:a:2', '../etc', 'tt1 2']) {
    expect(parseStreamId(bad)).toBeNull();
  }
});

it('rejects a valid id with anything in front of it', () => {
  // Only the ^ anchor rejects these. Task 4 decodes the path segment before calling this, so
  // %2e%2e%2ftt1234 arrives here as ../tt1234.
  for (const bad of ['../tt1234', 'x tt1234', 'evil-tt1234', '/tt1234', 'tt tt1234']) {
    expect(parseStreamId(bad)).toBeNull();
  }
});

it('rejects a trailing newline or a newline-injected suffix', () => {
  // Guards against the `m` flag ever being added to ID_RE: with `m`, `$` matches end-of-line
  // rather than end-of-string, and a newline-separated value would parse as a valid id.
  expect(parseStreamId('tt1234\n')).toBeNull();
  expect(parseStreamId('tt1234\ninjected')).toBeNull();
});

it('rejects a negative or zero season/episode', () => {
  expect(parseStreamId('tt1:0:1')).toBeNull();
  expect(parseStreamId('tt1:1:0')).toBeNull();
  expect(parseStreamId('tt1:-1:1')).toBeNull();
});

it('rejects an unbounded digit run instead of overflowing to Infinity', () => {
  // Number('9'.repeat(400)) is Infinity, and Infinity would reach Jellyfin as `?season=Infinity`.
  expect(parseStreamId('tt1:' + '9'.repeat(400) + ':1')).toBeNull();
  expect(parseStreamId('tt1:1:' + '9'.repeat(400))).toBeNull();
  expect(parseStreamId('tt' + '9'.repeat(400))).toBeNull();
});

it('builds a play stream pointing at pulse, never at jellyfin', () => {
  const s = buildPlayStream('http://pulse:3000', 'tok', 'jf-1', 'Shawshank') as any;
  expect(s.url).toBe('http://pulse:3000/api/_public/addon/tok/play/jf-1');
  // notWebReady because the proxy is plain http on the LAN and the container may not be mp4.
  expect(s.behaviorHints.notWebReady).toBe(true);
  expect(JSON.stringify(s)).not.toContain('api_key');
  // Stremio renders `name` as the badge and `description` as the row's text. The title goes on
  // its own line so the viewer can see WHICH title this row will play — the whole symptom of the
  // lookup bug was a row confidently naming a film the viewer had not opened.
  expect(s.description).toBe('\u25b6 Play from your library\nShawshank');
});

it('builds a request stream that names what it will do', () => {
  const s = buildRequestStream('http://pulse:3000', 'tok', 'movie', 'tt1') as any;
  expect(s.url).toBe('http://pulse:3000/api/_public/addon/tok/request/movie/tt1');
  expect(s.name).toBeTruthy();
  // The viewer's only signal is this text; it must say that selecting it requests the title.
  expect(String(s.description ?? s.title ?? '').toLowerCase()).toContain('request');
  // Two lines: what selecting it does, then why it is offered at all.
  expect(s.description).toBe('\uff0b Request on Pulse\nNot in your library — select to request it');
});
