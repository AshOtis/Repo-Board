/* Repo Board: the GitHub side. Only talks to api.github.com, through Obsidian's requestUrl. */

class RBGitHub {
  constructor(getToken) { this.getToken = getToken; this.remaining = null; this.resetAt = null; }

  async req(path, opts = {}) {
    const headers = {
      Accept: opts.raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    const token = (this.getToken() || '').trim();
    if (token) headers.Authorization = 'Bearer ' + token;
    const r = await requestUrl({
      url: 'https://api.github.com' + path, method: opts.method || 'GET', headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      contentType: opts.body ? 'application/json' : undefined, throw: false,
    });
    const h = {}; for (const k in (r.headers || {})) h[k.toLowerCase()] = r.headers[k];
    if (h['x-ratelimit-remaining'] != null) this.remaining = Number(h['x-ratelimit-remaining']);
    if (h['x-ratelimit-reset'] != null) this.resetAt = Number(h['x-ratelimit-reset']) * 1000;
    if (r.status === 202) return { pending: true };   // GitHub is still working the stats out
    if (r.status === 204) return null;                  // empty repo
    if (r.status === 404) return null;
    if (r.status >= 400) {
      let msg = 'GitHub said ' + r.status;
      try { if (r.json && r.json.message) msg = r.json.message; } catch (e) { /* not json */ }
      if (r.status === 403 && this.remaining === 0) msg = 'GitHub rate limit reached. Add a token in settings, or wait until ' + new Date(this.resetAt).toLocaleTimeString() + '.';
      if (r.status === 401) msg = 'GitHub did not accept the token. Check it in settings.';
      const e = new Error(msg); e.status = r.status; throw e;
    }
    return opts.raw ? r.text : r.json;
  }

  // One listing, a page at a time. Returns null when the first page is a 404.
  async pages(path) {
    const out = [];
    for (let page = 1; page <= 5; page++) {
      const list = await this.req(path + (path.includes('?') ? '&' : '?') + `per_page=100&page=${page}`);
      if (!Array.isArray(list)) return page === 1 ? null : out;
      out.push(...list);
      if (list.length < 100) break;
    }
    return out;
  }

  async listRepos(owner, includePrivate) {
    const o = encodeURIComponent(owner);
    if (includePrivate && (this.getToken() || '').trim()) {
      const me = await this.req('/user');
      if (me && String(me.login).toLowerCase() === owner.toLowerCase()) return (await this.pages('/user/repos?affiliation=owner&sort=pushed')) || [];
      const org = await this.pages(`/orgs/${o}/repos?type=all&sort=pushed`);
      if (org) return org;
    }
    const list = await this.pages(`/users/${o}/repos?sort=pushed`);
    if (!list) { const e = new Error(`No GitHub user or organisation called "${owner}".`); e.status = 404; throw e; }
    return list;
  }

  async openIssues(owner, repo) {
    const out = [];
    for (let page = 1; page <= 3; page++) {
      const list = await this.req(`/repos/${owner}/${repo}/issues?state=open&per_page=100&page=${page}`) || [];
      out.push(...list.filter(i => !i.pull_request));
      if (list.length < 100) break;
    }
    return out;
  }

  // 52 weeks of daily commit counts. GitHub works these out on first ask, so wait a moment and try once more.
  async commitActivity(owner, repo) {
    for (let t = 0; t < 2; t++) {
      const r = await this.req(`/repos/${owner}/${repo}/stats/commit_activity`);
      if (Array.isArray(r) && r.length) return r;
      if (r && r.pending) await new Promise(res => window.setTimeout(res, 1500)); else return null;
    }
    return null;
  }

  latestRelease(owner, repo) { return this.req(`/repos/${owner}/${repo}/releases/latest`); }

  async manifest(owner, repo, branch) {
    const txt = await this.req(`/repos/${owner}/${repo}/contents/manifest.json${branch ? '?ref=' + encodeURIComponent(branch) : ''}`, { raw: true });
    if (!txt) return null;
    try { return JSON.parse(txt); } catch (e) { return null; }
  }

  setIssueState(owner, repo, number, state) { return this.req(`/repos/${owner}/${repo}/issues/${number}`, { method: 'PATCH', body: { state } }); }
  newIssue(owner, repo, title, labels, body) { return this.req(`/repos/${owner}/${repo}/issues`, { method: 'POST', body: { title, labels, body: body || undefined } }); }
}

// Is version a newer than version b? ("1.2.0" > "1.1.9")
function rbNewer(a, b) {
  const pa = String(a).split('.').map(n => parseInt(n, 10) || 0), pb = String(b).split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0); }
  return false;
}

// Work out how a repo's release stands, the way the Obsidian directory sees it
function rbStatus(manifest, release) {
  if (!manifest) return { level: 'none', text: 'No manifest.json' };
  const kind = manifest.id ? 'plugin' : 'theme';
  const v = manifest.version;
  if (!release) return { level: 'warn', text: `${v} · no release yet`, waiting: true };
  const tag = release.tag_name;
  if (tag !== v) {
    if (tag.replace(/^v/i, '') === v) return { level: 'bad', text: `Release tag "${tag}" has a "v"; it must be exactly ${v}` };
    if (rbNewer(v, tag)) return { level: 'warn', text: `${v} in manifest, ${tag} released`, waiting: true };
    return { level: 'bad', text: `Release ${tag} is newer than manifest ${v}` };
  }
  const names = (release.assets || []).map(a => a.name);
  const need = kind === 'plugin' ? ['main.js', 'manifest.json'] : ['theme.css', 'manifest.json'];
  const missing = need.filter(n => !names.includes(n));
  if (missing.length) return { level: 'bad', text: `${tag} is missing ${missing.join(' and ')}` };
  return { level: 'ok', text: `${tag} · released ${rbAgo(Date.parse(release.published_at))}` };
}

function rbAgo(t) {
  if (!t) return '';
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.round(s / 60) + ' min ago';
  if (s < 86400) return Math.round(s / 3600) + ' h ago';
  const d = Math.round(s / 86400);
  return d === 1 ? 'yesterday' : d + ' days ago';
}
