const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');
const {TextEncoder, TextDecoder} = require('node:util');
const html = fs.readFileSync('/workspace/musikanalyse.html', 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
function load(name, next, globals = {}) {
  const start = script.indexOf(`function ${name}(`);
  const end = script.indexOf(`function ${next}(`, start);
  assert.notEqual(start, -1, `${name} helper exists`);
  assert.notEqual(end, -1, `${next} helper exists`);
  const declarations = script.slice(start, end);
  return vm.runInNewContext(`${declarations};globalThis.__loaded=${name};globalThis.__loaded`, {TextEncoder, TextDecoder, btoa, atob, URL, ...globals});
}
test('pointer position maps to bounded timeline time', () => {
  const map = load('mapPointerToTime', 'updateSegmentFromDrag');
  assert.equal(map(150, {left: 100, width: 200}, 100), 25);
  assert.equal(map(50, {left: 100, width: 200}, 100), 0);
  assert.equal(map(400, {left: 100, width: 200}, 100), 100);
});
test('drag moves a segment without changing its length and keeps it in bounds', () => {
  const update = load('updateSegmentFromDrag', 'setVideoVisible');
  assert.deepEqual({...update({start: 20, end: 40}, 'move', 7, 100)}, {start: 27, end: 47});
  assert.deepEqual({...update({start: 20, end: 40}, 'move', 90, 100)}, {start: 80, end: 100});
});
test('resize enforces a minimum one-second segment', () => {
  const update = load('updateSegmentFromDrag', 'setVideoVisible');
  assert.deepEqual({...update({start: 20, end: 40}, 'start', 50, 100)}, {start: 39, end: 40});
  assert.deepEqual({...update({start: 20, end: 40}, 'end', -50, 100)}, {start: 20, end: 21});
});
test('share state round-trips video and Unicode analysis names', () => {
  const encode = load('encodeAnalysisState', 'decodeAnalysisState');
  const decode = load('decodeAnalysisState', 'toast');
  const state = {version: 1, videoUrl: 'https://youtu.be/_t9t0kZRJ54', duration: 222,
    tracks: [{name: 'Rhythmus 🎵', color: '#ff986b'}], nickname: 'Mia',
    segments: [{name: 'Überleitung', start: 10, end: 30, track: 0}]};
  assert.deepEqual(JSON.parse(JSON.stringify(decode(encode(state)))), state);
});
test('invalid shared state is rejected', () => {
  const decode = load('decodeAnalysisState', 'toast');
  assert.equal(decode('not-valid-base64!'), null);
  assert.equal(decode('e30'), null);
});
test('video visibility toggle updates the panel and accessible button state', () => {
  const setVisible = load('setVideoVisible', 'encodeAnalysisState');
  const classes = new Set();
  const video = {classList: {toggle(name, force) { force ? classes.add(name) : classes.delete(name); }}};
  const attributes = {};
  const button = {textContent: '', setAttribute(name, value) { attributes[name] = value; }};
  setVisible(false, video, button);
  assert.equal(classes.has('is-hidden'), true);
  assert.equal(button.textContent, 'Video einblenden');
  assert.equal(attributes['aria-pressed'], 'false');
  setVisible(true, video, button);
  assert.equal(classes.has('is-hidden'), false);
  assert.equal(button.textContent, 'Video ausblenden');
  assert.equal(attributes['aria-pressed'], 'true');
});
test('analysis share payload includes the trimmed nickname', () => {
  const normalize = load('normalizeNickname', 'fitSegmentsToDuration');
  const build = load('buildAnalysisState', 'layoutSummaryBlocks', {normalizeNickname: normalize});
  const state = build('https://youtu.be/_t9t0kZRJ54', 180, [], [], '  Alex  ');
  assert.deepEqual(JSON.parse(JSON.stringify(state)), {
    version: 1, videoUrl: 'https://youtu.be/_t9t0kZRJ54', duration: 180,
    tracks: [], segments: [], nickname: 'Alex'
  });
});
test('nickname removes all whitespace and is limited to eight characters', () => {
  const normalize = load('normalizeNickname', 'fitSegmentsToDuration');
  assert.equal(normalize(' Ab c\tDe123456 '), 'AbcDe123');
  assert.equal(normalize('   '), '');
});
test('video duration keeps every segment inside the actual timeline', () => {
  const fit = load('fitSegmentsToDuration', 'buildTimelineTicks');
  assert.deepEqual(JSON.parse(JSON.stringify(fit([
    {name: 'A', start: 23, end: 59, track: 1},
    {name: 'B', start: 60, end: 94, track: 2}
  ], 50))), [
    {name: 'A', start: 23, end: 50, track: 1},
    {name: 'B', start: 49, end: 50, track: 2}
  ]);
});
test('timeline ticks end at the actual video duration', () => {
  const fmt = value => `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(Math.floor(value % 60)).padStart(2, '0')}`;
  const ticks = load('buildTimelineTicks', 'getVisibleTickIndexes', {fmt});
  const result = ticks(222);
  assert.equal(result[0].label, '00:00');
  assert.equal(result.at(-1).label, '03:42');
  assert.equal(result.at(-1).position, 100);
  assert.equal(result.length, 15);
});
test('timeline labels thin out by repeated halving when their measured gaps overlap', () => {
  const stride = load('getTimelineTickStride', 'getResizeHandleWidth');
  const visible = load('getVisibleTickIndexes', 'getTimelineTickStride', {getTimelineTickStride: stride});
  assert.deepEqual(JSON.parse(JSON.stringify(visible(15, 960, 70))), [0, 2, 4, 6, 8, 10, 12, 14]);
  assert.deepEqual(JSON.parse(JSON.stringify(visible(15, 400, 70))), [0, 4, 8, 12, 14]);
});
test('resize hit zones shrink with short blocks but stay capped for long blocks', () => {
  const handleWidth = load('getResizeHandleWidth', 'isSegmentActive');
  assert.equal(handleWidth(16), 6);
  assert.equal(handleWidth(80), 20);
  assert.equal(handleWidth(200), 24);
});
test('only the currently playing segment is marked active', () => {
  const isActive = load('isSegmentActive', 'stopPlaybackOnTrackChange');
  const segment = {start: 10, end: 20};
  assert.equal(isActive(segment, 15, true), true);
  assert.equal(isActive(segment, 20, true), false);
  assert.equal(isActive(segment, 15, false), false);
});
test('switching matrix rows stops playback only when the row changes', () => {
  const stopOnChange = load('stopPlaybackOnTrackChange', 'getInitialSegments');
  let stops = 0;
  assert.equal(stopOnChange(2, 1, () => stops++), true);
  assert.equal(stopOnChange(2, 2, () => stops++), false);
  assert.equal(stops, 1);
});
test('the editor starts with exactly two sample blocks', () => {
  const initial = load('getInitialSegments', 'getOverviewHeight');
  assert.equal(initial().length, 2);
  assert.equal(initial()[0].track, 0);
  assert.equal(initial()[1].track, 1);
});
test('analysis categories use the requested fixed labels', () => {
  const categories = load('getSectionCategories', 'buildAnalysisState');
  assert.deepEqual(JSON.parse(JSON.stringify(categories())), [
    'Intro/Break/Outro', 'Strophe', 'Pre-Chorus', 'Chorus', 'Spezial'
  ]);
});
test('the special matrix row offers its default and all alternate labels', () => {
  const options = load('getTrackLabelOptions', 'getSectionCategories');
  assert.deepEqual(JSON.parse(JSON.stringify(options())), [
    'Spezial', 'Bass', 'Gesang', 'Analysebereich', 'Improvisation'
  ]);
});
test('overview blocks share a row unless their times overlap', () => {
  const layout = load('layoutSummaryBlocks', 'selectTrack');
  assert.deepEqual(JSON.parse(JSON.stringify(layout([
    {start: 20, end: 40}, {start: 0, end: 30}, {start: 40, end: 60}
  ]))), [
    {index: 1, row: 0}, {index: 0, row: 1}, {index: 2, row: 0}
  ]);
});
test('overview tolerates slight overlaps but separates substantial overlaps', () => {
  const layout = load('layoutSummaryBlocks', 'selectTrack');
  assert.deepEqual(JSON.parse(JSON.stringify(layout([
    {start: 0, end: 30}, {start: 29, end: 45}, {start: 42, end: 60}
  ], 2))), [
    {index: 0, row: 0}, {index: 1, row: 0}, {index: 2, row: 1}
  ]);
});
test('overview reserves twice a matrix row height and expands for overlap rows', () => {
  const height = load('getOverviewHeight', 'getOverviewRowMetrics');
  assert.equal(height(1), 68);
  assert.equal(height(2), 94);
  assert.equal(height(3), 120);
});
test('overview overflow rows use half-height blocks below the full-height first row', () => {
  const metrics = load('getOverviewRowMetrics', 'createSegmentAt');
  assert.deepEqual(JSON.parse(JSON.stringify(metrics(0))), {top: 2, height: 48});
  assert.deepEqual(JSON.parse(JSON.stringify(metrics(1))), {top: 52, height: 24});
  assert.deepEqual(JSON.parse(JSON.stringify(metrics(2))), {top: 78, height: 24});
});
test('new section uses the selected category and stays within the video duration', () => {
  const create = load('createSegmentAt', 'removeSegmentAt');
  assert.deepEqual({...create(42, 100, 3, 'Chorus')}, {
    name: 'Chorus', start: 42, end: 62, track: 3
  });
  assert.deepEqual({...create(100, 100, 2, 'Pre-Chorus')}, {
    name: 'Pre-Chorus', start: 99, end: 100, track: 2
  });
});
test('one selected section can be deleted without affecting other sections', () => {
  const remove = load('removeSegmentAt', 'renderRuler');
  assert.deepEqual(JSON.parse(JSON.stringify(remove([
    {name: 'A'}, {name: 'B'}, {name: 'C'}
  ], 1))), [{name: 'A'}, {name: 'C'}]);
});
test('section list order follows the blocks current timeline positions', () => {
  const order = load('getOrderedSections', 'getSectionDisplayName');
  assert.deepEqual(JSON.parse(JSON.stringify(order([
    {name: 'Chorus', start: 40}, {name: 'Verse', start: 10}
  ]).map(section => section.name))), ['Verse', 'Chorus']);
});
test('section list label follows the block current matrix row', () => {
  const displayName = load('getSectionDisplayName', 'isOverviewSegmentActive');
  assert.equal(displayName({name: 'Stale label', track: 2}, [
    {name: 'Intro'}, {name: 'Strophe'}, {name: 'Chorus'}
  ]), 'Chorus');
});
test('first-row sections use Intro, Break, and a final Outro label', () => {
  const display = load('getSectionDisplayName', 'isOverviewSegmentActive');
  const tracks = [{name: 'Intro/Break/Outro'}, {name: 'Strophe'}];
  assert.equal(display({name: 'old', start: 0, track: 0}, tracks), 'Intro');
  const sections = [
    {name: 'old', start: 30, track: 0},
    {name: 'old', start: 0, track: 0},
    {name: 'old', start: 20, track: 1},
    {name: 'old', start: 10, track: 0},
  ];
  assert.equal(display(sections[1], tracks, sections), 'Intro');
  assert.equal(display(sections[3], tracks, sections), 'Break');
  assert.equal(display(sections[0], tracks, sections), 'Outro');
  sections.push({name: 'later', start: 40, track: 1});
  assert.equal(display(sections[0], tracks, sections), 'Break');
});
test('only first-row overview blocks receive active highlighting', () => {
  const active = load('isOverviewSegmentActive', 'getInitialSegments', {isSegmentActive: (segment, time, playing) => playing && time >= segment.start && time < segment.end});
  const segment = {start: 10, end: 20};
  assert.equal(active(0, segment, 15, true), true);
  assert.equal(active(1, segment, 15, true), false);
  assert.equal(active(0, segment, 20, true), false);
});
test('font size control never goes below 100% and scales in five-percent increments', () => {
  const clamp = load('clampFontStep', 'fontScaleForStep');
  const scale = load('fontScaleForStep', 'getInitialSegments', {clampFontStep: clamp});
  assert.equal(clamp(-8), 0);
  assert.equal(clamp(12), 10);
  assert.equal(scale(-5), 1);
  assert.equal(scale(0), 1);
  assert.equal(scale(10), 1.5);
});
test('pasting a clipboard link fills the URL without focusing the input', async () => {
  const paste = load('pasteClipboardText', 'normalizeNickname');
  let value = '';
  const result = await paste(async () => '  https://youtu.be/_t9t0kZRJ54  ', text => { value = text; });
  assert.equal(result, true);
  assert.equal(value, 'https://youtu.be/_t9t0kZRJ54');
  assert.equal(await paste(async () => '   ', () => assert.fail('empty clipboard must not replace the URL')), false);
});
test('YouTube link is informational and exposes a clipboard paste control', () => {
  assert.match(html, /<[^>]+id="youtubeUrl"[^>]*class="[^"]*url-display/);
  assert.match(html, /id="pasteUrl"/);
  assert.ok(script.includes("$('#pasteUrl').onclick=async()=>"));
  assert.ok(script.includes('navigator.clipboard.readText()'));
});
test('special track dot stays visible and long labels are clipped in place', () => {
  assert.ok(html.includes('.trackname .dot{display:inline-block;flex:0 0 7px}'));
  assert.ok(html.includes('overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px'));
});
test('font controls use standard buttons and have no explanatory sentence', () => {
  assert.match(html, /id="fontDown"[^>]*>−5<\/button>/);
  assert.match(html, /id="fontUp"[^>]*>\+5<\/button>/);
  assert.ok(!html.includes('Mit A− / A+ lässt sich die Schriftgröße'));
  assert.ok(html.includes('#appTooltip{position:fixed'));
});