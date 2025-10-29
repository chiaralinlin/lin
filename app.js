// To‑do app with localStorage persistence + reorder + due dates & reminders + optional backend sync
// STORAGE key
const STORAGE_KEY = 'todos_' + (typeof USER !== 'undefined' ? USER : 'default_user_chiaralinlin');

// Optional sync endpoint: set to your server URL if you want remote sync, example:
// const SYNC_URL = 'https://your-server.example.com/api/todos';
const SYNC_URL = ''; // <-- set this to enable backend sync

// Auto-sync interval (ms)
const AUTO_SYNC_INTERVAL = 60 * 1000; // 60s

// DOM
const newTodoInput = document.getElementById('newTodo');
const newDueInput = document.getElementById('newDue');
const addBtn = document.getElementById('addBtn');
const todoList = document.getElementById('todoList');
const countEl = document.getElementById('count');
const clearCompletedBtn = document.getElementById('clearCompleted');
const clearAllBtn = document.getElementById('clearAll');
const filterButtons = document.querySelectorAll('.filter');
const syncNowBtn = document.getElementById('syncNow');
const syncStatusEl = document.getElementById('syncStatus');

let todos = [];
let filter = 'all'; // all | active | completed

// Reminder timers map
let reminderTimers = new Map();

// Create unique id
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// Load todos
function loadTodos() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    todos = raw ? JSON.parse(raw) : [];
  } catch (e) {
    console.error('Failed to parse todos', e);
    todos = [];
  }
}

// Save todos (persist and update sync queue)
function saveTodos(opts = {}) {
  // update updatedAt for items changed in opts.changedIds (or overall save time)
  const now = Date.now();
  if (opts.changedIds && Array.isArray(opts.changedIds)) {
    for (const id of opts.changedIds) {
      const t = todos.find(x => x.id === id);
      if (t) t.updatedAt = now;
    }
  } else {
    // update overall modified time
    // not changing individual updatedAt here except on create/update operations
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(todos));
}

// Add new todo
function addTodo(text, dueISO = null) {
  const trimmed = text.trim();
  if (!trimmed) return;
  const todo = {
    id: uid(),
    text: trimmed,
    completed: false,
    dueDate: dueISO || null, // ISO string or null
    createdAt: Date.now(),
    updatedAt: Date.now(),
    // order is implicit by array index (0 = top)
  };
  todos.unshift(todo); // newest first by default
  saveTodos({ changedIds: [todo.id] });
  render();
  scheduleReminders();
  if (SYNC_URL) scheduleSyncDebounced();
}

// Toggle completion
function toggleTodo(id) {
  const t = todos.find(x => x.id === id);
  if (!t) return;
  t.completed = !t.completed;
  t.updatedAt = Date.now();
  saveTodos({ changedIds: [id] });
  render();
  if (SYNC_URL) scheduleSyncDebounced();
}

// Delete
function deleteTodo(id) {
  todos = todos.filter(x => x.id !== id);
  saveTodos();
  render();
  cancelReminder(id);
  if (SYNC_URL) scheduleSyncDebounced();
}

// Update text
function updateTodoText(id, newText) {
  const t = todos.find(x => x.id === id);
  if (!t) return;
  t.text = newText.trim() || t.text;
  t.updatedAt = Date.now();
  saveTodos({ changedIds: [id] });
  render();
  if (SYNC_URL) scheduleSyncDebounced();
}

// Update due date
function updateTodoDue(id, dueISO) {
  const t = todos.find(x => x.id === id);
  if (!t) return;
  t.dueDate = dueISO || null;
  t.updatedAt = Date.now();
  saveTodos({ changedIds: [id] });
  render();
  scheduleReminders();
  if (SYNC_URL) scheduleSyncDebounced();
}

// Clear completed
function clearCompleted() {
  todos = todos.filter(t => !t.completed);
  saveTodos();
  render();
  scheduleReminders();
  if (SYNC_URL) scheduleSyncDebounced();
}

// Clear all
function clearAll() {
  todos = [];
  saveTodos();
  render();
  scheduleReminders();
  if (SYNC_URL) scheduleSyncDebounced();
}

// Filter helpers
function filteredTodos() {
  if (filter === 'active') return todos.filter(t => !t.completed);
  if (filter === 'completed') return todos.filter(t => t.completed);
  return todos;
}

// Drag & Drop reordering
let dragSrcId = null;

function handleDragStart(e) {
  const li = e.currentTarget;
  dragSrcId = li.dataset.id;
  li.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  try { e.dataTransfer.setData('text/plain', dragSrcId); } catch (err) {}
}

function handleDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  const el = e.currentTarget;
  el.classList.add('drag-over');
}

function handleDragLeave(e) {
  e.currentTarget.classList.remove('drag-over');
}

function handleDrop(e) {
  e.preventDefault();
  const target = e.currentTarget;
  const targetId = target.dataset.id;
  const srcId = dragSrcId || (e.dataTransfer && e.dataTransfer.getData('text/plain'));
  if (!srcId || !targetId || srcId === targetId) {
    cleanupDragStates();
    return;
  }
  // reorder todos array: move src before target
  const srcIndex = todos.findIndex(t => t.id === srcId);
  const tgtIndex = todos.findIndex(t => t.id === targetId);
  if (srcIndex === -1 || tgtIndex === -1) { cleanupDragStates(); return; }

  const [item] = todos.splice(srcIndex, 1);
  todos.splice(tgtIndex, 0, item);
  // persist and update updatedAt for moved item
  item.updatedAt = Date.now();
  saveTodos({ changedIds: [item.id] });
  render();
  if (SYNC_URL) scheduleSyncDebounced();
  cleanupDragStates();
}

function handleDragEnd(e) {
  cleanupDragStates();
}

function cleanupDragStates() {
  document.querySelectorAll('.todo-item').forEach(el => {
    el.classList.remove('dragging', 'drag-over');
  });
  dragSrcId = null;
}

// Reminders scheduling
function scheduleReminders() {
  // Clear existing timers
  for (const [id, tId] of reminderTimers.entries()) {
    clearTimeout(tId);
  }
  reminderTimers.clear();

  // Request notification permission if needed
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission().catch(() => {});
  }

  const now = Date.now();
  for (const t of todos) {
    if (!t.dueDate) continue;
    if (t.completed) continue;
    const dueMs = new Date(t.dueDate).getTime();
    if (isNaN(dueMs)) continue;
    const timeUntil = dueMs - now;
    if (timeUntil <= 0) {
      // overdue: notify immediately (but not more than once per page load)
      notifyReminder(t, true);
    } else {
      const timer = setTimeout(() => notifyReminder(t, false), timeUntil);
      reminderTimers.set(t.id, timer);
    }
  }
}

function notifyReminder(todo, overdue) {
  const message = overdue ? `Overdue: ${todo.text}` : `Due now: ${todo.text}`;
  // Browser Notification if allowed
  if ('Notification' in window && Notification.permission === 'granted') {
    try {
      const n = new Notification('To‑Do Reminder', { body: message, tag: `todo-${todo.id}` });
      // optional: click behavior
      n.onclick = () => window.focus();
    } catch (e) {
      // fallback
      alert(message);
    }
  } else {
    alert(message);
  }
  // Optionally mark reminder as triggered in state (not implemented)
}

// Sync: naive last-write-wins merging
let syncInProgress = false;
let scheduledSyncTimer = null;
const syncDebounceMs = 1500;

async function pullRemote() {
  if (!SYNC_URL) return null;
  try {
    const res = await fetch(SYNC_URL + '/pull', { method: 'GET', headers: { 'Content-Type': 'application/json' }});
    if (!res.ok) throw new Error('Pull failed');
    const data = await res.json();
    return data; // expect { todos: [...] }
  } catch (err) {
    console.warn('pullRemote failed', err);
    return null;
  }
}

async function pushRemote(payload) {
  if (!SYNC_URL) return false;
  try {
    const res = await fetch(SYNC_URL + '/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) throw new Error('Push failed');
    return true;
  } catch (err) {
    console.warn('pushRemote failed', err);
    return false;
  }
}

async function syncNow(manual = false) {
  if (!SYNC_URL) {
    syncStatusEl.textContent = 'Sync disabled';
    return;
  }
  if (syncInProgress) return;
  syncInProgress = true;
  syncStatusEl.textContent = 'Syncing...';

  try {
    // 1) pull remote
    const remote = await pullRemote();
    if (remote && Array.isArray(remote.todos)) {
      // merge remote and local based on updatedAt
      const merged = mergeTodos(remote.todos, todos);
      todos = merged;
      saveTodos();
    }

    // 2) push local (send full list)
    await pushRemote({ todos });

    syncStatusEl.textContent = 'Synced ' + new Date().toLocaleTimeString();
  } catch (err) {
    console.warn('syncNow error', err);
    syncStatusEl.textContent = 'Sync error';
  } finally {
    syncInProgress = false;
    if (!manual) {
      // keep status for a moment
      setTimeout(() => {
        if (!syncInProgress) syncStatusEl.textContent = 'Idle';
      }, 2000);
    }
  }
}

function mergeTodos(remoteList, localList) {
  // Build map of items by id
  const map = new Map();
  for (const r of remoteList) {
    map.set(r.id, r);
  }
  for (const l of localList) {
    const r = map.get(l.id);
    if (!r) {
      map.set(l.id, l);
    } else {
      // Keep the one with greater updatedAt
      if ((l.updatedAt || 0) > (r.updatedAt || 0)) {
        map.set(l.id, l);
      } else {
        map.set(l.id, r);
      }
    }
  }
  // If remote has items not in local: include them
  // Preserve order using local order first, then remote extras appended
  const localIds = localList.map(x => x.id);
  const ordered = [];
  for (const id of localIds) {
    const item = map.get(id);
    if (item) ordered.push(item);
    map.delete(id);
  }
  // remaining items (remote extras)
  for (const item of map.values()) ordered.push(item);
  return ordered;
}

function scheduleSyncDebounced() {
  if (!SYNC_URL) return;
  if (scheduledSyncTimer) clearTimeout(scheduledSyncTimer);
  scheduledSyncTimer = setTimeout(() => syncNow(false), syncDebounceMs);
}

// Render
function render() {
  todoList.innerHTML = '';

  const list = filteredTodos();
  if (list.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'todo-item';
    empty.innerHTML = `<div class="todo-left"><div class="todo-text" style="color:var(--muted)">No tasks here</div></div>`;
    todoList.appendChild(empty);
  } else {
    list.forEach((t) => {
      const li = document.createElement('li');
      li.className = 'todo-item';
      li.dataset.id = t.id;
      li.draggable = true;

      // left: handle + checkbox + text
      const left = document.createElement('div');
      left.className = 'todo-left';

      const handle = document.createElement('div');
      handle.className = 'handle';
      handle.innerHTML = '≡';

      const toggle = document.createElement('button');
      toggle.className = 'toggle' + (t.completed ? ' checked' : '');
      toggle.setAttribute('aria-label', t.completed ? 'Mark as active' : 'Mark as completed');
      if (t.completed) {
        const check = document.createElement('span');
        check.className = 'checkmark';
        toggle.appendChild(check);
      }

      const text = document.createElement('div');
      text.className = 'todo-text' + (t.completed ? ' completed' : '');
      text.textContent = t.text;
      text.title = 'Double-click to edit';

      left.appendChild(handle);
      left.appendChild(toggle);
      left.appendChild(text);

      // due date display
      const due = document.createElement('div');
      due.className = 'due';
      if (t.dueDate) {
        const dueDate = new Date(t.dueDate);
        const now = Date.now();
        if (dueDate.getTime() < now && !t.completed) due.classList.add('overdue');
        else if (dueDate.getTime() - now < 24 * 60 * 60 * 1000 && !t.completed) due.classList.add('due-soon');
        due.textContent = dueDate.toLocaleString();
      } else {
        due.textContent = '';
      }
      left.appendChild(due);

      // right actions
      const actions = document.createElement('div');
      actions.className = 'todo-actions';

      const dueBtn = document.createElement('button');
      dueBtn.className = 'icon-btn';
      dueBtn.title = 'Set due date';
      dueBtn.innerHTML = '📅';

      const editBtn = document.createElement('button');
      editBtn.className = 'icon-btn';
      editBtn.title = 'Edit';
      editBtn.innerHTML = '✎';

      const delBtn = document.createElement('button');
      delBtn.className = 'icon-btn';
      delBtn.title = 'Delete';
      delBtn.innerHTML = '🗑';

      actions.appendChild(dueBtn);
      actions.appendChild(editBtn);
      actions.appendChild(delBtn);

      li.appendChild(left);
      li.appendChild(actions);
      todoList.appendChild(li);

      // Event listeners
      handle.addEventListener('mousedown', (ev) => {
        // allow drag via handle: set draggable true (already set) - no-op
      });

      toggle.addEventListener('click', () => toggleTodo(t.id));
      delBtn.addEventListener('click', () => deleteTodo(t.id));

      // Edit (double click or edit button)
      function startEdit() {
        const input = document.createElement('input');
        input.type = 'text';
        input.value = t.text;
        input.className = 'edit-input';
        input.setAttribute('aria-label', 'Edit task');
        left.replaceChild(input, text);
        input.focus();
        input.setSelectionRange(0, input.value.length);

        function commit() {
          const v = input.value.trim();
          if (v) updateTodoText(t.id, v);
          else deleteTodo(t.id);
        }
        input.addEventListener('blur', commit, { once: true });
        input.addEventListener('keydown', (ev) => {
          if (ev.key === 'Enter') { input.blur(); }
          else if (ev.key === 'Escape') { render(); }
        });
      }
      text.addEventListener('dblclick', startEdit);
      editBtn.addEventListener('click', startEdit);

      // Due date button: show a prompt for simplicity
      dueBtn.addEventListener('click', () => {
        // small input overlay
        const inp = document.createElement('input');
        inp.type = 'datetime-local';
        inp.className = 'edit-input';
        inp.value = t.dueDate ? isoToLocalInputValue(t.dueDate) : '';
        actions.replaceChild(inp, dueBtn);
        inp.focus();
        inp.addEventListener('blur', () => {
          const v = inp.value ? new Date(inp.value).toISOString() : null;
          updateTodoDue(t.id, v);
        }, { once: true });
        inp.addEventListener('keydown', (ev) => {
          if (ev.key === 'Enter') inp.blur();
          else if (ev.key === 'Escape') render();
        });
      });

      // Drag events
      li.addEventListener('dragstart', handleDragStart);
      li.addEventListener('dragover', (e) => { e.preventDefault(); li.classList.add('drag-over'); });
      li.addEventListener('dragenter', (e) => { e.preventDefault(); li.classList.add('drag-over'); });
      li.addEventListener('dragleave', handleDragLeave);
      li.addEventListener('drop', handleDrop);
      li.addEventListener('dragend', handleDragEnd);
    });
  }

  // update count
  const remaining = todos.filter(t => !t.completed).length;
  countEl.innerHTML = `<span class="count">${remaining}</span> item${remaining !== 1 ? 's' : ''} left`;

  // update filter active state
  filterButtons.forEach(btn => btn.classList.toggle('active', btn.dataset.filter === filter));
}

// Utility: convert ISO -> local input value "YYYY-MM-DDTHH:MM"
function isoToLocalInputValue(iso) {
  try {
    const d = new Date(iso);
    const tzOffset = d.getTimezoneOffset() * 60000;
    const localTime = new Date(d.getTime() - tzOffset);
    return localTime.toISOString().slice(0, 16);
  } catch (e) {
    return '';
  }
}

// Event wiring
addBtn.addEventListener('click', () => {
  addTodo(newTodoInput.value, newDueInput.value ? new Date(newDueInput.value).toISOString() : null);
  newTodoInput.value = '';
  newDueInput.value = '';
  newTodoInput.focus();
});

newTodoInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    addTodo(newTodoInput.value, newDueInput.value ? new Date(newDueInput.value).toISOString() : null);
    newTodoInput.value = '';
    newDueInput.value = '';
  }
});

clearCompletedBtn.addEventListener('click', clearCompleted);
clearAllBtn.addEventListener('click', () => {
  if (!confirm('Clear all tasks?')) return;
  clearAll();
});

filterButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    filter = btn.dataset.filter;
    render();
  });
});

// Sync button
syncNowBtn.addEventListener('click', async () => {
  if (!SYNC_URL) {
    alert('Sync is not configured. Set SYNC_URL in app.js to enable backend sync.');
    return;
  }
  await syncNow(true);
});

// Init: load, render, schedule reminders and auto-sync
loadTodos();
render();
scheduleReminders();

if (SYNC_URL) {
  syncStatusEl.textContent = 'Idle';
  // perform initial sync
  syncNow(false);
  // auto sync periodically
  setInterval(() => {
    syncNow(false);
  }, AUTO_SYNC_INTERVAL);
} else {
  syncStatusEl.textContent = 'Sync disabled';
}

// Clean up timers when page unloads
window.addEventListener('beforeunload', () => {
  for (const tId of reminderTimers.values()) clearTimeout(tId);
});

// Optional: expose some functions to global for debugging
window._todos = () => todos;
window._syncNow = syncNow;