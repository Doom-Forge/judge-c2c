(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const categories = ['scalability', 'security', 'usefulness'];
  const linkedRun = () =>
    /^[a-f0-9]{64}$/i.test(location.hash.slice(1))
      ? location.hash.slice(1)
      : null;
  let token = '',
    selected = linkedRun(),
    interval = null,
    generation = 0;
  const node = (tag, text, className) => {
    const result = document.createElement(tag);
    if (text !== undefined) result.textContent = String(text);
    if (className) result.className = className;
    return result;
  };
  const score = (value) =>
    typeof value === 'number' && Number.isFinite(value)
      ? value.toFixed(1)
      : '—';
  const badge = (value = 'UNVERIFIED') =>
    node(
      'span',
      value,
      `badge ${String(value)
        .toLowerCase()
        .replace(/[^a-z_]/g, '')}`,
    );
  const notify = (message, error = false) => {
    $('notice').textContent = message;
    $('notice').className = error ? 'error' : 'subtle';
  };
  function lock() {
    token = '';
    selected = linkedRun();
    generation++;
    clearInterval(interval);
    $('login').hidden = false;
    $('workspace').hidden = true;
    $('lock').hidden = true;
    $('credential').value = '';
    $('repositories').replaceChildren();
    $('runs').replaceChildren();
    $('detail').replaceChildren();
  }
  async function api(path, method = 'GET') {
    const response = await fetch(path, {
      method,
      headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store',
    });
    if (response.status === 401 || response.status === 403) {
      lock();
      throw new Error('Workspace locked. Enter a valid organizer credential.');
    }
    if (!response.ok)
      throw new Error(`Request failed (${response.status}). Try refreshing.`);
    return response.json();
  }
  async function refresh() {
    const version = generation;
    try {
      const data = await api('/api/matrix/overview');
      if (version !== generation || !token) return;
      $('login').hidden = true;
      $('workspace').hidden = false;
      $('lock').hidden = false;
      $('repositories').replaceChildren(
        ...data.repositories.map((repo) => {
          const card = node('article', undefined, 'matrix-repository');
          card.append(
            node('h3', repo.full_name),
            node(
              'p',
              repo.evaluation_status === 'READY'
                ? `${data.runs.filter((run) => run.repository_id === repo.id).length} retained attempts · versioned repository checks`
                : repo.evaluation_status === 'SPECIFICATION_REQUIRED'
                  ? 'Challenge specification required · evaluation and scores are disabled.'
                  : 'No trusted matrix configured · evaluation and scores are disabled.',
              repo.evaluation_status === 'READY' ? undefined : 'subtle',
            ),
          );
          return card;
        }),
      );
      $('runs').replaceChildren(
        ...data.runs.map((run) => {
          const button = node('button', undefined, 'run-choice');
          button.type = 'button';
          button.setAttribute('aria-pressed', String(run.id === selected));
          button.append(
            node('strong', `${run.full_name} · PR #${run.pr_number}`),
            badge(run.state),
            node(
              'small',
              `${String(run.head_sha).slice(0, 12)} · ${run.created_at}`,
            ),
          );
          button.addEventListener('click', () => {
            selected = run.id;
            history.replaceState(null, '', `#${encodeURIComponent(run.id)}`);
            refresh();
          });
          return button;
        }),
      );
      if (!data.runs.length)
        $('runs').append(
          node(
            'p',
            'No container runs yet. New PR deliveries appear here.',
            'empty',
          ),
        );
      if (selected === null && data.runs.length) selected = data.runs[0].id;
      if (selected !== null) {
        const run = await api(
          `/api/matrix/runs/${encodeURIComponent(selected)}`,
        );
        if (version !== generation || run.id !== selected) return;
        render(run);
        for (const [index, button] of [...$('runs').children].entries())
          button.setAttribute(
            'aria-pressed',
            String(data.runs[index]?.id === selected),
          );
      }
      notify('Container results refreshed.');
    } catch (error) {
      notify(error.message, true);
    }
  }
  function render(run) {
    const target = $('detail');
    target.replaceChildren();
    const heading = node('div', undefined, 'detail-title');
    heading.append(
      node('h2', `PR #${run.pr_number} · Container results`),
      badge(run.state),
    );
    if (['FAILED', 'COMPLETED'].includes(run.state)) {
      const retry = node('button', 'Create retry attempt', 'button');
      retry.addEventListener('click', async () => {
        retry.disabled = true;
        const version = generation;
        try {
          const next = await api(
            `/api/matrix/runs/${encodeURIComponent(run.id)}/retry`,
            'POST',
          );
          if (version !== generation || !token) return;
          selected = next.id;
          await refresh();
        } catch (error) {
          notify(error.message, true);
        } finally {
          retry.disabled = false;
        }
      });
      heading.append(retry);
    }
    target.append(heading);
    if (run.failure_code)
      target.append(
        node(
          'p',
          `Execution error: ${run.failure_code}. Unfinished checks remain UNVERIFIED. Retry creates a new attempt and preserves this history.`,
          'error',
        ),
      );
    if (run.state === 'SUPERSEDED')
      target.append(
        node(
          'p',
          'Historical attempt: a newer PR head superseded this run.',
          'state-banner state-superseded',
        ),
      );
    const report = run.report || {};
    const baseline = report.baseline || {};
    const scores = node('div', undefined, 'matrix-scores');
    for (const category of [...categories, 'overall']) {
      const total = category === 'overall';
      const result = report.categories?.[category];
      const value = total ? report.overallScore : result?.score;
      const oldValue = total
        ? baseline.overallScore
        : baseline.categories?.[category]?.score;
      const card = node(
        'article',
        undefined,
        `matrix-score${total ? ' total' : ''}`,
      );
      card.append(
        node(
          'h3',
          total
            ? 'Overall / 100'
            : `${category[0].toUpperCase()}${category.slice(1)} / 100`,
        ),
        node('span', score(value), 'number'),
      );
      card.append(
        total
          ? node(
              'span',
              typeof value === 'number'
                ? 'Equal category weights'
                : 'Final score unavailable',
              'subtle',
            )
          : badge(result?.status),
      );
      card.append(node('span', `Baseline ${score(oldValue)}`, 'subtle'));
      if (typeof value === 'number' && typeof oldValue === 'number')
        card.append(
          node(
            'span',
            `${value - oldValue >= 0 ? '+' : ''}${(value - oldValue).toFixed(1)} points vs baseline`,
            'subtle',
          ),
        );
      scores.append(card);
    }
    target.append(scores);
    const meta = node('dl', undefined, 'panel matrix-meta');
    for (const [label, value] of [
      ['Attempt', run.id],
      [
        'Matrix version',
        run.matrix_version || report.matrixVersion || 'Unavailable',
      ],
      ['Matrix digest', run.matrix_digest],
      ['Pinned container image', run.image_uri],
      ['Executed container image', report.image],
      ['PR head SHA', run.head_sha],
      ['Frozen baseline SHA', run.baseline_sha],
    ]) {
      const item = node('div');
      item.append(node('dt', label), node('dd', value ?? 'Unavailable'));
      meta.append(item);
    }
    target.append(meta);
    const evidence = node('section', undefined, 'panel');
    const evidenceHead = node('div', undefined, 'panel-head');
    evidenceHead.append(node('h2', 'Individual check evidence'));
    evidence.append(evidenceHead);
    if (!report.checks?.length)
      evidence.append(
        node(
          'p',
          'No completed check evidence is available for this attempt.',
          'empty',
        ),
      );
    for (const check of report.checks || []) {
      const item = node('article', undefined, 'matrix-evidence');
      item.append(
        node('h3', check.id),
        badge(check.status),
        node(
          'span',
          `${check.category} · ${typeof check.durationMs === 'number' ? `${check.durationMs} ms` : 'Timing unavailable'}`,
          'subtle',
        ),
        node('p', check.detail || 'No additional detail recorded.'),
      );
      const prior = baseline.checks?.find((entry) => entry.id === check.id);
      item.append(
        node(
          'p',
          prior
            ? `Baseline: ${prior.status} · ${typeof prior.durationMs === 'number' ? `${prior.durationMs} ms` : 'Timing unavailable'}\n${prior.detail || ''}`
            : 'Baseline: no matching check evidence available.',
          'baseline-evidence',
        ),
      );
      evidence.append(item);
    }
    target.append(evidence);
  }
  $('login').addEventListener('submit', async (event) => {
    event.preventDefault();
    generation++;
    token = $('credential').value.trim();
    $('credential').value = '';
    if (!token) return;
    clearInterval(interval);
    await refresh();
    if (token)
      interval = setInterval(() => {
        if (!document.hidden) void refresh();
      }, 30000);
  });
  $('lock').addEventListener('click', () => {
    lock();
    notify('Workspace locked.');
  });
  $('refresh').addEventListener('click', refresh);
})();
