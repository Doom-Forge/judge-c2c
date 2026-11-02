let credential = '',
  page = 'overview',
  currentRun = null,
  overview = null,
  pollTimer = null;
const $ = (s) => document.querySelector(s);
const esc = (v) =>
  String(v ?? '').replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ],
  );
const badge = (s) =>
  `<span class="badge ${esc(String(s).toLowerCase())}">${esc(s)}</span>`;
const parse = (s) => (s ? JSON.parse(s) : null);
async function get(path) {
  const r = await fetch(path, {
    headers: credential ? { authorization: 'Bearer ' + credential } : {},
  });
  if (r.status === 401) {
    $('#login').hidden = false;
    $('#content').hidden = true;
    throw new Error('Enter an organizer credential to continue.');
  }
  if (!r.ok) throw new Error('The workspace is unavailable. Refresh to retry.');
  const data = await r.json();
  $('#login').hidden = true;
  $('#content').hidden = false;
  if (credential) $('#signout').hidden = false;
  return data;
}
function message(text) {
  $('#message').className = text ? 'error' : '';
  $('#message').textContent = text;
}
async function load() {
  clearTimeout(pollTimer);
  message('');
  try {
    if (currentRun) {
      await detail(currentRun);
      return;
    }
    if (page === 'organization') {
      await window.organizationWorkspace.load();
      return;
    }
    if (page === 'repositories') {
      await repositories();
      return;
    }
    if (page === 'attention') {
      await attention();
      return;
    }
    overview = await get('/api/overview');
    $('#login').hidden = true;
    $('#content').hidden = false;
    configureWorkspaceMode(overview);
    renderOverview();
  } catch (e) {
    message(e.message);
  }
}

function configureWorkspaceMode(info) {
  $('#signout').hidden = info.demo || info.preview;
  $('#demo-banner').hidden = !info.demo && !info.preview;
  $('#demo-banner').innerHTML = info.preview
    ? 'REAL PUBLIC PR REVIEW <span>Read-only GitHub · Your session expires after 24 hours · Build and tests require an isolated runner.</span>'
    : 'REVIEW ENVIRONMENT <span>Illustrative submission. All displayed evidence is synthetic. Live judging is disabled.</span>';
  $('#mode-label').textContent = info.preview
    ? 'PUBLIC PR REVIEW'
    : info.demo
      ? 'SYNTHETIC REVIEW'
      : 'JUDGE WORKSPACE';
}

function buildJudgeSummary(r, c, a, e, report, engineeringReview) {
  const passCount = e.filter((x) => x.status === 'PASS').length;
  const failCount = e.filter((x) => x.status === 'FAIL').length;
  const unverifiedCount = e.filter((x) => x.status === 'UNVERIFIED').length;

  return `<section class="panel judge-summary"><div class="panel-head"><h2>Judge Summary</h2></div>
    <div class="summary-grid">
      <div class="summary-item">
        <div class="summary-label">Team</div>
        <div class="summary-value">${esc(a.team_name)}</div>
      </div>
      <div class="summary-item">
        <div class="summary-label">Issue</div>
        <div class="summary-value">${c.issueNumbers.length ? esc(c.issueNumbers.map((n) => '#' + n).join(', ')) : 'N/A'}</div>
      </div>
      <div class="summary-item">
        <div class="summary-label">PR</div>
        <div class="summary-value">#${r.pr_number}</div>
      </div>
      <div class="summary-item">
        <div class="summary-label">Head commit</div>
        <div class="summary-value"><code>${esc(r.head_sha.slice(0, 7))}</code></div>
      </div>
    </div>
    <div class="summary-checks">
      <div class="check-stat pass">${passCount} PASS</div>
      <div class="check-stat fail">${failCount} FAIL</div>
      <div class="check-stat unverified">${unverifiedCount} UNVERIFIED</div>
    </div>
    <div class="summary-assessment">
      <strong>Overall assessment:</strong> ${esc(report?.summary || r.failure_code || (r.state === 'COMPLETED' ? 'No assessment report available' : 'Evaluation in progress'))}
    </div>
  </section>`;
}

function buildRequirementsSection(c, report, e) {
  return `<section class="panel"><div class="panel-head"><h2>Requirements</h2><span class="subtle">${c.requirements.length} requirements</span></div>
    ${c.requirements
      .map(
        (req) => `
      <div class="inset">
        <strong>${esc(req.title)}</strong> <span class="subtle">${req.mandatory ? 'Mandatory' : 'Optional'}</span>
        ${req.criteria
          .map((cr) => {
            const relevant = e.filter(
              (x) =>
                x.criterionId === cr.id &&
                (cr.kind !== 'functional' || x.kind === 'execution'),
            );
            const result = {
              status: relevant.some((x) => x.status === 'FAIL')
                ? 'FAIL'
                : relevant.some((x) => x.status === 'PASS')
                  ? 'PASS'
                  : 'UNVERIFIED',
              explanation:
                'Objective criterion evidence; behavior without a relevant trusted check remains unverified.',
              evidenceIds: relevant.map((x) => x.id),
            };
            return `<div class="criterion">
            <div class="criterion-head">
              <strong>${esc(cr.id)}</strong>
              ${badge(result?.status || 'UNVERIFIED')}
              <span class="criterion-kind">${esc(cr.kind)}</span>
            </div>
            <p class="description">${esc(cr.description)}</p>
            <p class="explanation">${esc(result?.explanation || 'No evidence assessment available yet.')}</p>
            ${(result?.evidenceIds || []).map((id) => `<button class="evidence-link" data-evidence="${esc(id)}">↗ ${esc(id)}</button>`).join('')}
          </div>`;
          })
          .join('')}
      </div>
    `,
      )
      .join('')}
  </section>`;
}

function buildObjectiveChecksSection(r, e) {
  const executionEvidence = e.filter((x) => x.kind === 'execution');
  const hasExecution = executionEvidence.length > 0;

  return `<section class="panel"><div class="panel-head"><h2>Objective Checks</h2><span class="subtle">${hasExecution ? executionEvidence.length + ' execution checks' : 'No execution evidence'}</span></div>
    ${
      hasExecution
        ? `
      <div class="checks-grid">
        ${executionEvidence
          .map((x) => {
            const deltaClass =
              x.baselineStatus === 'PASS' && x.status === 'FAIL'
                ? 'regression'
                : x.baselineStatus === 'FAIL' && x.status === 'PASS'
                  ? 'improvement'
                  : x.baselineStatus === x.status
                    ? 'unchanged'
                    : 'mixed';
            const deltaIcon =
              deltaClass === 'regression'
                ? '↓'
                : deltaClass === 'improvement'
                  ? '↑'
                  : '→';

            return `
          <div class="check-item ${x.status.toLowerCase()} ${deltaClass}">
            <div class="check-status">${badge(x.status)}</div>
            <div class="check-id"><code>${esc(x.id)}</code></div>
            <div class="check-claim">${esc(x.claim)}</div>
            ${
              x.baselineStatus
                ? `
              <div class="check-delta">
                <span class="delta-label">Baseline ${badge(x.baselineStatus)} ${deltaIcon} Submission ${badge(x.status)}</span>
              </div>
            `
                : ''
            }
            ${x.path ? `<div class="check-path"><code>${esc(x.path)}</code></div>` : ''}
          </div>
        `;
          })
          .join('')}
      </div>
      <div class="delta-legend">
        <span class="delta-legend-item regression">↓ Regression</span>
        <span class="delta-legend-item improvement">↑ Improvement</span>
        <span class="delta-legend-item unchanged">→ Unchanged</span>
      </div>
    `
        : '<div class="empty">No execution evidence available. Runtime behavior remains unverified.</div>'
    }
  </section>`;
}

function buildEngineeringReviewSection(engineeringReview) {
  if (!engineeringReview || !engineeringReview.rubric) {
    return `<section class="panel"><div class="panel-head"><h2>Engineering Review</h2></div><div class="empty">Engineering review not available yet.</div></section>`;
  }

  const rubric = engineeringReview.rubric;

  // Group by dimension
  const byDimension = {};
  rubric.forEach((item) => {
    if (!byDimension[item.dimension]) byDimension[item.dimension] = [];
    byDimension[item.dimension].push(item);
  });

  return `<section class="panel"><div class="panel-head"><h2>Engineering Review</h2><span class="subtle">Bounded evidence-backed analysis</span></div>
    ${Object.entries(byDimension)
      .map(
        ([dimension, items]) => `
      <details class="dimension-section" open>
        <summary><strong>${esc(dimension)}</strong> <span class="subtle">(${items.length} facets)</span></summary>
        <div class="dimension-facets">
          ${items
            .map(
              (item) => `
            <div class="facet-item">
              <div class="facet-head">
                <strong>${esc(item.id)}</strong>
                <span class="facet-label">${esc(item.label)}</span>
                ${badge(item.status)}
                <span class="facet-coverage">${esc(item.analysisCoverage)}</span>
              </div>
              ${
                item.boundedAnalysis
                  ? `
                <div class="bounded-analysis">
                  <div class="analysis-assessment">${esc(item.boundedAnalysis.assessment)}</div>
                  <div class="analysis-meta">
                    <span class="confidence">Confidence: ${esc(item.boundedAnalysis.confidence)}</span>
                    <span class="limit">Limit: ${esc(item.boundedAnalysis.limit)}</span>
                  </div>
                </div>
              `
                  : ''
              }
              ${item.needsReview ? '<div class="needs-review-flag">⚠ Requires human review</div>' : ''}
            </div>
          `,
            )
            .join('')}
        </div>
      </details>
    `,
      )
      .join('')}
  </section>`;
}

function buildSecuritySection(e, engineeringReview) {
  const securityEvidence = e.filter(
    (x) => x.criterionId?.includes('security') || x.kind === 'security',
  );
  const secretEvidence = e.filter((x) => x.criterionId?.includes('secret'));

  const securityFacets =
    engineeringReview?.rubric?.filter((r) => r.dimension === 'SECURITY') || [];

  return `<section class="panel"><div class="panel-head"><h2>Security</h2><span class="subtle">${securityFacets.length} facets analyzed</span></div>
    <div class="security-facets">
      ${securityFacets
        .map(
          (facet) => `
        <div class="security-facet">
          <div class="facet-head">
            <strong>${esc(facet.id)}</strong>
            <span class="facet-label">${esc(facet.label)}</span>
            ${badge(facet.status)}
          </div>
          ${
            facet.boundedAnalysis
              ? `
            <div class="bounded-analysis">
              <div class="analysis-assessment">${esc(facet.boundedAnalysis.assessment)}</div>
            </div>
          `
              : ''
          }
        </div>
      `,
        )
        .join('')}
    </div>
    ${
      secretEvidence.length
        ? `
      <details class="security-evidence">
        <summary>Secret scan results (${secretEvidence.length})</summary>
        ${secretEvidence
          .map(
            (x) => `
          <div class="evidence-item">
            ${badge(x.status)} <code>${esc(x.id)}</code>
            <p>${esc(x.claim)}</p>
          </div>
        `,
          )
          .join('')}
      </details>
    `
        : ''
    }
  </section>`;
}

function buildContributionsSection(additionalContributions, report) {
  const findings = report?.findings || [];

  return `<section class="panel"><div class="panel-head"><h2>Additional Contributions</h2><span class="subtle">${additionalContributions.length} candidates · ${findings.length} findings</span></div>
    ${
      additionalContributions.length
        ? `
      <div class="contributions-list">
        ${additionalContributions
          .map(
            (c) => `
          <div class="contribution-item">
            <div class="contribution-category">${esc(c.category)}</div>
            <div class="contribution-description">${esc(c.description)}</div>
            <div class="contribution-paths">${(c.paths || []).map((p) => `<code>${esc(p)}</code>`).join(', ')}</div>
            <div class="contribution-status">
              <span class="status-label">Verification:</span> ${badge(c.verificationStatus || 'UNVERIFIED')}
              <span class="status-label">Recorded decision:</span> ${badge(c.latestDecision?.decision || 'PENDING')}
              <p>Candidate records do not automatically change evaluation results or award credit.</p>
            </div>
          </div>
        `,
          )
          .join('')}
      </div>
    `
        : '<div class="empty">No additional contribution candidates detected.</div>'
    }

    ${
      findings.length
        ? `
      <div class="findings-section">
        <h3>Contextual Findings</h3>
        ${findings
          .map(
            (f) => `
          <div class="finding-item">
            <strong>${esc(f.severity)} · ${esc(f.category)}</strong>
            <p>${esc(f.claim)}</p>
            <span class="subtle">Evidence: ${esc(f.evidenceIds.join(', '))}</span>
          </div>
        `,
          )
          .join('')}
      </div>
    `
        : ''
    }
  </section>`;
}

function buildEvidenceSection(e) {
  const byKind = {};
  e.forEach((x) => {
    if (!byKind[x.kind]) byKind[x.kind] = [];
    byKind[x.kind].push(x);
  });

  return `<section class="panel"><div class="panel-head"><h2>Evidence Explorer</h2><span class="subtle">${e.length} records</span></div>
    ${Object.entries(byKind)
      .map(
        ([kind, items]) => `
      <details class="evidence-kind" ${kind === 'execution' ? 'open' : ''}>
        <summary><strong>${esc(kind.toUpperCase())}</strong> <span class="subtle">(${items.length})</span></summary>
        <div class="evidence-list" style="max-height: none;">
          ${items
            .map(
              (x) => `
            <article class="evidence-item" id="e-${esc(x.id)}">
              <div>${badge(x.status)} <code>${esc(x.id)}</code></div>
              <p>${esc(x.claim)}</p>
              ${x.path ? `<code>${esc(x.path)}</code>` : ''}
              ${x.baselineStatus ? `<p>Baseline ${badge(x.baselineStatus)} → submission ${badge(x.status)}</p>` : ''}
              ${x.criterionId ? `<span class="subtle">Criterion: ${esc(x.criterionId)}</span>` : ''}
            </article>
          `,
            )
            .join('')}
        </div>
      </details>
    `,
      )
      .join('')}
  </section>`;
}

function buildAttentionSection(attentionItems) {
  if (!attentionItems || attentionItems.length === 0) {
    return '';
  }

  return `<section class="panel attention-section"><div class="panel-head"><h2>⚠ Needs Attention</h2><span class="subtle">${attentionItems.length} items</span></div>
    <div class="attention-list">
      ${attentionItems
        .map(
          (item) => `
        <div class="attention-item">
          <div class="attention-reason">${esc(item.what)}</div>
          <div class="attention-detail">${esc(item.why)}<p>${esc(item.action)}</p><p class="subtle">Inspect: ${esc((item.inspect || []).join(', '))}</p></div>
        </div>
      `,
        )
        .join('')}
    </div>
  </section>`;
}

async function attention() {
  $('#breadcrumb').innerHTML =
    'Workspace <span class="slash">/</span> Needs Attention';
  $('#content').innerHTML =
    '<div class="loading">Loading attention items…</div>';

  try {
    const runs = await get('/api/overview');
    const attentionRuns = runs.runs.filter((r) => {
      const e = parse(r.evidence) || [];
      const report = parse(r.report);
      return (
        r.state === 'FAILED' ||
        e.some((x) => x.status === 'FAIL') ||
        report?.aiTrace?.requiresHumanAttention ||
        (r.ai_status !== 'COMPLETED' && r.state === 'COMPLETED')
      );
    });

    $('#content').innerHTML = `
      <button class="back" id="back">← All submissions</button>
      <section class="panel">
        <div class="panel-head"><h2>Needs Attention</h2><span class="subtle">${attentionRuns.length} items</span></div>
        ${
          attentionRuns.length
            ? `
          <div class="attention-grid">
            ${attentionRuns
              .map((r) => {
                const a = parse(r.assignment_snapshot);
                const e = parse(r.evidence) || [];
                const report = parse(r.report);
                const failCount = e.filter((x) => x.status === 'FAIL').length;

                let reason = '';
                if (r.state === 'FAILED') reason = 'Evaluation failed';
                else if (failCount > 0) reason = `${failCount} failed checks`;
                else if (report?.aiTrace?.requiresHumanAttention)
                  reason = 'AI review requires attention';
                else if (r.ai_status !== 'COMPLETED')
                  reason = 'AI review incomplete';

                return `
                <div class="attention-card">
                  <button class="row-button" data-run="${esc(r.id)}">
                    <div class="attention-header">
                      <strong>${esc(r.full_name)}</strong>
                      <span class="attention-reason">${esc(reason)}</span>
                    </div>
                    <div class="attention-meta">
                      <span>PR #${r.pr_number}</span>
                      <span>${esc(a.team_name)}</span>
                      <span>${badge(r.state)}</span>
                    </div>
                  </button>
                </div>
              `;
              })
              .join('')}
          </div>
        `
            : '<div class="empty">No items currently need attention.</div>'
        }
      </section>
    `;

    $('#back').addEventListener('click', back);
    document.querySelectorAll('[data-run]').forEach((b) => {
      b.addEventListener('click', () => openRun(b.dataset.run));
    });
  } catch (e) {
    message(e.message);
  }
}

function renderOverview() {
  const c = overview.counts;
  $('#breadcrumb').innerHTML =
    'Workspace <span class="slash">/</span> Submissions';
  $('#content').innerHTML =
    `<section class="stats" aria-label="Evaluation summary">${[
      [
        'Open submissions',
        c.openSubmissions,
        `${c.repositories} repositories · ${c.teams} teams`,
      ],
      ['Evaluating now', c.active, 'Current asynchronous evaluations'],
      ['Completed', c.completed, 'Evidence reports available'],
      ['Needs attention', c.attention, `${c.failed} failed evaluations`],
    ]
      .map(
        ([l, v, f], i) =>
          `<div class="stat ${i === 3 ? 'attention' : ''}"><div class="stat-label">${l}</div><div class="stat-value">${v}</div><div class="stat-foot">${f}</div></div>`,
      )
      .join(
        '',
      )}</section><section class="panel"><div class="panel-head"><h2>Competition metrics</h2></div><div class="metrics-grid">${[
      ['Total teams', c.teams],
      ['Submitted teams', 'Unavailable'],
      ['Not submitted', 'Unavailable'],
      [
        'Evaluation completion rate',
        c.completed + c.failed > 0
          ? Math.round((c.completed / (c.completed + c.failed)) * 100) + '%'
          : 'N/A',
      ],
      ['Avg evaluation time', 'N/A'],
    ]
      .map(
        ([l, v]) =>
          `<div class="metric-item"><div class="metric-label">${esc(l)}</div><div class="metric-value">${esc(String(v))}</div></div>`,
      )
      .join(
        '',
      )}</div></section><section class="panel"><div class="panel-head"><h2>Submission activity</h2><div class="filters"><input id="search" type="search" placeholder="Search repository, team or PR" aria-label="Search submissions"><select id="filter" aria-label="Filter evaluation state"><option value="">All evaluations</option><option>COMPLETED</option><option>FAILED</option><option>QUEUED</option><option>SUPERSEDED</option></select><select id="sort" aria-label="Sort submissions"><option value="newest">Newest first</option><option value="oldest">Oldest first</option></select></div></div><div class="table-wrap"><table><thead><tr><th>SUBMISSION</th><th>TEAM</th><th>STATE</th><th>EVIDENCE</th><th>REVIEW</th></tr></thead><tbody id="rows"></tbody></table></div><div class="panel-foot"><span id="row-count"></span><span>${overview.preview ? 'Latest 50 session reviews · seven-day retention' : 'Latest 100 evaluations · immutable history'}</span></div></section><section class="principle"><h3>A verdict you can inspect.</h3><p>Requirements come from the frozen contract. Deterministic evidence comes first. Contextual reasoning cites that evidence, and behavior without verification remains explicitly unverified.</p></section>`;
  if (overview.preview) {
    $('#content').insertAdjacentHTML('afterbegin', reviewForm());
    $('#review-form').addEventListener('submit', submitReview);
    $('#prepared-example').addEventListener('click', () => {
      $('#pr-url').value = 'https://github.com/octocat/Hello-World/pull/1';
      $('#expected-behavior').value =
        'Document the Git initialization steps in README.';
      $('#assertion-path').value = 'README';
      $('#assertion-text').value = '$ git init';
      $('#protected-paths').value = '.github/workflows';
      $('#baseline').value = '';
      $('#review-form details').open = true;
    });
  }
  $('#search').addEventListener('input', renderRows);
  $('#filter').addEventListener('change', renderRows);
  $('#sort').addEventListener('change', renderRows);
  renderRows();
}
function reviewForm() {
  return `<section class="panel"><div class="panel-head"><h2>Evaluate a real public PR</h2><button class="button" id="prepared-example" type="button">Use prepared public example</button><span class="subtle">GitHub evidence · isolated review session</span></div><form id="review-form" class="review-form"><label for="pr-url">Public GitHub pull request URL</label><input id="pr-url" name="prUrl" type="url" placeholder="https://github.com/owner/repository/pull/123" maxlength="300" required><label for="expected-behavior">What was the team expected to implement?</label><textarea id="expected-behavior" name="expectedBehavior" rows="3" minlength="10" maxlength="2000" placeholder="Describe the required behavior and acceptance criteria. Repository text cannot change these expectations." required></textarea><details><summary>Baseline and objective assertions (optional)</summary><div class="form-grid"><div><label for="baseline">Frozen baseline commit SHA</label><input id="baseline" name="baseline" placeholder="40-character commit SHA" pattern="[a-f0-9]{40}"><p class="subtle">If omitted, the PR merge base is captured. Use a frozen challenge baseline for hackathon testing.</p></div><div><label for="protected-paths">Protected paths (one per line)</label><textarea id="protected-paths" name="protectedPaths" rows="2" placeholder=".github/workflows&#10;tests"></textarea></div><div><label for="assertion-path">Source assertion: file path</label><input id="assertion-path" name="assertionPath" placeholder="README.md" maxlength="240"></div><div><label for="assertion-text">Must contain this literal text</label><input id="assertion-text" name="assertionText" placeholder="Exact case-sensitive text" maxlength="1000"></div></div><p class="subtle">Source assertions compare baseline and head. They establish source presence, not whether code works.</p></details><div class="form-actions"><button class="button primary" type="submit">Evaluate PR</button><span class="subtle">No code execution, AI review is optional. GitHub evidence only.</span></div><p id="review-error" class="error"></p></form></section>`;
}
async function submitReview(event) {
  event.preventDefault();
  const form = event.currentTarget,
    button = form.querySelector('button[type="submit"]');
  const values = new FormData(form),
    input = {
      requestKey: crypto.randomUUID(),
      prUrl: values.get('prUrl'),
      expectedBehavior: values.get('expectedBehavior'),
      protectedPaths: String(values.get('protectedPaths'))
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean),
    };
  if (values.get('baseline'))
    input.baseline = String(values.get('baseline')).trim();
  if (values.get('assertionPath') || values.get('assertionText')) {
    if (!values.get('assertionPath') || !values.get('assertionText')) {
      document.getElementById('review-error').textContent =
        'Provide both a source path and literal text.';
      return;
    }
    input.sourceAssertion = {
      path: String(values.get('assertionPath')).trim(),
      text: String(values.get('assertionText')).trim(),
    };
  }
  button.disabled = true;
  button.textContent = 'Queueing review…';
  try {
    const response = await fetch('/api/preview/evaluations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
    const result = await response.json();
    if (!response.ok)
      throw new Error(
        result.message ||
          (response.status === 400
            ? 'Check the PR URL, SHA and relative paths.'
            : `Cannot queue review: ${result.error}`),
      );
    await openRun(result.runId);
  } catch (error) {
    document.getElementById('review-error').textContent = error.message;
    button.disabled = false;
    button.textContent = 'Evaluate PR';
  }
}
function renderRows() {
  const q = $('#search').value.toLowerCase(),
    f = $('#filter').value,
    s = $('#sort').value;
  let rows = overview.runs.filter((r) => {
    const a = parse(r.assignment_snapshot);
    return (
      (!f || r.state === f) &&
      `${r.full_name} ${r.pr_number} ${a.team_name}`.toLowerCase().includes(q)
    );
  });

  rows.sort((a, b) => {
    const order = String(a.created_at || '').localeCompare(
      String(b.created_at || ''),
    );
    return s === 'oldest' ? order : -order;
  });

  $('#rows').innerHTML =
    rows
      .map((r) => {
        const a = parse(r.assignment_snapshot),
          e = parse(r.evidence) || [];
        const uncertain = e.some((x) => x.status === 'UNVERIFIED');
        const failed = e.some((x) => x.status === 'FAIL');
        return `<tr><td><button class="row-button" data-run="${esc(r.id)}"><strong>${esc(r.full_name)}</strong><small>PR #${r.pr_number} · ${esc(r.head_sha.slice(0, 7))}</small></button></td><td>${esc(a.team_name)}<small>${esc(a.team_id)}</small></td><td>${badge(r.state)}</td><td><strong>${e.filter((x) => x.status === 'PASS').length} verified checks</strong><small>${e.filter((x) => x.status === 'FAIL').length} failed · ${e.filter((x) => x.status === 'UNVERIFIED').length} unverified</small></td><td>${failed ? badge('FAIL') : uncertain ? badge('UNVERIFIED') : '<span class="subtle">Inspect report</span>'}</td></tr>`;
      })
      .join('') ||
    `<tr><td colspan="5" class="empty">${overview.preview ? 'No reviews yet. Enter a real public PR above to begin.' : 'No submissions match. Register a repository contract and PR assignment to begin live evaluation.'}</td></tr>`;
  $('#row-count').textContent = `${rows.length} evaluations`;
  document
    .querySelectorAll('[data-run]')
    .forEach((b) => b.addEventListener('click', () => openRun(b.dataset.run)));
}
async function openRun(id) {
  currentRun = id;
  history.replaceState(null, '', '/?run=' + encodeURIComponent(id));
  await load();
}
async function detail(id) {
  const r = await get('/api/evaluations/' + encodeURIComponent(id));
  if (r.preview) configureWorkspaceMode({ preview: true, demo: false });
  else {
    overview ||= await get('/api/overview');
    configureWorkspaceMode(overview);
  }
  $('#content').hidden = false;
  $('#login').hidden = true;
  const c = parse(r.contract_snapshot) || {
      department: 'Public PR review',
      category: 'Resolving submission',
      repository: { fullName: r.full_name },
      issueNumbers: [],
      evaluationVersion: 'public-review-v1',
      constraints: [],
      requirements: [
        {
          id: 'review-expectation',
          title: 'Expected behavior',
          mandatory: true,
          criteria: [
            {
              id: 'expected-behavior',
              description:
                r.request?.expectedBehavior ||
                'Capturing authoritative expectations',
              kind: 'functional',
            },
          ],
        },
      ],
    },
    a = parse(r.assignment_snapshot),
    e = parse(r.evidence) || [],
    report = parse(r.report),
    engineeringReview = report?.engineeringReview,
    additionalContributions = r.additionalContributions || [],
    attentionItems = r.attentionItems || [];
  $('#breadcrumb').innerHTML =
    'Workspace <span class="slash">/</span> Submission detail';

  // Build state banner
  let stateBanner = '';
  if (r.state === 'FAILED') {
    stateBanner = `<div class="state-banner state-failed">FAILED EVALUATION · ${esc(r.failure_code || 'Unknown error')}</div>`;
  } else if (
    r.state === 'COMPLETED' &&
    (r.ai_status !== 'COMPLETED' || report?.aiTrace?.requiresHumanAttention)
  ) {
    stateBanner = `<div class="state-banner state-attention">NEEDS REVIEW · AI review incomplete or requires human attention</div>`;
  }
  if (
    r.currentSubmission &&
    (r.currentSubmission.closed ||
      r.currentSubmission.latestRunId !== r.id ||
      r.currentSubmission.headSha !== r.head_sha)
  ) {
    stateBanner += `<div class="state-banner state-superseded">HISTORICAL EVALUATION · ${r.currentSubmission.closed ? 'Submission is closed' : 'Current submission differs from this frozen attempt'}. Preserved results describe only the displayed commits.</div>`;
  }

  // Build sections
  const judgeSummary = buildJudgeSummary(r, c, a, e, report, engineeringReview);
  const requirementsSection = buildRequirementsSection(c, report, e);
  const objectiveChecksSection = buildObjectiveChecksSection(r, e);
  const engineeringReviewSection =
    buildEngineeringReviewSection(engineeringReview);
  const securitySection = buildSecuritySection(e, engineeringReview);
  const contributionsSection = buildContributionsSection(
    additionalContributions,
    report,
  );
  const evidenceSection = buildEvidenceSection(e);
  const attentionSection = buildAttentionSection(attentionItems);

  $('#content').innerHTML =
    `<button class="back" id="back">← All submissions</button>${stateBanner}<div class="detail-title"><div><div class="eyebrow">${esc(c.department)} / ${esc(c.category)} / PR #${r.pr_number}</div><h2>${esc(c.repository.fullName)}</h2><span class="subtle">${esc(a.team_name)}${c.issueNumbers.length ? ' · Issue ' + esc(c.issueNumbers.map((n) => '#' + n).join(', ')) : ''}</span></div>${badge(r.state)}</div>

    ${judgeSummary}

    <section class="panel"><div class="panel-head"><h2>Submission metadata</h2></div><div class="commit-grid">${[
      ['BASELINE', r.baseline_sha],
      ['PARTICIPANT HEAD', r.head_sha],
      ['EVALUATION VERSION', c.evaluationVersion],
      ['CONTRACT HASH', r.contract_hash],
    ]
      .map(
        ([l, v]) =>
          `<div><div class="meta-label">${l}</div><div class="meta-value" title="${esc(v)}">${esc(v.length > 20 ? v.slice(0, 12) + '…' : v)}</div></div>`,
      )
      .join('')}</div></section>

    ${requirementsSection}
    ${objectiveChecksSection}

    ${buildAIReviewStateSection(r, report)}
    ${engineeringReviewSection}
    ${securitySection}
    ${buildPerformanceSection(e)}
    ${buildRegressionsSection(e)}
    ${contributionsSection}
    ${evidenceSection}
    ${attentionSection}

    <div class="detail-grid"><div>${report?.solution_approach ? window.JudgeApproach(report) : '<section class="panel"><div class="panel-head"><h3>Solution approach review</h3></div><p class="inset">No solution approach analysis is recorded for this attempt.</p></section>'}<section class="panel"><div class="panel-head"><h2>Contextual findings</h2></div><div class="inset">${report?.findings?.length ? report.findings.map((f) => `<p><strong>${esc(f.severity)} · ${esc(f.category)}</strong><br>${esc(f.claim)}<br><span class="subtle">Contextual inference · ${esc(f.evidenceIds.join(', '))}</span></p>`).join('') : '<p>No confirmed findings have been established by this evaluation.</p>'}</div></section></div><aside><section class="panel"><div class="panel-head"><h2>Judge attention</h2></div><div class="inset"><p>${esc(report?.summary || r.failure_code || 'Evaluation is in progress.')}</p><p><strong>Build, tests & benchmarks</strong><br>${(r.execution || []).length ? 'Preserved isolated execution results are available. Only behavior covered by trusted checks is verified.' : 'No isolated execution results are recorded. Runtime behavior remains unverified.'}</p><p><strong>AI review</strong><br>${esc(r.ai_status || 'Pending')}</p><p><strong>GitHub publication</strong><br>${esc(r.publication_status)}</p></div></section><section class="panel"><div class="panel-head"><h2>Constraints</h2></div><div class="inset">${c.constraints.map((s) => `<p>${esc(s)}</p>`).join('')}</div></section><section class="panel"><div class="panel-head"><h2>Evaluation timeline</h2></div><ol class="timeline">${r.timeline.map((t) => `<li><strong>${esc(t.state)}</strong><br>${esc(t.detail)}<small>${esc(t.created_at)} UTC</small></li>`).join('')}</ol></section><section class="panel"><div class="panel-head"><h2>Artifacts</h2></div><div class="inset">${r.artifacts.length ? r.artifacts.map((a) => `<button class="artifact-link" data-artifact="${esc(a.key)}">↗ ${esc(a.key)}</button>`).join('') : '<div class="empty">No artifacts available yet.</div>'}</div></section></div>`;
  if (r.preview) {
    $('#content').insertAdjacentHTML(
      'beforeend',
      `<section class="panel"><div class="panel-head"><h2>Actual baseline-to-head changes</h2><div class="form-actions"><button class="button" id="review-latest">Review latest head</button><button class="button" id="download-report">Download review JSON</button></div></div><div class="inset"><p><a href="${esc(r.request.prUrl)}" target="_blank" rel="noopener noreferrer">Open GitHub PR #${r.pr_number}</a></p><p>${c.baselineSource === 'organizer-specified' ? 'Baseline: reviewer-specified frozen commit.' : c.baselineSource ? 'Baseline: captured PR merge base, not an organizer-frozen challenge baseline.' : 'The baseline and head are being resolved.'}</p>${c.resolution ? `<p class="review-notice"><strong>Frozen GitHub snapshot</strong> · Captured ${esc(c.resolution.capturedAt)}. Latest PR head could not be refreshed. This review uses only the displayed frozen commits.</p>` : ''}<p class="subtle">${esc(c.prTitle || '')}</p>${r.failure_code ? `<p class="error">${esc(failureDescription(r.failure_code))}</p>` : ''}</div>${(parse(r.context)?.files || []).map((f) => `<details class="diff-file"><summary><code>${esc(f.filename)}</code> · ${esc(f.status)} · +${f.additions} / −${f.deletions}</summary>${f.previous_filename ? `<p>Previously ${esc(f.previous_filename)}</p>` : ''}<pre>${esc(f.patch || 'GitHub did not provide a text patch for this file.')}</pre>${f.patchTruncated ? '<p class="subtle">Displayed patch truncated at 5,000 characters. Inspect the exact commits on GitHub for the full diff.</p>' : ''}</details>`).join('') || '<div class="empty">Change evidence has not been recorded yet.</div>'}</section>`,
    );
    $('#review-latest').addEventListener('click', async () => {
      currentRun = null;
      page = 'overview';
      history.replaceState(null, '', '/');
      await load();
      if (!$('#review-form')) return;
      $('#pr-url').value = r.request.prUrl;
      $('#expected-behavior').value = r.request.expectedBehavior;
      $('#baseline').value = r.request.baseline || '';
      $('#protected-paths').value = (r.request.protectedPaths || []).join('\n');
      $('#assertion-path').value = r.request.sourceAssertion?.path || '';
      $('#assertion-text').value = r.request.sourceAssertion?.text || '';
      $('#pr-url').focus();
    });
    $('#download-report').addEventListener('click', () => {
      const url = URL.createObjectURL(
        new Blob(
          [
            JSON.stringify(
              {
                ...r,
                contract_snapshot: parse(r.contract_snapshot),
                evidence: parse(r.evidence),
                context: parse(r.context),
                report: parse(r.report),
              },
              null,
              2,
            ),
          ],
          { type: 'application/json' },
        ),
      );
      const link = document.createElement('a');
      link.href = url;
      link.download = `judge-c2c-pr-${r.pr_number}.json`;
      link.click();
      URL.revokeObjectURL(url);
    });
    if (!['COMPLETED', 'FAILED'].includes(r.state))
      pollTimer = setTimeout(load, 2500);
  }
  $('#back').addEventListener('click', back);
  document.querySelectorAll('[data-evidence]').forEach((b) =>
    b.addEventListener('click', () => {
      const target = document.getElementById('e-' + b.dataset.evidence);
      if (!target) return;
      const group = target.closest('details');
      if (group) group.open = true;
      target.scrollIntoView({
        behavior: matchMedia('(prefers-reduced-motion: reduce)').matches
          ? 'instant'
          : 'smooth',
      });
    }),
  );
  document.querySelectorAll('[data-artifact]').forEach((b) =>
    b.addEventListener('click', async () => {
      try {
        const res = await fetch(
          '/api/artifact?key=' + encodeURIComponent(b.dataset.artifact),
          {
            headers: { authorization: 'Bearer ' + credential },
          },
        );
        if (!res.ok) throw new Error('Artifact download failed.');
        const blob = await res.blob(),
          url = URL.createObjectURL(blob),
          a = document.createElement('a');
        a.href = url;
        a.download = 'evidence.json';
        a.click();
        URL.revokeObjectURL(url);
      } catch (e) {
        message(e.message);
      }
    }),
  );
}
function failureDescription(code) {
  const descriptions = {
    GITHUB_HTTP_404:
      'GitHub could not find the public PR or a frozen commit. Private repositories require a configured GitHub App.',
    GITHUB_HTTP_403:
      'GitHub rejected the public request, usually because its unauthenticated rate limit was reached. Try a new review later.',
    GITHUB_HTTP_429: 'GitHub rate limited this review. Try a new review later.',
    GITHUB_HTTP_422: 'GitHub could not compare the requested commits.',
    BASELINE_NOT_ANCESTOR:
      'The specified baseline is not an ancestor of the PR head.',
  };
  return descriptions[code] || code;
}

function buildAIReviewStateSection(r, report) {
  const aiStatus = r.ai_status || 'PENDING';
  const aiTrace = report?.aiTrace;
  const requiresAttention = aiTrace?.requiresHumanAttention;

  let statusClass =
    aiStatus === 'COMPLETED'
      ? 'ai-complete'
      : aiStatus === 'FAILED'
        ? 'ai-failed'
        : 'ai-pending';

  return `<section class="panel"><div class="panel-head"><h2>AI Review State</h2></div>
    <div class="ai-review-status ${statusClass}">
      <div class="ai-status-label">Status</div>
      <div class="ai-status-value">${badge(aiStatus)}</div>
      ${requiresAttention ? '<div class="ai-attention-flag">⚠ Requires human attention</div>' : ''}
    </div>
    ${
      aiTrace
        ? `
      <div class="ai-review-details">
        <div class="ai-detail-item">
          <span class="ai-detail-label">Model:</span>
          <span class="ai-detail-value">${esc(aiTrace.model || 'N/A')}</span>
        </div>
        <div class="ai-detail-item">
          <span class="ai-detail-label">Grounding:</span>
          <span class="ai-detail-value">${esc(aiTrace.groundingPolicy || 'Unavailable')}</span>
        </div>
        <div class="ai-detail-item">
          <span class="ai-detail-label">Citations:</span>
          <span class="ai-detail-value">${new Set((report?.assessments || []).flatMap((item) => item.evidenceIds || []).concat(report?.solution_approach?.evidence || [])).size} distinct recorded evidence IDs</span>
        </div>
        <div class="ai-detail-item">
          <span class="ai-detail-label">Assessment:</span>
          <span class="ai-detail-value">${esc(aiTrace.failureCode || aiTrace.policy || 'Unavailable')}</span>
        </div>
      </div>
    `
        : '<div class="empty">AI review details not available.</div>'
    }
  </section>`;
}

function buildPerformanceSection(e) {
  const benchmarkEvidence = e.filter((x) => x.kind === 'benchmark');

  if (benchmarkEvidence.length === 0) {
    return `<section class="panel"><div class="panel-head"><h2>Performance</h2></div><div class="empty">No benchmark evidence available.</div></section>`;
  }

  return `<section class="panel"><div class="panel-head"><h2>Performance</h2><span class="subtle">${benchmarkEvidence.length} benchmarks</span></div>
    <div class="checks-grid">
      ${benchmarkEvidence
        .map(
          (x) => `
        <div class="check-item ${x.status.toLowerCase()}">
          <div class="check-status">${badge(x.status)}</div>
          <div class="check-id"><code>${esc(x.id)}</code></div>
          <div class="check-claim">${esc(x.claim)}</div>
          ${
            x.baselineStatus
              ? `
            <div class="check-delta">
              <span class="delta-label">Baseline ${badge(x.baselineStatus)} → ${badge(x.status)}</span>
            </div>
          `
              : ''
          }
        </div>
      `,
        )
        .join('')}
    </div>
  </section>`;
}

function buildRegressionsSection(e) {
  const regressionEvidence = e.filter(
    (x) => x.baselineStatus === 'PASS' && x.status === 'FAIL',
  );

  if (regressionEvidence.length === 0) {
    return `<section class="panel"><div class="panel-head"><h2>Regressions</h2></div><div class="empty">${e.some((x) => x.kind === 'execution' && x.baselineStatus && x.baselineStatus !== 'UNVERIFIED' && x.status !== 'UNVERIFIED') ? 'No PASS-to-FAIL regression detected in recorded baseline/head execution comparisons. Unperformed checks remain UNVERIFIED.' : 'No verified baseline/head execution comparison is available. Regression safety remains UNVERIFIED.'}</div></section>`;
  }

  return `<section class="panel regression-section"><div class="panel-head"><h2>Regressions</h2><span class="subtle">${regressionEvidence.length} regressions detected</span></div>
    <div class="regression-list">
      ${regressionEvidence
        .map(
          (x) => `
        <div class="regression-item">
          <div class="regression-status">${badge('FAIL')}</div>
          <div class="regression-id"><code>${esc(x.id)}</code></div>
          <div class="regression-claim">${esc(x.claim)}</div>
          <div class="regression-path">${x.path ? `<code>${esc(x.path)}</code>` : ''}</div>
        </div>
      `,
        )
        .join('')}
    </div>
  </section>`;
}

async function repositories() {
  $('#breadcrumb').innerHTML =
    'Workspace <span class="slash">/</span> Repositories';
  $('#content').innerHTML = '<div class="loading">Loading repositories…</div>';
  try {
    const data = await get('/api/repositories');
    $('#content').innerHTML =
      `<section class="panel"><div class="panel-head"><h2>Registered repositories</h2><span class="subtle">${data.repositories.length} repositories</span></div>${
        data.repositories
          .map((r) => {
            const configured = r.judgingConfigured ?? Boolean(r.document);
            return `<div class="inset"><strong>${esc(r.full_name)}</strong><small>ID: ${esc(r.id)}</small><p><span class="badge">${r.connected ? 'Connected to GitHub' : 'Registered'}</span> <span class="badge">${configured ? 'Judging configured' : 'Judging setup required'}</span></p>${configured ? '' : '<p class="subtle">Set up judging criteria and PR assignments in GitHub organization to start evaluation.</p>'}</div>`;
          })
          .join('') ||
        '<div class="empty">No repositories connected yet. Connect a GitHub organization to add repositories.</div>'
      }</section>`;
  } catch (e) {
    message(e.message);
  }
}
function back() {
  currentRun = null;
  page = 'overview';
  history.replaceState(null, '', '/');
  load();
}
document.addEventListener('DOMContentLoaded', () => {
  const params = new URLSearchParams(window.location.search);
  if (params.get('run')) {
    currentRun = params.get('run');
  }
  if (params.get('organization')) {
    page = 'organization';
  }
  if (params.get('attention')) {
    page = 'attention';
  }
  $('#nav-overview').addEventListener('click', () => {
    page = 'overview';
    currentRun = null;
    document
      .querySelectorAll('.nav')
      .forEach((b) => b.classList.remove('active'));
    $('#nav-overview').classList.add('active');
    history.replaceState(null, '', '/');
    load();
  });
  $('#nav-attention').addEventListener('click', () => {
    page = 'attention';
    currentRun = null;
    document
      .querySelectorAll('.nav')
      .forEach((b) => b.classList.remove('active'));
    $('#nav-attention').classList.add('active');
    history.replaceState(null, '', '?attention=1');
    load();
  });
  $('#nav-repos').addEventListener('click', () => {
    page = 'repositories';
    currentRun = null;
    document
      .querySelectorAll('.nav')
      .forEach((b) => b.classList.remove('active'));
    $('#nav-repos').classList.add('active');
    history.replaceState(null, '', '/');
    load();
  });
  $('#nav-organization').addEventListener('click', () => {
    page = 'organization';
    currentRun = null;
    document
      .querySelectorAll('.nav')
      .forEach((b) => b.classList.remove('active'));
    $('#nav-organization').classList.add('active');
    history.replaceState(null, '', '?organization=1');
    load();
  });
  $('#login-form').addEventListener('submit', (event) => {
    event.preventDefault();
    credential = $('#token').value.trim();
    $('#token').value = '';
    load();
  });
  $('#signout').addEventListener('click', () => {
    credential = '';
    $('#signout').hidden = true;
    $('#login').hidden = false;
    $('#content').hidden = true;
    load();
  });
  load();
});
