(() => {
  const $ = (selector) => document.querySelector(selector);
  const esc = (value) =>
    String(value ?? '').replace(
      /[&<>"']/g,
      (char) =>
        ({
          '&': '&amp;',
          '<': '&lt;',
          '>': '&gt;',
          '"': '&quot;',
          "'": '&#39;',
        })[char],
    );
  let timer = null,
    roleObserver = null,
    authenticatedRole = null,
    archiveReadOnly = false;
  async function call(path, body) {
    const multipart = body instanceof FormData;
    const response = await fetch('/api/organization/' + path, {
      headers: body && !multipart ? { 'content-type': 'application/json' } : {},
      ...(body
        ? {
            method: 'POST',
            body: multipart ? body : JSON.stringify(body),
          }
        : {}),
    });
    const data = await response.json();
    if (!response.ok) {
      const failure = new Error(data.error || 'ORGANIZATION_UNAVAILABLE');
      failure.status = response.status;
      throw failure;
    }
    return data;
  }
  function error(error) {
    $('#message').className = 'error';
    $('#message').textContent = error.message;
  }
  function dateLabel(value) {
    if (value === null || value === undefined || value === '') {
      return 'Unavailable';
    }
    const normalized =
      typeof value === 'string' &&
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value)
        ? `${value.replace(' ', 'T')}Z`
        : value;
    const date = new Date(normalized);
    return Number.isNaN(date.valueOf()) ? 'Unavailable' : date.toISOString();
  }
  function evidenceLinks(ids, available) {
    return (
      (ids || [])
        .filter((id) => available.has(String(id)))
        .map(
          (id) =>
            `<a class="evidence-link" href="#evidence-${encodeURIComponent(
              String(id),
            )}">${esc(id)}</a>`,
        )
        .join('') || '<span class="subtle">No linked evidence recorded.</span>'
    );
  }
  function requirementStatus(value) {
    return ['PASS', 'PARTIAL', 'FAIL', 'UNVERIFIED'].includes(value)
      ? value
      : 'UNVERIFIED';
  }
  function escapedList(values, emptyLabel = 'None recorded.') {
    if (!Array.isArray(values)) return '<span>Not available</span>';
    if (values.length === 0) return `<span>${esc(emptyLabel)}</span>`;
    return `<ul>${values
      .map((value) => `<li>${esc(value)}</li>`)
      .join('')}</ul>`;
  }
  function checkComparison(execution, baselineSha, headSha) {
    const rows = execution || [],
      baselineResults = rows.filter((row) => row.commit_sha === baselineSha),
      headResults = rows.filter((row) => row.commit_sha === headSha);
    if (baselineSha === headSha) {
      return '<p class="subtle">Baseline/head comparison unavailable: both frozen inputs refer to the same commit.</p>';
    }
    if (baselineResults.length > 1 || headResults.length > 1) {
      return '<p class="subtle">Baseline/head comparison unavailable: multiple exact-commit executions exist, so retry history is ambiguous.</p>';
    }
    const baseline = baselineResults[0],
      head = headResults[0];
    if (!baseline || !head) {
      return '<p class="subtle">Baseline/head comparison unavailable: a trusted result for both exact commits is not recorded.</p>';
    }
    const parse = (row) => {
        try {
          return JSON.parse(row.result).checks || [];
        } catch {
          return [];
        }
      },
      baselineChecks = parse(baseline),
      headChecks = parse(head),
      keyed = new Map(
        baselineChecks.map((check) => [`${check.kind}:${check.id}`, check]),
      );
    return (
      headChecks
        .map((check) => {
          const prior = keyed.get(`${check.kind}:${check.id}`),
            explanation = !prior
              ? 'No matching baseline check; comparison unavailable.'
              : prior.status === 'FAIL' && check.status === 'FAIL'
                ? 'Failed on baseline and head; pre-existing failure, not a demonstrated regression.'
                : prior.status === 'PASS' && check.status === 'FAIL'
                  ? 'Passed on baseline and failed on head; regression observed.'
                  : prior.status === 'FAIL' && check.status === 'PASS'
                    ? 'Baseline failure passes on head.'
                    : prior.status === check.status
                      ? 'Same status on baseline and head.'
                      : `Baseline ${prior.status}; head ${check.status}.`;
          return `<div class="evidence-item"><strong>${esc(
            check.kind,
          )} · ${esc(check.id)}: ${esc(
            prior?.status || 'Unavailable',
          )} → ${esc(check.status)}</strong><p>${esc(explanation)}</p></div>`;
        })
        .join('') ||
      '<p class="subtle">No head checks are available for comparison.</p>'
    );
  }
  async function loadIdentities(target) {
    const data = await call('identities');
    target.innerHTML = `<h3>Named console access</h3><p>Create a separate revocable credential for each person. Participant credentials read only their assigned team's submission status and criterion outcomes. Private artifacts and security reports remain restricted.</p><form class="review-form" id="identity-create"><label>Person's name<input name="name" minlength="2" maxlength="80" required></label><label>Role<select name="role">${[
      'participant',
      'judge',
      'security',
      'organizer',
    ]
      .map((role) => `<option>${role}</option>`)
      .join(
        '',
      )}</select></label><label>Team ID (participant role only)<input name="teamId" maxlength="80"></label><button class="button">Create named access</button></form><p id="identity-result" role="status"></p><div id="identity-credential"></div>${
      data.identities
        .map(
          (identity) =>
            `<article class="inset"><strong>${esc(
              identity.name,
            )}</strong> · ${esc(identity.role)} ${
              identity.team_id ? '· team ' + esc(identity.team_id) : ''
            }<p>${
              identity.revoked_at
                ? 'Revoked ' + esc(identity.revoked_at)
                : `<button class="button" data-revoke-identity="${esc(
                    identity.id,
                  )}">Revoke ${esc(identity.name)}</button>`
            }</p></article>`,
        )
        .join('') || '<p>No named credentials issued.</p>'
    }`;
    target.querySelector('#identity-create').onsubmit = async (event) => {
      event.preventDefault();
      const values = new FormData(event.target);
      const body = { name: values.get('name'), role: values.get('role') };
      if (values.get('teamId')) body.teamId = values.get('teamId');
      try {
        const issued = await call('identities', body);
        await loadIdentities(target);
        target.querySelector('#identity-result').textContent =
          `Access created for ${issued.name}. This credential is shown once; share it privately with that person.`;
        const input = document.createElement('input');
        input.readOnly = true;
        input.autocomplete = 'off';
        input.setAttribute('aria-label', 'One-time console credential');
        input.value = issued.credential;
        target.querySelector('#identity-credential').appendChild(input);
      } catch (failure) {
        target.querySelector('#identity-result').textContent = failure.message;
      }
    };
    for (const button of target.querySelectorAll('[data-revoke-identity]')) {
      button.onclick = async () => {
        try {
          await call(
            'identities/' + button.dataset.revokeIdentity + '/revoke',
            {},
          );
          await loadIdentities(target);
          target.querySelector('#identity-result').textContent =
            'Credential revoked. Its active sessions have been removed.';
        } catch (failure) {
          target.querySelector('#identity-result').textContent =
            failure.message;
        }
      };
    }
  }
  async function loadParticipant(target) {
    const data = await call('participant');
    target.innerHTML = `<h3>${esc(data.team.name)}</h3><p>Team status · ${esc(
      data.team.status || 'Unavailable',
    )}</p>${
      data.track
        ? `<p>${esc(data.track.fullName)} · repository ${esc(
            data.track.repositoryId,
          )}</p>`
        : '<p>No repository track selected.</p>'
    }<h4>Active members</h4><p>Active member list unavailable.</p><h4>Submissions</h4>${
      data.submissions
        .map(
          (submission) =>
            `<article class="inset"><strong>${esc(
              submission.full_name,
            )} · PR #${esc(submission.pr_number)}</strong><p>${esc(
              submission.status,
            )} · ${esc(
              submission.mapping_status || 'Mapping unavailable',
            )} · ${esc(
              submission.evaluation_status || 'Evaluation unavailable',
            )} · head ${esc(submission.head_sha)}</p></article>`,
        )
        .join('') || '<p>No team submissions.</p>'
    }<h4>Evaluation history</h4>${
      data.evaluations
        .map(
          (run) =>
            `<a class="row-button" href="#participant-evaluation-${esc(
              run.id,
            )}" data-participant-evaluation="${esc(
              run.id,
            )}">PR #${esc(run.pr_number)} · ${esc(
              run.head_sha.slice(0, 12),
            )}</a>`,
        )
        .join('') || '<p>No team evaluations.</p>'
    }<p id="participant-result" role="status"></p><div id="participant-evaluation-detail"></div>${'<section class="inset" id="participant-documents"><h4>Analysis documents</h4><form id="participant-upload" class="review-form"><label for="participant-document-file">Upload PDF or DOCX (maximum 2 MiB)</label><input id="participant-document-file" name="file" type="file" accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document" required><button class="button" type="submit">Upload document</button><p id="participant-upload-result" role="status"></p></form><div id="participant-document-history"></div></section>'}`;
    for (const button of target.querySelectorAll(
      '[data-participant-evaluation]',
    )) {
      button.onclick = async (event) => {
        event.preventDefault();
        try {
          const detail = await call(
            'participant/evaluations/' + button.dataset.participantEvaluation,
          );
          target.querySelector('#participant-evaluation-detail').innerHTML =
            `<h4>PR #${esc(
              detail.evaluation.prNumber,
            )} · ${esc(detail.evaluation.state)}</h4>${detail.requirements
              .map(
                (requirement) =>
                  `<article class="inset"><strong>${esc(
                    requirement.requirementId,
                  )} · ${esc(requirement.status)}</strong>${requirement.criteria
                    .map(
                      (criterion) =>
                        `<p>${esc(criterion.criterionId)} · ${esc(
                          criterion.status,
                        )} · ${esc(criterion.reason)}</p>`,
                    )
                    .join('')}</article>`,
              )
              .join('')}`;
        } catch (failure) {
          target.querySelector('#participant-result').textContent =
            failure.message;
        }
      };
    }
    const history = target.querySelector('#participant-document-history');
    if (history) {
      const renderDocuments = (documents) => {
        history.innerHTML = documents.length
          ? documents
              .map(
                (document) =>
                  `<article class="inset"><strong>Version ${esc(
                    document.version,
                  )} · ${esc(document.filename)}</strong><p>${esc(
                    document.status,
                  )} · ${esc(document.content_type)} · ${esc(
                    String(document.bytes),
                  )} bytes · ${esc(dateLabel(document.created_at))}</p>${
                    document.status === 'STORED'
                      ? `<a class="button" href="/api/organization/participant/documents/${encodeURIComponent(
                          document.id,
                        )}">Download ${esc(document.filename)}</a>`
                      : '<span>Download unavailable.</span>'
                  }</article>`,
              )
              .join('')
          : '<p>No documents uploaded yet.</p>';
      };
      const refreshDocuments = async () => {
        const result = await call('participant/documents');
        renderDocuments(result.documents);
      };
      try {
        await refreshDocuments();
      } catch (failure) {
        history.textContent = `Document history unavailable: ${failure.message}`;
      }
      const uploadForm = target.querySelector('#participant-upload'),
        fileInput = uploadForm.querySelector('input[type="file"]'),
        uploadResult = target.querySelector('#participant-upload-result'),
        validateFile = (file) => {
          const extension = file.name.toLowerCase().split('.').pop(),
            acceptedType =
              (extension === 'pdf' && file.type === 'application/pdf') ||
              (extension === 'docx' &&
                file.type ===
                  'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
          if (!acceptedType) {
            uploadResult.textContent = 'Choose a PDF or DOCX file.';
            return false;
          }
          if (file.size > 2 * 1024 * 1024) {
            uploadResult.textContent = 'File must be 2 MiB or smaller.';
            return false;
          }
          uploadResult.textContent = '';
          return true;
        };
      fileInput.onchange = () => {
        const file = fileInput.files[0];
        if (file) validateFile(file);
      };
      uploadForm.onsubmit = async (event) => {
        event.preventDefault();
        const form = event.currentTarget,
          file = fileInput.files[0];
        if (!file || !validateFile(file)) return;
        const body = new FormData();
        body.append('file', file);
        uploadResult.textContent = 'Uploading document…';
        try {
          const uploaded = await call('participant/documents', body);
          await refreshDocuments();
          uploadResult.textContent = `Uploaded version ${uploaded.document.version}.`;
          form.reset();
        } catch (failure) {
          uploadResult.textContent = failure.message;
        }
      };
    }
  }
  async function loadJudgeWorkspace(target) {
    const [assignmentData, teamData] = await Promise.all([
        call('round-two/assignments'),
        call('round-two/teams'),
      ]),
      assignedIds = new Set(
        assignmentData.assignments
          .filter((assignment) => !assignment.revoked_at)
          .map((assignment) => String(assignment.team_id)),
      ),
      teams = teamData.teams.filter((team) => assignedIds.has(String(team.id))),
      details = await Promise.all(
        teams.map(async (team) => ({
          team,
          detail: await call(
            'round-two/teams/' + encodeURIComponent(String(team.id)),
          ),
        })),
      );
    const showQueue = () => {
      target.innerHTML = `<section class="panel"><div class="panel-head"><h2>Assigned teams</h2><button class="button" id="judge-lock">Lock workspace</button></div><label for="judge-team-search">Search teams, repositories, or pull requests</label><input id="judge-team-search" type="search"><label for="judge-mapping-filter">Mapping status</label><select id="judge-mapping-filter"><option value="all">All</option><option value="no-pr">No pull request</option>${[
        ...new Set(
          details.flatMap(({ detail }) =>
            (detail.matrixSubmissions || [])
              .map((submission) => submission.mapping_status)
              .filter(Boolean),
          ),
        ),
      ]
        .map(
          (status) => `<option value="${esc(status)}">${esc(status)}</option>`,
        )
        .join('')}</select><div id="judge-team-list">${
        details
          .map(({ team, detail }) => {
            const prs = detail.matrixSubmissions || [];
            return `<article class="inset judge-team-card" data-team-id="${esc(
              team.id,
            )}" data-search="${esc(
              [
                team.name,
                ...prs.flatMap((pr) => [
                  pr.full_name,
                  pr.pr_number,
                  pr.mapping_status,
                ]),
              ]
                .join(' ')
                .toLowerCase(),
            )}" data-mapping="${prs
              .map((pr) => esc(pr.mapping_status))
              .join(' ')}"><h3>${esc(team.name)}</h3>${
              prs.length
                ? prs
                    .map(
                      (pr) =>
                        `<p>${esc(pr.full_name)} · PR #${esc(
                          pr.pr_number,
                        )} · mapping ${esc(pr.mapping_status)}</p>`,
                    )
                    .join('')
                : '<p>No pull requests submitted.</p>'
            }<button class="button" data-open-review="${esc(
              team.id,
            )}">Open review workspace</button></article>`;
          })
          .join('') || '<p>No teams are currently assigned.</p>'
      }</div></section>`;
      target.querySelector('#judge-lock').onclick = async () => {
        await call('logout', {});
        await load();
      };
      const filter = () => {
        const query = target
            .querySelector('#judge-team-search')
            .value.trim()
            .toLowerCase(),
          mapping = target.querySelector('#judge-mapping-filter').value;
        for (const card of target.querySelectorAll('.judge-team-card')) {
          const noPullRequests =
            card.querySelector('p')?.textContent ===
            'No pull requests submitted.';
          card.hidden =
            !card.dataset.search.includes(query) ||
            (mapping === 'no-pr'
              ? !noPullRequests
              : mapping !== 'all' &&
                !card.dataset.mapping.split(' ').includes(mapping));
        }
      };
      target.querySelector('#judge-team-search').oninput = filter;
      target.querySelector('#judge-mapping-filter').onchange = filter;
      for (const button of target.querySelectorAll('[data-open-review]')) {
        button.onclick = () => showWorkspace(button.dataset.openReview);
      }
    };
    const showWorkspace = async (teamId) => {
      const selected = details.find(
        ({ team }) => String(team.id) === String(teamId),
      );
      if (!selected) return;
      const { team, detail } = selected,
        stages = [
          { id: 'ANALYSIS', label: 'Analysis (10%)' },
          { id: 'ENGINEERING', label: 'Pull Request (90%)' },
        ];
      let activeStage = 'ANALYSIS';
      const renderStage = async (stage) => {
        activeStage = stage;
        if (stage === 'PULL_REQUEST') {
          const submissions = detail.matrixSubmissions || [];
          target.querySelector('#team-review-content').innerHTML =
            `<h3>Tracked pull requests</h3>${
              submissions.length
                ? submissions
                    .map((pr) => {
                      const repo =
                          typeof pr.full_name === 'string' &&
                          /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(
                            pr.full_name,
                          ),
                        number = Number(pr.pr_number),
                        link =
                          repo && Number.isSafeInteger(number) && number > 0
                            ? `https://github.com/${pr.full_name}/pull/${number}`
                            : null,
                        report =
                          pr.report && typeof pr.report === 'object'
                            ? pr.report
                            : null,
                        assessments = Array.isArray(report?.assessments)
                          ? report.assessments
                          : [];
                      return `<article class="inset"><h4>${
                        link
                          ? `<a href="${esc(
                              link,
                            )}" target="_blank" rel="noopener noreferrer">${esc(
                              pr.full_name,
                            )} · PR #${esc(pr.pr_number)}</a>`
                          : `${esc(pr.full_name)} · PR #${esc(pr.pr_number)}`
                      }</h4><p>Head <code>${esc(
                        pr.head_sha || 'Unavailable',
                      )}</code></p><p>Author ${esc(
                        pr.author_login || 'Unavailable',
                      )}${
                        pr.author_id == null
                          ? ''
                          : ` · GitHub user ID ${esc(pr.author_id)}`
                      }</p><p>Mapping ${esc(
                        pr.mapping_status || 'Unavailable',
                      )} · ${esc(pr.mapping_reason || '')}</p><p>Updated ${esc(
                        pr.updated_at || 'Unavailable',
                      )} · ${pr.closed ? 'Closed' : 'Open'} · latest run ${esc(
                        pr.latest_run_id || 'Unavailable',
                      )}</p><p>Evaluation ${esc(
                        pr.evaluation_status || 'Unavailable',
                      )}${
                        pr.failure_code ? ` · ${esc(pr.failure_code)}` : ''
                      }</p>${
                        report
                          ? `<p>${esc(report.summary || '')}</p>${assessments
                              .map(
                                (assessment) =>
                                  `<p>${esc(assessment.criterionId)} · ${esc(
                                    assessment.status,
                                  )} · ${esc(
                                    assessment.explanation ||
                                      assessment.reason ||
                                      '',
                                  )}</p>`,
                              )
                              .join('')}`
                          : '<p>Evaluation evidence unavailable.</p>'
                      }</article>`;
                    })
                    .join('')
                : '<p>No tracked pull requests.</p>'
            }`;
          return;
        }
        const query = `teamId=${encodeURIComponent(
          String(team.id),
        )}&stage=${encodeURIComponent(stage)}`;
        const review = await call('round-two/reviews?' + query),
          content = target.querySelector('#team-review-content'),
          documents = detail.documents || [],
          currentDocument = review.currentDocument,
          draft = review.draft,
          history = review.submissions || [];
        const links = documents
          .map(
            (document) =>
              `<a class="button" href="/api/organization/round-two/teams/${encodeURIComponent(
                String(team.id),
              )}/documents/${encodeURIComponent(document.id)}">Version ${esc(
                document.version,
              )} · ${esc(document.filename)}</a>`,
          )
          .join('');
        let saved = {};
        try {
          saved =
            typeof draft?.payload === 'string'
              ? JSON.parse(draft.payload)
              : draft?.payload || {};
        } catch {}
        const feedback = stage === 'ANALYSIS' ? saved : {};
        const criteria = review.rubric?.criteria || [],
          criterionScores = saved.criteriaScores || [];
        const prEvidence =
          stage === 'ENGINEERING'
            ? `<h3>Tracked pull requests</h3>${
                (detail.matrixSubmissions || [])
                  .map((pr) => {
                    const repositoryParts =
                        typeof pr.full_name === 'string'
                          ? pr.full_name.split('/')
                          : [],
                      validRepository =
                        repositoryParts.length === 2 &&
                        repositoryParts.every((part) =>
                          /^[A-Za-z0-9_.-]+$/.test(part),
                        ),
                      number = Number(pr.pr_number),
                      href =
                        validRepository &&
                        Number.isSafeInteger(number) &&
                        number > 0
                          ? `https://github.com/${pr.full_name}/pull/${number}`
                          : null,
                      report =
                        pr.report && typeof pr.report === 'object'
                          ? pr.report
                          : null,
                      assessments = Array.isArray(report?.assessments)
                        ? report.assessments
                        : [];
                    return `<article class="inset"><h4>${
                      href
                        ? `<a href="${esc(
                            href,
                          )}" target="_blank" rel="noopener noreferrer">${esc(
                            pr.full_name,
                          )} · PR #${esc(pr.pr_number)}</a>`
                        : `${esc(pr.full_name)} · PR #${esc(pr.pr_number)}`
                    }</h4><p>Head <code>${esc(
                      pr.head_sha || 'Unavailable',
                    )}</code></p><p>Author ${esc(
                      pr.author_login || 'Unavailable',
                    )}${
                      pr.author_id == null
                        ? ''
                        : ` · GitHub user ID ${esc(pr.author_id)}`
                    }</p><p>Mapping ${esc(
                      pr.mapping_status || 'Unavailable',
                    )} · ${esc(pr.mapping_reason || '')}</p><p>Updated ${esc(
                      pr.updated_at || 'Unavailable',
                    )} · ${pr.closed ? 'Closed' : 'Open'} · latest run ${esc(
                      pr.latest_run_id || 'Unavailable',
                    )}</p><p>Evaluation ${esc(
                      pr.evaluation_status || 'Unavailable',
                    )}${
                      pr.failure_code ? ` · ${esc(pr.failure_code)}` : ''
                    }</p>${
                      report
                        ? `<p>${esc(report.summary || '')}</p>${assessments
                            .map(
                              (assessment) =>
                                `<p>${esc(assessment.criterionId)} · ${esc(
                                  assessment.status,
                                )} · ${esc(
                                  assessment.explanation ||
                                    assessment.reason ||
                                    '',
                                )}</p>`,
                            )
                            .join('')}`
                        : '<p>Evaluation evidence unavailable.</p>'
                    }</article>`;
                  })
                  .join('') || '<p>No tracked pull requests.</p>'
              }`
            : '';
        content.innerHTML = `${prEvidence}<p>${
          stage === 'ANALYSIS' ? 'Analysis review' : 'Engineering review'
        }</p>${
          stage === 'ANALYSIS'
            ? `<h4>Current analysis document</h4>${
                currentDocument
                  ? `<p>Latest analysis version ${esc(
                      currentDocument.version,
                    )}</p>`
                  : '<p>No analysis document uploaded.</p>'
              }${links}<p>${
                review.documentStale
                  ? 'The selected document is stale; choose the latest version.'
                  : ''
              }</p>`
            : `<h4>Repository rubric</h4>${
                review.rubric
                  ? `<p>Rubric version ${esc(review.rubric.version)}</p>`
                  : `<p>${esc(review.rubricError || 'Rubric unavailable.')}</p>`
              }`
        }<h4>${
          stage === 'ANALYSIS' ? 'Analysis' : 'Engineering'
        } review history</h4>${
          history.length
            ? history
                .map(
                  (submission) =>
                    `<article class="inset"><strong>Revision ${esc(
                      submission.revision,
                    )} · score ${esc(submission.score)}</strong><p>${esc(
                      submission.reason || '',
                    )}</p><p>${esc(
                      JSON.stringify(submission.payload),
                    )}</p></article>`,
                )
                .join('')
            : `<p>No ${
                stage === 'ANALYSIS' ? 'analysis' : 'engineering'
              } review submitted.</p>`
        }${
          draft ? `<p>Draft updated ${esc(draft.updated_at || '')}</p>` : ''
        }<form class="review-form" id="stage-review-form">${
          stage === 'ANALYSIS'
            ? `<label>Score<input name="score" type="number" min="0" max="100" step="0.01" required value="${esc(
                draft?.score ?? '',
              )}"></label><label>Problem understanding<textarea name="problemUnderstanding" required>${esc(
                feedback.problemUnderstanding || '',
              )}</textarea></label><label>Remediation<textarea name="remediation" required>${esc(
                feedback.remediation || '',
              )}</textarea></label><label>Innovation impact<textarea name="innovationImpact" required>${esc(
                feedback.innovationImpact || '',
              )}</textarea></label><label>Overall<textarea name="overall" required>${esc(
                feedback.overall || '',
              )}</textarea></label><label>Analysis document<select name="documentId" required><option value="">Select document version</option>${documents
                .map(
                  (document) =>
                    `<option value="${esc(document.id)}" ${
                      String(draft?.document_id || currentDocument?.id) ===
                      String(document.id)
                        ? 'selected'
                        : ''
                    }>Version ${esc(document.version)}</option>`,
                )
                .join('')}</select></label>`
            : `${criteria
                .map((criterion) => {
                  const prior = criterionScores.find(
                    (item) => item.criterionId === criterion.id,
                  );
                  return `<fieldset><legend>${esc(criterion.label)} (${esc(
                    criterion.weight,
                  )}%)</legend><label>Score<input name="criterion-${esc(
                    criterion.id,
                  )}-score" type="number" min="0" max="100" step="0.01" required value="${esc(
                    prior?.score ?? '',
                  )}"></label><label>Comment<textarea name="criterion-${esc(
                    criterion.id,
                  )}-comment">${esc(
                    prior?.comment || '',
                  )}</textarea></label></fieldset>`;
                })
                .join('')}<label>Overall<textarea name="overall" required>${esc(
                saved.overall || '',
              )}</textarea></label>`
        }${
          history.length
            ? '<label>Revision reason<textarea name="reason" aria-label="Revision reason" minlength="10" maxlength="1000"></textarea></label>'
            : ''
        }<div class="form-actions">${
          !history.length
            ? '<button class="button" type="button" data-review-action="SAVE_DRAFT">Save draft</button><button class="button primary" type="button" data-review-action="SUBMIT">Submit final review</button>'
            : '<button class="button primary" type="button" data-review-action="REVISE">Revise final review</button>'
        }</div></form><p id="review-status" role="status"></p>`;
        const sendReview = async (action) => {
          const form = content.querySelector('#stage-review-form'),
            values = new FormData(form),
            body = { action, teamId: String(team.id), stage };
          if (stage === 'ANALYSIS') {
            body.score = Number(values.get('score'));
            body.documentId = values.get('documentId');
            body.feedback = {
              problemUnderstanding: values.get('problemUnderstanding'),
              remediation: values.get('remediation'),
              innovationImpact: values.get('innovationImpact'),
              overall: values.get('overall'),
            };
          } else {
            body.criteriaScores = criteria.map((criterion) => ({
              criterionId: criterion.id,
              score: Number(values.get(`criterion-${criterion.id}-score`)),
              comment: values.get(`criterion-${criterion.id}-comment`),
            }));
            body.overall = values.get('overall');
          }
          if (action === 'REVISE') body.reason = values.get('reason');
          const status = content.querySelector('#review-status');
          status.textContent = 'Saving review…';
          try {
            const result = await call('round-two/reviews', body);
            await renderStage(activeStage);
            content.querySelector('#review-status').textContent =
              action === 'SAVE_DRAFT'
                ? 'Draft saved.'
                : `Submitted revision ${result.revision}.`;
          } catch (failure) {
            status.textContent = failure.message;
          }
        };
        for (const button of content.querySelectorAll('[data-review-action]')) {
          button.onclick = () => sendReview(button.dataset.reviewAction);
        }
      };
      target.innerHTML = `<section class="panel"><div class="panel-head"><h2>${esc(
        team.name,
      )} review workspace</h2><button class="button" id="judge-back">Back to assigned teams</button></div><nav aria-label="Review stages">${stages
        .map(
          (stage) =>
            `<button class="button" data-review-stage="${stage.id}">${stage.label}</button>`,
        )
        .join('')}</nav><div id="team-review-content"></div></section>`;
      target.querySelector('#judge-back').onclick = showQueue;
      for (const button of target.querySelectorAll('[data-review-stage]')) {
        button.onclick = () => renderStage(button.dataset.reviewStage);
      }
      await renderStage('ANALYSIS');
    };
    showQueue();
  }
  async function loadSecurity(target) {
    const data = await call('security-reports');
    target.innerHTML = `<h3>Confidential vulnerability reports</h3><p>Restricted to organizers and security reviewers. Reports and attached text stay out of GitHub issues, judging evidence and AI review. Use this private intake for sensitive reproduction details.</p><form id="security-intake" class="review-form"><label>Repository ID<input name="repositoryId" type="number" min="1" required></label><label>Title<input name="title" minlength="5" maxlength="120" required></label><label>Private reproduction and impact<textarea name="details" minlength="20" maxlength="20000" required></textarea></label><label>Optional text artifact name<input name="artifactName" maxlength="120"></label><label>Optional private text artifact<textarea name="artifactContent" maxlength="20000"></textarea></label><button class="button">Submit privately</button></form><p id="security-result" role="status"></p><div>${
      data.reports
        .map(
          (r) =>
            `<button class="row-button" data-security-id="${esc(
              r.id,
            )}">${esc(r.title)} · ${esc(r.status)}</button>`,
        )
        .join('') || '<p>No confidential reports.</p>'
    }</div><div id="security-detail"></div>`;
    target.querySelector('#security-intake').onsubmit = async (event) => {
      event.preventDefault();
      const values = new FormData(event.target);
      try {
        await call('security-reports', {
          repositoryId: Number(values.get('repositoryId')),
          title: values.get('title'),
          details: values.get('details'),
          artifacts: values.get('artifactContent')
            ? [
                {
                  name: values.get('artifactName'),
                  content: values.get('artifactContent'),
                },
              ]
            : [],
        });
        await loadSecurity(target);
        target.querySelector('#security-result').textContent =
          'Confidential report received.';
      } catch (failure) {
        target.querySelector('#security-result').textContent = failure.message;
      }
    };
    for (const button of target.querySelectorAll('[data-security-id]')) {
      button.onclick = async () => {
        try {
          const id = button.dataset.securityId;
          const detail = await call('security-reports/' + id);
          const region = target.querySelector('#security-detail');
          region.innerHTML = `<h4>${esc(
            detail.report.title,
          )}</h4><pre>${esc(detail.report.details)}</pre>${detail.report.artifacts
            .map((a) => `<h4>${esc(a.name)}</h4><pre>${esc(a.content)}</pre>`)
            .join('')}<h4>Private review history</h4>${detail.reviews
            .map(
              (r) =>
                `<p>${esc(r.status)} · ${esc(
                  r.created_at,
                )}</p><pre>${esc(r.reason)}</pre>`,
            )
            .join(
              '',
            )}<form class="review-form"><label>Review state<select name="status">${[
            'TRIAGED',
            'NEEDS_INFORMATION',
            'CONFIRMED',
            'REJECTED',
            'RESOLVED',
          ]
            .map((v) => `<option>${v}</option>`)
            .join(
              '',
            )}</select></label><label>Private reason<textarea name="reason" minlength="20" maxlength="2000" required></textarea></label><button class="button">Record private review</button></form>`;
          region.querySelector('form').onsubmit = async (event) => {
            event.preventDefault();
            const values = new FormData(event.target);
            try {
              await call('security-reports/' + id + '/reviews', {
                status: values.get('status'),
                reason: values.get('reason'),
              });
              await loadSecurity(target);
            } catch (failure) {
              target.querySelector('#security-result').textContent =
                failure.message;
            }
          };
        } catch (failure) {
          target.querySelector('#security-result').textContent =
            failure.message;
        }
      };
    }
  }
  function receipt(value) {
    if (value.length > 16000) throw new Error('INVALID_CONNECTION_RECEIPT');
    let data;
    try {
      data = JSON.parse(value);
    } catch {
      throw new Error('INVALID_CONNECTION_RECEIPT');
    }
    const allowed = [
      'reference',
      'connection',
      'organization',
      'workspace',
      'origin',
      'targetHash',
      'appId',
      'appSlug',
      'installationId',
      'repositories',
      'actor',
      'at',
      'expiresAt',
      'runner',
      'provider',
      'functionalEvaluation',
    ];
    if (
      !data ||
      typeof data !== 'object' ||
      Array.isArray(data) ||
      Object.keys(data).some((key) => !allowed.includes(key))
    ) {
      throw new Error(
        'Use only the credential-free connection receipt, never the private setup journal.',
      );
    }
    const org = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/;
    let origin;
    try {
      origin = new URL(data.origin);
    } catch {
      throw new Error('INVALID_CONNECTION_RECEIPT');
    }
    const at = Date.parse(data.at),
      expires = Date.parse(data.expiresAt),
      now = Date.now();
    if (
      data.connection !== 'VERIFIED' ||
      [
        'organization',
        'workspace',
        'origin',
        'targetHash',
        'reference',
        'at',
        'expiresAt',
      ].some((key) => typeof data[key] !== 'string') ||
      ['appSlug', 'actor', 'runner', 'provider', 'functionalEvaluation'].some(
        (key) => data[key] !== undefined && typeof data[key] !== 'string',
      ) ||
      (data.repositories !== undefined &&
        (!Array.isArray(data.repositories) ||
          data.repositories.some((item) => typeof item !== 'string'))) ||
      !org.test(data.organization) ||
      !/^[a-z0-9][a-z0-9-]{0,62}$/.test(data.workspace) ||
      origin.protocol !== 'https:' ||
      origin.origin !== data.origin ||
      !/^[a-f0-9]{64}$/.test(data.targetHash) ||
      !/^[a-f0-9]{32}$/.test(data.reference) ||
      !Number.isSafeInteger(data.appId) ||
      data.appId < 1 ||
      !Number.isSafeInteger(data.installationId) ||
      data.installationId < 1 ||
      !Number.isFinite(at) ||
      !Number.isFinite(expires) ||
      at > now ||
      now - at > 900000 ||
      expires <= now ||
      expires <= at ||
      expires - at > 900000
    ) {
      throw new Error('INVALID_OR_EXPIRED_CONNECTION_RECEIPT');
    }
    return {
      organization: data.organization,
      workspace: data.workspace,
      origin: data.origin,
      targetHash: data.targetHash,
      appId: data.appId,
      installationId: data.installationId,
      verificationReference: data.reference,
      verifiedAt: data.at,
      expiresAt: data.expiresAt,
    };
  }
  function retirementPanel(status, target) {
    const pending = status.retirement?.state === 'RETIRING';
    target.innerHTML = `<h3>${
      pending ? 'Retirement pending' : 'Retire this workspace'
    }</h3><p>Retirement fences new work and removes this workspace’s GitHub App installation. Historical evidence remains read-only. Your acknowledgement authorizes retirement; it is not independent replacement proof or functional evaluation evidence.</p>${
      pending
        ? `<p>Installation removal is not confirmed. ${esc(
            status.retirement.error ||
              'Waiting for authoritative GitHub confirmation.',
          )}</p><p>Replacement: ${esc(
            status.retirement.replacement?.organization,
          )} · ${esc(status.retirement.replacement?.origin)}</p>`
        : ''
    }<form id="organization-retirement" class="review-form">${
      pending
        ? ''
        : '<label>Credential-free connection receipt<textarea id="retirement-receipt" maxlength="16000" required></textarea></label><p id="replacement-review" role="status"></p>'
    }<label>Type ${esc(
      status.organization,
    )} exactly<input id="retirement-confirmation" autocomplete="off" required></label><label><input id="retirement-attestation" type="checkbox" required> I have verified the replacement workspace and authorize removal of this old installation.</label><button class="button" id="retirement-submit" disabled>${
      pending ? 'Retry installation removal' : 'Retire old workspace'
    }</button><p id="retirement-result" role="status"></p></form>`;
    let replacement = pending ? status.retirement.replacement : null;
    const update = () => {
      if (!pending) {
        try {
          replacement = receipt($('#retirement-receipt').value);
          $('#replacement-review').textContent =
            `Replacement: ${replacement.organization} · ${replacement.origin}`;
        } catch {
          replacement = null;
          $('#replacement-review').textContent =
            'Paste a fresh credential-free verification receipt.';
        }
      }
      $('#retirement-submit').disabled =
        !replacement ||
        $('#retirement-confirmation').value !== status.organization ||
        !$('#retirement-attestation').checked;
    };
    target.querySelector('form').addEventListener('input', update);
    target.querySelector('form').addEventListener('submit', async (event) => {
      event.preventDefault();
      update();
      if ($('#retirement-submit').disabled) return;
      $('#retirement-submit').disabled = true;
      $('#retirement-result').textContent =
        'Waiting for authoritative installation removal…';
      try {
        const result = await call('retire', {
          confirmation: $('#retirement-confirmation').value,
          attestation: true,
          replacement,
        });
        if (!['RETIRING', 'RETIRED'].includes(result.retirement?.state)) {
          throw new Error('RETIREMENT_UNCONFIRMED');
        }
        await load();
      } catch (failure) {
        $('#retirement-result').textContent = failure.message;
        update();
      }
    });
  }
  async function loadArchive(status) {
    $('#mode-label').textContent = 'READ ONLY ARCHIVE';
    const replacement = status.retirement.replacement;
    let link = '';
    try {
      const url = new URL(replacement?.origin);
      if (url.protocol === 'https:' && url.origin === replacement.origin) {
        link = `<a class="button" href="${esc(
          url.origin,
        )}?organization=1">Open replacement ${esc(
          replacement.organization,
        )}</a>`;
      }
    } catch {}
    $('#content').innerHTML = `<section class="panel"><h2>${esc(
      status.organization,
    )} · ${
      status.retirement.state === 'RETIRED'
        ? 'Retired workspace'
        : 'Retirement pending'
    }</h2><p>Historical evidence is read-only. New evaluation work is fenced.${
      status.retirement.state === 'RETIRING'
        ? ' Installation removal is not confirmed.'
        : ''
    }</p>${link}<button class="button" id="archive-lock">Lock organization</button></section><div id="archive-role"></div><div id="organization-runs"></div><div id="organization-detail"></div>`;
    $('#archive-lock').onclick = async () => {
      await call('logout', {});
      await load();
    };
    const strip = () =>
      document
        .querySelectorAll(
          '#content form,#retry-evaluation,#retry-artifact-capture,[data-contribution-decision],[data-contribution-reason]',
        )
        .forEach((node) => {
          if (!node.closest('#retirement-panel')) node.remove();
        });
    roleObserver = new MutationObserver(strip);
    roleObserver.observe($('#content'), { childList: true, subtree: true });
    if (status.role === 'organizer' && status.retirement.state === 'RETIRING') {
      const panel = document.createElement('section');
      panel.id = 'retirement-panel';
      panel.className = 'panel inset';
      $('#content').append(panel);
      retirementPanel(status, panel);
    }
    if (status.role === 'participant') {
      await loadParticipant($('#archive-role'));
    } else if (status.role === 'security') {
      await loadSecurity($('#archive-role'));
    } else {
      const overview = await call('overview');
      $('#organization-runs').innerHTML =
        `<section class="panel"><h3>Historical evaluations</h3>${
          overview.runs
            .map(
              (run) =>
                `<button class="row-button" data-org-run="${esc(
                  run.id,
                )}">${esc(run.full_name)} · PR #${esc(
                  run.pr_number,
                )} · ${esc(run.state)}</button>`,
            )
            .join('') || '<p>No recorded evaluations.</p>'
        }</section>`;
      document
        .querySelectorAll('[data-org-run]')
        .forEach(
          (button) => (button.onclick = () => detail(button.dataset.orgRun)),
        );
      const id = new URL(location.href).searchParams.get('evaluation');
      if (id) await detail(id);
    }
    strip();
  }
  async function load() {
    clearTimeout(timer);
    roleObserver?.disconnect();
    roleObserver = null;
    authenticatedRole = null;
    archiveReadOnly = false;
    $('#message').textContent = '';
    $('#login').hidden = true;
    $('#signout').hidden = true;
    $('#content').hidden = false;
    $('#breadcrumb').textContent = 'Workspace / GitHub organization';
    $('#mode-label').textContent = 'GITHUB APP';
    $('#demo-banner').hidden = true;
    try {
      const status = await call('status');
      if (!status.authenticated) {
        $('#content').innerHTML =
          `<section class="panel"><div class="panel-head"><h2>Connect ${esc(
            status.organization,
          )}</h2></div><form class="review-form" id="organization-login"><p>Unlock the organization console with your named console access code or organization setup code. Your server-assigned role controls access. App private keys stay on the server.</p><label for="organization-token">Organizer access code or named console code</label><input id="organization-token" type="password" autocomplete="off" required minlength="32"><button class="button primary">Unlock organization</button></form></section>`;
        $('#organization-login').addEventListener('submit', async (event) => {
          event.preventDefault();
          const token = $('#organization-token').value;
          $('#organization-token').value = '';
          try {
            await call('login', { token });
            await load();
          } catch (e) {
            error(e);
          }
        });
        return;
      }
      authenticatedRole = status.role;
      archiveReadOnly = ['RETIRING', 'RETIRED'].includes(
        status.retirement?.state,
      );
      if (archiveReadOnly) {
        await loadArchive(status);
        return;
      }
      if (status.identity) {
        $('#breadcrumb').textContent =
          `Workspace / ${status.identity.name} · ${status.role}`;
      }
      if (status.role === 'participant') {
        $('#mode-label').textContent = 'PARTICIPANT · READ ONLY';
        $('#content').innerHTML = `<section class="panel inset"><h2>${esc(
          status.identity?.name,
        )} · Team console</h2><button class="button" id="participant-lock">Lock team console</button><div id="participant-workspace"></div></section>`;
        $('#participant-lock').onclick = async () => {
          await call('logout', {});
          await load();
        };
        await loadParticipant($('#participant-workspace'));
        return;
      }
      if (status.role === 'judge') {
        $('#mode-label').textContent = 'JUDGE · ASSIGNED TEAMS';
        $('#content').innerHTML =
          '<section class="panel"><div id="judge-workspace"></div></section>';
        await loadJudgeWorkspace($('#judge-workspace'));
        return;
      }
      if (status.role === 'security') {
        $('#content').innerHTML =
          '<section class="panel"><button class="button" id="security-lock">Lock security console</button><div id="confidential-security"></div></section>';
        $('#security-lock').onclick = async () => {
          await call('logout', {});
          await load();
        };
        await loadSecurity($('#confidential-security'));
        return;
      }
      const app = status.app;
      if (status.role === 'judge') {
        const disableAdmin = () => {
          for (const form of document.querySelectorAll(
            '#content form:not(#workflow-query)',
          )) {
            for (const control of form.querySelectorAll(
              'input,select,textarea,button',
            )) {
              if (!control.disabled) control.disabled = true;
            }
          }
          for (const control of document.querySelectorAll(
            '#sync-repositories,#register-app,#test-runner,#test-reviewer,#retry-labels,#retry-evaluation,[data-configure]',
          )) {
            if (!control.disabled) control.disabled = true;
          }
        };
        roleObserver = new MutationObserver(disableAdmin);
        roleObserver.observe($('#content'), {
          childList: true,
          subtree: true,
        });
        disableAdmin();
        $('#mode-label').textContent = 'JUDGE · READ ONLY';
      }
      $('#content').innerHTML =
        `<section class="panel"><div class="panel-head"><h2>${esc(
          status.organization,
        )} · GitHub App</h2><button class="button" id="organization-lock">Lock organization</button></div><div class="inset"><p>${
          app
            ? `App <strong>${esc(app.slug)}</strong> · ${
                app.installationId
                  ? 'Installation #' + app.installationId
                  : 'Awaiting installation'
              }`
            : 'Create an organization-owned GitHub App. Contents and PRs: read. Issues and checks: write. No source modification permissions.'
        }</p>${
          !app
            ? '<button class="button primary" id="register-app">Register App on GitHub</button>'
            : !app.installationId
              ? `<a class="button primary" href="${esc(
                  app.installUrl,
                )}">Install on ${esc(status.organization)}</a>`
              : '<button class="button" id="sync-repositories">Sync installed repositories</button>'
        }<p class="subtle">Only repositories selected during installation are available. Functional behavior remains UNVERIFIED until isolated checks provide execution evidence.</p></div></section><section class="panel inset"><p><strong>Isolated execution: ${
          status.runner?.enabled ? 'configured' : 'disabled'
        }</strong> · AI requirement review: ${
          status.ai?.enabled ? 'configured' : 'disabled'
        }</p><p class="subtle">${esc(
          status.runner?.reason ||
            'Runtime availability has not been verified.',
        )}</p><button class="button" id="test-runner">Test Docker runner</button><p id="runner-status" role="status"></p><button class="button" id="test-reviewer">Test AI reviewer</button><p id="reviewer-status" role="status"></p></section><div id="organization-workflow"></div><div id="organization-repositories"></div><div id="organization-runs"></div><div id="organization-detail"></div>`;
      if (authenticatedRole === 'organizer') {
        const panel = document.createElement('section');
        panel.className = 'panel inset';
        panel.innerHTML =
          '<h3>System observations</h3><button class="button" id="load-system-metrics">Load last-hour observations</button><p id="system-metrics-result" role="status">Metrics are operational observations, not a submission quality score.</p>';
        $('#content').append(panel);
        $('#load-system-metrics').addEventListener('click', async () => {
          const target = $('#system-metrics-result');
          target.textContent = 'Loading recorded metrics…';
          try {
            const data = await call('system/metrics?minutes=60');
            const totals = new Map();
            for (const bucket of data.buckets || []) {
              const total = totals.get(bucket.metric) || {
                count: 0,
                sum: 0,
                max: 0,
              };
              total.count += bucket.count;
              total.sum += bucket.sum;
              total.max = Math.max(total.max, bucket.max);
              totals.set(bucket.metric, total);
            }
            target.textContent = totals.size
              ? [...totals]
                  .map(([name, item]) =>
                    name.endsWith('latencyMs') || name.endsWith('durationMs')
                      ? ` ${name}: ${Math.round(
                          item.sum / item.count,
                        )} ms mean, ${item.max} ms maximum (${item.count} samples)`
                      : `${name}: ${item.sum} recorded ${
                          name.endsWith('Tokens') ? 'tokens' : 'events'
                        }`,
                  )
                  .join(' · ') +
                ' · Retention: 7 days. ' +
                (data.alerts ?? [])
                  .map(
                    (alert) =>
                      alert.title + ': ' + alert.observed + '. ' + alert.action,
                  )
                  .join(' ')
              : 'No recorded observations for this window. This is not proof of healthy or inactive services.';
          } catch (failure) {
            target.textContent = `Metrics unavailable${
              failure.status ? ' (HTTP ' + failure.status + ')' : ''
            }. Existing evaluation evidence is unaffected.`;
          }
        });
      }
      $('#organization-lock').addEventListener('click', async () => {
        try {
          await call('logout', {});
          await load();
        } catch (e) {
          error(e);
        }
      });
      $('#test-runner')?.addEventListener('click', async () => {
        const button = $('#test-runner');
        button.disabled = true;
        $('#runner-status').textContent =
          'Checking the authenticated tunnel and isolated baseline/submission containers…';
        try {
          const result = await call('runner-check', {});
          $('#runner-status').textContent =
            result.status === 'COMPLETED'
              ? 'Docker runner verified: missing baseline FAIL → trusted canary PASS. Synthetic diagnostic, not a participant PR evaluation.'
              : 'Runner diagnostic: ' +
                result.status +
                '. No functional behavior has been verified.';
        } catch (e) {
          error(e);
          $('#runner-status').textContent =
            'Runner unavailable. Participant checks remain UNVERIFIED.';
        } finally {
          button.disabled = false;
        }
      });
      $('#test-reviewer')?.addEventListener('click', async () => {
        const button = $('#test-reviewer');
        button.disabled = true;
        $('#reviewer-status').textContent =
          'Checking provider and structured output validation…';
        try {
          const result = await call('reviewer-check', {});
          $('#reviewer-status').textContent =
            result.status === 'COMPLETED'
              ? 'AI reviewer returned a validated report. This is a synthetic diagnostic, not a PR evaluation.'
              : result.trace?.failureCode === 'CLOUDFLARE_AI_QUOTA_EXHAUSTED'
                ? 'Cloudflare AI daily quota exhausted. Wait for the quota reset or enable Workers Paid. AI analysis remains UNVERIFIED; objective evidence is preserved.'
                : 'Reviewer diagnostic: ' +
                  result.status +
                  '. Objective evidence remains available.';
        } catch (e) {
          error(e);
        } finally {
          button.disabled = false;
        }
      });
      $('#register-app')?.addEventListener('click', async () => {
        try {
          const setup = await call('start', {});
          const target = new URL(setup.action);
          if (
            target.origin !== 'https://github.com' ||
            target.pathname !==
              `/organizations/${encodeURIComponent(
                status.organization,
              )}/settings/apps/new` ||
            target.username ||
            target.password
          ) {
            throw new Error('INVALID_REGISTRATION_TARGET');
          }
          const form = document.createElement('form');
          form.action = target.href;
          form.method = 'POST';
          const field = document.createElement('input');
          field.type = 'hidden';
          field.name = 'manifest';
          field.value = JSON.stringify(setup.manifest);
          form.append(field);
          document.body.append(form);
          form.submit();
        } catch (e) {
          error(e);
        }
      });
      $('#sync-repositories')?.addEventListener('click', async () => {
        try {
          await call('sync', {});
          await load();
        } catch (e) {
          error(e);
        }
      });
      if (authenticatedRole === 'organizer') {
        const retirement = document.createElement('section');
        retirement.className = 'panel inset';
        $('#content').append(retirement);
        retirementPanel(status, retirement);
        const securityPanel = document.createElement('section');
        securityPanel.className = 'panel inset';
        $('#content').appendChild(securityPanel);
        try {
          await loadSecurity(securityPanel);
        } catch (failure) {
          securityPanel.innerHTML = `<h3>Confidential vulnerability reports</h3><p role="status">Restricted report intake unavailable: ${esc(
            failure.message,
          )}. Existing evaluation views remain available.</p>`;
        }
        const identitiesPanel = document.createElement('section');
        identitiesPanel.className = 'panel inset';
        $('#content').appendChild(identitiesPanel);
        try {
          await loadIdentities(identitiesPanel);
        } catch (failure) {
          identitiesPanel.innerHTML = `<h3>Named console access</h3><p role="status">Identity management unavailable: ${esc(
            failure.message,
          )}.</p>`;
        }
      }
      if (!app?.installationId) return;
      const [repos, overview] = await Promise.all([
        call('repositories'),
        call('overview'),
      ]);
      try {
        await window.JudgeCompetition.mount(
          $('#organization-workflow'),
          repos.repositories,
        );
      } catch {
        // A management outage must not hide already-persisted judging evidence.
        $('#organization-workflow').innerHTML =
          '<section class="panel"><p role="status">Hackathon controls are unavailable. Evaluation evidence remains available; refresh to retry management.</p></section>';
      }
      $('#organization-repositories').innerHTML =
        `<section class="panel"><div class="panel-head"><h2>Installed repositories</h2><span>${
          repos.repositories.filter((r) => r.accessible).length
        } available</span></div>${
          repos.repositories
            .map(
              (r) =>
                `<article class="repo-card"><h3>${esc(r.full_name)}</h3><p>${
                  r.private ? 'Private' : 'Public'
                } · ${esc(r.default_branch)} · ${
                  r.accessible
                    ? 'Installation access confirmed'
                    : 'Access removed'
                }</p>${
                  r.accessible
                    ? `<button class="button" data-configure="${r.id}">Configure issue and evaluation</button>`
                    : ''
                }<div id="repository-${r.id}"></div></article>`,
            )
            .join('') ||
          '<div class="empty">No repositories selected. Update the App installation on GitHub, then sync.</div>'
        }</section>`;
      document
        .querySelectorAll('[data-configure]')
        .forEach((button) =>
          button.addEventListener('click', () =>
            configure(Number(button.dataset.configure)),
          ),
        );
      $('#organization-runs').innerHTML =
        `<section class="panel"><div class="panel-head"><h2>Organization evaluations</h2><span>${overview.counts.active} active · ${overview.counts.attention} require attention</span></div>${
          overview.runs
            .map(
              (run) =>
                `<div class="inset"><button class="row-button" data-org-run="${esc(
                  run.id,
                )}"><strong>${esc(
                  run.full_name ?? contract.repository.fullName,
                )} · PR #${run.pr_number}</strong><small>${esc(
                  run.state,
                )} · ${esc(run.head_sha.slice(0, 12))}</small></button></div>`,
            )
            .join('') ||
          '<div class="empty">Configure an assigned issue and team for a PR to start. Subsequent GitHub PR events evaluate new heads automatically.</div>'
        }</section>`;
      document
        .querySelectorAll('[data-org-run]')
        .forEach((button) =>
          button.addEventListener('click', () => detail(button.dataset.orgRun)),
        );
      const id = new URL(location.href).searchParams.get('evaluation');
      if (id) await detail(id);
    } catch (e) {
      error(e);
    }
  }
  async function configure(id) {
    try {
      const data = await call(`repositories/${id}/context`),
        container = $('#repository-' + id);
      if (!data.pulls.length || !data.issues.length) {
        container.innerHTML = `<p>Create an open issue and PR in <a href="https://github.com/${esc(
          data.repository.full_name,
        )}">${esc(
          data.repository.full_name,
        )}</a> to assign and evaluate work.</p>`;
        return;
      }
      container.innerHTML = `<form class="review-form" id="challenge-${id}"><label for="pr-${id}">Pull request</label><select id="pr-${id}" name="prNumber">${data.pulls
        .map(
          (pr) =>
            `<option value="${pr.number}">#${pr.number} · ${esc(
              pr.title,
            )}</option>`,
        )
        .join(
          '',
        )}</select><label for="issue-${id}">Assigned issue</label><select id="issue-${id}" name="issueNumber">${data.issues
        .map(
          (issue) =>
            `<option value="${issue.number}">#${issue.number} · ${esc(
              issue.title,
            )}</option>`,
        )
        .join(
          '',
        )}</select><label for="execution-${id}">Trusted execution profile</label><select id="execution-${id}" name="executionProfile"><option value="source-only">Source review only</option><option value="payment-retry-v1">Payment retry API v1 — four trusted acceptance cases</option></select><p class="subtle">The payment profile requires server.mjs serving POST /payments/retry on port 9000. It verifies transient retries, attempt limits, permanent failures and invalid limits. Select only if these are approved challenge requirements. With execution disabled, all four remain UNVERIFIED.</p><label for="team-${id}">Team name</label><input id="team-${id}" name="teamName" required maxlength="100"><label for="expected-${id}">Authoritative expected behavior and acceptance criteria</label><textarea id="expected-${id}" name="expectedBehavior" required minlength="10" maxlength="2000" rows="4"></textarea><label for="baseline-${id}">Freeze baseline commit</label><input id="baseline-${id}" name="baseline" value="${esc(
        data.baseline,
      )}" pattern="[a-f0-9]{40}" required><p class="subtle">Defaults to the current default-branch commit. Confirm this is the intended starting state; it must be an ancestor of the PR head.</p><div class="form-grid"><div><label for="source-${id}">Source assertion path (optional)</label><input id="source-${id}" name="sourcePath"></div><div><label for="literal-${id}">Required literal text (optional)</label><input id="literal-${id}" name="sourceText" maxlength="1000"></div></div><label for="protected-${id}">Protected paths (one per line)</label><textarea id="protected-${id}" name="protectedPaths" rows="2"></textarea><p class="subtle">These expectations are stored outside the participant repository. Activating creates immutable evaluation inputs and publishes a Judge-C2C Check to the PR.</p><button class="button primary" type="submit">Activate challenge and evaluate PR</button><div id="challenge-status-${id}" role="status"></div></form>`;
      $('#challenge-' + id).addEventListener('submit', async (event) => {
        event.preventDefault();
        const values = new FormData(event.currentTarget),
          button = event.currentTarget.querySelector('button[type=submit]');
        const input = {
          repositoryId: id,
          prNumber: Number(values.get('prNumber')),
          issueNumber: Number(values.get('issueNumber')),
          teamName: values.get('teamName'),
          expectedBehavior: values.get('expectedBehavior'),
          baseline: values.get('baseline'),
          executionProfile: values.get('executionProfile'),
          protectedPaths: String(values.get('protectedPaths'))
            .split('\n')
            .map((value) => value.trim())
            .filter(Boolean),
        };
        if (values.get('sourcePath') || values.get('sourceText')) {
          if (!values.get('sourcePath') || !values.get('sourceText')) {
            error(new Error('Provide both source path and literal text.'));
            return;
          }
          input.sourceAssertion = {
            path: values.get('sourcePath'),
            text: values.get('sourceText'),
          };
        }
        button.disabled = true;
        try {
          const result = await call('challenges', input);
          $('#challenge-status-' + id).textContent =
            'Evaluation queued. Open the report below.';
          await load();
          if (result.runId) await detail(result.runId);
        } catch (e) {
          button.disabled = false;
          error(e);
        }
      });
    } catch (e) {
      error(e);
    }
  }
  function repositoryIntelligenceHtml(context, trace) {
    const index = context?.repositoryIntelligence;
    const files = Array.isArray(index?.files) ? index.files.slice(0, 30) : [];
    const reads = Array.isArray(trace?.retrieval?.log)
      ? trace.retrieval.log.slice(0, 4)
      : [];
    if (!index && !trace?.retrieval && !trace?.retrievalFailure) return '';
    return `<details class="inset"><summary>Source inventory and review context</summary>${
      index
        ? `<p>Advisory inventory · ${esc(index.version)} · ${esc(
            index.status,
          )} · ${esc(index.scope)}. ${esc(
            (index.limitations || []).join(' '),
          )}</p><p>Immutable index ${
            context.repositoryIndexCache?.hit ? 'reused' : 'created'
          } · <code>${esc(
            context.repositoryIndexCache?.key || 'unavailable',
          )}</code></p>${files
            .map(
              (file) =>
                `<article><strong>${esc(file.path)}</strong><p>Component ${esc(
                  file.component,
                )} · symbols ${esc(
                  (file.symbols || [])
                    .slice(0, 200)
                    .map((symbol) => symbol.name)
                    .join(', ') || 'none inventoried',
                )}</p><p>Added ${esc(
                  (file.added || []).join(', ') || 'none',
                )} · removed ${esc(
                  (file.removed || []).join(', ') || 'none',
                )}</p>${(file.potentialApiChanges || [])
                  .map(
                    (change) =>
                      `<p>Potential API ${esc(change.kind)}: <code>${esc(
                        change.name,
                      )}</code> · UNVERIFIED; requires compatibility checks.</p>`,
                  )
                  .join('')}</article>`,
            )
            .join('')}`
        : ''
    }${
      trace?.retrieval
        ? `<p>Progressive reads: ${esc(
            String(trace.retrieval.bytes),
          )}/${esc(String(trace.retrieval.maxBytes))} bytes · ${esc(
            String(reads.length),
          )}/${esc(String(trace.retrieval.maxReads))} reads.</p>${reads
            .map(
              (read) =>
                `<p><code>${esc(read.path)}</code> · ${esc(
                  read.side,
                )} lines ${esc(String(read.startLine))} + ${esc(
                  String(read.lineCount),
                )} · ${esc(read.status)} · ${esc(
                  String(read.bytes),
                )} bytes</p>`,
            )
            .join('')}`
        : ''
    }${
      trace?.retrievalFailure
        ? `<p>Optional retrieval unavailable: ${esc(
            trace.retrievalFailure,
          )}. Review uses supplied evidence.</p>`
        : ''
    }</details>`;
  }
  async function detail(
    id,
    artifactCaptureResult = null,
    contributionNotice = null,
  ) {
    try {
      clearTimeout(timer);
      const run = await call('evaluations/' + encodeURIComponent(id)),
        contract = JSON.parse(run.contract_snapshot),
        evidence = JSON.parse(run.evidence || '[]'),
        report = JSON.parse(run.report || 'null');
      const expectedArtifactHtml =
        Array.isArray(run.expectedArtifactResults) &&
        run.expectedArtifactResults.length
          ? '<section class="panel"><h3>Expected artifacts — availability only</h3>' +
            run.expectedArtifactResults
              .map(
                (item) =>
                  `<div class="inset"><strong>${esc(
                    item.id,
                  )} · ${esc(item.kind)} · ${esc(item.status)}</strong><p>${
                    item.required ? 'Required capture' : 'Optional capture'
                  } · ${esc(item.reason)}</p></div>`,
              )
              .join('') +
            '</section>'
          : '<p class="subtle">No artifact expectations declared in this frozen contract.</p>';
      const planHtml = run.evaluationPlan
        ? `<p>Review depth: ${esc(run.evaluationPlan.depth)} · ${esc(
            (run.evaluationPlan.reviewAreas || []).join(', '),
          )}. ${esc(
            (run.evaluationPlan.reasons || []).join(' '),
          )} All authoritative checks remain required.</p>`
        : '<p>Evaluation plan unavailable.</p>';
      const routingHtml = report?.aiTrace?.modelRouting
        ? `<p>AI model: ${esc(report.aiTrace.model || 'Unavailable')} · ${esc(
            report.aiTrace.modelRouting.reason,
          )} Routing version ${esc(report.aiTrace.modelRouting.version)}.</p>`
        : '';
      const groundingHtml =
        report?.aiTrace?.requiresHumanAttention ||
        (report &&
          report.aiTrace?.groundingPolicy !==
            'objective-facts-unverified-narratives-v1')
          ? '<p class="error" role="status">Needs review: contextual AI narratives are unverified interpretations. Citation validity does not establish prose truth. Objective evidence alone determines criterion outcomes.</p>'
          : '';
      const findings = Array.isArray(report?.findings) ? report.findings : [];
      const engineeringHtml =
        '<section class="panel"><h3>Engineering findings</h3><p>Quality, architecture, security, performance and testing observations are advisory. Severity is a review priority, not proof of a defect.</p>' +
        (findings.length
          ? findings
              .map((finding, index) => {
                const provenance = (report.findingsProvenance || []).find(
                  (item) => item.findingIndex === index,
                );
                return `<article class="inset engineering-finding"><strong>${esc(
                  finding.category,
                )} · ${esc(
                  finding.severity,
                )}</strong><span class="badge">UNVERIFIED AI interpretation · assessment</span><p>Origin: ${esc(
                  provenance?.origin || 'UNVERIFIED',
                )} · related requirements: ${esc(
                  provenance?.relatedRequirementIds?.join(', ') ||
                    'UNVERIFIED — requirement linkage unavailable',
                )}</p><p>${esc(finding.claim)}</p>${evidenceLinks(
                  finding.evidenceIds,
                  new Map(evidence.map((e) => [String(e.id), e])),
                )}</article>`;
              })
              .join('')
          : '<p>No engineering findings recorded. This does not establish that these areas are free of concerns.</p>') +
        (Array.isArray(report?.engineeringReview?.dimensions)
          ? report.engineeringReview.dimensions
              .map(
                (dimension) =>
                  `<article class="inset engineering-dimension"><strong>${esc(
                    dimension.dimension,
                  )} · ${esc(dimension.status)}</strong><p>${esc(
                    dimension.summary,
                  )}</p>${
                    dimension.supportMatrix
                      ? `<p>Facts: ${esc(
                          dimension.supportMatrix.facts.status,
                        )} · configured check outcomes only. Engineering assessment: ${esc(
                          dimension.supportMatrix.engineeringAssessment.status,
                        )}. Model interpretation: ${esc(
                          dimension.supportMatrix.contextualAi.status,
                        )}.</p><p>${esc(
                          dimension.supportMatrix.engineeringAssessment.text,
                        )} Human inspection required.</p>${evidenceLinks(
                          dimension.supportMatrix.engineeringAssessment
                            .evidenceIds,
                          new Map(evidence.map((e) => [String(e.id), e])),
                        )}`
                      : ''
                  }${(dimension.checks || [])
                    .map(
                      (check) =>
                        `<p><code>${esc(check.checkId)}</code> · ${esc(
                          check.kind,
                        )} · baseline ${esc(check.baselineStatus)} → head ${esc(
                          check.status,
                        )} · ${esc(check.delta)}</p>${evidenceLinks(
                          check.evidenceIds,
                          new Map(evidence.map((e) => [String(e.id), e])),
                        )}`,
                    )
                    .join('')}${(dimension.missingCapabilities || [])
                    .map(
                      (capability) =>
                        `<p class="subtle">${esc(capability.status)} · ${esc(
                          capability.reason,
                        )}</p>`,
                    )
                    .join('')}${
                    dimension.contextualEvidenceIds?.length
                      ? `<p>Context only; no dimension-wide verification:</p>${evidenceLinks(
                          dimension.contextualEvidenceIds,
                          new Map(evidence.map((e) => [String(e.id), e])),
                        )}`
                      : ''
                  }</article>`,
              )
              .join('')
          : '<p>Engineering dimension normalization unavailable for this historical report.</p>') +
        (Array.isArray(report?.engineeringReview?.rubric)
          ? `<details class="engineering-rubric"><summary>Engineering review facets — evidence scope and inspection needs</summary>${report.engineeringReview.rubric
              .map(
                (facet) =>
                  `<article class="inset"><strong>${esc(
                    facet.id,
                  )} · ${esc(facet.label)} · ${esc(
                    facet.status,
                  )}</strong><p>${esc(facet.inspectReason)}</p><p>Scope ${esc(
                    facet.scope,
                  )} · human inspection required · AI narrative ${esc(
                    facet.aiNarrativeStatus,
                  )}.</p>${evidenceLinks(
                    facet.evidenceIds,
                    new Map(evidence.map((e) => [String(e.id), e])),
                  )}<p>${esc(
                    facet.analysisCoverage || 'MISSING_MEANINGFUL_ANALYSIS',
                  )} · ${esc(
                    facet.missingAnalysisReason ||
                      'Contextual interpretation requires human inspection.',
                  )}</p>${(facet.contextualAnalysis || [])
                    .map(
                      (analysis) =>
                        `<p><strong>${esc(
                          analysis.observationPath ||
                            `findings[${analysis.findingIndex}]`,
                        )}</strong> · ${esc(analysis.status)} · ${esc(
                          analysis.relevanceBasis,
                        )}</p><p>${esc(analysis.text)}</p>${evidenceLinks(
                          (analysis.evidence || []).map(
                            (item) => item.evidenceId,
                          ),
                          new Map(evidence.map((e) => [String(e.id), e])),
                        )}<p>Requirements: ${esc(
                          [
                            ...new Set(
                              (analysis.evidence || [])
                                .map((item) => item.requirementId)
                                .filter(Boolean),
                            ),
                          ].join(', ') || 'No cited criterion linkage',
                        )} · source/check scope only.</p>`,
                    )
                    .join('')}</article>`,
              )
              .join('')}</details>`
          : '') +
        '</section>';
      const regressions = evidence.filter(
        (e) => e.baselineStatus === 'PASS' && e.status === 'FAIL',
      );
      const regressionHtml =
        '<section class="panel"><h3>Regressions</h3>' +
        (regressions.length
          ? regressions
              .map(
                (e) =>
                  `<article class="inset"><strong>Baseline PASS → submission FAIL</strong><p>${esc(
                    e.claim,
                  )}</p>${evidenceLinks(
                    [e.id],
                    new Map(evidence.map((item) => [String(item.id), item])),
                  )}</article>`,
              )
              .join('')
          : '<p>No regression is established by the recorded baseline/head results. Missing or incomplete checks do not prove regression safety.</p>') +
        '</section>';
      const current = run.currentSubmission,
        freshness = !current
          ? '<p class="freshness unknown" role="status">Current submission status is unavailable; freshness cannot be confirmed.</p>'
          : current.closed
            ? '<p class="freshness historical" role="status">Submission is closed. This evaluation is historical.</p>'
            : current.latestRunId === run.id && current.headSha === run.head_sha
              ? '<p class="freshness current" role="status">Current evaluation for the open submission head.</p>'
              : `<p class="freshness historical" role="status">Historical evaluation. Current open submission head: ${esc(
                  current.headSha,
                )} · latest run ${esc(current.latestRunId)}.</p>`,
        evidenceById = new Map(evidence.map((item) => [String(item.id), item]));
      history.replaceState(
        null,
        '',
        '/?organization=1&evaluation=' + encodeURIComponent(id),
      );
      const executions = run.execution || [],
        artifacts = run.artifacts || [],
        additionalContributions = Array.isArray(run.additionalContributions)
          ? run.additionalContributions
          : [],
        requirementResults = Array.isArray(run.requirementResults)
          ? run.requirementResults
          : [],
        requirementResultById = new Map(
          requirementResults.map((result) => [result.requirementId, result]),
        ),
        contributionCategories = Array.isArray(contract.additionalCategories)
          ? contract.additionalCategories.slice(0, 20)
          : [],
        runContext = (() => {
          try {
            return typeof run.context === 'string'
              ? JSON.parse(run.context)
              : run.context || {};
          } catch {
            return {};
          }
        })(),
        changedPaths = [
          ...new Set(
            (Array.isArray(runContext.files) ? runContext.files : [])
              .map((file) => file?.filename || file?.path)
              .filter((path) => typeof path === 'string' && path.length > 0),
          ),
        ].slice(0, 100),
        eligibleCriterionIds = (contract.requirements || []).flatMap(
          (requirement) => {
            const projection = requirementResultById.get(requirement.id),
              projectionCriteria = Array.isArray(projection?.criteria)
                ? projection.criteria
                : [],
              statusById = new Map(
                projectionCriteria.map((criterion) => [
                  criterion.criterionId,
                  requirementStatus(criterion.status),
                ]),
              );
            return (requirement.criteria || [])
              .filter(
                (criterion) =>
                  requirement.mandatory === false &&
                  statusById.get(criterion.id) === 'PASS',
              )
              .map((criterion) => criterion.id);
          },
        ),
        currentOpenRun =
          run.state === 'COMPLETED' &&
          run.currentSubmission &&
          !run.currentSubmission.closed &&
          run.currentSubmission.latestRunId === run.id &&
          run.currentSubmission.headSha === run.head_sha,
        terminal = ['COMPLETED', 'FAILED', 'SUPERSEDED'].includes(run.state),
        recapturableArtifacts = artifacts.some((artifact) => {
          const expires =
            artifact.expires_at == null ? null : Number(artifact.expires_at);
          return (
            ['PENDING', 'FAILED'].includes(artifact.status) &&
            expires !== null &&
            Number.isFinite(expires) &&
            expires > Date.now()
          );
        }),
        requirementsHtml = (contract.requirements || [])
          .map((requirement) => {
            const result = requirementResultById.get(requirement.id),
              mandatory =
                typeof result?.mandatory === 'boolean'
                  ? result.mandatory
                  : typeof requirement.mandatory === 'boolean'
                    ? requirement.mandatory
                    : null,
              requirementCriteria = Array.isArray(result?.criteria)
                ? result.criteria
                : [],
              criterionResultById = new Map(
                requirementCriteria.map((item) => [item.criterionId, item]),
              ),
              obligation =
                mandatory === true
                  ? 'Mandatory'
                  : mandatory === false
                    ? 'Optional'
                    : 'Requirement type unavailable',
              attention =
                result?.needsAttention === true
                  ? 'Needs attention'
                  : result?.needsAttention === false
                    ? 'No attention flag'
                    : 'Attention status unavailable',
              criteria = (requirement.criteria || [])
                .map((criterion) => {
                  const objective = criterionResultById.get(criterion.id),
                    status = requirementStatus(objective?.status),
                    reason =
                      objective?.reason ||
                      (result
                        ? 'No deterministic criterion result is available.'
                        : 'No deterministic requirement result is available.');
                  return `<div class="criterion"><strong>${esc(
                    criterion.id,
                  )} · ${esc(status)}</strong><p class="description">${esc(
                    criterion.description,
                  )}</p><p>${esc(
                    reason,
                  )}</p><div class="criterion-evidence" aria-label="Evidence for ${esc(
                    criterion.id,
                  )}">${evidenceLinks(
                    objective?.evidenceIds,
                    evidenceById,
                  )}</div></div>`;
                })
                .join('');
            return `<section class="requirement-group" data-requirement-id="${esc(
              requirement.id,
            )}"><div class="panel-head"><h4>${esc(
              requirement.title || requirement.id,
            )}</h4><span>${esc(obligation)}</span><strong class="badge">${esc(
              requirementStatus(result?.status),
            )}</strong></div><p>${esc(attention)}</p>${criteria}</section>`;
          })
          .join(''),
        executionHtml = executions
          .map((row) => {
            const result = JSON.parse(row.result),
              cacheStatus = row.cache_status || 'Unavailable',
              request =
                typeof row.request === 'string'
                  ? (() => {
                      try {
                        return JSON.parse(row.request);
                      } catch {
                        return null;
                      }
                    })()
                  : row.request;
            return `<div class="inset"><strong>${esc(
              row.commit_sha === run.baseline_sha
                ? 'Baseline'
                : row.commit_sha === run.head_sha
                  ? 'Submission head'
                  : 'Execution',
            )} · ${esc(
              (row.commit_sha || '').slice(0, 12),
            )}</strong><p>Image ${esc(result.image)} · ${esc(
              result.runtime,
            )} · ${esc(result.version)}</p><p>Evidence SHA-256 <code>${esc(
              row.result_hash,
            )}</code></p><div class="provenance"><strong>Execution provenance</strong><p>Cache: ${esc(
              cacheStatus,
            )} · original execution: ${esc(
              dateLabel(result.startedAt),
            )} – ${esc(
              dateLabel(result.finishedAt),
            )}</p><p>Recorded in detail: ${esc(
              dateLabel(row.created_at),
            )}</p><p>Original request hash: <code>${esc(
              row.request_hash || 'Unavailable',
            )}</code> · origin run: ${esc(
              row.origin_run_id || 'Unavailable',
            )} · origin execution: ${esc(
              row.origin_execution_id || 'Unavailable',
            )}</p><p>Cache key: <code>${esc(
              row.cache_key || 'Unavailable',
            )}</code></p>${
              request
                ? `<details><summary>Safe request summary</summary><p>Original run ${esc(
                    request.runId || 'Unavailable',
                  )} · commit ${esc(
                    request.commit || 'Unavailable',
                  )} · policy ${esc(
                    request.policyHash || 'Unavailable',
                  )}</p><ul>${(request.files || [])
                    .map(
                      (file) =>
                        `<li><code>${esc(file.path)}</code> · ${esc(
                          file.sha256,
                        )} · ${esc(String(file.bytes))} bytes</li>`,
                    )
                    .join('')}</ul></details>`
                : '<p>Safe request summary unavailable.</p>'
            }</div>${result.checks
              .map(
                (check) =>
                  `<div class="evidence-item"><strong>${esc(
                    check.status,
                  )} · ${esc(check.kind)} · ${esc(check.id)}</strong><p>${esc(
                    check.detail,
                  )}</p><p>${check.durationMs} ms · exit ${esc(
                    String(check.exitCode ?? 'N/A'),
                  )}</p>${
                    check.stdout || check.stderr
                      ? `<details><summary>Bounded output</summary><pre>${esc(
                          check.stdout,
                        )}${esc(check.stderr)}</pre></details>`
                      : ''
                  }</div>`,
              )
              .join('')}</div>`;
          })
          .join(''),
        artifactHtml =
          artifacts
            .map((artifact) => {
              const expires =
                  artifact.expires_at == null
                    ? null
                    : Number(artifact.expires_at),
                expired =
                  expires !== null &&
                  (!Number.isFinite(expires) || expires <= Date.now()),
                downloadable =
                  artifact.status === 'STORED' && expires !== null && !expired,
                download = `/api/organization/artifact?key=${encodeURIComponent(
                  artifact.key,
                )}`;
              return `<div class="evidence-item artifact"><strong>${esc(
                artifact.kind || 'Artifact',
              )} · ${esc(artifact.status || 'Unavailable')}</strong><p>${esc(
                String(artifact.bytes ?? 'Unavailable'),
              )} bytes · SHA-256 <code>${esc(
                artifact.sha256 || 'Unavailable',
              )}</code></p><p>Created ${esc(
                dateLabel(artifact.created_at),
              )} · expires ${
                artifact.expires_at == null
                  ? 'Unavailable'
                  : esc(dateLabel(expires))
              }</p>${
                artifact.error_code
                  ? `<p>Safe failure reason: ${esc(artifact.error_code)}</p>`
                  : ''
              }${
                downloadable
                  ? `<a class="button" href="${download}">Download protected artifact</a>`
                  : `<span class="button disabled" aria-disabled="true">${
                      expired ? 'Download expired' : 'Download unavailable'
                    }</span>`
              }</div>`;
            })
            .join('') ||
          '<p class="subtle">No artifact metadata is available.</p>';
      const contributionsHtml = additionalContributions.length
          ? additionalContributions
              .map((contribution) => {
                const decision = contribution.latestDecision,
                  verificationStatus =
                    contribution.verificationStatus === 'VERIFIED' ||
                    contribution.verificationStatus === 'UNVERIFIED'
                      ? contribution.verificationStatus
                      : 'Not available',
                  verificationLabel =
                    verificationStatus === 'VERIFIED'
                      ? 'Criterion improvement verified'
                      : verificationStatus,
                  verificationExplanation =
                    verificationStatus === 'VERIFIED'
                      ? 'Configured criterion improvement verified; claimed design and file attribution require organizer review.'
                      : verificationStatus === 'UNVERIFIED'
                        ? 'No configured criterion improvement is verified.'
                        : 'Verification status is not available.',
                  mayRecognize =
                    !archiveReadOnly &&
                    authenticatedRole === 'organizer' &&
                    currentOpenRun &&
                    verificationStatus === 'VERIFIED',
                  id = esc(contribution.id || 'Not available');
                return `<article class="inset contribution-card" data-contribution-id="${id}"><div class="panel-head"><h4>${esc(
                  contribution.title || 'Not available',
                )}</h4><span>${esc(
                  contribution.category || 'Not available',
                )}</span><span class="badge">${esc(
                  verificationLabel,
                )}</span></div><p>${esc(verificationExplanation)}</p><p>${esc(
                  contribution.description || 'Not available',
                )}</p><p>Contribution ${id} · run ${esc(
                  contribution.runId || 'Not available',
                )} · submitted by ${esc(
                  contribution.actor || 'Not available',
                )} · ${esc(
                  dateLabel(contribution.createdAt),
                )}</p><p>Changed paths ${escapedList(
                  contribution.paths,
                )}</p><p>Criteria ${escapedList(
                  contribution.criterionIds,
                )}</p><div class="contribution-evidence"><strong>Evidence</strong>${evidenceLinks(
                  contribution.evidenceIds,
                  evidenceById,
                )}</div>${
                  decision
                    ? `<div class="inset"><strong>Latest decision ${esc(
                        decision.decision || 'Not available',
                      )} · sequence ${esc(
                        String(decision.sequence ?? 'Not available'),
                      )}</strong><p>Decision ${esc(
                        decision.id || 'Not available',
                      )} · candidate ${esc(
                        decision.candidateId || 'Not available',
                      )} · run ${esc(
                        decision.runId || 'Not available',
                      )}</p><p>${esc(
                        decision.reason || 'Not available',
                      )}</p><p>${esc(
                        decision.actor || 'Not available',
                      )} · ${esc(dateLabel(decision.createdAt))}</p></div>`
                    : '<p>No decision recorded.</p>'
                }${
                  !archiveReadOnly && authenticatedRole === 'organizer'
                    ? `<label for="contribution-reason-${encodeURIComponent(
                        String(contribution.id || 'unknown'),
                      )}">Decision reason</label><textarea id="contribution-reason-${encodeURIComponent(
                        String(contribution.id || 'unknown'),
                      )}" data-contribution-reason rows="2" minlength="20" maxlength="2000"></textarea><div class="contribution-actions"><button class="button" aria-label="Recognize criterion improvement" data-contribution-decision="RECOGNIZED" ${
                        mayRecognize ? '' : 'disabled'
                      }>Recognize criterion improvement</button><button class="button" data-contribution-decision="REJECTED">Reject</button></div><p data-contribution-status role="status"></p>`
                    : ''
                }</article>`;
              })
              .join('')
          : '<p class="empty">No additional contributions have been recorded.</p>',
        contributionPathsHtml = changedPaths.length
          ? changedPaths
              .map(
                (path) =>
                  `<label><input type="checkbox" name="paths" value="${esc(
                    path,
                  )}"> <code>${esc(path)}</code></label>`,
              )
              .join('')
          : '<p>No changed paths are available for selection.</p>',
        contributionEvidenceHtml = evidence.length
          ? evidence
              .map(
                (item) =>
                  `<label><input type="checkbox" name="evidenceIds" value="${esc(
                    item.id,
                  )}"> ${esc(item.id)} · ${esc(item.status)}</label>`,
              )
              .join('')
          : '<p>No known evidence is available for selection.</p>',
        contributionCriteriaHtml = eligibleCriterionIds.length
          ? eligibleCriterionIds
              .map(
                (criterionId) =>
                  `<label><input type="checkbox" name="criterionIds" value="${esc(
                    criterionId,
                  )}"> ${esc(criterionId)}</label>`,
              )
              .join('')
          : '<p>No verified criteria are available to associate.</p>',
        contributionFormHtml =
          !archiveReadOnly &&
          authenticatedRole === 'organizer' &&
          run.state === 'COMPLETED' &&
          contributionCategories.length > 0 &&
          changedPaths.length > 0 &&
          evidence.length > 0
            ? `<form id="add-contribution-form" class="review-form"><label for="contribution-category">Category</label><select id="contribution-category" name="category" required>${contributionCategories
                .map(
                  (category) =>
                    `<option value="${esc(category)}">${esc(
                      category,
                    )}</option>`,
                )
                .join(
                  '',
                )}</select><label for="contribution-title">Title</label><input id="contribution-title" name="title" required maxlength="120"><label for="contribution-description">Description</label><textarea id="contribution-description" name="description" required minlength="20" maxlength="2000" rows="3"></textarea><fieldset><legend>Changed paths</legend>${contributionPathsHtml}</fieldset><fieldset><legend>Known evidence</legend>${contributionEvidenceHtml}</fieldset><fieldset><legend>Optional criterion checks (passing checks do not alone prove baseline improvement)</legend>${contributionCriteriaHtml}</fieldset><button class="button" type="submit">Add contribution</button><p id="contribution-form-status" role="status"></p></form>`
            : authenticatedRole === 'organizer'
              ? run.state !== 'COMPLETED'
                ? '<p>Additional contributions can be added to completed evaluations only.</p>'
                : !contributionCategories.length
                  ? '<p>No additional contribution categories are configured.</p>'
                  : '<p>Contribution entry requires available changed paths and known evidence.</p>'
              : '',
        contributionNoticeHtml = contributionNotice
          ? `<p class="${
              contributionNotice.type === 'warning'
                ? 'error'
                : 'artifact-capture-notice'
            }" role="status">${esc(contributionNotice.message)}</p>`
          : '';
      const artifactCaptureHtml =
          !archiveReadOnly &&
          authenticatedRole === 'organizer' &&
          terminal &&
          recapturableArtifacts
            ? '<div class="artifact-capture"><button class="button" id="retry-artifact-capture">Retry artifact capture</button><p id="artifact-retry-status" role="status"></p></div>'
            : '',
        artifactCaptureNotice = artifactCaptureResult
          ? `<p class="artifact-capture-notice" role="status">Artifact capture ${esc(
              artifactCaptureResult.status,
            )}.${(artifactCaptureResult.failures || [])
              .map((failure) => ` ${esc(failure.kind)}: ${esc(failure.code)}.`)
              .join('')}</p>`
          : '';
      $('#organization-detail').innerHTML =
        `<section class="panel"><div class="panel-head"><h2>${esc(
          run.full_name ?? contract.repository.fullName,
        )} · PR #${run.pr_number}</h2><span class="badge">${esc(
          run.state,
        )}</span></div><div class="inset" id="ai-trace">${freshness}<p>Frozen baseline <code>${esc(
          run.baseline_sha,
        )}</code><br>Evaluated head <code>${esc(
          run.head_sha,
        )}</code></p><p>Evaluation ${esc(
          contract.evaluationVersion,
        )} · GitHub publication: ${esc(
          run.publication_status,
        )} · AI review: ${esc(run.ai_status || 'pending')}</p>${
          report?.aiTrace?.cost
            ? `<p class="subtle">AI final response cost: ${
                report.aiTrace.cost.status === 'ESTIMATE'
                  ? '$' +
                    esc((report.aiTrace.cost.microUsd / 1000000).toFixed(6)) +
                    ' estimate; retrieval and failed requests excluded'
                  : 'unavailable; verified pricing and usage are required'
              }.</p>`
            : ''
        }${
          report?.aiTrace?.qualitativeCriterionAnalysis?.status === 'UNVERIFIED'
            ? `<p class="ai-notice"><strong>Missing AI criterion analysis remains UNVERIFIED.</strong> Trusted objective results were recovered for ${esc(
                report.aiTrace.qualitativeCriterionAnalysis.missingCriterionIds.join(
                  ', ',
                ),
              )}; no missing AI judgment was invented. Human review is required.</p>`
            : ''
        }${
          report?.aiTrace?.failureCode
            ? `<p class="error">AI review rejected: ${esc(
                report.aiTrace.failureCode,
              )}. Objective evidence remains available.</p>`
            : ''
        }${
          !archiveReadOnly &&
          (run.retryable === true ||
            run.state === 'FAILED' ||
            (run.state === 'COMPLETED' &&
              ([
                'FAILED',
                'SKIPPED_CONTEXT_LIMIT',
                'NOT_CONFIGURED',
                'NEEDS_REVIEW',
              ].includes(run.ai_status) ||
                run.reviewPolicyCurrent === false)))
            ? `<button class="button" id="retry-evaluation">Retry as a new evaluation attempt</button>`
            : ''
        }<p>${esc(
          report?.summary || run.failure_code || 'Evaluation in progress',
        )}</p>${
          run.ai_status !== 'COMPLETED'
            ? `<p class="ai-notice"><strong>Semantic review ${esc(
                run.ai_status || 'pending',
              )}</strong>. Objective check results remain separate; this submission has not completed AI review.</p>`
            : ''
        }${
          report?.aiTrace?.contextBudget
            ? `<p class="subtle">Review context: ${esc(
                String(
                  report.aiTrace.contextBudget.finalContextBytes ??
                    report.aiTrace.contextBudget.contextBytes,
                ),
              )} bytes; omitted evidence ${esc(
                String(
                  report.aiTrace.contextBudget.omittedEvidenceIds?.length ?? 0,
                ),
              )}, source excerpts ${esc(
                String(
                  report.aiTrace.contextBudget.omittedSourcePaths?.length ?? 0,
                ),
              )}. Omitted context remains unverified.</p>`
            : ''
        }<p class="ai-notice">AI interpretation is advisory inference. It does not replace authoritative requirements or execution evidence, and it cannot mark unexecuted behavior as verified.</p><p>Functional behavior is verified only by the listed trusted execution results. Only configured checks are shown; unperformed checks remain UNVERIFIED. Source patterns and advisory matches do not establish exploitability.</p></div><p><a class="button" href="/api/organization/evaluations/${encodeURIComponent(
          id,
        )}/bundle">Download reproducibility bundle</a></p><div class="panel-head"><h3>Authoritative requirements</h3></div>${
          (run.attentionItems ?? []).length
            ? `<section class="inset"><h3>Needs attention</h3>${run.attentionItems
                .map(
                  (item) =>
                    `<article><strong>${esc(item.what)}</strong><p>${esc(
                      item.why,
                    )}</p><p>Inspect: ${item.inspect
                      .map(
                        (id) =>
                          `<a href="#${
                            [
                              'timeline',
                              'ai-trace',
                              'solution-approach',
                              'engineering-review',
                            ].includes(id)
                              ? id
                              : 'evidence-' + encodeURIComponent(id)
                          }">${esc(id)}</a>`,
                      )
                      .join(', ')}</p><p>${esc(item.action)}</p></article>`,
                )
                .join('')}</section>`
            : ''
        }${requirementsHtml}${planHtml}${repositoryIntelligenceHtml(
          runContext,
          report?.aiTrace,
        )}${routingHtml}${groundingHtml}${expectedArtifactHtml}<div id="solution-approach">${window.JudgeApproach(
          report,
        )}</div><div id="engineering-review">${engineeringHtml}</div>${regressionHtml}<div class="panel-head"><h3>Evidence ledger</h3></div>${evidence
          .map(
            (item) =>
              `<div class="evidence-item" id="evidence-${encodeURIComponent(
                String(item.id),
              )}"><strong>${esc(item.status)} · ${esc(
                item.id,
              )}</strong><p>${esc(item.claim)}</p>${
                item.path ? `<code>${esc(item.path)}</code>` : ''
              }${
                item.baselineStatus
                  ? `<p>Baseline ${esc(
                      item.baselineStatus,
                    )} → head ${esc(item.status)}</p>`
                  : ''
              }</div>`,
          )
          .join(
            '',
          )}<div class="panel-head"><h3>Additional contributions</h3></div><p>Contribution records and decisions do not change evaluation results automatically.</p>${contributionsHtml}${contributionFormHtml}${contributionNoticeHtml}<div class="panel-head"><h3>Baseline and head check comparison</h3></div>${checkComparison(
          executions,
          run.baseline_sha,
          run.head_sha,
        )}<div class="panel-head"><h3>Isolated execution</h3></div>${
          executionHtml ||
          '<div class="empty">No runtime results have been recorded. Isolated execution is disabled or unavailable.</div>'
        }<div class="panel-head"><h3>Protected artifacts</h3></div>${artifactHtml}${artifactCaptureHtml}${artifactCaptureNotice}<div class="panel-head"><h3>Evaluation history</h3></div><ol class="timeline" id="timeline">${(
          run.timeline || []
        )
          .map(
            (item) =>
              `<li><strong>${esc(item.state)}</strong> ${esc(
                item.detail,
              )}<small>${esc(item.created_at)}</small></li>`,
          )
          .join('')}</ol></section>`;
      $('#add-contribution-form')?.addEventListener('submit', async (event) => {
        event.preventDefault();
        const form = event.currentTarget,
          status = $('#contribution-form-status'),
          formData = new FormData(form),
          payload = {
            category: String(formData.get('category') || ''),
            title: String(formData.get('title') || ''),
            description: String(formData.get('description') || ''),
            paths: [...new Set(formData.getAll('paths').map(String))].filter(
              (path) => changedPaths.includes(path),
            ),
            evidenceIds: [
              ...new Set(formData.getAll('evidenceIds').map(String)),
            ].filter((evidenceId) => evidenceById.has(evidenceId)),
            criterionIds: [
              ...new Set(formData.getAll('criterionIds').map(String)),
            ].filter((criterionId) =>
              eligibleCriterionIds.includes(criterionId),
            ),
          };
        status.textContent = 'Saving contribution…';
        try {
          await call(
            'evaluations/' + encodeURIComponent(id) + '/contributions',
            payload,
          );
          await detail(id, null, {
            type: 'success',
            message: 'Contribution saved; records refreshed.',
          });
        } catch (failure) {
          const message =
            failure.status === 409
              ? 'Contribution could not be saved because evaluation state changed; refreshing records.'
              : failure.status === 403
                ? 'Organizer authorization is required to add a contribution.'
                : `Contribution could not be saved${
                    failure.status ? ` (HTTP ${failure.status})` : ''
                  }.`;
          await detail(id, null, { type: 'warning', message });
        }
      });
      for (const action of document.querySelectorAll(
        '[data-contribution-decision]',
      )) {
        action.addEventListener('click', async () => {
          const card = action.closest('[data-contribution-id]'),
            contribution = additionalContributions.find(
              (item) => String(item.id) === card?.dataset.contributionId,
            ),
            status = card?.querySelector('[data-contribution-status]'),
            reason = card
              ?.querySelector('[data-contribution-reason]')
              ?.value.trim(),
            decision = action.dataset.contributionDecision;
          if (
            !contribution ||
            !status ||
            !['RECOGNIZED', 'REJECTED'].includes(decision)
          ) {
            return;
          }
          if (!reason || reason.length < 20) {
            status.textContent =
              'Enter a decision reason of at least 20 characters.';
            return;
          }
          if (
            decision === 'RECOGNIZED' &&
            (!currentOpenRun || contribution.verificationStatus !== 'VERIFIED')
          ) {
            status.textContent =
              'Recognition requires a verified contribution on the current open completed run.';
            return;
          }
          action.disabled = true;
          status.textContent = 'Saving decision…';
          try {
            await call(
              'contributions/' +
                encodeURIComponent(contribution.id) +
                '/decisions',
              {
                decision,
                reason,
                requestId: crypto.randomUUID(),
                expectedPreviousSequence:
                  contribution.latestDecision?.sequence ?? null,
              },
            );
            await detail(id, null, {
              type: 'success',
              message: 'Decision saved; contribution records refreshed.',
            });
          } catch (failure) {
            const message =
              failure.status === 409
                ? 'Decision state or eligibility changed; refreshing contribution records.'
                : failure.status === 403
                  ? 'Organizer authorization is required to record a decision.'
                  : `Decision could not be saved${
                      failure.status ? ` (HTTP ${failure.status})` : ''
                    }.`;
            await detail(id, null, { type: 'warning', message });
          }
        });
      }
      $('#retry-artifact-capture')?.addEventListener('click', async (event) => {
        const button = event.currentTarget,
          status = $('#artifact-retry-status'),
          stillEligible = (run.artifacts || []).some((artifact) => {
            const expires =
              artifact.expires_at == null ? null : Number(artifact.expires_at);
            return (
              ['PENDING', 'FAILED'].includes(artifact.status) &&
              expires !== null &&
              Number.isFinite(expires) &&
              expires > Date.now()
            );
          });
        if (!stillEligible) {
          status.textContent =
            'Artifact capture is unavailable because its retention window has expired.';
          button.remove();
          return;
        }
        button.disabled = true;
        status.textContent = 'Retrying artifact capture…';
        try {
          const result = await call(
            'evaluations/' + encodeURIComponent(id) + '/artifacts/retry',
            {},
          );
          if (!['CAPTURED', 'PARTIAL'].includes(result.status)) {
            throw new Error('CAPTURE_RESPONSE_INVALID');
          }
          await detail(id, result);
        } catch (failure) {
          status.textContent =
            failure.status === 409
              ? 'Artifact capture retry is only available for terminal evaluations.'
              : failure.status === 503
                ? 'Artifact storage is unavailable. Existing evidence metadata is unchanged.'
                : failure.status
                  ? `Artifact capture retry failed (HTTP ${failure.status}).`
                  : 'Artifact capture retry could not reach the service.';
          button.disabled = false;
        }
      });
      $('#retry-evaluation')?.addEventListener('click', async () => {
        try {
          const next = await call(
            'evaluations/' + encodeURIComponent(id) + '/retry',
            {},
          );
          await detail(next.runId);
        } catch (e) {
          error(e);
        }
      });
      if (!['COMPLETED', 'FAILED', 'SUPERSEDED'].includes(run.state)) {
        timer = setTimeout(() => detail(id), 2500);
      }
    } catch (e) {
      error(e);
    }
  }
  window.organizationWorkspace = { load, stop: () => clearTimeout(timer) };
})();
