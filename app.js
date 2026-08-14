  const GITHUB_USER = 'Moozz';
  const GITHUB_REPO = 'lieblingsrestaurant';
  const GITHUB_FILE = 'restaurants.json';
  const RECIPE_FILE = 'recipes.json';
  const API_URL        = `https://api.github.com/repos/${GITHUB_USER}/${GITHUB_REPO}/contents/${GITHUB_FILE}`;
  const RECIPE_API_URL = `https://api.github.com/repos/${GITHUB_USER}/${GITHUB_REPO}/contents/${RECIPE_FILE}`;
  const TOKEN_KEY   = 'lb_github_pat';

  const LOCATION_KEY   = 'lb_current_location';
  const DEFAULT_LOCATION = 'Bangkok';

  let allData      = { locations: [], restaurants: {} }; // restaurants.json
  let recipeData   = { locations: [], recipes: {} };      // recipes.json
  let currentLocation = null;
  let currentType      = null; // 'restaurant' | 'recipe'
  let items        = [];   // always === the active location's array, in whichever file
  let fileSha      = null;
  let recipeSha    = null;
  let activeFilter = 'all';
  let editIndex    = -1;
  let lastSpinIndex = -1;

  const getToken = () => localStorage.getItem(TOKEN_KEY) || '';

  function setStatus(state, text) {
    const dot = document.getElementById('statusDot');
    dot.className = 'status-dot' + (state ? ' ' + state : '');
    document.getElementById('statusText').textContent = text;
  }

  // ── GitHub helpers ───────────────────────────────────────────────────────────

  function ghHeaders() {
    return {
      'Authorization': `Bearer ${getToken()}`,
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json'
    };
  }

  // Safe UTF-8 base64 encode/decode (handles Thai and all unicode)
  function b64encode(str) {
    return btoa(encodeURIComponent(str).replace(/%([0-9A-F]{2})/g, (_, p1) => String.fromCharCode('0x' + p1)));
  }
  function b64decode(str) {
    return decodeURIComponent(atob(str).split('').map(c => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)).join(''));
  }

  function migrateTags(list) {
    let changed = false;
    const newList = list.map(r => {
      if (!r.cuisine && !r.tags) return r;
      const merged = [
        ...(r.cuisine ? r.cuisine.split(',').map(t => t.trim()) : []),
        ...(r.tags || [])
      ].map(t => t.toLowerCase()).filter(Boolean);
      const deduped = [...new Set(merged)];
      const { cuisine, ...rest } = r;
      if (JSON.stringify(deduped) !== JSON.stringify(r.tags) || cuisine !== undefined) changed = true;
      return { ...rest, tags: deduped };
    });
    return { list: newList, changed };
  }

  // Normalizes whatever shape came from GitHub into { locations: [...], restaurants: { loc: [...] } }.
  // Handles the pre-location format (a flat array) by folding it into a single default location.
  function normalizeData(raw) {
    let changed = false;
    let data;
    if (Array.isArray(raw)) {
      data = { locations: [DEFAULT_LOCATION], restaurants: { [DEFAULT_LOCATION]: raw } };
      changed = true;
    } else {
      const locations = Array.isArray(raw.locations) && raw.locations.length
        ? raw.locations
        : Object.keys(raw.restaurants || {});
      data = { locations, restaurants: raw.restaurants || {} };
    }
    if (!data.locations.length) {
      data.locations = [DEFAULT_LOCATION];
      changed = true;
    }
    data.locations.forEach(loc => {
      if (!Array.isArray(data.restaurants[loc])) { data.restaurants[loc] = []; changed = true; }
    });
    data.locations.forEach(loc => {
      const { list, changed: c } = migrateTags(data.restaurants[loc]);
      data.restaurants[loc] = list;
      if (c) changed = true;
    });
    return { data, changed };
  }

  // Normalizes whatever shape came from GitHub into { locations: [...], recipes: { loc: [...] } }.
  function normalizeRecipeData(raw) {
    let changed = false;
    let data;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      data = { locations: [], recipes: {} };
    } else {
      const locations = Array.isArray(raw.locations) ? raw.locations : Object.keys(raw.recipes || {});
      data = { locations, recipes: raw.recipes || {} };
    }
    data.locations.forEach(loc => {
      if (!Array.isArray(data.recipes[loc])) { data.recipes[loc] = []; changed = true; }
    });
    return { data, changed };
  }

  function pickCurrentLocation() {
    const combined = [
      ...allData.locations.map(name => ({ name, type: 'restaurant' })),
      ...recipeData.locations.map(name => ({ name, type: 'recipe' }))
    ];
    if (!combined.length) {
      currentLocation = null; currentType = null; items = [];
      updateLocationLabel();
      return;
    }
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(LOCATION_KEY) || 'null'); } catch (e) {}
    const match = (saved && combined.find(l => l.name === saved.name && l.type === saved.type)) || combined[0];
    currentLocation = match.name;
    currentType = match.type;
    localStorage.setItem(LOCATION_KEY, JSON.stringify(match));
    items = currentType === 'recipe' ? recipeData.recipes[currentLocation] : allData.restaurants[currentLocation];
    updateLocationLabel();
  }

  function updateLocationLabel() {
    const icon = currentType === 'recipe' ? '🍳' : '📍';
    document.getElementById('currentLocationLabel').textContent = currentLocation ? `${icon} ${currentLocation}` : 'add a location';
  }

  async function loadRestaurants() {
    const res = await fetch(API_URL, { headers: ghHeaders() });
    if (res.status === 404) {
      allData = { locations: [DEFAULT_LOCATION], restaurants: { [DEFAULT_LOCATION]: [] } };
      fileSha = null;
      return;
    }
    if (!res.ok) throw new Error(`GitHub ${res.status}`);
    const data = await res.json();
    fileSha = data.sha;
    const raw = JSON.parse(b64decode(data.content.replace(/\n/g, '')));
    const { data: normalized, changed } = normalizeData(raw);
    allData = normalized;
    if (changed) await pushRestaurants();
  }

  async function loadRecipes() {
    const res = await fetch(RECIPE_API_URL, { headers: ghHeaders() });
    if (res.status === 404) {
      recipeData = { locations: [], recipes: {} };
      recipeSha = null;
      return;
    }
    if (!res.ok) throw new Error(`GitHub ${res.status}`);
    const data = await res.json();
    recipeSha = data.sha;
    const raw = JSON.parse(b64decode(data.content.replace(/\n/g, '')));
    const { data: normalized, changed } = normalizeRecipeData(raw);
    recipeData = normalized;
    if (changed) await pushRecipes();
  }

  async function loadAll() {
    if (!getToken()) {
      setStatus('err', 'no token — open settings');
      document.getElementById('resultName').textContent = 'connect github to get started';
      render();
      return;
    }
    setStatus('loading', 'syncing...');
    let restaurantError = null, recipeError = null;
    try { await loadRestaurants(); } catch (e) { restaurantError = e.message; }
    try { await loadRecipes(); } catch (e) { recipeError = e.message; }
    pickCurrentLocation();
    if (restaurantError || recipeError) {
      setStatus('err', 'sync issue — ' + (restaurantError || recipeError));
      document.getElementById('resultName').textContent = 'could not fully sync — check settings';
    } else {
      const rCount = allData.locations.reduce((sum, loc) => sum + (allData.restaurants[loc] || []).length, 0);
      const cCount = recipeData.locations.reduce((sum, loc) => sum + (recipeData.recipes[loc] || []).length, 0);
      setStatus('ok', `synced · ${rCount} place${rCount !== 1 ? 's' : ''} · ${cCount} recipe${cCount !== 1 ? 's' : ''}`);
    }
    render();
  }

  async function pushRestaurants() {
    const content = b64encode(JSON.stringify(allData, null, 2));
    const total = allData.locations.reduce((sum, loc) => sum + allData.restaurants[loc].length, 0);
    const body = {
      message: fileSha ? `update restaurants (${total} total across ${allData.locations.length} location${allData.locations.length !== 1 ? 's' : ''})` : 'create restaurants.json',
      content,
      ...(fileSha ? { sha: fileSha } : {})
    };
    const res = await fetch(API_URL, { method: 'PUT', headers: ghHeaders(), body: JSON.stringify(body) });
    if (!res.ok) { const e = await res.json(); throw new Error(e.message || `GitHub ${res.status}`); }
    fileSha = (await res.json()).content.sha;
  }

  async function pushRecipes() {
    const content = b64encode(JSON.stringify(recipeData, null, 2));
    const total = recipeData.locations.reduce((sum, loc) => sum + (recipeData.recipes[loc] || []).length, 0);
    const body = {
      message: recipeSha ? `update recipes (${total} total across ${recipeData.locations.length} location${recipeData.locations.length !== 1 ? 's' : ''})` : 'create recipes.json',
      content,
      ...(recipeSha ? { sha: recipeSha } : {})
    };
    const res = await fetch(RECIPE_API_URL, { method: 'PUT', headers: ghHeaders(), body: JSON.stringify(body) });
    if (!res.ok) { const e = await res.json(); throw new Error(e.message || `GitHub ${res.status}`); }
    recipeSha = (await res.json()).content.sha;
  }

  // ── Settings ─────────────────────────────────────────────────────────────────

  function openSettings() {
    document.getElementById('sToken').value = getToken();
    document.getElementById('settingsError').style.display = 'none';
    document.getElementById('settingsModal').style.display = 'flex';
    setTimeout(() => document.getElementById('sToken').focus(), 50);
  }
  function closeSettings() { document.getElementById('settingsModal').style.display = 'none'; }

  async function saveSettings() {
    const token = document.getElementById('sToken').value.trim();
    const errEl = document.getElementById('settingsError');
    const btn   = document.getElementById('settingsSaveBtn');
    if (!token) { errEl.textContent = 'please enter a token'; errEl.style.display = 'block'; return; }
    btn.disabled = true; btn.textContent = 'connecting...'; errEl.style.display = 'none';
    try {
      const res = await fetch(`https://api.github.com/repos/${GITHUB_USER}/${GITHUB_REPO}`, {
        headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/vnd.github+json' }
      });
      if (res.status === 401) throw new Error('invalid token');
      if (res.status === 404) throw new Error('repo not found — check token has repo scope');
      if (!res.ok) throw new Error(`GitHub ${res.status}`);
      localStorage.setItem(TOKEN_KEY, token);
      closeSettings();
      loadAll();
    } catch (e) {
      errEl.textContent = e.message; errEl.style.display = 'block';
    } finally {
      btn.disabled = false; btn.textContent = 'save & connect';
    }
  }

  // ── Locations ────────────────────────────────────────────────────────────────

  function switchLocation(name, type) {
    if (name === currentLocation && type === currentType) { closeLocations(); return; }
    currentLocation = name;
    currentType = type;
    localStorage.setItem(LOCATION_KEY, JSON.stringify({ name, type }));
    items = type === 'recipe' ? recipeData.recipes[name] : allData.restaurants[name];
    activeFilter = 'all';
    updateLocationLabel();
    closeLocations();
    render();
  }

  function renderLocationsList() {
    const el = document.getElementById('locationsList');
    el.innerHTML = '';
    const combined = [
      ...allData.locations.map(name => ({ name, type: 'restaurant' })),
      ...recipeData.locations.map(name => ({ name, type: 'recipe' }))
    ];
    if (!combined.length) {
      el.innerHTML = '<p class="empty-state">no locations yet — add one below</p>';
      return;
    }
    combined.forEach(({ name, type }) => {
      const count = type === 'recipe' ? (recipeData.recipes[name] || []).length : (allData.restaurants[name] || []).length;
      const isCurrent = name === currentLocation && type === currentType;
      const row = document.createElement('div');
      row.className = 'rest-card' + (isCurrent ? ' current' : '');
      if (!isCurrent) {
        row.style.cursor = 'pointer';
        row.onclick = () => switchLocation(name, type);
      }

      const icon = document.createElement('div');
      icon.className = 'rest-icon';
      icon.textContent = type === 'recipe' ? '🍳' : '📍';

      const info = document.createElement('div');
      info.className = 'rest-info';
      const nameEl = document.createElement('div');
      nameEl.className = 'rest-name';
      nameEl.textContent = name;
      if (isCurrent) {
        const badge = document.createElement('span');
        badge.textContent = ' current';
        badge.style.cssText = 'color: var(--text-secondary); font-weight: 400; font-size: 12px;';
        nameEl.appendChild(badge);
      }
      const metaEl = document.createElement('div');
      metaEl.className = 'rest-tags';
      metaEl.textContent = `${type === 'recipe' ? 'recipes' : 'restaurants'} · ${count} item${count !== 1 ? 's' : ''}`;
      info.appendChild(nameEl); info.appendChild(metaEl);

      const actions = document.createElement('div');
      actions.className = 'rest-actions';
      const delBtn = document.createElement('button');
      delBtn.className = 'btn-icon'; delBtn.title = 'delete location'; delBtn.textContent = '✕';
      delBtn.onclick = (e) => { e.stopPropagation(); deleteLocation(name, type); };
      actions.appendChild(delBtn);

      row.appendChild(icon); row.appendChild(info); row.appendChild(actions);
      el.appendChild(row);
    });
  }

  function openLocations() {
    document.getElementById('locationsError').style.display = 'none';
    document.getElementById('fNewLocation').value = '';
    renderLocationsList();
    document.getElementById('locationsModal').style.display = 'flex';
  }
  function closeLocations() { document.getElementById('locationsModal').style.display = 'none'; }

  async function addLocation() {
    const input = document.getElementById('fNewLocation');
    const name  = input.value.trim();
    const type  = document.querySelector('input[name="newLocType"]:checked').value;
    const errEl = document.getElementById('locationsError');
    errEl.style.display = 'none';
    if (!name) { errEl.textContent = 'enter a location name'; errEl.style.display = 'block'; return; }
    const existsSameType = type === 'recipe'
      ? recipeData.locations.some(l => l.toLowerCase() === name.toLowerCase())
      : allData.locations.some(l => l.toLowerCase() === name.toLowerCase());
    if (existsSameType) { errEl.textContent = 'that location already exists'; errEl.style.display = 'block'; return; }

    if (type === 'recipe') { recipeData.locations.push(name); recipeData.recipes[name] = []; }
    else { allData.locations.push(name); allData.restaurants[name] = []; }

    try {
      if (type === 'recipe') await pushRecipes(); else await pushRestaurants();
      input.value = '';
      switchLocation(name, type);
      openLocations(); // reopen so the modal reflects the updated location list
    } catch (e) {
      if (type === 'recipe') { recipeData.locations.pop(); delete recipeData.recipes[name]; }
      else { allData.locations.pop(); delete allData.restaurants[name]; }
      errEl.textContent = 'failed to save: ' + e.message; errEl.style.display = 'block';
    }
  }

  async function deleteLocation(name, type) {
    const isRecipe = type === 'recipe';
    const store = isRecipe ? recipeData : allData;
    const key   = isRecipe ? 'recipes' : 'restaurants';
    const count = (store[key][name] || []).length;
    if (!confirm(`Delete location "${name}"${count ? ` and its ${count} item${count !== 1 ? 's' : ''}` : ''}? This can't be undone.`)) return;
    const backupLocations = [...store.locations];
    const backupList = store[key][name];
    store.locations = store.locations.filter(l => l !== name);
    delete store[key][name];
    const wasCurrent = name === currentLocation && type === currentType;
    try {
      if (isRecipe) await pushRecipes(); else await pushRestaurants();
      if (wasCurrent) { pickCurrentLocation(); render(); }
      renderLocationsList();
    } catch (e) {
      store.locations = backupLocations;
      store[key][name] = backupList;
      const errEl = document.getElementById('locationsError');
      errEl.textContent = 'failed to delete: ' + e.message; errEl.style.display = 'block';
    }
  }

  // ── Restaurant CRUD ──────────────────────────────────────────────────────────

  function openModal(idx) {
    editIndex = idx !== undefined ? idx : -1;
    document.getElementById('modalTitle').textContent = editIndex >= 0 ? 'edit restaurant' : 'add a restaurant';
    const r = editIndex >= 0 ? items[editIndex] : {};
    document.getElementById('fName').value    = r.name  || '';
    document.getElementById('fCuisine').value = (r.tags || []).join(', ');
    document.getElementById('fEmoji').value   = r.emoji || '';
    document.getElementById('fNote').value    = r.note    || '';
    document.getElementById('saveError').style.display = 'none';
    document.getElementById('saveBtn').disabled = false;
    document.getElementById('saveBtn').textContent = 'save';
    document.getElementById('modal').style.display = 'flex';
    setTimeout(() => document.getElementById('fName').focus(), 50);
  }
  function closeModal() { document.getElementById('modal').style.display = 'none'; }

  async function saveRestaurant() {
    const name  = document.getElementById('fName').value.trim();
    const errEl = document.getElementById('saveError');
    const btn   = document.getElementById('saveBtn');
    if (!name) { errEl.textContent = 'name is required'; errEl.style.display = 'block'; return; }

    const obj = {
      name,
      tags:  document.getElementById('fCuisine').value.split(',').map(t => t.trim().toLowerCase()).filter(Boolean),
      emoji: document.getElementById('fEmoji').value.trim() || '🍽',
      note:  document.getElementById('fNote').value.trim()
    };

    btn.disabled = true; btn.textContent = 'saving...'; errEl.style.display = 'none';
    const backup = editIndex >= 0 ? { ...items[editIndex] } : null;
    if (editIndex >= 0) items[editIndex] = obj; else items.push(obj);

    try {
      await pushRestaurants();
      closeModal(); render();
    } catch (e) {
      if (editIndex >= 0) items[editIndex] = backup; else items.pop();
      errEl.textContent = 'failed to save: ' + e.message; errEl.style.display = 'block';
      btn.disabled = false; btn.textContent = 'save';
    }
  }

  async function deleteRestaurant(i) {
    if (!confirm(`Remove "${items[i].name}"?`)) return;
    const removed = items.splice(i, 1)[0];
    render();
    try {
      await pushRestaurants();
    } catch (e) {
      items.splice(i, 0, removed);
      render();
      alert('delete failed: ' + e.message);
    }
  }

  // ── Recipe detail view ──────────────────────────────────────────────────────

  let recipeDetailIndex = -1;

  function formatRecipeTime(r) {
    const total = (r.prepTime || 0) + (r.cookTime || 0);
    return total ? `⏱ ${total} min` : '';
  }

  function openRecipeDetail(idx) {
    const r = items[idx];
    if (!r) return;
    recipeDetailIndex = idx;
    document.getElementById('rdEmoji').textContent = r.emoji || '🍳';
    document.getElementById('rdName').textContent = r.name;
    document.getElementById('rdTags').textContent = (r.tags || []).join(' · ');
    const metaParts = [];
    const t = formatRecipeTime(r);
    if (t) metaParts.push(t);
    if (r.servings) metaParts.push(`serves ${r.servings}`);
    document.getElementById('rdMeta').textContent = metaParts.join(' · ');
    document.getElementById('rdNote').textContent = r.note || '';

    const ingEl = document.getElementById('rdIngredients');
    ingEl.innerHTML = '';
    if (!(r.ingredients || []).length) {
      ingEl.innerHTML = '<p class="empty-state">no ingredients listed</p>';
    } else {
      r.ingredients.forEach(ing => {
        const row = document.createElement('label');
        row.className = 'ingredient-row';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.onchange = () => row.classList.toggle('checked', cb.checked);
        const span = document.createElement('span');
        const amt = (ing.amount !== null && ing.amount !== undefined) ? `${ing.amount}${ing.unit || ''} ` : '';
        span.textContent = `${amt}${ing.name}`;
        row.appendChild(cb); row.appendChild(span);
        ingEl.appendChild(row);
      });
    }

    const secEl = document.getElementById('rdSections');
    secEl.innerHTML = '';
    if (!(r.sections || []).length) {
      secEl.innerHTML = '<p class="empty-state">no instructions yet</p>';
    } else {
      r.sections.forEach((sec, si) => {
        const block = document.createElement('div');
        block.className = 'step-section';
        const head = document.createElement('div');
        head.className = 'step-section-head' + (si === 0 ? ' open' : '');
        head.innerHTML = `<span>${sec.title}</span><span class="chev">›</span>`;
        const body = document.createElement('div');
        body.className = 'step-section-body' + (si === 0 ? ' open' : '');
        (sec.steps || []).forEach((step, i) => {
          const stepEl = document.createElement('div');
          stepEl.className = 'step-item' + (step.important ? ' important' : '');
          stepEl.innerHTML = `<span class="step-num">${i + 1}${step.important ? ' ★' : ''}</span><span>${step.text}</span>`;
          body.appendChild(stepEl);
        });
        head.onclick = () => { head.classList.toggle('open'); body.classList.toggle('open'); };
        block.appendChild(head); block.appendChild(body);
        secEl.appendChild(block);
      });
    }

    document.getElementById('recipeDetailOverlay').style.display = 'block';
    window.scrollTo(0, 0);
  }
  function closeRecipeDetail() { document.getElementById('recipeDetailOverlay').style.display = 'none'; }
  function editFromDetail() { const idx = recipeDetailIndex; closeRecipeDetail(); openRecipeForm(idx); }
  function deleteFromDetail() { const idx = recipeDetailIndex; closeRecipeDetail(); deleteRecipe(idx); }

  // ── Recipe add/edit form ────────────────────────────────────────────────────

  let recipeFormIndex = -1;
  let formIngredients = [];
  let formSections = [];
  const UNIT_OPTIONS = ['', 'g', 'kg', 'ml', 'pcs'];

  function handleAddClick() {
    if (currentType === 'recipe') openRecipeForm(); else openModal();
  }

  function openRecipeForm(idx) {
    recipeFormIndex = idx !== undefined ? idx : -1;
    const r = recipeFormIndex >= 0 ? items[recipeFormIndex] : {};
    document.getElementById('recipeFormTitle').textContent = recipeFormIndex >= 0 ? 'edit recipe' : 'add a recipe';
    document.getElementById('rfPaste').value = '';
    document.getElementById('rfPasteError').style.display = 'none';
    document.getElementById('rfName').value = r.name || '';
    document.getElementById('rfTags').value = (r.tags || []).join(', ');
    document.getElementById('rfEmoji').value = r.emoji || '';
    document.getElementById('rfNote').value = r.note || '';
    document.getElementById('rfServings').value = r.servings || '';
    document.getElementById('rfPrepTime').value = r.prepTime || '';
    document.getElementById('rfCookTime').value = r.cookTime || '';
    formIngredients = JSON.parse(JSON.stringify(r.ingredients || []));
    formSections = JSON.parse(JSON.stringify(r.sections || (recipeFormIndex < 0 ? [{ title: 'Prep', steps: [] }, { title: 'Cook', steps: [] }] : [])));
    document.getElementById('recipeFormError').style.display = 'none';
    renderIngredientsEditor();
    renderSectionsEditor();
    document.getElementById('recipeFormOverlay').style.display = 'block';
    window.scrollTo(0, 0);
  }
  function closeRecipeForm() { document.getElementById('recipeFormOverlay').style.display = 'none'; }

  function renderIngredientsEditor() {
    const el = document.getElementById('rfIngredientsList');
    el.innerHTML = '';
    formIngredients.forEach((ing, i) => {
      const row = document.createElement('div');
      row.className = 'ing-row';

      const amtInput = document.createElement('input');
      amtInput.type = 'number'; amtInput.step = 'any'; amtInput.placeholder = 'amt';
      amtInput.value = ing.amount ?? '';
      amtInput.oninput = () => { ing.amount = amtInput.value === '' ? null : parseFloat(amtInput.value); };

      const unitSelect = document.createElement('select');
      UNIT_OPTIONS.forEach(u => {
        const opt = document.createElement('option');
        opt.value = u; opt.textContent = u || '—';
        if (u === (ing.unit || '')) opt.selected = true;
        unitSelect.appendChild(opt);
      });
      unitSelect.onchange = () => { ing.unit = unitSelect.value || null; };

      const nameInput = document.createElement('input');
      nameInput.type = 'text'; nameInput.placeholder = 'ingredient name'; nameInput.style.flex = '1';
      nameInput.value = ing.name || '';
      nameInput.oninput = () => { ing.name = nameInput.value; };

      const delBtn = document.createElement('button');
      delBtn.className = 'btn-icon'; delBtn.title = 'remove'; delBtn.textContent = '✕';
      delBtn.onclick = () => { formIngredients.splice(i, 1); renderIngredientsEditor(); };

      row.appendChild(amtInput); row.appendChild(unitSelect); row.appendChild(nameInput); row.appendChild(delBtn);
      el.appendChild(row);
    });
  }
  function addIngredientRow() {
    formIngredients.push({ name: '', amount: null, unit: null });
    renderIngredientsEditor();
  }

  function renderSectionsEditor() {
    const el = document.getElementById('rfSectionsList');
    el.innerHTML = '';
    formSections.forEach((sec, si) => {
      sec.steps = sec.steps || [];
      const block = document.createElement('div');
      block.className = 'section-block';

      const titleRow = document.createElement('div');
      titleRow.className = 'section-title-row';
      const titleInput = document.createElement('input');
      titleInput.type = 'text'; titleInput.placeholder = 'section title';
      titleInput.value = sec.title || '';
      titleInput.oninput = () => { sec.title = titleInput.value; };
      const upBtn = document.createElement('button');
      upBtn.className = 'btn-icon'; upBtn.title = 'move up'; upBtn.textContent = '↑';
      upBtn.onclick = () => { if (si > 0) { [formSections[si - 1], formSections[si]] = [formSections[si], formSections[si - 1]]; renderSectionsEditor(); } };
      const downBtn = document.createElement('button');
      downBtn.className = 'btn-icon'; downBtn.title = 'move down'; downBtn.textContent = '↓';
      downBtn.onclick = () => { if (si < formSections.length - 1) { [formSections[si + 1], formSections[si]] = [formSections[si], formSections[si + 1]]; renderSectionsEditor(); } };
      const delSecBtn = document.createElement('button');
      delSecBtn.className = 'btn-icon'; delSecBtn.title = 'remove section'; delSecBtn.textContent = '✕';
      delSecBtn.onclick = () => { formSections.splice(si, 1); renderSectionsEditor(); };
      titleRow.appendChild(titleInput); titleRow.appendChild(upBtn); titleRow.appendChild(downBtn); titleRow.appendChild(delSecBtn);
      block.appendChild(titleRow);

      sec.steps.forEach((step, sti) => {
        const stepRow = document.createElement('div');
        stepRow.className = 'step-row';
        const textArea = document.createElement('textarea');
        textArea.placeholder = 'step text';
        textArea.value = step.text || '';
        textArea.oninput = () => { step.text = textArea.value; };
        const impBtn = document.createElement('button');
        impBtn.type = 'button';
        impBtn.className = 'step-important-toggle' + (step.important ? ' active' : '');
        impBtn.title = 'mark as important';
        impBtn.textContent = step.important ? '★' : '☆';
        impBtn.onclick = () => {
          step.important = !step.important;
          impBtn.classList.toggle('active', step.important);
          impBtn.textContent = step.important ? '★' : '☆';
        };
        const delStepBtn = document.createElement('button');
        delStepBtn.className = 'btn-icon'; delStepBtn.title = 'remove step'; delStepBtn.textContent = '✕';
        delStepBtn.onclick = () => { sec.steps.splice(sti, 1); renderSectionsEditor(); };
        stepRow.appendChild(textArea); stepRow.appendChild(impBtn); stepRow.appendChild(delStepBtn);
        block.appendChild(stepRow);
      });

      const addStepBtn = document.createElement('button');
      addStepBtn.className = 'btn-add';
      addStepBtn.textContent = '+ add step';
      addStepBtn.onclick = () => { sec.steps.push({ text: '', important: false }); renderSectionsEditor(); };
      block.appendChild(addStepBtn);

      el.appendChild(block);
    });
  }
  function addSectionBlock() {
    formSections.push({ title: '', steps: [] });
    renderSectionsEditor();
  }

  function parsePastedRecipe() {
    const raw = document.getElementById('rfPaste').value.trim();
    const errEl = document.getElementById('rfPasteError');
    errEl.style.display = 'none';
    if (!raw) { errEl.textContent = 'paste a recipe JSON blob first'; errEl.style.display = 'block'; return; }
    let parsed;
    try { parsed = JSON.parse(raw); } catch (e) { errEl.textContent = 'invalid JSON: ' + e.message; errEl.style.display = 'block'; return; }
    document.getElementById('rfName').value = parsed.name || '';
    document.getElementById('rfTags').value = (parsed.tags || []).join(', ');
    document.getElementById('rfEmoji').value = parsed.emoji || '';
    document.getElementById('rfNote').value = parsed.note || '';
    document.getElementById('rfServings').value = parsed.servings || '';
    document.getElementById('rfPrepTime').value = parsed.prepTime || '';
    document.getElementById('rfCookTime').value = parsed.cookTime || '';
    formIngredients = Array.isArray(parsed.ingredients) ? parsed.ingredients : [];
    formSections = Array.isArray(parsed.sections) ? parsed.sections : [];
    renderIngredientsEditor();
    renderSectionsEditor();
  }

  async function saveRecipe() {
    const name = document.getElementById('rfName').value.trim();
    const errEl = document.getElementById('recipeFormError');
    const btn = document.getElementById('recipeSaveBtn');
    errEl.style.display = 'none';
    if (!name) { errEl.textContent = 'name is required'; errEl.style.display = 'block'; return; }

    const obj = {
      name,
      tags: document.getElementById('rfTags').value.split(',').map(t => t.trim().toLowerCase()).filter(Boolean),
      emoji: document.getElementById('rfEmoji').value.trim() || '🍳',
      note: document.getElementById('rfNote').value.trim(),
      servings: parseInt(document.getElementById('rfServings').value) || null,
      prepTime: parseInt(document.getElementById('rfPrepTime').value) || null,
      cookTime: parseInt(document.getElementById('rfCookTime').value) || null,
      ingredients: formIngredients.filter(i => (i.name || '').trim()).map(i => ({ name: i.name.trim(), amount: (i.amount ?? null), unit: i.unit || null })),
      sections: formSections.filter(s => (s.title || '').trim() || (s.steps || []).length).map(s => ({
        title: (s.title || '').trim() || 'steps',
        steps: (s.steps || []).filter(st => (st.text || '').trim()).map(st => ({ text: st.text.trim(), important: !!st.important }))
      }))
    };

    btn.disabled = true; btn.textContent = 'saving...';
    const backup = recipeFormIndex >= 0 ? { ...items[recipeFormIndex] } : null;
    if (recipeFormIndex >= 0) items[recipeFormIndex] = obj; else items.push(obj);

    try {
      await pushRecipes();
      closeRecipeForm();
      render();
    } catch (e) {
      if (recipeFormIndex >= 0) items[recipeFormIndex] = backup; else items.pop();
      errEl.textContent = 'failed to save: ' + e.message; errEl.style.display = 'block';
    } finally {
      btn.disabled = false; btn.textContent = 'save';
    }
  }

  async function deleteRecipe(i) {
    if (!confirm(`Remove "${items[i].name}"?`)) return;
    const removed = items.splice(i, 1)[0];
    render();
    try {
      await pushRecipes();
    } catch (e) {
      items.splice(i, 0, removed);
      render();
      alert('delete failed: ' + e.message);
    }
  }

  // ── Spin ──────────────────────────────────────────────────────────────────────

  let lastSpinItem = null;

  function spin() {
    const pool = getFiltered();
    if (!pool.length) return;
    const btn = document.getElementById('spinBtn');
    btn.disabled = true;
    document.getElementById('viewRecipeBtn').style.display = 'none';
    let count = 0;
    const total = 12 + Math.floor(Math.random() * 8);
    const tick = setInterval(() => {
      const r = pool[Math.floor(Math.random() * pool.length)];
      lastSpinItem = r;
      document.getElementById('resultEmoji').textContent = r.emoji || (currentType === 'recipe' ? '🍳' : '🍽');
      document.getElementById('resultName').textContent  = r.name;
      if (currentType === 'recipe') {
        const meta = [...(r.tags || [])];
        const t = formatRecipeTime(r);
        if (t) meta.push(t);
        if (r.servings) meta.push(`serves ${r.servings}`);
        document.getElementById('resultMeta').textContent = meta.join(' · ');
      } else {
        document.getElementById('resultMeta').textContent = (r.tags || []).join(' · ');
      }
      document.getElementById('resultNote').textContent  = r.note || '';
      count++;
      if (count >= total) {
        clearInterval(tick); btn.disabled = false;
        if (currentType === 'recipe') {
          lastSpinIndex = items.indexOf(lastSpinItem);
          document.getElementById('viewRecipeBtn').style.display = 'block';
        }
      }
    }, 80 + count * 3);
  }

  // ── Render ────────────────────────────────────────────────────────────────────

  function getAllTags() {
    const set = new Set();
    items.forEach(r => (r.tags || []).forEach(t => set.add(t)));
    return [...set];
  }

  function getFiltered() {
    if (activeFilter === 'all') return items;
    return items.filter(r => (r.tags || []).includes(activeFilter));
  }

  function syncFilterHeight() {
    const left = document.querySelector('.spin-left');
    const filterEl = document.getElementById('filters');
    if (!left || !filterEl) return;
    filterEl.style.maxHeight = left.getBoundingClientRect().height + 'px';
  }
  window.addEventListener('resize', syncFilterHeight);

  function render() {
    if (!currentLocation) {
      document.getElementById('filters').innerHTML = '';
      document.getElementById('countBadge').textContent = '0';
      document.getElementById('sectionTypeLabel').textContent = 'places';
      document.getElementById('addBtnLabel').textContent = '+ add';
      document.getElementById('list').innerHTML = '<p class="empty-state">no locations yet — tap the location button above to add one</p>';
      document.getElementById('spinBtn').disabled = true;
      document.getElementById('resultEmoji').textContent = '🎲';
      document.getElementById('resultName').textContent = 'add a location to get started';
      document.getElementById('resultMeta').textContent = '';
      document.getElementById('resultNote').textContent = '';
      document.getElementById('viewRecipeBtn').style.display = 'none';
      return;
    }

    const isRecipe = currentType === 'recipe';
    document.getElementById('sectionTypeLabel').textContent = isRecipe ? 'recipes' : 'restaurants';
    document.getElementById('addBtnLabel').textContent = isRecipe ? '+ add recipe' : '+ add';

    const tags = getAllTags();
    const filterEl = document.getElementById('filters');
    filterEl.innerHTML = '';
    ['all', ...tags].forEach(t => {
      const el = document.createElement('button');
      el.className = 'tag' + (activeFilter === t ? ' active' : '');
      el.textContent = t;
      el.onclick = () => { activeFilter = t; render(); };
      filterEl.appendChild(el);
    });
    syncFilterHeight();

    document.getElementById('countBadge').textContent = items.length;
    const listEl = document.getElementById('list');
    listEl.innerHTML = '';
    const filtered = getFiltered();

    if (!filtered.length) {
      const noun = isRecipe ? 'recipes' : 'restaurants';
      listEl.innerHTML = '<p class="empty-state">' +
        (items.length ? `no ${noun} match this filter` : `no ${noun} yet — add your first one!`) + '</p>';
      if (!items.length) {
        document.getElementById('resultEmoji').textContent = '🎲';
        document.getElementById('resultName').textContent  = isRecipe ? 'add some recipes, then spin!' : 'add some restaurants, then spin!';
        document.getElementById('resultMeta').textContent  = '';
        document.getElementById('resultNote').textContent  = '';
      }
    }

    filtered.forEach(r => {
      const realIdx = items.indexOf(r);
      const card = document.createElement('div');
      card.className = 'rest-card';
      if (isRecipe) {
        const t = formatRecipeTime(r);
        const metaParts = [...(r.tags || [])];
        if (t) metaParts.push(t);
        if (r.servings) metaParts.push(`serves ${r.servings}`);
        card.innerHTML = `
          <div class="rest-icon">${r.emoji || '🍳'}</div>
          <div class="rest-info">
            <div class="rest-name">${r.name}</div>
            <div class="rest-tags">${metaParts.join(' · ') || 'no tags'}</div>
          </div>
          <div class="rest-actions">
            <button class="btn-icon" title="view" onclick="openRecipeDetail(${realIdx})">👁</button>
            <button class="btn-icon" title="edit" onclick="openRecipeForm(${realIdx})">✎</button>
            <button class="btn-icon" title="delete" onclick="deleteRecipe(${realIdx})">✕</button>
          </div>`;
        card.querySelector('.rest-info').onclick = () => openRecipeDetail(realIdx);
      } else {
        card.innerHTML = `
          <div class="rest-icon">${r.emoji || '🍽'}</div>
          <div class="rest-info">
            <div class="rest-name">${r.name}</div>
            <div class="rest-tags">${(r.tags || []).join(' · ') || 'no tags'}</div>
          </div>
          <div class="rest-actions">
            <button class="btn-icon" title="edit" onclick="openModal(${realIdx})">✎</button>
            <button class="btn-icon" title="delete" onclick="deleteRestaurant(${realIdx})">✕</button>
          </div>`;
      }
      listEl.appendChild(card);
    });

    document.getElementById('spinBtn').disabled = filtered.length === 0;
  }

  // ── Init ──────────────────────────────────────────────────────────────────────

  document.getElementById('modal').addEventListener('click', e => {
    if (e.target === document.getElementById('modal')) closeModal();
  });
  document.getElementById('settingsModal').addEventListener('click', e => {
    if (e.target === document.getElementById('settingsModal')) closeSettings();
  });
  document.getElementById('locationsModal').addEventListener('click', e => {
    if (e.target === document.getElementById('locationsModal')) closeLocations();
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { closeModal(); closeSettings(); closeLocations(); closeRecipeDetail(); closeRecipeForm(); }
  });

  loadAll();
