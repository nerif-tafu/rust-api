/* Single-page Rust Items API: renders the API reference from the OpenAPI spec
   and drives the status header, force-update and logs modal. No framework. */

const METHOD_ORDER = ['get', 'post', 'put', 'patch', 'delete'];

function el(tag, opts = {}) {
  const node = document.createElement(tag);
  if (opts.className) node.className = opts.className;
  if (opts.text != null) node.textContent = String(opts.text);
  if (opts.html != null) node.innerHTML = opts.html; // only used with trusted static strings
  if (opts.attrs) for (const [k, v] of Object.entries(opts.attrs)) node.setAttribute(k, v);
  if (opts.children) node.append(...opts.children.filter(Boolean));
  return node;
}

/* ---- API reference ------------------------------------------------------ */

function paramTable(parameters) {
  if (!parameters || !parameters.length) return null;
  const rows = parameters.map((p) =>
    el('tr', {
      children: [
        el('td', { children: [el('span', { className: 'ref-code', text: p.name })] }),
        el('td', { className: 'muted', text: p.in }),
        el('td', { text: (p.schema && p.schema.type) || p.type || '' }),
        el('td', { className: 'muted', text: p.required ? 'required' : 'optional' }),
        el('td', { className: 'muted', text: p.description || '' })
      ]
    })
  );
  const head = el('tr', {
    children: ['Name', 'In', 'Type', '', 'Description'].map((h) => el('th', { text: h }))
  });
  return el('table', { className: 'ref-table', children: [el('thead', { children: [head] }), el('tbody', { children: rows })] });
}

function responseTable(responses) {
  if (!responses) return null;
  const rows = Object.entries(responses).map(([code, r]) =>
    el('tr', {
      children: [
        el('td', { children: [el('span', { className: 'ref-code', text: code })] }),
        el('td', { className: 'muted', text: (r && r.description) || '' })
      ]
    })
  );
  const head = el('tr', { children: ['Status', 'Description'].map((h) => el('th', { text: h })) });
  return el('table', { className: 'ref-table', children: [el('thead', { children: [head] }), el('tbody', { children: rows })] });
}

function endpointCard(path, method, op) {
  const m = method.toLowerCase();
  const desc = op.summary || op.description || '';

  const summary = el('div', {
    className: 'endpoint-summary',
    children: [
      el('span', { className: `method m-${m}`, text: method.toUpperCase() }),
      el('span', { className: 'endpoint-path', text: path }),
      desc ? el('span', { className: 'endpoint-desc', text: desc }) : null,
      el('span', { className: 'endpoint-caret', text: '›' })
    ]
  });

  const bodyChildren = [];
  if (op.description && op.description !== op.summary) {
    bodyChildren.push(el('p', { className: 'summary', text: op.description }));
  }
  const params = paramTable(op.parameters);
  if (params) { bodyChildren.push(el('h4', { text: 'Parameters' }), params); }
  const responses = responseTable(op.responses);
  if (responses) { bodyChildren.push(el('h4', { text: 'Responses' }), responses); }

  const card = el('div', {
    className: `endpoint m-${m}`,
    attrs: { 'data-search': `${method} ${path} ${desc}`.toLowerCase() },
    children: [summary, el('div', { className: 'endpoint-body', children: bodyChildren })]
  });
  summary.addEventListener('click', () => card.classList.toggle('open'));
  return card;
}

function renderReference(spec) {
  const mount = document.getElementById('apiReference');
  if (!mount) return;
  const cards = [];
  const paths = spec.paths || {};
  Object.keys(paths).sort().forEach((path) => {
    const methods = Object.keys(paths[path]).sort(
      (a, b) => METHOD_ORDER.indexOf(a) - METHOD_ORDER.indexOf(b)
    );
    methods.forEach((method) => {
      if (!METHOD_ORDER.includes(method.toLowerCase())) return;
      cards.push(endpointCard(path, method, paths[path][method]));
    });
  });
  mount.replaceChildren(...cards);

  const count = document.getElementById('endpointCount');
  if (count) count.textContent = `${cards.length} endpoints`;

  const filter = document.getElementById('refFilter');
  if (filter) {
    filter.addEventListener('input', () => {
      const q = filter.value.trim().toLowerCase();
      cards.forEach((c) => {
        c.style.display = !q || c.getAttribute('data-search').includes(q) ? '' : 'none';
      });
    });
  }
}

async function loadReference() {
  try {
    const r = await fetch('/api-docs/swagger.json');
    const spec = await r.json();
    renderReference(spec);
  } catch (err) {
    const mount = document.getElementById('apiReference');
    if (mount) mount.append(el('p', { className: 'muted-note', text: 'Could not load API spec: ' + err.message }));
  }
}

/* ---- Force update ------------------------------------------------------- */

function forceUpdate() {
  if (!confirm('This will force a game update and re-extraction. It may take several minutes. Continue?')) return;
  fetch('/api/force-update', { method: 'POST', headers: { 'Content-Type': 'application/json' } })
    .then((r) => r.json())
    .then((data) => {
      if (data.success) {
        alert('Force update started. Check the logs for progress.');
        setTimeout(() => location.reload(), 2000);
      } else {
        alert('Update failed: ' + (data.error || 'Unknown error'));
      }
    })
    .catch((err) => alert('Error starting update: ' + err.message));
}

/* ---- Logs modal --------------------------------------------------------- */

let logsEventSource = null;

function openLogsModal() {
  document.getElementById('logsModal').classList.add('open');
  loadLogs();
  startLogsStream();
}

function closeLogsModal() {
  stopLogsStream();
  document.getElementById('logsModal').classList.remove('open');
}

function startLogsStream() {
  stopLogsStream();
  logsEventSource = new EventSource('/api/logs/stream');
  logsEventSource.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.log) appendLogLine(data.log);
    } catch {}
  };
  logsEventSource.onerror = () => stopLogsStream();
}

function stopLogsStream() {
  if (logsEventSource) { logsEventSource.close(); logsEventSource = null; }
}

function appendLogLine(text) {
  const container = document.getElementById('logsContainer');
  if (!container) return;
  const note = container.querySelector('.muted-note');
  if (note) note.remove();
  container.append(el('div', { className: 'log-line', text }));
  container.scrollTop = container.scrollHeight;
}

function loadLogs() {
  const container = document.getElementById('logsContainer');
  container.replaceChildren(el('div', { className: 'muted-note', text: 'Loading logs…' }));
  fetch('/api/logs?lines=100')
    .then((r) => r.json())
    .then((data) => {
      if (data.logs && data.logs.length) {
        container.replaceChildren(...data.logs.map((l) => el('div', { className: 'log-line', text: typeof l === 'string' ? l : (l.message || JSON.stringify(l)) })));
        container.scrollTop = container.scrollHeight;
        const c = document.getElementById('logCount');
        if (c && data.totalLines != null) c.textContent = data.totalLines;
      } else {
        container.replaceChildren(el('div', { className: 'muted-note', text: 'No logs available.' }));
      }
    })
    .catch((err) => container.replaceChildren(el('div', { className: 'muted-note', text: 'Failed to load logs: ' + err.message })));
}

/* ---- Wire up ------------------------------------------------------------ */

document.addEventListener('DOMContentLoaded', () => {
  loadReference();
  const fu = document.getElementById('forceUpdateBtn');
  if (fu) fu.addEventListener('click', forceUpdate);
  const ol = document.getElementById('openLogsBtn');
  if (ol) ol.addEventListener('click', openLogsModal);
  const cl = document.getElementById('closeLogsBtn');
  if (cl) cl.addEventListener('click', closeLogsModal);
  const refresh = document.getElementById('refreshLogsBtn');
  if (refresh) refresh.addEventListener('click', loadLogs);
});
