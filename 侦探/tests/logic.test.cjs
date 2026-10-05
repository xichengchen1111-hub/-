// Local logic tests: a minimal document stub, not a real-browser/UI test.
// Run: node --test tests/logic.test.cjs
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const key = 'white-oak-detective-demo-v1';

function boot(raw, unavailable = false) {
  const storage = new Map(raw === undefined ? [] : [[key, raw]]);
  const nodes = new Map();
  const listeners = {};
  const node = selector => {
    if (!nodes.has(selector)) nodes.set(selector, {
      innerHTML: '', textContent: '', value: '', isConnected: true,
      classList: {add() {}, remove() {}}, focus() {},
      querySelector: s => node(selector + ' ' + s), querySelectorAll: () => []
    });
    return nodes.get(selector);
  };
  const context = vm.createContext({
    window: {}, document: {querySelector: node, activeElement: null,
      addEventListener: (event, callback) => { listeners[event] = callback; }},
    localStorage: {
      getItem(k) { if (unavailable) throw Error('storage unavailable'); return storage.get(k) ?? null; },
      setItem(k, v) { if (unavailable) throw Error('storage unavailable'); storage.set(k, v); }
    }, setTimeout() {return 1;}, clearTimeout() {}
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'case.js'), 'utf8'), context);
  // Expose closure state only in this in-memory test copy; game files stay intact.
  const source = fs.readFileSync(path.join(root, 'app.js'), 'utf8').replace(
    "\nstate.phase='title';render();",
    "\nwindow.test={actions,unlock,inspect,notebook,render,get state(){return state;}};state.phase='title';render();"
  );
  vm.runInContext(source, context);
  return {...context.window.test, api: context.window.test, C: context.window.CASE,
    node, listeners, storage};
}
function start(g) {
  g.actions.resetconfirm(); g.actions.accept();
  for (let i = 0; i < g.C.intro.length; i++) g.actions.introNext();
  assert.equal(g.api.state.phase, 'investigation');
}
function lock(g, which, value) {
  const error = {textContent: ''};
  g.unlock({dataset: {lock: which}, querySelector: s => s === 'input' ? {value, select() {}} : error});
  return error.textContent;
}

test('title, office invitation and complete introduction', () => {
  const g = boot(); assert.match(g.node('#app').innerHTML, /走进事务所/);
  g.actions.new(); assert.equal(g.api.state.phase, 'hub');
  g.actions.spot('hubcomputer'); assert.match(g.node('#overlay-root').innerHTML, /私人邀请/);
  start(g); assert.equal(g.api.state.room, 'office');
});
test('all rooms, hotspots and evidence can be rendered', () => {
  const g = boot(); start(g);
  for (const [id, room] of Object.entries(g.C.rooms)) {
    g.actions.room(id);
    for (const [spot] of room.spots) { g.actions.spot(spot); g.actions.close(); }
  }
  for (const id of Object.keys(g.C.evidence)) g.inspect(id);
  assert.equal(g.api.state.collected.length, Object.keys(g.C.evidence).length);
});
test('collection is idempotent and laboratory report requires all samples and departure', () => {
  const g = boot(); start(g);
  for (const id of ['body', 'cup', 'water', 'pillbox']) g.inspect(id);
  g.actions.room('hall'); assert.equal(g.api.state.labDone, false);
  g.actions.leaves(); g.actions.leaves();
  assert.equal(g.api.state.collected.filter(x => x === 'bottle').length, 1);
  g.actions.room('office'); assert.equal(g.api.state.labDone, false);
  g.actions.room('hall'); assert.equal(g.api.state.labDone, true);
  g.actions.room('office'); g.actions.room('hall');
  assert.equal(g.api.state.collected.filter(x => x === 'lab').length, 1);
});
test('both locks reject wrong passwords and accept matching clues', () => {
  const g = boot(); start(g);
  for (const [which, code] of [['computer','1114'], ['safe','0617']]) {
    assert.match(lock(g, which, '0000'), /不正确/);
    assert.equal(g.api.state.unlocked[which], undefined);
    lock(g, which, code); assert.equal(g.api.state.unlocked[which], true);
  }
});
test('all interviews and evidence follow-ups are recorded', () => {
  const g = boot(); start(g);
  for (const [person, questions] of Object.entries(g.C.questions)) {
    questions.forEach((_, i) => g.actions.ask(person + ':' + i));
    for (const item of Object.keys(g.C.followups[person])) {
      g.inspect(item); g.node('#show-evidence').value = item; g.actions.showevidence(person);
      assert.equal(g.api.state.asked[person + ':e:' + item].a, g.C.followups[person][item]);
    }
  }
  assert.equal(Object.keys(g.api.state.asked).filter(x => !x.includes(':e:')).length, 24);
});
test('all notebook tabs, comparisons, stars and notes', () => {
  const g = boot(); start(g);
  g.notebook('items'); g.notebook('compare');
  g.inspect('bottle'); g.inspect('seal'); g.actions.star('seal');
  assert.ok(g.api.state.stars.includes('seal'));
  for (const tab of ['items','people','statements','events','compare','notes']) g.notebook(tab);
  g.listeners.input({target: {id:'personal-notes', value:'测试手记 < & >', matches: () => false}});
  g.notebook('notes'); assert.match(g.node('#overlay-root').innerHTML, /测试手记 &lt; &amp; &gt;/);
});
test('dog hints are distinct and capped at three uses', () => {
  const g = boot(); start(g);
  for (let i = 0; i < 4; i++) g.actions.dog();
  assert.equal(g.api.state.dogUses, 3);
  assert.equal(new Set(g.api.state.hinted).size, 3);
});
test('dog does not consume uses when all clue targets are exhausted', () => {
  const g = boot(); start(g);
  for (const id of Object.keys(g.C.evidence)) g.inspect(id);
  lock(g, 'computer', '1114'); g.actions.dog();
  assert.equal(g.api.state.dogUses, 0);
});
test('reload restores room, evidence, interview, notes and lock state', () => {
  const g = boot(); start(g); g.actions.room('butler'); g.inspect('seal');
  g.actions.ask('butler:0'); lock(g,'safe','0617');
  g.listeners.input({target:{id:'personal-notes', value:'存档测试', matches:()=>false}});
  const restored = boot(g.storage.get(key)); restored.actions.continue();
  assert.equal(JSON.stringify(restored.api.state), JSON.stringify(g.api.state));
});
test('correct report, complete ending, archive and replay', () => {
  const g = boot(); start(g); g.inspect('bottle');
  g.actions.reportpick('suspect:butler'); g.actions.reportpick('weapon:bottle');
  g.actions.confirmreport(); g.actions.submitreport();
  assert.match(g.node('#app').innerHTML, /你的判断正确/);
  for (let i = 0; i <= g.C.ending.length; i++) g.actions.endingNext();
  assert.equal(g.api.state.phase, 'closed');
  g.actions.returnhub(); g.actions.spot('archive');
  assert.match(g.node('#overlay-root').innerHTML, /查看结案记录/);
  g.actions.replay(); assert.equal(g.api.state.endingStep, 0);
});
test('incorrect report displays alternate feedback', () => {
  const g = boot(); start(g); g.inspect('knife');
  g.actions.reportpick('suspect:son'); g.actions.reportpick('weapon:knife'); g.actions.submitreport();
  assert.match(g.node('#app').innerHTML, /还有另一层经过/);
});
test('incomplete report stays disabled and invalid report choices are rejected', () => {
  const g = boot(); start(g); g.actions.report();
  assert.match(g.node('#overlay-root').innerHTML, /data-action="confirmreport" disabled/);
  g.actions.reportpick('weapon:bottle'); g.actions.reportpick('suspect:victim');
  assert.equal(g.api.state.report.weapon, null); assert.equal(g.api.state.report.suspect, null);
  g.actions.submitreport(); assert.equal(g.api.state.phase, 'investigation');
});
test('unavailable storage still permits a complete introduction', () => {
  const g = boot(undefined, true); start(g);
  assert.match(g.node('#app').innerHTML, /无法保存进度/);
});
test('restart confirmation can be cancelled without losing progress', () => {
  const g = boot(); start(g); g.inspect('bottle'); g.actions.new(); g.actions.close();
  assert.ok(g.api.state.collected.includes('bottle'));
  g.actions.new(); g.actions.resetconfirm();
  assert.equal(g.api.state.collected.length, 0); assert.equal(g.api.state.phase, 'hub');
});

test('known issue: password return button is implicitly a submit button', () => {
  const g = boot(); start(g); g.actions.spot('computer');
  const html = g.node('#overlay-root').innerHTML;
  assert.match(html, /<form[\s\S]*<button class="" data-action="close">返回<\/button>/);
});
test('known issue: structurally incomplete saved data can crash continue', () => {
  const raw = JSON.stringify({version:1, phase:'investigation', room:'office', collected:[], dogUses:0});
  const g = boot(raw); g.actions.continue();
  assert.throws(() => g.actions.spot('body'));
});
test('known issue: malformed JSON incorrectly marks storage as unavailable', () => {
  const g = boot('{broken'); start(g);
  assert.ok(g.storage.get(key).startsWith('{"version"'));
  assert.match(g.node('#app').innerHTML, /无法保存进度/);
});
