import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { setWorkspaceEnabled } from '../../modules/tool-engine/workspace-state.ts';
import { createShiftHeldStore, listenForShiftKey } from './shift-key-listeners.ts';

const sidePanelSource = readFileSync(new URL('./SidePanel.tsx', import.meta.url), 'utf8');
const modelPickerSource = readFileSync(new URL('./ModelPicker.tsx', import.meta.url), 'utf8');
const modelVisibilitySource = readFileSync(new URL('../settings/ModelVisibilityPanel.tsx', import.meta.url), 'utf8');
const indexCss = readFileSync(new URL('../../index.css', import.meta.url), 'utf8');

type ShiftListenerEvent = { type: string; key?: string; shiftKey?: boolean };
type ShiftListener = (event: ShiftListenerEvent) => void;
type ShiftListenerType = 'keydown' | 'keyup' | 'pointerdown' | 'pointermove' | 'blur';

class KeyTarget {
  private readonly listeners: Record<ShiftListenerType, Set<ShiftListener>> = {
    keydown: new Set<ShiftListener>(),
    keyup: new Set<ShiftListener>(),
    pointerdown: new Set<ShiftListener>(),
    pointermove: new Set<ShiftListener>(),
    blur: new Set<ShiftListener>(),
  };

  addEventListener(type: ShiftListenerType, listener: ShiftListener): void {
    this.listeners[type].add(listener);
  }

  removeEventListener(type: ShiftListenerType, listener: ShiftListener): void {
    this.listeners[type].delete(listener);
  }

  emit(type: ShiftListenerType, props: Omit<ShiftListenerEvent, 'type'> = {}): void {
    const event = { type, ...props };
    for (const listener of this.listeners[type]) listener(event);
  }

  get listenerCount(): number {
    return Object.values(this.listeners).reduce((count, set) => count + set.size, 0);
  }
}

class VisibilityTarget {
  private readonly listeners = new Set<() => void>();

  addEventListener(type: 'visibilitychange', listener: () => void): void {
    assert.equal(type, 'visibilitychange');
    this.listeners.add(listener);
  }

  removeEventListener(type: 'visibilitychange', listener: () => void): void {
    assert.equal(type, 'visibilitychange');
    this.listeners.delete(listener);
  }

  emit(): void {
    for (const listener of this.listeners) listener();
  }

  get listenerCount(): number {
    return this.listeners.size;
  }
}

test('the low-level Shift tracker balances window and document listeners', () => {
  const target = new KeyTarget();
  const visibilityTarget = new VisibilityTarget();
  const states: boolean[] = [];

  for (let cycle = 0; cycle < 3; cycle++) {
    const leave = listenForShiftKey(target, visibilityTarget, (held) => states.push(held));
    assert.equal(target.listenerCount, 5);
    assert.equal(visibilityTarget.listenerCount, 1);
    target.emit('keydown', { key: 'Shift', shiftKey: true });
    target.emit('keyup', { key: 'Shift', shiftKey: false });
    leave();
    assert.equal(target.listenerCount, 0);
    assert.equal(visibilityTarget.listenerCount, 0);
  }

  const unmount = listenForShiftKey(target, visibilityTarget, (held) => states.push(held));
  assert.equal(target.listenerCount, 5);
  assert.equal(visibilityTarget.listenerCount, 1);
  unmount();
  assert.equal(target.listenerCount, 0);
  assert.equal(visibilityTarget.listenerCount, 0);
  assert.deepEqual(states, [true, false, true, false, true, false]);
});

test('Shift keyup with a stale modifier flag (WebKitGTK) still releases', () => {
  const target = new KeyTarget();
  const visibilityTarget = new VisibilityTarget();
  const states: boolean[] = [];
  const stop = listenForShiftKey(target, visibilityTarget, (held) => states.push(held));

  // WebKitGTK reports shiftKey === true on Shift's own keyup even though
  // the key was released; WebView2 reports false there. Both must read as
  // released — trusting the flag is what left the sidebar delete button
  // armed forever on Linux.
  target.emit('keydown', { key: 'Shift', shiftKey: true });
  target.emit('keyup', { key: 'Shift', shiftKey: true });
  target.emit('keydown', { key: 'Shift', shiftKey: true });
  target.emit('keyup', { key: 'Shift', shiftKey: false });
  stop();
  assert.deepEqual(states, [true, false, true, false]);
});

test('non-Shift keys and pointer events re-read the live modifier state', () => {
  const target = new KeyTarget();
  const visibilityTarget = new VisibilityTarget();
  const states: boolean[] = [];
  const stop = listenForShiftKey(target, visibilityTarget, (held) => states.push(held));

  // A Shift keyup that never reaches the page (window unfocused mid-hold,
  // IME grab) self-heals on the next keystroke…
  target.emit('keydown', { key: 'Shift', shiftKey: true });
  target.emit('keydown', { key: 'a', shiftKey: false });
  // A pointer press corrects stale state before its later click handler.
  target.emit('pointerdown', { shiftKey: true });
  // …and on any pointer move — the recovery path a hover-driven arm state
  // actually needs on Wayland, where the webview may never see the blur.
  target.emit('pointermove', { shiftKey: false });
  // Duplicate releases must not re-notify.
  target.emit('pointermove', { shiftKey: false });
  stop();
  assert.deepEqual(states, [true, false, true, false]);
});

test('blur and visibilitychange release the held state', () => {
  const target = new KeyTarget();
  const visibilityTarget = new VisibilityTarget();
  const states: boolean[] = [];
  const stop = listenForShiftKey(target, visibilityTarget, (held) => states.push(held));

  target.emit('keydown', { key: 'Shift', shiftKey: true });
  target.emit('blur');
  target.emit('keydown', { key: 'Shift', shiftKey: true });
  visibilityTarget.emit();
  stop();
  assert.deepEqual(states, [true, false, true, false]);
});

test('one Shift store shares one DOM listener set across every consumer', () => {
  const target = new KeyTarget();
  const visibilityTarget = new VisibilityTarget();
  const store = createShiftHeldStore(target, visibilityTarget);
  const first: boolean[] = [];
  const second: boolean[] = [];
  const stopFirst = store.subscribe(() => first.push(store.getSnapshot()));
  const stopSecond = store.subscribe(() => second.push(store.getSnapshot()));

  assert.equal(target.listenerCount, 5);
  assert.equal(visibilityTarget.listenerCount, 1);
  target.emit('keydown', { key: 'Shift', shiftKey: true });
  target.emit('pointermove', { shiftKey: true });
  stopFirst();
  visibilityTarget.emit();
  stopSecond();

  assert.deepEqual(first, [true]);
  assert.deepEqual(second, [true, false]);
  store.destroy();
  store.destroy();
  assert.equal(target.listenerCount, 0);
  assert.equal(visibilityTarget.listenerCount, 0);
});

test('Shift-gated mutations validate the click event instead of display state', () => {
  const customSkillRow = sourceBetween('function CustomSkillRow', '\n}\n\nexport function SidePanel');
  assert.match(customSkillRow, /onClick=\{\(event\) => \{\s*if \(!event\.shiftKey\)/);
  assert.match(
    modelVisibilitySource,
    /onClick=\{\(event\) => \{\s*if \(event\.shiftKey\) onDelete\(\);\s*else onEdit\(\);/,
  );
  assert.match(modelPickerSource, /if \(e\.shiftKey && onShiftClick\)/);
  assert.equal(modelPickerSource.match(/onShiftClick=\{\(\) => onHide\(m\)\}/g)?.length, 2);
});

function sourceBetween(start: string, end: string, from = 0): string {
  const startAt = sidePanelSource.indexOf(start, from);
  assert.notEqual(startAt, -1, `missing source boundary: ${start}`);
  const endAt = sidePanelSource.indexOf(end, startAt + start.length);
  assert.notEqual(endAt, -1, `missing source boundary: ${end}`);
  return sidePanelSource.slice(startAt, endAt);
}

function whiteboardSection(): string {
  const headingAt = sidePanelSource.indexOf('<h3>{WHITEBOARD_UI_TEXT.title}</h3>');
  assert.notEqual(headingAt, -1, 'missing Whiteboard section heading');
  const sectionAt = sidePanelSource.lastIndexOf(
    "<div className={cn('side-section side-whiteboard-section side-generation-lock-exempt', !toolsDraft.enabled && 'disabled')}>",
    headingAt,
  );
  assert.notEqual(sectionAt, -1, 'missing Whiteboard section boundary');
  const nextSectionAt = sidePanelSource.indexOf(
    "<div className={cn('side-section side-skills-section', !toolsDraft.enabled && 'disabled')}>",
    headingAt + 1,
  );
  assert.notEqual(nextSectionAt, -1, 'missing section after Whiteboard');
  return sidePanelSource.slice(sectionAt, nextSectionAt);
}

test('Workspace activation leaves Web Access off and enables File I/O and Whiteboard', () => {
  const defaults = sourceBetween('const DEFAULT_TOOLS:', '\n};');
  const normalizer = sourceBetween('function withWhiteboardDefault', '\n}');
  assert.match(defaults, /file_io_enabled:\s*false/);
  assert.match(defaults, /whiteboard_enabled:\s*false/);
  assert.match(normalizer, /whiteboard_enabled:\s*tools\.whiteboard_enabled \?\? false/);

  const activated = setWorkspaceEnabled({
    enabled: false,
    web_access_enabled: false,
    web_access_grants_initialized: false,
    tool_grants: [],
    file_io_enabled: false,
    whiteboard_enabled: false,
  }, true);
  assert.equal(activated.enabled, true);
  assert.equal(activated.web_access_enabled, false);
  assert.equal(activated.web_access_grants_initialized, false);
  assert.deepEqual(activated.tool_grants, []);
  assert.equal(activated.file_io_enabled, true);
  assert.equal(activated.whiteboard_enabled, true);
  assert.doesNotMatch(sidePanelSource, /expandWebAccessForFirstActivation/);
  assert.match(sidePanelSource, /if \(v\) setWebAccessCollapsed\(false\)/);
  assert.match(
    sidePanelSource,
    /const expandFileIoForActivation =\s*v && toolsDraft\.file_io_enabled !== true/,
  );
  assert.match(
    sidePanelSource,
    /if \(expandFileIoForActivation\) setDirsCollapsed\(false\)/,
  );
  assert.match(
    sidePanelSource,
    /const expandWhiteboardForActivation =\s*v && toolsDraft\.whiteboard_enabled !== true/,
  );
  assert.match(
    sidePanelSource,
    /if \(expandWhiteboardForActivation\) setWhiteboardCollapsed\(false\)/,
  );
});

test('File I/O and Web Access show the approval note at the category level', () => {
  assert.match(sidePanelSource, /Click Add to add a working directory\./);
  assert.equal(
    sidePanelSource.match(/Checked tools are pre-approved\. No permission popup appears\./g)?.length,
    2,
  );
  assert.equal(sidePanelSource.match(/<ToolGrantNote \/>/g)?.length, 1);
  assert.equal(
    sidePanelSource.match(/<\/ul>\s*<ToolGrantNote \/>/g)?.length,
    1,
    'the File I/O grant note must be at the category level',
  );
});

test('Workspace capability sections use the requested visual order', () => {
  const ordering = indexCss.slice(
    indexCss.indexOf('/* Side-panel section ordering */'),
    indexCss.indexOf('/* Directory radio-list in the File I/O section */'),
  );
  const expected = [
    ['side-file-section', 1],
    ['side-network-section', 2],
    ['side-whiteboard-section', 3],
    ['side-skills-section', 4],
    ['side-shell-section', 5],
  ] as const;

  for (const [className, order] of expected) {
    assert.match(
      ordering,
      new RegExp(`\\.side-body > \\.${className}\\s*\\{\\s*order:\\s*${order};`),
    );
    assert.match(sidePanelSource, new RegExp(`side-section ${className}`));
  }
});

test('Shell describes its binary allowlist without implying binaries are model tools', () => {
  assert.match(sidePanelSource, /Only the following binaries may be executed:/);
  assert.doesNotMatch(sidePanelSource, /exposed to the model along with the following shell binaries/);
});

test('Whiteboard uses the compact collapsible section pattern and remains grant-free', () => {
  const section = whiteboardSection();
  const timeoutHeadingAt = sidePanelSource.indexOf('<h3>Stream idle timeout</h3>');
  const whiteboardHeadingAt = sidePanelSource.indexOf('<h3>{WHITEBOARD_UI_TEXT.title}</h3>');
  const skillsHeadingAt = sidePanelSource.indexOf('<h3>Skills</h3>');
  assert.ok(timeoutHeadingAt < whiteboardHeadingAt && whiteboardHeadingAt < skillsHeadingAt);
  assert.equal(section.match(/<Toggle\b/g)?.length, 1);
  assert.doesNotMatch(section, /<input\b/);
  assert.doesNotMatch(section, /tool_grants|permission|grant/i);
  assert.match(section, /side-section side-whiteboard-section side-generation-lock-exempt/);
  assert.match(section, /className="side-collapse-btn"/);
  assert.match(section, /onClick=\{\(\) => setWhiteboardCollapsed\(\(p\) => !p\)\}/);
  assert.match(section, /aria-label=\{whiteboardCollapsed \? 'Expand Whiteboard' : 'Collapse Whiteboard'\}/);
  assert.doesNotMatch(section, /title=\{whiteboardCollapsed \? 'Expand Whiteboard' : 'Collapse Whiteboard'\}/);
  assert.match(section, /transform: whiteboardCollapsed \? 'rotate\(-90deg\)' : 'rotate\(0deg\)'/);
  assert.match(
    section,
    /!whiteboardCollapsed && \(\s*<div className="side-section-hint-row">\s*<p className="side-section-hint">\{WHITEBOARD_UI_TEXT\.description\}<\/p>/,
  );
  assert.match(section, /className="ghost-btn small"/);
  assert.match(section, /disabled=\{!toolsDraft\.enabled \|\| !toolsDraft\.whiteboard_enabled\}/);
  assert.match(section, /onClick=\{onOpenWhiteboard\}/);
  assert.match(section, /\{WHITEBOARD_UI_TEXT\.open\}/);
  assert.match(section, /checked=\{toolsDraft\.whiteboard_enabled \?\? false\}/);
  assert.match(section, /disabled=\{!toolsDraft\.enabled \|\| locked\}/);
  assert.match(section, /whiteboard_enabled:\s*enabled/);
  assert.match(section, /if \(enabled\) setWhiteboardCollapsed\(false\)/);

  const deactivated = setWorkspaceEnabled({
    enabled: true,
    web_access_grants_initialized: true,
    tool_grants: ['lc_web_fetch'],
    whiteboard_enabled: true,
  }, false);
  assert.equal(deactivated.enabled, false);
  assert.equal(deactivated.whiteboard_enabled, true, 'master off preserves the category choice');
  assert.deepEqual(deactivated.tool_grants, ['lc_web_fetch']);
});

test('Whiteboard stays visually active while generation config siblings remain muted', () => {
  assert.match(indexCss, /\.side-body\.generation-config-locked\s*\{\s*opacity:\s*1/);
  assert.match(
    indexCss,
    /> :not\(\.side-generation-lock-exempt\):not\(\.side-lock-zone\),\s*\.side-body\.generation-config-locked > \.side-lock-zone > \*\s*\{\s*opacity:\s*0\.55/,
  );
  assert.match(
    indexCss,
    /\.side-generation-lock-exempt \.ghost-btn:not\(:disabled\)\s*\{\s*cursor:\s*pointer/,
  );
});

test('Whiteboard uses the same inert generation lock as execution-affecting toggles', () => {
  const section = whiteboardSection();
  const lockZone = sourceBetween('function LockZone', '\n}\n\ninterface SliderProps');
  assert.match(section, /<LockZone locked=\{locked\}>\s*<Toggle/);
  assert.match(lockZone, /inert=\{locked \|\| undefined\}/);
  assert.match(lockZone, /aria-disabled=\{locked \|\| undefined\}/);
  assert.match(
    sidePanelSource,
    /title=\{locked \? ACTIVE_GENERATION_CONFIG_LOCK_MESSAGE : undefined\}/,
  );
});
