document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('search-form');
  const searchInput = document.getElementById('search-input');
  const licenseSelect = document.getElementById('license-select');
  const ecosystemSelect = document.getElementById('ecosystem-select');
  const statusContainer = document.getElementById('status-container');
  const resultsList = document.getElementById('results-list');

  form.addEventListener('submit', async (event) => {
    event.preventDefault();

    const query = searchInput.value.trim();
    if (!query) {
      showStatus('Please enter a search query.', 'error');
      return;
    }

    const projectLicense = licenseSelect.value;
    const ecosystem = ecosystemSelect.value;
    
    // Construct search URL
    const url = new URL('/api/search', window.location.origin);
    url.searchParams.set('q', query);
    url.searchParams.set('ecosystem', ecosystem);
    if (projectLicense) {
      url.searchParams.set('projectLicense', projectLicense);
    }

    // Set loading state
    showStatus('Searching components...', 'loading');
    resultsList.innerHTML = '';

    try {
      const response = await fetch(url);
      const data = await response.json();

      if (!response.ok) {
        showStatus(data.error || 'Failed to search components.', 'error');
        return;
      }

      if (!data.results || data.results.length === 0) {
        showStatus('No components found matching your query.', 'empty');
        return;
      }

      // Clear status and render results
      statusContainer.innerHTML = '';
      renderResults(data.results);

    } catch (error) {
      console.error('Search error:', error);
      showStatus('An unexpected network error occurred.', 'error');
    }
  });

  function showStatus(message, type) {
    statusContainer.innerHTML = `
      <div class="status-message ${type}">
        ${escapeHtml(message)}
      </div>
    `;
  }

  function renderResults(results) {
    resultsList.innerHTML = results.map((item, index) => {
      const { name, repoUrl, overall, verdict, badges, scores, reasons } = item;
      
      const titleHtml = repoUrl 
        ? `<a href="${escapeHtml(repoUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(name)}</a>`
        : escapeHtml(name);

      const scorecardBadgeHtml = badges.scorecard !== null
        ? `<span class="badge">OpenSSF: ${badges.scorecard}/10</span>`
        : '';

      const cveBadgeHtml = `<span class="badge">CVEs: ${badges.cveCount}</span>`;
      const licenseBadgeHtml = `<span class="badge">License: ${escapeHtml(badges.license)}</span>`;

      // Per axis scores - score values are floats between 0 and 1, we map to percentage
      const fitPercent = Math.round(scores.fit * 100);
      const licensePercent = Math.round(scores.license * 100);
      const securityPercent = Math.round(scores.security * 100);
      const healthPercent = Math.round(scores.health * 100);
      const effortPercent = Math.round(scores.effort * 100);

      // Unique ID for the expandable section
      const listId = `reasons-${index}`;

      return `
        <article class="card">
          <div class="card-header">
            <div class="card-title-group">
              <h2 class="card-title">${titleHtml}</h2>
              <div style="margin-top: 0.25rem;">
                <span class="verdict-pill ${verdict}">${escapeHtml(verdict)}</span>
              </div>
            </div>
            <div class="score-badge">
              <span class="score-value">${overall}</span>
              <span class="score-label">Overall</span>
            </div>
          </div>

          <div class="badges-row">
            ${licenseBadgeHtml}
            ${cveBadgeHtml}
            ${scorecardBadgeHtml}
          </div>

          <div class="scores-grid">
            <div class="score-bar-group">
              <div class="score-bar-header">
                <span>Fit</span>
                <span>${fitPercent}%</span>
              </div>
              <div class="score-bar-bg">
                <div class="score-bar-fill" style="width: ${fitPercent}%;"></div>
              </div>
            </div>

            <div class="score-bar-group">
              <div class="score-bar-header">
                <span>License</span>
                <span>${licensePercent}%</span>
              </div>
              <div class="score-bar-bg">
                <div class="score-bar-fill" style="width: ${licensePercent}%;"></div>
              </div>
            </div>

            <div class="score-bar-group">
              <div class="score-bar-header">
                <span>Security</span>
                <span>${securityPercent}%</span>
              </div>
              <div class="score-bar-bg">
                <div class="score-bar-fill" style="width: ${securityPercent}%;"></div>
              </div>
            </div>

            <div class="score-bar-group">
              <div class="score-bar-header">
                <span>Health</span>
                <span>${healthPercent}%</span>
              </div>
              <div class="score-bar-bg">
                <div class="score-bar-fill" style="width: ${healthPercent}%;"></div>
              </div>
            </div>

            <div class="score-bar-group">
              <div class="score-bar-header">
                <span>Effort</span>
                <span>${effortPercent}%</span>
              </div>
              <div class="score-bar-bg">
                <div class="score-bar-fill" style="width: ${effortPercent}%;"></div>
              </div>
            </div>
          </div>

          <div class="reasons-container">
            <button 
              type="button" 
              class="reasons-toggle" 
              aria-expanded="false" 
              aria-controls="${listId}"
              onclick="toggleReasons('${listId}', this)"
            >
              Reasons (${reasons.length})
            </button>
            <ul id="${listId}" class="reasons-list hidden">
              ${reasons.map(reason => `<li>${escapeHtml(reason)}</li>`).join('')}
            </ul>
          </div>
        </article>
      `;
    }).join('');
  }

  // Helper to escape HTML safely
  function escapeHtml(str) {
    if (!str) return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // Expose toggleReasons globally since it's used in inline onclick
  window.toggleReasons = (id, button) => {
    const list = document.getElementById(id);
    if (!list) return;
    const isHidden = list.classList.contains('hidden');
    if (isHidden) {
      list.classList.remove('hidden');
      button.setAttribute('aria-expanded', 'true');
    } else {
      list.classList.add('hidden');
      button.setAttribute('aria-expanded', 'false');
    }
  };
});
