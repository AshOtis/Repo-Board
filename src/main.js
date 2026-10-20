/* Repo Board: a tab that shows the open issues and release health of your GitHub repos, one card per repo. */

const RB_VIEW = 'repo-board-view';
const RB_DEFAULTS = {
  owner: '', token: '', only: '', skip: '', pin: '', obsidianOnly: true, refreshMins: 30,
  layout: 'board', filter: 'all', hideDone: false, cache: null,
  bg: 'none', bgImage: '', bgDim: 35, bgBlur: 0, bgGlow: 35, bgAuroraDim: 50, openOnStart: false,
};
const RB_QUICK_LABELS = ['bug', 'release', 'mobile', 'small', 'idea'];
const RB_LEVEL = { bad: 0, warn: 1, ok: 2, none: 3 };

class RepoBoard extends Plugin {
  async onload() {
    this.d = Object.assign({}, RB_DEFAULTS, await this.loadData());
    this.gh = new RBGitHub(() => this.d.token);
    this.loading = false; this.error = '';
    this.done = new Set();            // issues closed from the board this session ("owner/repo#n")
    this.registerView(RB_VIEW, leaf => new RBView(leaf, this));
    this.addRibbonIcon('kanban-square', 'Open Repo Board', () => this.open());
    this.addCommand({ id: 'open', name: 'Open the board', callback: () => this.open() });
    this.addCommand({ id: 'refresh', name: 'Refresh from GitHub', callback: () => this.refresh(true) });
    this.addSettingTab(new RBSettings(this.app, this));
    // keep it fresh while a board is open
    this.registerInterval(window.setInterval(() => { if (this.views().length && this.stale()) this.refresh(); }, 60000));
    // optional: open the board (or bring it to the front) every time Obsidian starts
    this.app.workspace.onLayoutReady(() => { if (this.d.openOnStart) this.open(); });
  }

  views() { return this.app.workspace.getLeavesOfType(RB_VIEW).map(l => l.view).filter(v => v instanceof RBView); }
  redraw() { this.views().forEach(v => v.render()); }
  save() { return this.saveData(this.d); }

  async open() {
    let leaf = this.app.workspace.getLeavesOfType(RB_VIEW)[0];
    if (!leaf) { leaf = this.app.workspace.getLeaf('tab'); await leaf.setViewState({ type: RB_VIEW, active: true }); }
    this.app.workspace.revealLeaf(leaf);
  }

  stale() {
    if (!this.d.owner) return false;
    if (!this.d.cache || this.d.cache.owner !== this.d.owner) return true;
    if (!this.d.refreshMins) return false;
    return Date.now() - this.d.cache.at > this.d.refreshMins * 60000;
  }

  list(s) { return String(s || '').split(/[\s,]+/).map(x => x.trim().toLowerCase()).filter(Boolean); }

  async refresh(loud) {
    const owner = this.d.owner.trim();
    if (!owner || this.loading) return;
    this.loading = true; this.error = ''; this.redraw();
    try {
      const only = this.list(this.d.only), skip = this.list(this.d.skip);
      let repos = (await this.gh.listRepos(owner)).filter(r => !r.archived && !r.fork);
      if (only.length) repos = repos.filter(r => only.includes(r.name.toLowerCase()));
      repos = repos.filter(r => !skip.includes(r.name.toLowerCase()));
      const out = await rbPool(repos, 4, async r => {
        const manifest = await this.gh.manifest(owner, r.name, r.default_branch);
        if (this.d.obsidianOnly && !manifest) return null;
        const [issues, release] = await Promise.all([
          r.open_issues_count ? this.gh.openIssues(owner, r.name) : Promise.resolve([]),
          manifest ? this.gh.latestRelease(owner, r.name) : Promise.resolve(null),
        ]);
        return {
          name: r.name, title: (manifest && manifest.name) || r.name, url: r.html_url, pushed: Date.parse(r.pushed_at) || 0,
          kind: manifest ? (manifest.id ? 'plugin' : 'theme') : 'repo',
          status: manifest ? rbStatus(manifest, release) : { level: 'none', text: r.description || 'Repository' },
          issues: issues.map(i => ({ n: i.number, title: i.title, url: i.html_url, at: Date.parse(i.created_at) || 0,
            labels: (i.labels || []).map(l => typeof l === 'string' ? { name: l, color: '888888' } : { name: l.name, color: l.color || '888888' }) })),
        };
      });
      this.d.cache = { owner, at: Date.now(), repos: out.filter(Boolean) };
      this.done.clear();
      await this.save();
      if (loud) new Notice('Repo Board: up to date.');
    } catch (e) {
      this.error = e.message || String(e);
      if (loud) new Notice('Repo Board: ' + this.error);
    } finally {
      this.loading = false; this.redraw();
    }
  }

  canWrite() { return !!this.d.token.trim(); }

  // Tick: close the issue on GitHub. Tick again: open it again.
  async toggleIssue(repo, issue) {
    if (!this.canWrite()) { new Notice('Add a GitHub token in Repo Board settings to tick tasks off.'); return; }
    const key = repo.name + '#' + issue.n, closing = !this.done.has(key);
    closing ? this.done.add(key) : this.done.delete(key);
    this.redraw();
    try { await this.gh.setIssueState(this.d.owner.trim(), repo.name, issue.n, closing ? 'closed' : 'open'); }
    catch (e) {
      closing ? this.done.delete(key) : this.done.add(key);
      this.redraw(); new Notice('Repo Board: ' + e.message);
    }
  }

  async addIssue(repo, title, labels) {
    const i = await this.gh.newIssue(this.d.owner.trim(), repo.name, title, labels);
    repo.issues.push({ n: i.number, title: i.title, url: i.html_url, at: Date.now(), labels: (i.labels || []).map(l => ({ name: l.name, color: l.color || '888888' })) });
    await this.save(); this.redraw();
  }
}

// run tasks a few at a time so a big account doesn't fire 50 requests at once
async function rbPool(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); } }));
  return out;
}

// readable text on a GitHub label colour
function rbInk(hex) {
  const n = parseInt(hex, 16); const r = n >> 16 & 255, g = n >> 8 & 255, b = n & 255;
  return (r * 299 + g * 587 + b * 114) / 1000 > 140 ? '#1a1410' : '#fff';
}

class RBView extends ItemView {
  constructor(leaf, plugin) { super(leaf); this.plugin = plugin; }
  getViewType() { return RB_VIEW; }
  getDisplayText() { return 'Repo Board'; }
  getIcon() { return 'kanban-square'; }

  async onOpen() {
    this.contentEl.addClass('rb');
    this.render();
    if (this.plugin.stale()) this.plugin.refresh();
    // the "synced x min ago" line keeps itself current
    this.registerInterval(window.setInterval(() => { if (this.syncEl) this.paintSync(); }, 30000));
  }

  paintSync() {
    const p = this.plugin, c = p.d.cache;
    this.syncEl.empty();
    this.syncEl.createSpan({ text: p.d.owner + ' · ' });
    if (p.loading) this.syncEl.createSpan({ cls: 'rb-busy', text: 'syncing…' });
    else if (p.error) this.syncEl.createSpan({ cls: 'rb-err', text: p.error });
    else if (c) this.syncEl.createSpan({ cls: 'rb-ok', text: 'synced ' + rbAgo(c.at) });
    const rf = this.syncEl.createEl('button', { cls: 'rb-icon', attr: { 'aria-label': 'Refresh from GitHub' } });
    setIcon(rf, 'refresh-cw'); rf.onclick = () => p.refresh(true);
    if (!p.canWrite()) this.syncEl.createSpan({ cls: 'rb-hint', text: ' · read only' });
  }

  render() {
    const p = this.plugin, d = p.d, el = this.contentEl;
    el.empty();
    this.paintBackground();
    const wrap = el.createDiv({ cls: 'rb-wrap' });

    if (!d.owner) {
      const e = wrap.createDiv({ cls: 'rb-empty' });
      e.createEl('h2', { text: 'Repo Board' });
      e.createEl('p', { text: 'Shows the open issues and release health of your GitHub repos, one card each.' });
      const b = e.createEl('button', { cls: 'mod-cta', text: 'Set your GitHub name' });
      b.onclick = () => { this.app.setting.open(); this.app.setting.openTabById(p.manifest.id); };
      return;
    }

    // pinned repos come first, in the order you typed them; then problems first, as before
    const pins = p.list(d.pin), pinAt = r => { const i = pins.indexOf(r.name.toLowerCase()); return i < 0 ? 1e9 : i; };
    const repos = ((d.cache && d.cache.owner === d.owner && d.cache.repos) || []).slice()
      .sort((a, b) => (pinAt(a) - pinAt(b)) || (RB_LEVEL[a.status.level] - RB_LEVEL[b.status.level]) || (b.issues.length - a.issues.length) || (b.pushed - a.pushed));
    const isDone = (r, i) => p.done.has(r.name + '#' + i.n);
    const open = repos.reduce((n, r) => n + r.issues.filter(i => !isDone(r, i)).length, 0);

    // header
    const top = wrap.createDiv({ cls: 'rb-top' });
    const left = top.createDiv();
    left.createEl('h1', { text: 'Repo Board' });
    this.syncEl = left.createDiv({ cls: 'rb-sync' }); this.paintSync();
    const stats = top.createDiv({ cls: 'rb-stats' });
    const stat = (n, l, cls) => { const s = stats.createDiv({ cls: 'rb-stat ' + (n && cls ? cls : '') }); s.createDiv({ cls: 'rb-n', text: String(n) }); s.createDiv({ cls: 'rb-l', text: l }); };
    stat(open, 'open tasks');
    stat(repos.filter(r => r.status.waiting).length, 'releases waiting', 'is-warn');
    stat(repos.filter(r => r.status.level === 'bad').length, 'checks failing', 'is-bad');

    // filters: the quick labels, plus any other label you use a lot
    const counts = {};
    repos.forEach(r => r.issues.forEach(i => i.labels.forEach(l => { counts[l.name] = (counts[l.name] || 0) + 1; })));
    const names = Array.from(new Set(RB_QUICK_LABELS.filter(n => counts[n]).concat(Object.keys(counts).sort((a, b) => counts[b] - counts[a])))).slice(0, 9);
    if (d.filter !== 'all' && d.filter !== 'problems' && !counts[d.filter]) d.filter = 'all';
    const bar = wrap.createDiv({ cls: 'rb-bar' });
    const chip = (key, text) => {
      const c = bar.createEl('button', { cls: 'rb-chip' + (d.filter === key ? ' is-on' : ''), text });
      c.onclick = () => { d.filter = key; p.save(); this.render(); };
    };
    chip('all', 'All'); chip('problems', 'Needs a release');
    names.forEach(n => chip(n, n.charAt(0).toUpperCase() + n.slice(1)));
    bar.createDiv({ cls: 'rb-sp' });
    const hd = bar.createEl('label', { cls: 'rb-check' });
    const cb = hd.createEl('input', { type: 'checkbox' }); cb.checked = d.hideDone; hd.appendText(' Hide done');
    cb.onchange = () => { d.hideDone = cb.checked; p.save(); this.render(); };
    const seg = bar.createDiv({ cls: 'rb-seg' });
    [['board', 'Board'], ['list', 'List']].forEach(([k, t]) => {
      const b = seg.createEl('button', { cls: d.layout === k ? 'is-on' : '', text: t });
      b.onclick = () => { d.layout = k; p.save(); this.render(); };
    });

    if (!repos.length) {
      wrap.createDiv({ cls: 'rb-none', text: p.loading ? 'Fetching your repos from GitHub…' : p.error ? 'Nothing to show yet.' : 'No repos found. Check the name in settings, or turn off "Only Obsidian plugins and themes".' });
      return;
    }

    const showIssue = (r, i) => (d.filter === 'all' || d.filter === 'problems' || i.labels.some(l => l.name === d.filter)) && !(d.hideDone && isDone(r, i));
    const showRepo = r => d.filter === 'problems' ? r.status.level === 'bad' || r.status.waiting : d.filter === 'all' || r.issues.some(i => showIssue(r, i));

    if (d.layout === 'list') {
      const t = wrap.createEl('table', { cls: 'rb-table' });
      const hr = t.createEl('thead').createEl('tr');
      ['', 'Task', 'Repo', 'Labels'].forEach(h => hr.createEl('th', { text: h }));
      const tb = t.createEl('tbody');
      repos.filter(showRepo).forEach(r => r.issues.filter(i => showIssue(r, i)).forEach(i => {
        const tr = tb.createEl('tr', { cls: isDone(r, i) ? 'is-done' : '' });
        this.box(tr.createEl('td'), r, i);
        const a = tr.createEl('td').createEl('a', { cls: 'rb-tt', text: i.title, href: i.url });
        a.createSpan({ cls: 'rb-num', text: ' #' + i.n });
        tr.createEl('td', { cls: 'rb-repo', text: r.title });
        this.labels(tr.createEl('td'), i);
      }));
      if (!tb.childElementCount) wrap.createDiv({ cls: 'rb-none', text: 'Nothing here.' });
      return;
    }

    const board = wrap.createDiv({ cls: 'rb-board' });
    repos.filter(showRepo).forEach(r => {
      const card = board.createDiv({ cls: 'rb-card' });
      const h = card.createDiv({ cls: 'rb-rh' });
      const nm = h.createEl('a', { cls: 'rb-rn', text: r.title, href: r.url, attr: { title: 'Open ' + r.name + ' on GitHub' } });
      nm.onclick = e => e.stopPropagation();
      h.createSpan({ cls: 'rb-kind', text: r.kind });
      const st = card.createDiv({ cls: 'rb-rel' });
      st.createSpan({ cls: 'rb-dot is-' + r.status.level }); st.createSpan({ text: r.status.text });
      const tasks = r.issues.filter(i => showIssue(r, i)).sort((a, b) => a.at - b.at);
      if (!tasks.length) card.createDiv({ cls: 'rb-task-none', text: 'Nothing to do' });
      tasks.forEach(i => {
        const row = card.createDiv({ cls: 'rb-task' + (isDone(r, i) ? ' is-done' : '') });
        this.box(row, r, i);
        const mid = row.createDiv({ cls: 'rb-mid' });
        const a = mid.createEl('a', { cls: 'rb-tt', text: i.title, href: i.url });
        a.createSpan({ cls: 'rb-num', text: ' #' + i.n });
        this.labels(mid, i);
      });
      if (p.canWrite()) {
        const add = card.createEl('button', { cls: 'rb-add', text: '+ New task' });
        add.onclick = () => new RBNewIssue(this.app, p, r).open();
      }
    });
  }

  // what sits behind the board: nothing (your theme shows through), one of the built-in aurora pictures, or your own picture
  paintBackground() {
    const host = this.containerEl, d = this.plugin.d;
    let bg = d.bg || (d.bgImage ? 'custom' : 'none'), url = '';
    if (bg === 'custom') {
      const f = d.bgImage ? this.app.vault.getAbstractFileByPath(d.bgImage) : null;
      if (f) url = `url("${this.app.vault.getResourcePath(f)}")`; else bg = 'none';
    }
    for (const k of ['warm', 'north', 'aurora']) host.toggleClass('rb-bg-' + k, bg === k);
    host.toggleClass('rb-bg-host', bg !== 'none');
    if (bg === 'none') { host.style.removeProperty('--rb-bg'); return; }
    if (url) host.style.setProperty('--rb-bg', url); else host.style.removeProperty('--rb-bg');
    host.style.setProperty('--rb-dim', String((bg === 'aurora' ? (d.bgAuroraDim ?? 50) : d.bgDim) / 100));
    host.style.setProperty('--rb-blur', d.bgBlur + 'px');
    host.style.setProperty('--rb-glow', String((d.bgGlow ?? 35) / 100));
  }

  box(parent, r, i) {
    const p = this.plugin, done = p.done.has(r.name + '#' + i.n);
    const b = parent.createEl('button', { cls: 'rb-box' + (done ? ' is-on' : ''), attr: { 'aria-label': done ? 'Open again' : 'Close on GitHub' } });
    if (done) setIcon(b, 'check');
    b.onclick = e => { e.preventDefault(); e.stopPropagation(); p.toggleIssue(r, i); };
  }

  labels(parent, i) {
    if (!i.labels.length) return;
    const w = parent.createDiv({ cls: 'rb-labels' });
    i.labels.forEach(l => {
      const s = w.createSpan({ cls: 'rb-lab', text: l.name });
      s.style.setProperty('--rb-lab', '#' + l.color); s.style.setProperty('--rb-lab-ink', rbInk(l.color));
    });
  }
}

class RBNewIssue extends Modal {
  constructor(app, plugin, repo) { super(app); this.plugin = plugin; this.repo = repo; this.picked = new Set(); }
  onOpen() {
    const { contentEl } = this;
    contentEl.addClass('rb-modal');
    this.titleEl.setText('New task in ' + this.repo.title);
    const input = contentEl.createEl('input', { type: 'text', cls: 'rb-input', attr: { placeholder: 'What needs doing?' } });
    const chips = contentEl.createDiv({ cls: 'rb-bar' });
    const used = new Set(RB_QUICK_LABELS);
    this.repo.issues.forEach(i => i.labels.forEach(l => used.add(l.name)));
    used.forEach(n => {
      const c = chips.createEl('button', { cls: 'rb-chip', text: n });
      c.onclick = () => { this.picked.has(n) ? this.picked.delete(n) : this.picked.add(n); c.toggleClass('is-on', this.picked.has(n)); };
    });
    const row = contentEl.createDiv({ cls: 'modal-button-container' });
    const go = row.createEl('button', { cls: 'mod-cta', text: 'Add to GitHub' });
    const submit = async () => {
      const t = input.value.trim(); if (!t) { input.focus(); return; }
      go.disabled = true; go.setText('Adding…');
      try { await this.plugin.addIssue(this.repo, t, Array.from(this.picked)); this.close(); }
      catch (e) { new Notice('Repo Board: ' + e.message); go.disabled = false; go.setText('Add to GitHub'); }
    };
    go.onclick = submit;
    input.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
    window.setTimeout(() => input.focus(), 30);
  }
  onClose() { this.contentEl.empty(); }
}

class RBSettings extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }
  display() {
    const el = this.containerEl, p = this.plugin, d = p.d;
    el.empty();
    new Setting(el).setName('GitHub user or organisation').setDesc('Whose repos to show, for example AshOtis.')
      .addText(t => t.setPlaceholder('your-name').setValue(d.owner).onChange(v => { d.owner = v.trim(); d.cache = null; p.save(); }));
    new Setting(el).setName('GitHub token').setDesc(createFragment(f => {
      f.appendText('Optional for public repos. Needed to tick tasks off and add new ones, and raises GitHub\'s limit from 60 to 5,000 requests an hour. ');
      f.appendText('Make a fine-grained token with "Issues: Read and write" on your repos. It is saved in this plugin\'s data.json in your vault, so leave it out of any vault you share publicly.');
    })).addText(t => { t.inputEl.type = 'password'; t.setPlaceholder('github_pat_…').setValue(d.token).onChange(v => { d.token = v.trim(); p.save(); p.redraw(); }); });
    new Setting(el).setName('Open when Obsidian starts').setDesc('Show the board as the front tab every time you open this vault.')
      .addToggle(t => t.setValue(d.openOnStart).onChange(v => { d.openOnStart = v; p.save(); }));
    new Setting(el).setName('Only Obsidian plugins and themes').setDesc('Hide repos without a manifest.json.')
      .addToggle(t => t.setValue(d.obsidianOnly).onChange(v => { d.obsidianOnly = v; d.cache = null; p.save(); }));
    new Setting(el).setName('Only these repos').setDesc('Repo names separated by commas. Leave empty for all of them.')
      .addText(t => t.setPlaceholder('lantern-focus, static-fm').setValue(d.only).onChange(v => { d.only = v; d.cache = null; p.save(); }));
    new Setting(el).setName('Pin to the top').setDesc('These repos always come first on the board, in this order, for example a to-do repo. Names separated by commas.')
      .addText(t => t.setPlaceholder('To-DO').setValue(d.pin || '').onChange(v => { d.pin = v; p.save(); p.redraw(); }));
    new Setting(el).setName('Skip these repos').setDesc('Repo names separated by commas.')
      .addText(t => t.setValue(d.skip).onChange(v => { d.skip = v; d.cache = null; p.save(); }));
    new Setting(el).setName('Refresh').setDesc('How often to check GitHub while the board is open.')
      .addDropdown(dd => dd.addOptions({ 15: 'Every 15 minutes', 30: 'Every 30 minutes', 60: 'Every hour', 0: 'Only when I press refresh' })
        .setValue(String(d.refreshMins)).onChange(v => { d.refreshMins = Number(v); p.save(); }));
    new Setting(el).setName('Background').setHeading();
    const bg = d.bg || (d.bgImage ? 'custom' : 'none');
    new Setting(el).setName('Background').setDesc('A picture behind the board. With None, your theme\'s own background shows through.')
      .addDropdown(dd => dd.addOptions({ none: 'None', warm: 'Aurora (warm)', north: 'Aurora (northern lights)', aurora: 'Static Aurora (live colours)', custom: 'My own picture' }).setValue(bg)
        .onChange(v => { d.bg = v; p.save(); p.redraw(); this.display(); }));
    if (bg === 'custom') {
      const pick = new Setting(el).setName('Picture').setDesc(d.bgImage ? d.bgImage : 'Pick any picture in your vault.');
      pick.addButton(b => b.setButtonText(d.bgImage ? 'Change' : 'Choose…').onClick(() => new RBImagePicker(this.app, f => { d.bgImage = f.path; p.save(); p.redraw(); this.display(); }).open()));
    }
    if (bg === 'aurora') {
      const theme = this.app.customCss && this.app.customCss.theme;
      el.createDiv({ cls: 'setting-item-description', text: theme === 'Static Aurora'
        ? 'The board shows the theme\'s aurora glows and accents, in the same colours. When Static FM, Aurora MP3 or Hi-Fi Tuner colour the theme, the board changes with it.'
        : 'Made for the Static Aurora theme, which isn\'t active. The board uses its default colours until you switch to it.' });
      new Setting(el).setName('Glow').setDesc('How strong the aurora is behind the board.')
        .addSlider(sl => sl.setLimits(10, 100, 5).setValue(d.bgGlow ?? 35).setDynamicTooltip().onChange(v => { d.bgGlow = v; p.save(); p.redraw(); }));
      new Setting(el).setName('Darken').setDesc('Dim the glow so the cards stay easy to read.')
        .addSlider(sl => sl.setLimits(0, 90, 5).setValue(d.bgAuroraDim ?? 50).setDynamicTooltip().onChange(v => { d.bgAuroraDim = v; p.save(); p.redraw(); }));
    } else if (bg !== 'none') {
      new Setting(el).setName('Darken').setDesc('Dim the picture so the cards stay easy to read.')
        .addSlider(sl => sl.setLimits(0, 90, 5).setValue(d.bgDim).setDynamicTooltip().onChange(v => { d.bgDim = v; p.save(); p.redraw(); }));
      new Setting(el).setName('Blur').setDesc('Soften the picture.')
        .addSlider(sl => sl.setLimits(0, 20, 1).setValue(d.bgBlur).setDynamicTooltip().onChange(v => { d.bgBlur = v; p.save(); p.redraw(); }));
    }
    new Setting(el).addButton(b => b.setButtonText('Refresh now').setCta().onClick(() => p.refresh(true)));
  }
}

class RBImagePicker extends FuzzySuggestModal {
  constructor(app, onPick) { super(app); this.onPick = onPick; this.setPlaceholder('Pick an image from your vault'); }
  getItems() { return this.app.vault.getFiles().filter(f => /^(png|jpe?g|webp|gif|avif|bmp|svg)$/i.test(f.extension)); }
  getItemText(f) { return f.path; }
  onChooseItem(f) { this.onPick(f); }
}
