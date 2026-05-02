export const RUN_TODO_STATUSES = ["pending", "in_progress", "completed"];
export const RUN_TODO_MAX_ITEMS = 20;
export const RUN_TODO_MAX_CONTENT_LENGTH = 180;
export const RUN_TODO_MAX_ACTIVE_FORM_LENGTH = 180;
export const EMPTY_RUN_TODO_STATE = Object.freeze({
  todos: Object.freeze([]),
  updated_at: null,
  update_count: 0,
});
export const EMPTY_RUN_TODO_STATE_JSON = JSON.stringify(EMPTY_RUN_TODO_STATE);

const STATUS_SET = new Set(RUN_TODO_STATUSES);

function parseJsonObject(value) {
  if (!value) return null;
  if (typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function textField(value, field, maxLength, { required = true, truncate = false } = {}) {
  if (value == null) {
    if (required) throw new Error(`${field} is required`);
    return "";
  }
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  const trimmed = value.trim().replace(/\s+/g, " ");
  if (!trimmed) {
    if (required) throw new Error(`${field} is required`);
    return "";
  }
  if (trimmed.length > maxLength) {
    if (truncate) return trimmed.slice(0, maxLength).trimEnd();
    throw new Error(`${field} must be ${maxLength} characters or fewer`);
  }
  return trimmed;
}

function normalizeTodoItem(item, index, { strict = false } = {}) {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    if (strict) throw new Error(`todos[${index}] must be an object`);
    return null;
  }
  const status = item.status || "pending";
  if (!STATUS_SET.has(status)) {
    if (strict) throw new Error(`todos[${index}].status must be pending, in_progress, or completed`);
    return null;
  }
  let content;
  let activeForm;
  try {
    content = textField(item.content, `todos[${index}].content`, RUN_TODO_MAX_CONTENT_LENGTH, { truncate: !strict });
    activeForm = textField(item.active_form, `todos[${index}].active_form`, RUN_TODO_MAX_ACTIVE_FORM_LENGTH, {
      required: false,
      truncate: !strict,
    });
  } catch (err) {
    if (strict) throw err;
    return null;
  }
  const normalized = { content, status };
  if (activeForm) normalized.active_form = activeForm;
  return normalized;
}

export function normalizeRunTodoItems(value, { strict = false } = {}) {
  if (!Array.isArray(value)) {
    if (strict) throw new Error("todos must be an array");
    return [];
  }
  if (value.length > RUN_TODO_MAX_ITEMS) {
    if (strict) throw new Error(`todos must contain ${RUN_TODO_MAX_ITEMS} items or fewer`);
  }
  const sourceItems = strict ? value : value.slice(0, RUN_TODO_MAX_ITEMS);
  const todos = sourceItems
    .map((item, index) => normalizeTodoItem(item, index, { strict }))
    .filter(Boolean);
  const activeCount = todos.filter((todo) => todo.status === "in_progress").length;
  if (activeCount > 1) {
    if (strict) throw new Error("todos must contain at most one in_progress item");
    let sawActive = false;
    return todos.map((todo) => {
      if (todo.status !== "in_progress") return todo;
      if (!sawActive) {
        sawActive = true;
        return todo;
      }
      return { ...todo, status: "pending" };
    });
  }
  return todos;
}

export function normalizeRunTodoState(value) {
  const parsed = parseJsonObject(value) || EMPTY_RUN_TODO_STATE;
  const todos = normalizeRunTodoItems(parsed.todos);
  const updatedAt = Number(parsed.updated_at);
  const updateCount = Number(parsed.update_count);
  return {
    todos,
    updated_at: Number.isFinite(updatedAt) && updatedAt > 0 ? updatedAt : null,
    update_count: Number.isFinite(updateCount) && updateCount > 0 ? Math.trunc(updateCount) : 0,
  };
}

export function createRunTodoState(todosInput, { previousState = null, now = Date.now() } = {}) {
  const todos = normalizeRunTodoItems(todosInput, { strict: true });
  const previous = normalizeRunTodoState(previousState);
  return {
    todos,
    updated_at: now,
    update_count: previous.update_count + 1,
  };
}

export function runTodoStateSummary(stateInput) {
  const state = normalizeRunTodoState(stateInput);
  const completed = state.todos.filter((todo) => todo.status === "completed").length;
  return {
    ...state,
    total: state.todos.length,
    completed,
  };
}

export function serializeRunTodoState(stateInput) {
  const state = normalizeRunTodoState(stateInput);
  return JSON.stringify(state);
}
